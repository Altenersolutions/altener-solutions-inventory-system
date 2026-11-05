// Production planning: "I want to build N vehicles (variant X)" -> component requirements, what stock can really be used,
// what is waiting for QC / on hold / on order, the shortage, and a pick list sorted by rack so the store walks the racks once.
const M = require("../models");
const { MS } = require("./constants");
const { BusinessError, notFound } = require("./errors");
const tree = require("./bomTree");
const { rackLabel } = require("./locations");

const up = (v) => String(v == null ? "" : v).trim().toUpperCase();
const AWAITING = [MS.PENDING_INCOMING_QC, "QC_REQUIRED", MS.RECEIVED, "PENDING_RETEST"];

async function requirements(body) {
  const model = up(body.model); const bom = await M.BOM.findOne({ vehicleModel: model }).lean(); if (!bom) throw notFound("BOM", model);
  const variant = up(body.variant); const qty = Number(body.quantity || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BusinessError("INVALID_QUANTITY", "Quantity must be a whole number from 1 to 100000.", { status: 400 });
  if (variant && !(bom.variants || []).includes(variant)) throw new BusinessError("UNKNOWN_VARIANT", `Variant ${variant} is not declared for ${model}${(bom.variants || []).length ? ` (${bom.variants.join(", ")})` : ""}.`, { status: 400 });
  if ((bom.variants || []).length && !variant) throw new BusinessError("VARIANT_REQUIRED", `${model} has variants (${bom.variants.join(", ")}) - choose one.`, { status: 400 });
  const revName = body.revision || bom.currentRevision; const rev = revName && (await M.BOMRevision.findOne({ bom: bom._id, revision: revName }).lean());
  if (!rev) throw new BusinessError("NO_BOM", `No BOM revision${revName ? " " + revName : ""} for ${model}.`, { status: 400 });

  const rows = await tree.explodeRevision(rev, { variant, qty, allowDraft: true, _stack: bom.assemblyPart ? [String(bom.assemblyPart)] : [] });
  const allLeaf = tree.leafLines(rows); const leaf = body.includeOptional ? allLeaf : allLeaf.filter((l) => !l.optional);
  const ids = leaf.map((l) => l.part);
  const parts = new Map((await M.PartMaster.find({ _id: { $in: ids } }, "partNumber partName unit supplier approvedSuppliers").populate("approvedSuppliers.supplier", "code name").lean()).map((p) => [String(p._id), p]));
  const items = await M.MaterialItem.find({ part: { $in: ids }, installedOn: { $in: [null, undefined] }, status: { $in: [MS.APPROVED, MS.HOLD, ...AWAITING] } }).sort({ createdAt: 1 }).lean();
  const itemIds = items.map((i) => i._id);
  const bal = itemIds.length ? await M.StockBalance.find({ materialItem: { $in: itemIds }, quantity: { $gt: 0 } }).populate("location", "locationCode type path rack bin").lean() : [];
  const resv = itemIds.length ? await M.Reservation.find({ materialItem: { $in: itemIds }, status: "ACTIVE" }).lean() : [];
  const reservedBy = new Map(); resv.forEach((r) => reservedBy.set(String(r.materialItem), (reservedBy.get(String(r.materialItem)) || 0) + r.quantity));
  const balBy = new Map(); bal.forEach((b) => { const k = String(b.materialItem); (balBy.get(k) || balBy.set(k, []).get(k)).push(b); });
  const pos = await M.PurchaseOrder.find({ status: { $in: ["OPEN", "PARTIAL"] }, "lines.part": { $in: ids } }).select("poNo lines").lean();

  const lines = [], pick = [];
  for (const l of leaf) {
    const pid = String(l.part), part = parts.get(pid) || {}; const mine = items.filter((i) => String(i.part) === pid);
    const sum = (arr) => arr.reduce((t, i) => t + (balBy.get(String(i._id)) || []).reduce((x, b) => x + b.quantity, 0), 0);
    const usableItems = mine.filter((i) => i.status === MS.APPROVED && (!l.requiredRevision || !i.partRevision || i.partRevision === l.requiredRevision));
    let usable = 0, reservedAway = 0; const alloc = [];
    for (const it of usableItems) {
      const bins = (balBy.get(String(it._id)) || []).filter((b) => b.location && b.location.type === "BIN");
      const inBins = bins.reduce((t, b) => t + b.quantity, 0); const res = reservedBy.get(String(it._id)) || 0; const free = Math.max(0, inBins - res);
      reservedAway += Math.min(inBins, res); usable += free;
      let left = free; for (const b of bins) { if (left <= 0) break; const take = Math.min(b.quantity, left); alloc.push({ item: it, loc: b.location, qty: take }); left -= take; }
    }
    const awaiting = sum(mine.filter((i) => AWAITING.includes(i.status))), onHold = sum(mine.filter((i) => i.status === MS.HOLD));
    let onOrder = 0; const poNos = [];
    for (const po of pos) { const o = po.lines.filter((x) => String(x.part) === pid).reduce((t, x) => t + Math.max(0, x.orderedQty - (x.receivedQty || 0)), 0); if (o > 0) { onOrder += o; poNos.push(po.poNo); } }
    const shortage = Math.max(0, l.requiredQuantity - usable), net = Math.max(0, shortage - onOrder - awaiting);
    const pref = (part.approvedSuppliers || []).find((a) => a.preferred) || (part.approvedSuppliers || [])[0];
    lines.push({ partNumber: l.partNumber, partName: part.partName, unit: part.unit || "NOS", required: l.requiredQuantity, usable, reserved: reservedAway, awaitingQc: awaiting, onHold, onOrder, poNumbers: poNos, shortage, shortageAfterIncoming: net,
      status: shortage === 0 ? "OK" : net === 0 ? "COVERED_BY_INCOMING" : "SHORT", where: l.installationPosition || "", supplier: pref && pref.supplier ? pref.supplier.name : "", leadTimeDays: pref ? pref.leadTimeDays : undefined, optional: !!l.optional });
    let need = l.requiredQuantity;
    for (const a of alloc) { if (need <= 0) break; const take = Math.min(a.qty, need); need -= take;
      pick.push({ partNumber: l.partNumber, partName: part.partName, rack: rackLabel(a.loc), locationCode: a.loc.locationCode, serialNumber: a.item.serialNumber || "", batchNumber: a.item.batchNumber || "", qty: take, unit: part.unit || "NOS", _sort: a.loc.path || a.loc.locationCode }); }
    if (need > 0) pick.push({ partNumber: l.partNumber, partName: part.partName, rack: "SHORT", locationCode: "", serialNumber: "", batchNumber: "", qty: need, unit: part.unit || "NOS", _sort: "~~~" });
  }
  pick.sort((a, b) => a._sort.localeCompare(b._sort) || a.partNumber.localeCompare(b.partNumber)); pick.forEach((p) => delete p._sort);
  lines.sort((a, b) => (a.status === "OK") - (b.status === "OK") || a.partNumber.localeCompare(b.partNumber));
  const short = lines.filter((l) => l.status !== "OK");
  // readiness: how much of the build can be started, overall and per group (assembly)
  const grp = new Map(); const r1 = (n) => Math.round(n * 1000) / 10;
  for (const l of lines) for (const g of l.where ? l.where.split("; ").map((w) => w.split(" > ")[0]) : ["(no group)"]) { const e = grp.get(g) || { group: g, lines: 0, ok: 0, short: 0, required: 0, covered: 0 }; e.lines++; if (l.status === "OK") e.ok++; else e.short++; e.required += l.required; e.covered += Math.min(l.required, l.usable); grp.set(g, e); }
  const totReq = lines.reduce((a, l) => a + l.required, 0), totCov = lines.reduce((a, l) => a + Math.min(l.required, l.usable), 0);
  const readiness = { qtyPercent: totReq ? r1(totCov / totReq) : 100, linePercent: lines.length ? r1((lines.length - short.length) / lines.length) : 100, groups: [...grp.values()].map((g) => ({ ...g, percent: g.required ? r1(g.covered / g.required) : 100 })).sort((a, b) => a.percent - b.percent) };
  return { model, revision: rev.revision, revisionStatus: rev.status, variant, quantity: qty, optionalSkipped: body.includeOptional ? 0 : allLeaf.length - leaf.length,
    summary: { components: lines.length, ok: lines.length - short.length, short: short.length, needsPurchase: lines.filter((l) => l.status === "SHORT").length, canBuild: short.length === 0 }, readiness, lines, pickList: pick, subAssemblies: rows.filter((r) => r.isAssembly).map((r) => ({ partNumber: r.partNumber, qty: r.qty, level: r.level })) };
}

// Parts below their minimum stock (usable + QC-pending + on order < minStock), with the quantity to buy and the preferred supplier's price.
async function reorder({ vehicle } = {}) {
  const purchasing = require("./purchasing"); const q = { minStock: { $gt: 0 }, active: { $ne: false } }; if (vehicle) q.vehicleCompatibility = up(vehicle);
  const parts = await M.PartMaster.find(q, "partNumber partName unit minStock approvedSuppliers unitCost vehicleCompatibility").populate("approvedSuppliers.supplier", "code name").lean(); const ids = parts.map((p) => p._id);
  const items = ids.length ? await M.MaterialItem.find({ part: { $in: ids }, installedOn: { $in: [null, undefined] }, status: { $in: [MS.APPROVED, ...AWAITING] } }).lean() : [];
  const bal = items.length ? await M.StockBalance.find({ materialItem: { $in: items.map((i) => i._id) }, quantity: { $gt: 0 } }).populate("location", "type").lean() : [];
  const resv = items.length ? await M.Reservation.find({ materialItem: { $in: items.map((i) => i._id) }, status: "ACTIVE" }).lean() : [];
  const pos = ids.length ? await M.PurchaseOrder.find({ status: { $in: ["OPEN", "PARTIAL"] }, "lines.part": { $in: ids } }).select("poNo lines").lean() : [];
  const out = [];
  for (const p of parts) {
    const mine = items.filter((i) => String(i.part) === String(p._id)); let usable = 0, awaiting = 0;
    for (const it of mine) { const b = bal.filter((x) => String(x.materialItem) === String(it._id)); const inBins = b.filter((x) => x.location && x.location.type === "BIN").reduce((t, x) => t + x.quantity, 0), all = b.reduce((t, x) => t + x.quantity, 0);
      const res = resv.filter((r) => String(r.materialItem) === String(it._id)).reduce((t, r) => t + r.quantity, 0); if (it.status === MS.APPROVED) usable += Math.max(0, inBins - res); else awaiting += all; }
    let onOrder = 0; const poNos = []; for (const po of pos) { const o = po.lines.filter((x) => String(x.part) === String(p._id)).reduce((t, x) => t + Math.max(0, x.orderedQty - (x.receivedQty || 0)), 0); if (o > 0) { onOrder += o; poNos.push(po.poNo); } }
    const position = usable + awaiting + onOrder; if (position >= p.minStock) continue;
    const pref = (p.approvedSuppliers || []).find((a) => a.preferred) || (p.approvedSuppliers || [])[0]; const sp = pref && pref.supplier ? purchasing.priceFor(p, pref.supplier._id) : undefined;
    let buy = p.minStock - position; if (sp && sp.moq && buy < sp.moq) buy = sp.moq;
    out.push({ partNumber: p.partNumber, partName: p.partName, unit: p.unit || "NOS", minStock: p.minStock, usable, awaitingQc: awaiting, onOrder, poNumbers: poNos, suggestedQty: buy, supplier: pref && pref.supplier ? pref.supplier.name : "", supplierId: pref && pref.supplier ? String(pref.supplier._id) : "", unitPrice: sp ? sp.price : null, currency: sp ? sp.currency : null, moq: sp ? sp.moq : undefined, leadTimeDays: pref ? pref.leadTimeDays : undefined, estimatedCost: sp ? Math.round(sp.price * buy * 100) / 100 : null });
  }
  out.sort((a, b) => (b.suggestedQty / (b.minStock || 1)) - (a.suggestedQty / (a.minStock || 1)));
  return { vehicle: vehicle ? up(vehicle) : "", count: out.length, estimatedTotal: Math.round(out.reduce((a, l) => a + (l.estimatedCost || 0), 0) * 100) / 100, withoutPrice: out.filter((l) => l.unitPrice == null).length, lines: out };
}
module.exports = { requirements, reorder };
