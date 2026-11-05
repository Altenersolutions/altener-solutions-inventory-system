const M = require("../models");
const C = require("./constants");
const { BusinessError, notFound, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { nextId } = require("./counters");
const codes = require("./codes");
const partIds = require("./partIds");
const { ensureRackBin } = require("./locations");
const s = (v) => (v == null ? "" : String(v).trim());
const yes = (v) => /^(y|yes|true|1|optional)$/i.test(s(v));

async function createBomRevision(user, model, body) {
  const bom = await M.BOM.findOne({ vehicleModel: s(model).toUpperCase() }); if (!bom) throw notFound("BOM", model);
  const items = []; const seen = new Set();
  for (const it of body.items) {
    const part = await M.PartMaster.findOne({ partNumber: s(it.partNumber).toUpperCase() });
    if (!part) throw new BusinessError("UNKNOWN_PART", `Unknown part ${it.partNumber}`, { status: 400 });
    if (seen.has(part.partNumber)) throw new BusinessError("DUPLICATE_BOM_ITEM", `${part.partNumber} appears twice in the BOM.`, { status: 400 });
    seen.add(part.partNumber);
    if (bom.assemblyPart && String(part._id) === String(bom.assemblyPart)) throw new BusinessError("BOM_CYCLE", `${part.partNumber} cannot contain itself.`, { status: 400 });
    items.push({ part: part._id, partNumber: part.partNumber, requiredQuantity: it.requiredQuantity, requiredRevision: it.requiredRevision || undefined, trackingType: part.trackingType, optional: !!it.optional, installationPosition: it.installationPosition, variants: [...new Set((it.variants || []).map((v) => s(v).toUpperCase()).filter(Boolean))], designStatus: s(it.designStatus).toUpperCase() || undefined, qtyVerified: it.qtyVerified });
  }
  const tree = require("./bomTree");
  if (bom.assemblyPart) await tree.assertNoLoop(bom.assemblyPart, items);
  await tree.pinAssemblyRevisions(items);
  const newVariants = [...new Set(items.flatMap((i) => i.variants))].filter((v) => !(bom.variants || []).includes(v));
  return atomic(async (ctx) => {
    if (newVariants.length) await ctx.set(M.BOM, bom._id, { variants: [...(bom.variants || []), ...newVariants] }); // variants named on a line are declared automatically
    const rev = await ctx.create(M.BOMRevision, { bom: bom._id, vehicleModel: bom.vehicleModel, revision: body.revision, effectiveDate: body.effectiveDate, changeReason: body.changeReason, items, status: "DRAFT" });
    await audit(ctx, user, { action: "BOM_REVISION_CREATED", entityType: "BOM", entityId: bom._id, entityLabel: `${bom.vehicleModel} ${rev.revision}`, reason: body.changeReason, after: { items: items.length } });
    return rev;
  });
}

async function importParts(user, rows, dryRun) {
  const { guess } = require("./bomExcel");
  const res = { created: 0, skipped: 0, skippedParts: [], errors: [], dryRun: !!dryRun };
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const n = i + 2; const raw = s(r.partnumber || r.partno || r.partid); const pn = raw.toUpperCase();
    try {
      const chk = partIds.checkPartNumber(raw); if (!chk.ok) throw new Error(chk.message);
      const name = s(r.partname || r.name || r.description); if (!name) throw new Error("partName is required");
      if (seen.has(pn)) throw new Error("this part number appears twice in the file");
      // category / tracking: blank = a sensible guess from the name (check them in Parts afterwards); a wrong word is still an error
      const g = guess({ name, spec: s(r.description), category: s(r.category).toUpperCase() });
      const cat = s(r.category) ? s(r.category).toUpperCase() : g.category, tr = s(r.trackingtype) ? s(r.trackingtype).toUpperCase() : g.trackingType;
      if (!C.CATEGORIES.includes(cat)) throw new Error(`category must be one of ${C.CATEGORIES.join("/")}`);
      if (!C.TRACKING.includes(tr)) throw new Error(`trackingType must be one of ${C.TRACKING.join("/")}`);
      if (await M.PartMaster.exists({ partNumber: pn })) { res.skipped++; if (res.skippedParts.length < 30) res.skippedParts.push(pn); seen.add(pn); continue; }
      const compat = s(r.compatibility).split(/[;|]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (compat.some((x) => !C.VEHICLE_TYPES.includes(x))) throw new Error(`compatibility must be from ${C.VEHICLE_TYPES.join("/")}`);
      const rack = s(r.racklocation || r.rack || r.defaultbin || r.bin);
      let bin = null; if (rack) bin = dryRun ? await ensureRackBin(rack, { dryRun: true }) : await ensureRackBin(rack); // "RACK-A / BIN-12" (created when new) or an existing bin code
      const supCodes = s(r.approvedsuppliers).split(/[;|]/).map((x) => x.trim().toUpperCase()).filter(Boolean); let approved = [];
      if (supCodes.length) { const found = await M.Supplier.find({ code: { $in: supCodes } }, "code").lean(); const miss = supCodes.filter((c) => !found.some((f) => f.code === c)); if (miss.length) throw new Error(`unknown supplier code(s): ${miss.join(", ")}`); approved = supCodes.map((c, k) => ({ supplier: found.find((f) => f.code === c)._id, preferred: k === 0 })); }
      const min = s(r.minstock) ? Number(r.minstock) : 0; if (!Number.isFinite(min) || min < 0) throw new Error("minStock invalid");
      if (!dryRun) await atomic(async (ctx) => {
        const p = await ctx.create(M.PartMaster, { partNumber: pn, partName: name, description: s(r.description) !== name ? s(r.description) : "", category: cat, subCategory: s(r.subcategory), unit: s(r.unit) || "NOS", trackingType: tr, defaultLocation: bin && bin._id, approvedSuppliers: approved, supplier: approved[0] && approved[0].supplier, vehicleCompatibility: compat, minStock: min, currentRevision: s(r.revision) || "REV-A" });
        await ctx.create(M.PartRevision, { part: p._id, revision: p.currentRevision, status: "APPROVED", approvedBy: user.id, approvedAt: new Date(), changeReason: "Imported", effectiveDate: new Date() });
        await audit(ctx, user, { action: "PART_CREATED", entityType: "Part", entityId: p._id, entityLabel: pn, where: "CSV import" });
      });
      seen.add(pn); res.created++;
    } catch (e) { res.errors.push({ row: n, partNumber: pn, message: e.message }); }
  }
  return res;
}

async function importBom(user, model, meta, rows) {
  const items = rows.map((r) => ({ partNumber: r.partnumber, requiredQuantity: Number(r.quantity), requiredRevision: s(r.requiredrevision) || undefined, optional: yes(r.optional), installationPosition: s(r.position), variants: s(r.variants || r.variant).split(/[;|]/).map((x) => x.trim()).filter(Boolean), designStatus: s(r.status), qtyVerified: s(r.qtyverified) ? yes(r.qtyverified) : undefined }));
  const bad = items.findIndex((i) => !i.partNumber || !(i.requiredQuantity >= 1) || !Number.isInteger(i.requiredQuantity));
  if (bad >= 0) throw invalid(`Row ${bad + 2}: partNumber and a whole-number quantity ≥ 1 are required.`);
  return createBomRevision(user, model, { ...meta, items });
}

async function legacyBin() {
  let b = await M.Location.findOne({ locationCode: "LEGACY-STOCK" });
  if (!b) { b = await M.Location.create({ locationCode: "LEGACY-STOCK", name: "Legacy Stock (unverified)", type: "BIN", path: "Legacy Stock (unverified)" }); b.qrCode = codes.locationPayload(b); await b.save(); }
  return b;
}
async function importOpeningStock(user, rows, dryRun) {
  const res = { created: 0, errors: [] }; const bin = dryRun ? null : await legacyBin(); let n = 0;
  for (const [i, r] of rows.entries()) {
    const pn = s(r.partnumber).toUpperCase();
    try {
      const part = await M.PartMaster.findOne({ partNumber: pn }); if (!part) throw new Error("unknown part - import parts first");
      const qty = Number(r.quantity || 1); if (!(qty > 0) || (part.trackingType !== "QUANTITY" && !Number.isInteger(qty))) throw new Error("invalid quantity");
      let serial, batch;
      if (part.trackingType === "SERIAL") { serial = s(r.serialnumber); if (!serial || qty !== 1) throw new Error("serial-tracked parts need one row per serial number, quantity 1"); if (await M.MaterialItem.exists({ part: part._id, serialNumber: serial })) throw new Error(`serial ${serial} already exists`); }
      else { batch = s(r.batchnumber); if (part.trackingType === "BATCH" && !batch) throw new Error("batch-tracked parts need a batchNumber"); batch = batch || `OPEN-${Date.now().toString(36)}-${++n}`; }
      if (!dryRun) await atomic(async (ctx) => {
        const it = await ctx.create(M.MaterialItem, { part: part._id, partNumber: part.partNumber, partRevision: s(r.revision) || part.currentRevision, trackingType: part.trackingType, serialNumber: serial, batchNumber: batch, quantity: qty, status: "LEGACY_UNVERIFIED", legacy: true, legacyNote: "Opening stock import - requires re-qualification" });
        await ctx.create(M.StockBalance, { materialItem: it._id, part: part._id, location: bin._id, quantity: qty });
        await ctx.create(M.InventoryTransaction, { transactionId: await nextId("txn", "TXN", 7), transactionType: "ADJUSTMENT", part: part._id, partNumber: part.partNumber, materialItem: it._id, serialNumber: serial, batchNumber: batch, quantity: qty, toLocation: bin._id, toStatus: "LEGACY_UNVERIFIED", user: user.id, userName: user.name, reason: "Opening stock import", referenceType: "Import" });
      });
      res.created++;
    } catch (e) { res.errors.push({ row: i + 2, partNumber: pn, message: e.message }); }
  }
  return res;
}

async function createPo(user, body) {
  const supplier = await M.Supplier.findById(body.supplierId).catch(() => null); if (!supplier) throw invalid("Unknown supplier.");
  if (supplier.active === false) throw invalid("This supplier is inactive.");
  const lines = [], docs = [], warnings = []; const purchasing = require("./purchasing");
  for (const l of body.lines) {
    const p = await M.PartMaster.findOne({ partNumber: s(l.partNumber).toUpperCase() }); if (!p) throw invalid(`Unknown part ${l.partNumber}`); docs.push(p);
    const sp = purchasing.priceFor(p, supplier._id); const unitPrice = l.unitPrice != null ? l.unitPrice : sp ? sp.price : undefined;   // the supplier's own price unless the buyer typed another
    if (sp && sp.moq && l.orderedQty < sp.moq) warnings.push(`${p.partNumber}: ordering ${l.orderedQty}, ${supplier.name}'s minimum order quantity is ${sp.moq}.`);
    if (unitPrice === undefined) warnings.push(`${p.partNumber}: no price for ${supplier.name} - add one under Parts > Suppliers.`);
    lines.push({ part: p._id, partNumber: p.partNumber, orderedQty: l.orderedQty, receivedQty: 0, unitPrice, currency: (sp && sp.currency) || "INR" });
  }
  await purchasing.assertOrderable(supplier, docs);
  return atomic(async (ctx) => {
    const po = await ctx.create(M.PurchaseOrder, { poNo: s(body.poNo).toUpperCase() || (await nextId("po", "PO", 5)), supplier: supplier._id, lines, expectedDate: body.expectedDate ? new Date(body.expectedDate) : undefined, notes: body.notes, createdBy: user.id });
    await audit(ctx, user, { action: "PO_CREATED", entityType: "PurchaseOrder", entityId: po._id, entityLabel: po.poNo, after: { supplier: supplier.name, lines: lines.length } });
    return Object.assign(po.toObject ? po.toObject() : po, { warnings, total: lines.reduce((a, l) => a + (l.unitPrice || 0) * l.orderedQty, 0) });
  });
}
module.exports = { createBomRevision, importParts, importBom, importOpeningStock, createPo };
