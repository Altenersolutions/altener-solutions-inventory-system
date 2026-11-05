// BOM quality + cost reports.
//   verification: which BOM lines still have a placeholder quantity / are not FINALIZED
//   costRollup:   what one (or N) vehicle(s) cost, from the supplier-specific prices
const M = require("../models");
const { BusinessError, notFound } = require("./errors");
const tree = require("./bomTree");
const purchasing = require("./purchasing");
const up = (v) => String(v == null ? "" : v).trim().toUpperCase();
const group = (where) => (where ? String(where).split("; ").map((w) => w.split(" > ")[0]) : ["(no group)"]);

async function revisionOf(model, name) {
  const bom = await M.BOM.findOne({ vehicleModel: up(model) }).lean(); if (!bom) throw notFound("BOM", model);
  const revName = name || bom.currentRevision;   // no approved revision yet (e.g. right after the first import): use the newest draft
  const rev = revName ? await M.BOMRevision.findOne({ bom: bom._id, revision: revName }).lean() : (await M.BOMRevision.find({ bom: bom._id }).sort({ createdAt: -1 }).limit(1).lean())[0]; if (!rev) throw notFound("BOM revision", revName);
  return { bom, rev };
}
// lines saved before this feature have no flag at all and are not counted as unverified
const isUnverified = (i) => i.qtyVerified === false;

function verificationOf(rev) {
  const items = rev.items || []; const byStatus = {}; items.forEach((i) => { const k = i.designStatus || "(none)"; byStatus[k] = (byStatus[k] || 0) + 1; });
  const unverified = items.filter(isUnverified); const notFinal = items.filter((i) => i.designStatus && i.designStatus !== "FINALIZED");
  return { total: items.length, verified: items.length - unverified.length, unverified: unverified.length, notFinalized: notFinal.length, byStatus, percentVerified: items.length ? Math.round(((items.length - unverified.length) / items.length) * 1000) / 10 : 100 };
}
async function verification(model, revision) {
  const { bom, rev } = await revisionOf(model, revision); const v = verificationOf(rev);
  const parts = new Map((await M.PartMaster.find({ _id: { $in: rev.items.filter(isUnverified).map((i) => i.part) } }, "partName").lean()).map((p) => [String(p._id), p.partName]));
  return { model: bom.vehicleModel, revision: rev.revision, status: rev.status, ...v,
    lines: rev.items.filter(isUnverified).slice(0, 1000).map((i) => ({ partNumber: i.partNumber, partName: parts.get(String(i.part)) || "", quantity: i.requiredQuantity, designStatus: i.designStatus || "", where: i.installationPosition || "" })) };
}

// price to use for a part: the preferred supplier's valid price, else the cheapest valid one, else the part's own unit cost
function chooseUnitPrice(part, strategy = "preferred", at = new Date()) {
  const ok = (part.approvedSuppliers || []).filter((a) => purchasing.priceFor(part, a.supplier && a.supplier._id ? a.supplier._id : a.supplier, at));
  const name = (a) => (a.supplier && a.supplier.name) || "supplier";
  if (ok.length) { const pick = strategy === "lowest" ? ok.reduce((m, a) => (a.price < m.price ? a : m)) : ok.find((a) => a.preferred) || ok.reduce((m, a) => (a.price < m.price ? a : m)); return { price: pick.price, currency: pick.currency || "INR", source: `SUPPLIER: ${name(pick)}` }; }
  if (part.unitCost != null && part.unitCost > 0) return { price: part.unitCost, currency: "INR", source: "PART UNIT COST" };
  return null;
}
async function costRollup({ model, revision, variant = "", qty = 1, strategy = "preferred" }) {
  const { bom, rev } = await revisionOf(model, revision); variant = up(variant); qty = Math.max(1, Math.min(100000, Number(qty) || 1));
  if (variant && !(bom.variants || []).includes(variant)) throw new BusinessError("UNKNOWN_VARIANT", `Variant ${variant} is not declared for ${bom.vehicleModel}.`, { status: 400 });
  const rows = await tree.explodeRevision(rev, { variant, qty, allowDraft: true, _stack: bom.assemblyPart ? [String(bom.assemblyPart)] : [] }); const leaf = tree.leafLines(rows);
  const parts = new Map((await M.PartMaster.find({ _id: { $in: leaf.map((l) => l.part) } }, "partNumber partName unitCost approvedSuppliers").populate("approvedSuppliers.supplier", "name code").lean()).map((p) => [String(p._id), p]));
  const lines = leaf.map((l) => { const p = parts.get(String(l.part)) || {}; const pr = chooseUnitPrice(p, strategy);
    return { partNumber: l.partNumber, partName: p.partName, quantity: l.requiredQuantity, unitPrice: pr ? pr.price : null, currency: pr ? pr.currency : null, source: pr ? pr.source : "MISSING", cost: pr ? Math.round(pr.price * l.requiredQuantity * 100) / 100 : null, where: l.installationPosition || "", optional: !!l.optional }; });
  const priced = lines.filter((l) => l.cost != null); const total = Math.round(priced.reduce((a, l) => a + l.cost, 0) * 100) / 100; const byGroup = {};
  for (const l of priced) { const gs = group(l.where); for (const g of gs) byGroup[g] = Math.round(((byGroup[g] || 0) + l.cost / gs.length) * 100) / 100; }
  return { model: bom.vehicleModel, revision: rev.revision, variant, quantity: qty, strategy, currency: "INR", total, perVehicle: Math.round((total / qty) * 100) / 100,
    coverage: { lines: lines.length, priced: priced.length, missing: lines.length - priced.length, percent: lines.length ? Math.round((priced.length / lines.length) * 1000) / 10 : 100 },
    byGroup: Object.entries(byGroup).map(([g, cost]) => ({ group: g, cost })).sort((a, b) => b.cost - a.cost), lines: lines.sort((a, b) => (b.cost || 0) - (a.cost || 0)), missingPrices: lines.filter((l) => l.cost == null).map((l) => ({ partNumber: l.partNumber, partName: l.partName, quantity: l.quantity })) };
}

// Bulk "verify quantities" from a CSV (partNumber, quantity, verified). Only DRAFT revisions can be changed.
const { atomic } = require("./uow"); const { audit } = require("./audit"); const { invalid } = require("./errors");
const yes = (v) => /^(y|yes|true|1|verified|ok)$/i.test(String(v == null ? "" : v).trim());
async function importQuantities(user, model, revName, rows, dryRun) {
  const bom = await M.BOM.findOne({ vehicleModel: up(model) }); if (!bom) throw notFound("BOM", model);
  const rev = await M.BOMRevision.findOne({ bom: bom._id, revision: revName }); if (!rev) throw notFound("BOM revision", revName);
  if (rev.status !== "DRAFT") throw new BusinessError("INVALID_STATE_TRANSITION", `${rev.revision} is ${rev.status}; only a DRAFT revision can be changed. Create a new revision first.`);
  const items = rev.toObject().items; const idx = new Map(items.map((i, k) => [i.partNumber, k])); const res = { updated: 0, verified: 0, quantityChanged: 0, unchanged: 0, errors: [], preview: [], dryRun: !!dryRun };
  for (const [n, r] of rows.entries()) {
    const pn = String(r.partnumber || r.partno || r.partid || "").trim().toUpperCase(); const row = n + 2;
    try {
      if (!pn) throw new Error("partNumber is empty"); if (!idx.has(pn)) throw new Error(`${pn} is not on ${rev.revision}`);
      const it = items[idx.get(pn)]; const qRaw = String(r.quantity != null ? r.quantity : r.qty != null ? r.qty : "").trim(); const vRaw = String(r.verified != null ? r.verified : "").trim();
      let changed = false, q = it.requiredQuantity;
      if (qRaw !== "") { q = Number(qRaw); if (!Number.isInteger(q) || q < 1) throw new Error("quantity must be a whole number, 1 or more"); if (q !== it.requiredQuantity) { it.requiredQuantity = q; res.quantityChanged++; changed = true; } }
      const v = vRaw !== "" ? yes(vRaw) : qRaw !== ""; if (v !== !!it.qtyVerified) { it.qtyVerified = v; if (v) res.verified++; changed = true; }
      if (changed) { res.updated++; if (res.preview.length < 15) res.preview.push({ partNumber: pn, quantity: q, verified: v ? "yes" : "no" }); } else res.unchanged++;
    } catch (e) { res.errors.push({ row, partNumber: pn, message: e.message }); }
  }
  if (!dryRun && res.updated) await atomic(async (ctx) => { await ctx.set(M.BOMRevision, rev._id, { items }); await audit(ctx, user, { action: "BOM_QUANTITIES_VERIFIED", entityType: "BOM", entityId: bom._id, entityLabel: `${bom.vehicleModel} ${rev.revision}`, where: "Verify quantities import", after: { updated: res.updated, verified: res.verified, quantityChanged: res.quantityChanged } }); });
  return res;
}

module.exports = { importQuantities, verification, verificationOf, isUnverified, costRollup, chooseUnitPrice };
