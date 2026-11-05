// Your own Part IDs: what is accepted, which old generated IDs may be replaced, and the bulk tools.
const M = require("../models");
const { BusinessError, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { ensureRackBin, rackLabel } = require("./locations");

const config = require("../config");
const s = (v) => (v == null ? "" : String(v).trim());

// Old sample numbers that were generated for the presentation (MECH-0001, ELEC-0001, ELCN-0001, OTH-0001).
// They are placeholders, not real IDs, so they may be replaced like TMP- numbers (until stock exists).
const GENERATED = /^(MECH|ELEC|ELCN|OTH)-\d{3,6}$/;
const isPlaceholder = (p) => !!(p && (p.provisional || GENERATED.test(p.partNumber || "")));

// "|" and "=" are used inside the QR / barcode text (MAT|PART|R=..|S=..), so they cannot be part of an ID.
const PATTERN_HELP = "numeric Part IDs must have exactly 12 digits: Model(3) + Category(3) + Material(1) + Process(1) + Resource(1) + Running serial(3)";
function checkPartNumber(v, { skipPattern = false } = {}) {
  const pn = s(v).toUpperCase();
  if (!pn) return { ok: false, message: "Part number is empty." };
  if (pn.length > 60) return { ok: false, message: "Part number is longer than 60 characters." };
  if (/[|=]/.test(pn)) return { ok: false, message: 'Part number cannot contain "|" or "=" (they are used inside barcodes).' };
  if (/[\u0000-\u001f]/.test(pn)) return { ok: false, message: "Part number contains hidden control characters." };
  if (!skipPattern && !config.partIdPattern.test(pn)) return { ok: false, message: `"${pn}" does not match your Part ID format (${PATTERN_HELP}). Use a temporary number until the ID is complete.` };
  return { ok: true, partNumber: pn };
}
// Sheet cell -> what kind of number it is. REAL = usable as the Part ID. PROPOSED = looks like an ID but is incomplete (kept as a note on a temporary part).
// PLACEHOLDER = all zeros ("under review"). INVALID = contains characters that break barcodes.
function classifyPartNumber(v) {
  const raw = s(v).toUpperCase(); if (!raw) return { type: "NONE", value: "" };
  if (/^0+$/.test(raw) || /^\d{3}0{6,9}$/.test(raw)) return { type: "PLACEHOLDER", value: "" };   // 000000, or the model code followed only by zeros (901000000)
  const chk = checkPartNumber(raw, { skipPattern: true }); if (!chk.ok) return { type: "INVALID", value: raw, message: chk.message };
  return config.partIdPattern.test(raw) ? { type: "REAL", value: raw } : { type: "PROPOSED", value: raw };
}
const assertPartNumber = (v) => { const r = checkPartNumber(v); if (!r.ok) throw invalid(r.message); return r.partNumber; };


// Changes the part number on every BOM line that uses the part (all revisions). Works on any MongoDB, undoes itself on failure.
async function renameInBoms(partId, to, ctx) {
  const opt = (ctx && ctx.opt) || {};
  const revs = await M.BOMRevision.find({ "items.part": partId }, null, opt).lean();
  for (const r of revs) {
    const items = r.items.map((i) => (String(i.part) === String(partId) ? { ...i, partNumber: to } : i));
    await M.BOMRevision.collection.updateOne({ _id: r._id }, { $set: { items } }, opt);
    if (ctx) ctx.onUndo(() => M.BOMRevision.collection.updateOne({ _id: r._id }, { $set: { items: r.items } }));
  }
  return revs.length;
}

// Rows: currentPartNumber (or partName) + newPartNumber.  Renames parts to YOUR IDs and updates every BOM line.
async function importPartIds(user, rows, dryRun) {
  const res = { updated: 0, unchanged: 0, errors: [], dryRun: !!dryRun, preview: [] };
  const seenNew = new Map(); const seenOld = new Set();
  const todo = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 2; const cur = s(r.currentpartnumber || r.oldpartnumber || r.partnumber).toUpperCase(), name = s(r.partname || r.name), neu = s(r.newpartnumber || r.realpartnumber || r.newid || r.partid);
    try {
      if (!neu) throw new Error("newPartNumber is empty");
      const chk = checkPartNumber(neu); if (!chk.ok) throw new Error(chk.message);
      if (!cur && !name) throw new Error("give currentPartNumber (e.g. TMP-00001 or MECH-0001) or partName");
      let part = null;
      if (cur) part = await M.PartMaster.findOne({ partNumber: cur });
      else { const hits = await M.PartMaster.find({ partName: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).limit(3); if (hits.length > 1) throw new Error(`more than one part is named "${name}" - use currentPartNumber`); part = hits[0]; }
      if (!part) throw new Error(`part ${cur || name} not found`);
      if (part.partNumber === chk.partNumber) { res.unchanged++; continue; }
      if (!isPlaceholder(part)) throw new Error(`${part.partNumber} already has a real part ID and is not renamed here`);
      if (seenOld.has(String(part._id))) throw new Error(`${part.partNumber} appears twice in the file`);
      if (seenNew.has(chk.partNumber)) throw new Error(`${chk.partNumber} is used for two parts (rows ${seenNew.get(chk.partNumber)} and ${n})`);
      if (await M.PartMaster.exists({ partNumber: chk.partNumber })) throw new Error(`${chk.partNumber} already exists`);
      if ((await M.MaterialItem.exists({ part: part._id })) || (await M.PurchaseOrder.exists({ "lines.part": part._id }))) throw new Error(`${part.partNumber} already has stock or purchase orders, so its ID can no longer be changed`);
      seenNew.set(chk.partNumber, n); seenOld.add(String(part._id));
      todo.push({ part, neu: chk.partNumber });
      if (res.preview.length < 15) res.preview.push({ from: part.partNumber, to: chk.partNumber, name: part.partName });
    } catch (e) { res.errors.push({ row: n, partNumber: cur || name, message: e.message }); }
  }
  if (dryRun) { res.updated = todo.length; return res; }
  for (const { part, neu } of todo) {
    try {
      const old = part.partNumber;
      await atomic(async (ctx) => {
        await ctx.set(M.PartMaster, part._id, { partNumber: neu, provisional: false });
        await renameInBoms(part._id, neu, ctx);
        await audit(ctx, user, { action: "PART_NUMBER_ASSIGNED", entityType: "Part", entityId: part._id, entityLabel: neu, before: { partNumber: old }, after: { partNumber: neu }, where: "Part ID import" });
      });
      res.updated++;
    } catch (e) { res.errors.push({ row: 0, partNumber: part.partNumber, message: e.message }); }
  }
  return res;
}

// Rows: partNumber + rackLocation ("RACK-A / BIN-12").  Sets the default storage place of EXISTING parts.
async function importRacks(user, rows, dryRun) {
  const res = { updated: 0, unchanged: 0, newRacksBins: 0, errors: [], dryRun: !!dryRun, preview: [] };
  const created = new Set();
  for (const [i, r] of rows.entries()) {
    const n = i + 2; const pn = s(r.partnumber || r.partno || r.partid).toUpperCase(), rk = s(r.racklocation || r.rack || r.location || r.defaultbin || r.bin);
    try {
      if (!pn) throw new Error("partNumber is empty");
      if (!rk) throw new Error("rackLocation is empty");
      const part = await M.PartMaster.findOne({ partNumber: pn }).populate("defaultLocation", "locationCode rack bin path");
      if (!part) throw new Error(`part ${pn} not found (import the part first)`);
      const probe = await ensureRackBin(rk, { dryRun: true });
      if (part.defaultLocation && part.defaultLocation.locationCode === probe.code) { res.unchanged++; continue; }
      if (!probe.exists) created.add(probe.code);
      if (res.preview.length < 15) res.preview.push({ partNumber: pn, from: rackLabel(part.defaultLocation) || "—", to: probe.label });
      if (!dryRun) {
        const bin = await ensureRackBin(rk);
        const before = part.defaultLocation ? part.defaultLocation.locationCode : null;
        await atomic(async (ctx) => { await ctx.set(M.PartMaster, part._id, { defaultLocation: bin._id }); await audit(ctx, user, { action: "PART_UPDATED", entityType: "Part", entityId: part._id, entityLabel: pn, before: { defaultLocation: before }, after: { defaultLocation: bin.locationCode }, where: "Rack location import" }); });
      }
      res.updated++;
    } catch (e) { res.errors.push({ row: n, partNumber: pn, message: e.message }); }
  }
  res.newRacksBins = created.size;
  return res;
}

// ---------------- approved suppliers ----------------
// list = [{ supplier: <id>, preferred, supplierPartNo, leadTimeDays }]; empty list = no restriction.
async function setApprovedSuppliers(user, part, list, where = "Parts") {
  const seen = new Set(); const clean = []; const prev = new Map((part.approvedSuppliers || []).map((a) => [String(a.supplier), a]));
  const num = (v) => (v === "" || v == null ? undefined : Number(v)); const day = (v) => (v ? new Date(v) : undefined); const now = new Date();
  for (const e of list) {
    const id = String(e.supplier); if (seen.has(id)) throw invalid("The same supplier is listed twice."); seen.add(id);
    const price = num(e.price), moq = num(e.moq), from = day(e.priceValidFrom), to = day(e.priceValidTo);
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw invalid("Price must be a number, zero or more.");
    if (moq !== undefined && (!Number.isFinite(moq) || moq < 0)) throw invalid("Minimum order quantity must be zero or more.");
    if ((from && isNaN(from)) || (to && isNaN(to))) throw invalid("Price validity dates are not valid dates."); if (from && to && to < from) throw invalid("Price valid-to date is before the valid-from date.");
    const old = prev.get(id);
    clean.push({ supplier: e.supplier, preferred: !!e.preferred, supplierPartNo: s(e.supplierPartNo) || undefined, leadTimeDays: e.leadTimeDays === "" || e.leadTimeDays == null ? undefined : Number(e.leadTimeDays),
      price, currency: s(e.currency).toUpperCase() || (old && old.currency) || "INR", moq, priceValidFrom: from, priceValidTo: to, priceNote: s(e.priceNote) || undefined,
      priceUpdatedAt: price === undefined ? undefined : old && old.price === price ? old.priceUpdatedAt || now : now });
  }
  if (clean.length && !clean.some((c) => c.preferred)) clean[0].preferred = true;
  if (clean.filter((c) => c.preferred).length > 1) { let first = true; clean.forEach((c) => { if (c.preferred) { if (!first) c.preferred = false; first = false; } }); }
  const sups = await M.Supplier.find({ _id: { $in: clean.map((c) => c.supplier) } }, "code name active").lean();
  if (sups.length !== clean.length) throw invalid("Unknown supplier in the list.");
  const code = (id) => (sups.find((x) => String(x._id) === String(id)) || {}).code; const pref = clean.find((c) => c.preferred);
  const prices = (arr) => arr.map((a) => `${a.code || code(a.supplier) || a.supplier}:${a.price == null ? "-" : a.price}`);
  await atomic(async (ctx) => {
    await ctx.set(M.PartMaster, part._id, { approvedSuppliers: clean, supplier: pref ? pref.supplier : part.supplier || null });
    await audit(ctx, user, { action: "PART_SUPPLIERS_SET", entityType: "Part", entityId: part._id, entityLabel: part.partNumber, where, before: { suppliers: [...prev.keys()], prices: [...prev.values()].map((a) => `${a.supplier}:${a.price == null ? "-" : a.price}`) }, after: { suppliers: sups.map((x) => x.code), preferred: pref && code(pref.supplier), prices: prices(clean.map((c) => ({ supplier: c.supplier, price: c.price }))) } });
  });
  return clean;
}

// Rows: partNumber, supplierCode, preferred (y/n), supplierPartNo, leadTimeDays - ONE ROW PER PART + SUPPLIER. Adds / updates those pairs, never removes others.
async function importSuppliers(user, rows, dryRun) {
  const res = { updated: 0, errors: [], dryRun: !!dryRun, preview: [] }; const plan = new Map();
  const sup = new Map((await M.Supplier.find({}, "code name").lean()).map((x) => [x.code, x]));
  for (const [i, r] of rows.entries()) {
    const n = i + 2; const pn = s(r.partnumber || r.partno || r.partid).toUpperCase(), code = s(r.suppliercode || r.supplier || r.code).toUpperCase();
    try {
      if (!pn) throw new Error("partNumber is empty"); if (!code) throw new Error("supplierCode is empty");
      const sp = sup.get(code); if (!sp) throw new Error(`supplier ${code} not found (see Suppliers page for the codes)`);
      let e = plan.get(pn); if (!e) { const part = await M.PartMaster.findOne({ partNumber: pn }); if (!part) throw new Error(`part ${pn} not found`); e = { part, list: (part.approvedSuppliers || []).map((a) => ({ supplier: a.supplier, preferred: a.preferred, supplierPartNo: a.supplierPartNo, leadTimeDays: a.leadTimeDays, price: a.price, currency: a.currency, moq: a.moq, priceValidFrom: a.priceValidFrom, priceValidTo: a.priceValidTo, priceNote: a.priceNote })) }; plan.set(pn, e); }
      const pref = /^(y|yes|true|1|preferred)$/i.test(s(r.preferred)); const cur = e.list.find((x) => String(x.supplier) === String(sp._id));
      const upd = { supplier: sp._id, preferred: pref || (cur && cur.preferred) || false, supplierPartNo: s(r.supplierpartno) || (cur && cur.supplierPartNo), leadTimeDays: s(r.leadtimedays) !== "" ? Number(r.leadtimedays) : cur && cur.leadTimeDays,
        price: s(r.price || r.unitprice) !== "" ? Number(String(r.price || r.unitprice).replace(/,/g, "")) : cur && cur.price, currency: s(r.currency) || (cur && cur.currency), moq: s(r.moq) !== "" ? Number(r.moq) : cur && cur.moq, priceValidFrom: s(r.validfrom || r.pricevalidfrom) || (cur && cur.priceValidFrom), priceValidTo: s(r.validto || r.pricevalidto) || (cur && cur.priceValidTo), priceNote: s(r.pricenote) || (cur && cur.priceNote) };
      if (upd.price !== undefined && !Number.isFinite(upd.price)) throw new Error("price must be a number"); if (upd.moq !== undefined && !Number.isFinite(upd.moq)) throw new Error("moq must be a number");
      if (upd.leadTimeDays != null && !Number.isFinite(upd.leadTimeDays)) throw new Error("leadTimeDays must be a number");
      if (pref) e.list.forEach((x) => (x.preferred = false));
      if (cur) Object.assign(cur, upd); else e.list.push(upd);
      if (res.preview.length < 15) res.preview.push({ partNumber: pn, supplier: code, preferred: upd.preferred ? "yes" : "", price: upd.price == null ? "" : upd.price });
    } catch (e) { res.errors.push({ row: n, partNumber: pn, message: e.message }); }
  }
  res.updated = plan.size;
  if (!dryRun) for (const { part, list } of plan.values()) { try { await setApprovedSuppliers(user, part, list, "Supplier import"); } catch (e) { res.errors.push({ row: 0, partNumber: part.partNumber, message: e.message }); res.updated--; } }
  return res;
}
module.exports = { classifyPartNumber, PATTERN_HELP, setApprovedSuppliers, importSuppliers, renameInBoms, GENERATED, isPlaceholder, checkPartNumber, assertPartNumber, importPartIds, importRacks };
