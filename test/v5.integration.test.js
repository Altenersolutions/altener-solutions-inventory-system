// Duplicate-receipt protection, supplier prices, Part ID format, BUZZT-style sheet import (draft IDs, status, verified quantities),
// verify-quantities flow, approval gate, cost roll-up, readiness, reorder, vehicle filter.  Needs MongoDB.
process.env.JWT_SECRET = "test-secret-1234567890-abcdef"; process.env.LOGIN_RATE_LIMIT = "1000"; process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest"); const mongoose = require("mongoose");
const db = require("../src/db"); const { createApp } = require("../src/app"); const { seed } = require("../src/scripts/seed"); const M = require("../src/models");

const PW = "ChangeMe#2026"; let app, token, supA, supB; const stamp = Date.now(); let n = 0;
const api = (m, u, b, h = {}) => { let r = request(app)[m](u).set("Authorization", `Bearer ${token}`); for (const [k, v] of Object.entries(h)) r = r.set(k, v); return b ? r.send(b) : r; };
const uid = (p) => `${p}-${stamp % 100000}-${++n}`;
const mkPart = async (partNumber, extra = {}) => { const r = await api("post", "/api/parts", { partName: `Part ${partNumber}`, category: "ELECTRICAL", trackingType: "BATCH", partNumber, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const invoiceFile = async () => {
  const data = Buffer.from("%PDF-1.4\n% idempotency test\n%%EOF\n");
  const upload = await api("post", "/api/files", { name: "invoice.pdf", mime: "application/pdf", purpose: "INVOICE", dataBase64: data.toString("base64") });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  return upload.body.id;
};
const ovr = { reason: "approved by store head", confirm: true };
const recBody = (sup, inv, part, batch, qty = 10) => ({ supplierId: String(sup._id), invoiceNo: inv, lines: [{ partNumber: part, quantity: qty, batchNumber: batch }] });

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_v5_${stamp}`); await seed({ quiet: true }); app = createApp();
  token = (await request(app).post("/login").send({ email: "admin@example.com", password: PW })).body.token;
  supA = await M.Supplier.findOne({ active: { $ne: false } }); supB = await M.Supplier.create({ code: `V5B${stamp % 10000}`, name: "Second Source Ltd" });
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

// ---------------------------------------------------------------- duplicate receipts
test("duplicate receipts: 6 simultaneous identical submissions save exactly ONE receipt and ONE stock record", async () => {
  const pn = uid("RACE"); await mkPart(pn); const inv = uid("INV");
  const rs = await Promise.all(Array.from({ length: 6 }, () => api("post", "/api/receiving", recBody(supA, inv, pn, "B-RACE"))));
  const ok = rs.filter((r) => r.status === 201); assert.equal(ok.length, 1, rs.map((r) => r.status).join(","));
  for (const r of rs.filter((x) => x.status !== 201)) { assert.equal(r.status, 409); assert.equal(r.body.error, "DUPLICATE_INVOICE"); assert.equal(r.body.overridable, true); }
  assert.equal(await M.Receipt.countDocuments({ invoiceNo: inv }), 1); assert.equal(await M.MaterialItem.countDocuments({ partNumber: pn }), 1);
});
test("duplicate receipts: the same invoice from another supplier is fine; an approved override may repeat it (and is recorded)", async () => {
  const pn = uid("DUP"); await mkPart(pn); const inv = uid("INV");
  assert.equal((await api("post", "/api/receiving", recBody(supA, inv, pn, "D1"))).status, 201);
  assert.equal((await api("post", "/api/receiving", recBody(supB, inv, pn, "D2"))).status, 201);
  assert.equal((await api("post", "/api/receiving", recBody(supA, inv, pn, "D3"))).status, 409);
  const over = await api("post", "/api/receiving", { ...recBody(supA, inv, pn, "D4"), override: ovr }); assert.equal(over.status, 201, JSON.stringify(over.body));
  assert.equal(await M.Receipt.countDocuments({ invoiceNo: inv }), 3);
});
test("idempotency key: a repeated submit returns the first answer and does the work once; a failed attempt can be retried with the same key", async () => {
  const pn = uid("IDEM"); await mkPart(pn); const inv = uid("INV"); const key = `key-${stamp}-${n}`;
  const firstBody = { ...recBody(supA, inv, pn, "I1"), invoiceFileId: await invoiceFile() };
  const first = await api("post", "/api/receiving", firstBody, { "Idempotency-Key": key }); assert.equal(first.status, 201);
  const again = await api("post", "/api/receiving", firstBody, { "Idempotency-Key": key });
  assert.equal(again.status, 201); assert.equal(again.headers["idempotent-replay"], "true"); assert.equal(again.body.receiptNo, first.body.receiptNo);
  assert.equal(await M.Receipt.countDocuments({ invoiceNo: inv }), 1);
  // a 409 is not remembered: same key + override works
  const inv2 = uid("INV"); await api("post", "/api/receiving", recBody(supA, inv2, pn, "I2")); const key2 = `key2-${stamp}-${n}`;
  const blockedBody = { ...recBody(supA, inv2, pn, "I3"), invoiceFileId: await invoiceFile() };
  const blocked = await api("post", "/api/receiving", blockedBody, { "Idempotency-Key": key2 }); assert.equal(blocked.status, 409);
  assert.equal(await M.IdempotencyKey.countDocuments({ key: new RegExp(`${key2}$`) }), 0, "failed responses must release their idempotency key");
  const retry = await api("post", "/api/receiving", { ...blockedBody, override: ovr }, { "Idempotency-Key": key2 }); assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal((await api("post", "/api/receiving", recBody(supA, uid("INV"), pn, "I9"), { "Idempotency-Key": "bad key!" })).status, 400);
});
test("simultaneous receipts against one PO never exceed it", async () => {
  const pn = uid("POR"); await mkPart(pn); const po = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 10 }] })).body;
  const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => api("post", "/api/receiving", { ...recBody(supA, uid("INV"), pn, `P${i}`, 10), poNumber: po.poNo })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.equal((await M.PurchaseOrder.findOne({ poNo: po.poNo })).lines[0].receivedQty, 10);
});

// ---------------------------------------------------------------- supplier prices
test("supplier-specific prices: separate price per approved supplier, validity dates, PO fills the right price, MOQ warning", async () => {
  const pn = uid("PRC"); const part = await mkPart(pn);
  const set = await api("put", `/api/parts/${part._id}/suppliers`, { suppliers: [
    { supplierId: String(supA._id), preferred: true, price: 120.5, moq: 10, leadTimeDays: 7 },
    { supplierId: String(supB._id), price: 99, currency: "inr", priceValidTo: "2000-01-01" }] });                      // B's price expired long ago
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.find((x) => String(x.supplier._id) === String(supA._id)).price, 120.5);
  assert.equal((await api("put", `/api/parts/${part._id}/suppliers`, { suppliers: [{ supplierId: String(supA._id), price: -1 }] })).status, 400);
  const poA = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 5 }] })).body;
  assert.equal(poA.lines[0].unitPrice, 120.5); assert.equal(poA.total, 602.5); assert.ok(poA.warnings.some((w) => /minimum order quantity is 10/.test(w)));
  const poB = (await api("post", "/api/purchase-orders", { supplierId: String(supB._id), lines: [{ partNumber: pn, orderedQty: 5 }] })).body;
  assert.equal(poB.lines[0].unitPrice, undefined); assert.ok(poB.warnings.some((w) => /no price for/.test(w)));                     // expired price is not used
  const poC = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 12, unitPrice: 111 }] })).body; assert.equal(poC.lines[0].unitPrice, 111); assert.equal(poC.warnings.length, 0);
  const aud = await M.AuditLog.findOne({ action: "PART_SUPPLIERS_SET", entityLabel: pn }); assert.ok(aud && aud.after.prices.length === 2);
});
test("supplier prices: CSV import + export", async () => {
  const pn = uid("PCSV"); await mkPart(pn);
  const csv = `partNumber,supplierCode,preferred,price,currency,moq,validFrom,validTo\n${pn},${supA.code},y,55.25,INR,5,2026-01-01,2099-12-31\n${pn},${supB.code},,60,INR,,,\n${pn},${supB.code},,abc,INR,,,\n`;
  const dry = (await api("post", "/api/import/approved-suppliers", { csv, dryRun: true })).body; assert.equal(dry.errors.length, 1); assert.match(dry.errors[0].message, /price must be a number/);
  assert.equal((await api("post", "/api/import/approved-suppliers", { csv: csv.split("\n").slice(0, 3).join("\n") + "\n" })).body.updated, 1);
  const p = await M.PartMaster.findOne({ partNumber: pn }); assert.equal(p.approvedSuppliers.find((a) => String(a.supplier) === String(supA._id)).price, 55.25); assert.equal(p.approvedSuppliers.length, 2);
  const ex = (await api("get", "/api/export/supplierPrices")).text; assert.match(ex, /partNumber,partName,supplierCode/); assert.ok(ex.includes(pn) && ex.includes("55.25"));
});

// ---------------------------------------------------------------- Part ID format
test("Part ID format: an incomplete numeric ID is refused with the reason; a complete 12-digit ID and letter IDs are accepted", async () => {
  const bad = await api("post", "/api/parts", { partName: "Draft", category: "ELECTRICAL", trackingType: "BATCH", partNumber: "901016037" }); assert.equal(bad.status, 400); assert.match(bad.body.message, /12 digits/);
  assert.equal((await mkPart("901016037".padEnd(9, "0") + "123")).partNumber, "901016037123");
  assert.equal((await mkPart(uid("AE-OK"))).trackingType, "BATCH");
});

// ---------------------------------------------------------------- BUZZT-style sheet
const HDR = ["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "QTY", "Status", "MP-Main Part", " RESOURCE", "SUPPLIER", "UNIT COST", "PART ID"];
const HDR2 = ["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "QTY", "Status", "CP- Child Part", " RESOURCE", "SUPPLIER", "UNIT COST", "PART ID"];
const sheetRows = (frame, bracket) => [["FINAL REVISION- BOM OF MECHANICAL (PREMIUM MODEL)"], HDR, HDR2,
  [1, "", "Chassis Assy", "Chassis Assy"],
  ["", 1, "A", "Frame", "", 1, "Finalized", "MP", "Proprietary", "Acme Metals Co", 500, frame],
  ["", 2, "B", "Bracket", "", 2, "Review", "CP", "Local", "Local", "", bracket],
  ["", 3, "C", "Bolt", "M8", "", "Finalized", "ASP", "Local", "Local", "", "000000"],
  ["", 4, "D", "Nut", "M8", 4, "Finalized", "ASP", "Local", "Local", 2, "901000000"],
  [2, "", "Door", "Door"], ["", 2.1, "", "Door Hinges"],
  ["", 1, "A", "Bolt", "M8", 6, "Finalized", "ASP", "Local", "Local", "", "000000"],
  ["", 2, "B", "Hinge", "", 2, "Finalized", "MP", "Proprietary", "87.5", "", "901002021"]];
const importBuzz = (model, rows, extra = {}) => api("post", "/api/import/bom-excel", { model, revision: "REV-A", changeReason: "test", rows, ...extra });

test("BUZZT-style sheet: dry run explains IDs, verification and suppliers; real IDs only for complete ones; drafts kept as a note", async () => {
  const model = "BUZZT"; const rows = sheetRows("901001243001", "901003023");
  const dry = (await importBuzz(model, rows, { dryRun: true })).body;
  assert.deepEqual([dry.ids.real, dry.ids.proposedOnly, dry.ids.placeholder], [1, 2, 3 - 0 - 0 + 0 === 3 ? 2 : 2]);   // Frame real; Bracket + Hinge drafts; Bolt (merged) + Nut placeholders
  assert.equal(dry.bomLines, 5); assert.equal(dry.verification.unverifiedLines, 2);                                  // Bracket (Review) + Bolt (qty blank on one row)
  assert.equal(dry.suppliers.mode, "LINK"); assert.deepEqual(dry.suppliers.unknown, ["Acme Metals Co"]); assert.ok(dry.warnings.some((w) => /"87.5" is a number/.test(w)));
  assert.equal(await M.PartMaster.countDocuments({ partNumber: "901001243001" }), 0);                                // dry run wrote nothing
  const real = await importBuzz(model, rows, { supplierMode: "CREATE" }); assert.equal(real.status, 201, JSON.stringify(real.body)); assert.equal(real.body.suppliers.created, 1);
  const parts = await M.PartMaster.find({ partName: { $in: ["Frame", "Bracket", "Bolt", "Nut", "Hinge"] } }).lean(); const by = Object.fromEntries(parts.map((p) => [p.partName, p]));
  assert.equal(by.Frame.partNumber, "901001243001"); assert.equal(by.Frame.provisional, false); assert.equal(by.Frame.approvedSuppliers[0].price, 500); 
  assert.match(by.Bracket.partNumber, /^TMP-/); assert.equal(by.Bracket.proposedPartId, "901003023"); assert.equal(by.Bracket.sourcing, "LOCAL");
  assert.match(by.Bolt.partNumber, /^TMP-/); assert.equal(by.Bolt.proposedPartId, undefined);
  const rev = (await api("get", "/api/bom/BUZZT/revisions")).body[0]; const item = (pn) => rev.items.find((i) => i.partNumber === pn);
  assert.equal(item(by.Bolt.partNumber).requiredQuantity, 7); assert.equal(item(by.Bolt.partNumber).qtyVerified, false); assert.equal(item(by.Bracket.partNumber).designStatus, "REVIEW"); assert.equal(item("901001243001").qtyVerified, true);
  assert.equal(item(by.Hinge.partNumber).installationPosition, "Door > Door Hinges");
  const pb = uid("VF-B"), pl = uid("VF-L"); await mkPart(pb, { vehicleCompatibility: ["BUZZ"] }); await mkPart(pl, { vehicleCompatibility: ["LITE"] });           // focus on one vehicle
  const vf = (await api("get", "/api/parts?vehicle=BUZZ")).body; assert.ok(vf.some((p) => p.partNumber === pb)); assert.ok(!vf.some((p) => p.partNumber === pl)); assert.ok(vf.every((p) => p.vehicleCompatibility.includes("BUZZ")));
});
test("verify quantities: report, approval is blocked until verified (or approved with a recorded reason), bulk verify by CSV", async () => {
  const v = (await api("get", "/api/bom/BUZZT/verification")).body; assert.equal(v.unverified, 2); assert.equal(v.total, 5); assert.equal(v.percentVerified, 60); assert.equal(v.lines.length, 2);
  const blocked = await api("post", "/api/bom/BUZZT/revisions/REV-A/approve"); assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "UNVERIFIED_QUANTITIES"); assert.equal(blocked.body.overridable, true);
  const csv = v.lines.map((l) => `${l.partNumber},${l.partName === "Bolt" ? 8 : l.quantity},yes`).join("\n");
  const dry = (await api("post", "/api/import/bom-quantities", { model: "BUZZT", revision: "REV-A", csv: `partNumber,quantity,verified\n${csv}\nNOPE-1,1,yes\n`, dryRun: true })).body; assert.equal(dry.updated, 2); assert.equal(dry.errors.length, 1); assert.equal(dry.quantityChanged, 1);
  assert.equal((await api("get", "/api/bom/BUZZT/verification")).body.unverified, 2);                                    // dry run changed nothing
  const real = (await api("post", "/api/import/bom-quantities", { model: "BUZZT", revision: "REV-A", csv: `partNumber,quantity,verified\n${csv}\n` })).body; assert.equal(real.verified, 2);
  const v2 = (await api("get", "/api/bom/BUZZT/verification")).body; assert.equal(v2.unverified, 0); assert.equal(v2.percentVerified, 100);
  assert.equal((await api("post", "/api/bom/BUZZT/revisions/REV-A/approve")).status, 200);
  assert.equal((await api("post", "/api/import/bom-quantities", { model: "BUZZT", revision: "REV-A", csv: "partNumber,quantity\nX,1\n" })).status, 409);   // approved revisions are immutable
});
test("approve with unverified quantities + written reason is allowed and recorded", async () => {
  const model = "BUZZT2"; assert.equal((await importBuzz(model, sheetRows("901001243001", "901003023"))).status, 201);
  const ok = await api("post", `/api/bom/${model}/revisions/REV-A/approve`, { override: ovr }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(await M.OverrideRecord.findOne({ kind: "UNVERIFIED_BOM" }));
});
test("re-import after IDs are completed: temporary parts get their real number (no duplicate parts), BOM lines follow", async () => {
  const before = await M.PartMaster.countDocuments({}); const bracket = await M.PartMaster.findOne({ partName: "Bracket", provisional: true }); assert.ok(bracket);
  const rows = sheetRows("901001243001", "901003023999");                                                              // Bracket's ID is now complete (12 digits)
  const dry = (await api("post", "/api/import/bom-excel", { model: "BUZZT", revision: "REV-B", changeReason: "ids completed", rows, dryRun: true })).body; assert.equal(dry.ids.adoptTemporary, 1);
  assert.equal((await api("post", "/api/import/bom-excel", { model: "BUZZT", revision: "REV-B", changeReason: "ids completed", rows })).status, 201);
  const after = await M.PartMaster.findById(bracket._id); assert.equal(after.partNumber, "901003023999"); assert.equal(after.provisional, false); assert.equal(after.proposedPartId, null);
  assert.equal(await M.PartMaster.countDocuments({}), before);                                                         // nothing duplicated
  const revs = (await api("get", "/api/bom/BUZZT/revisions")).body; assert.ok(revs.every((r) => !r.items.some((i) => i.part && String(i.part._id) === String(bracket._id)) || r.items.find((i) => String(i.part._id) === String(bracket._id)).partNumber === "901003023999"));
});

// ---------------------------------------------------------------- cost, readiness, reorder
test("cost roll-up: preferred supplier price, falls back to part unit cost, reports coverage and missing prices", async () => {
  const a = uid("CA"), b = uid("CB"), c = uid("CC"); const pa = await mkPart(a), pb = await mkPart(b); await mkPart(c);
  await api("put", `/api/parts/${pa._id}/suppliers`, { suppliers: [{ supplierId: String(supA._id), preferred: true, price: 10 }, { supplierId: String(supB._id), price: 7 }] });
  await M.PartMaster.updateOne({ _id: pb._id }, { unitCost: 4 });
  const model = uid("COSTM").replace(/-/g, ""); await api("post", "/api/bom", { vehicleModel: model });
  await api("post", `/api/bom/${model}/revisions`, { revision: "REV-A", changeReason: "t", items: [{ partNumber: a, requiredQuantity: 3, installationPosition: "Frame" }, { partNumber: b, requiredQuantity: 5, installationPosition: "Frame" }, { partNumber: c, requiredQuantity: 2, installationPosition: "Cabin" }] });
  const cost = (await api("get", `/api/bom/${model}/cost?revision=REV-A&qty=2`)).body; assert.equal(cost.total, 100); assert.equal(cost.perVehicle, 50);   // (3*10 + 5*4) * 2
  assert.deepEqual(cost.coverage, { lines: 3, priced: 2, missing: 1, percent: 66.7 }); assert.equal(cost.missingPrices[0].partNumber, c); assert.equal(cost.byGroup[0].group, "Frame"); assert.match(cost.lines.find((l) => l.partNumber === a).source, /SUPPLIER/);
  assert.equal((await api("get", `/api/bom/${model}/cost?revision=REV-A&strategy=lowest`)).body.lines.find((l) => l.partNumber === a).unitPrice, 7);
});
test("planning readiness per group, and reorder suggestions with supplier price and MOQ", async () => {
  const a = uid("RDA"), b = uid("RDB"); const pa = await mkPart(a, { minStock: 20 }); await mkPart(b);
  await api("put", `/api/parts/${pa._id}/suppliers`, { suppliers: [{ supplierId: String(supA._id), preferred: true, price: 5, moq: 50, leadTimeDays: 9 }] });
  const model = uid("RDM").replace(/-/g, ""); await api("post", "/api/bom", { vehicleModel: model });
  await api("post", `/api/bom/${model}/revisions`, { revision: "REV-A", changeReason: "t", items: [{ partNumber: a, requiredQuantity: 2, installationPosition: "Frame" }, { partNumber: b, requiredQuantity: 1, installationPosition: "Cabin" }] }); await api("post", `/api/bom/${model}/revisions/REV-A/approve`);
  const r = await api("post", `/api/receiving`, recBody(supA, uid("INV"), a, "RD1", 30)); const it = r.body.items[0];
  await api("post", `/api/receiving/${r.body.receiptId}/qc`, { materialItemId: it.id, result: "PASS" }); const bin = await M.Location.findOne({ type: "BIN" });
  assert.equal((await api("post", `/api/materials/${it.id}/put-away`, { scannedLocation: bin.locationCode })).status, 200);
  const plan = (await api("post", "/api/planning/requirements", { model, quantity: 5 })).body;
  assert.equal(plan.readiness.groups.length, 2); const g = Object.fromEntries(plan.readiness.groups.map((x) => [x.group, x])); assert.equal(g.Frame.percent, 100); assert.equal(g.Cabin.percent, 0); assert.equal(plan.readiness.linePercent, 50); assert.equal(plan.readiness.qtyPercent, 66.7);
  const ro = (await api("get", "/api/planning/reorder")).body; assert.equal(ro.lines.find((l) => l.partNumber === b), undefined);       // minStock 0 -> never suggested
  const mine = ro.lines.find((l) => l.partNumber === a); assert.equal(mine, undefined);                                                // 30 on hand >= minStock 20
  await mkPart(uid("RO"), { minStock: 100 }); const ro2 = (await api("get", "/api/planning/reorder")).body; assert.ok(ro2.lines.some((l) => l.suggestedQty === 100 && l.unitPrice === null));
  await api("put", `/api/parts/${pa._id}`, { minStock: 100 }); const ro3 = (await api("get", "/api/planning/reorder")).body.lines.find((l) => l.partNumber === a);
  assert.equal(ro3.usable, 30); assert.equal(ro3.suggestedQty, 70 < 50 ? 50 : 70); assert.equal(ro3.supplier.length > 0, true); assert.equal(ro3.estimatedCost, 350); assert.equal(ro3.leadTimeDays, 9);
});
