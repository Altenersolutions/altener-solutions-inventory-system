// Purchasing rules, approved suppliers, multi-level BOM + variants, planning, stock accuracy check, permissions.
// Needs MongoDB (same as the other end-to-end tests).
process.env.JWT_SECRET = "test-secret-1234567890-abcdef"; process.env.LOGIN_RATE_LIMIT = "1000"; process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const db = require("../src/db"); const config = require("../src/config");
const { createApp } = require("../src/app"); const { seed } = require("../src/scripts/seed"); const M = require("../src/models");
const { stockReconciliation } = require("../src/domain/reconcile");

const PW = "ChangeMe#2026"; let app, token, supA, supB; const stamp = Date.now(); let n = 0;
const api = (m, u, b) => { const r = request(app)[m](u).set("Authorization", `Bearer ${token}`); return b ? r.send(b) : r; };
const uid = (p) => `${p}-${stamp % 100000}-${++n}`;
const mkPart = async (partNumber, extra = {}) => { const r = await api("post", "/api/parts", { partName: `Part ${partNumber}`, category: "ELECTRICAL", trackingType: "BATCH", partNumber, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const receive = (sup, body) => api("post", "/api/receiving", { supplierId: String(sup._id), invoiceNo: uid("INV"), ...body });
const ovr = { reason: "approved by store head", confirm: true };

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_v4_${stamp}`); await seed({ quiet: true }); app = createApp();
  token = (await request(app).post("/login").send({ email: "admin@example.com", password: PW })).body.token;
  supA = await M.Supplier.findOne({ active: { $ne: false } }); supB = await M.Supplier.create({ code: `SUPB${stamp % 10000}`, name: "Second Supplier Pvt Ltd" });
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

// ---------------------------------------------------------------- purchase orders
test("PO: over-receipt is checked on the TOTAL of the receipt (6 + 6 on a PO of 10 is refused)", async () => {
  const pn = uid("PO-P"); await mkPart(pn);
  const po = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 10 }] })).body;
  const bad = await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 6, batchNumber: "B1" }, { partNumber: pn, quantity: 6, batchNumber: "B2" }] });
  assert.equal(bad.status, 409, JSON.stringify(bad.body)); assert.equal(bad.body.error, "PO_MISMATCH");
  assert.equal((await M.PurchaseOrder.findOne({ poNo: po.poNo })).lines[0].receivedQty, 0);               // nothing was booked
  const okOverride = await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 12, batchNumber: "B3" }], override: ovr });
  assert.equal(okOverride.status, 201, JSON.stringify(okOverride.body));
  assert.ok(await M.OverrideRecord.findOne({ kind: "PO_MISMATCH" }));                                    // the override is on record
});
test("PO: partial deliveries -> PARTIAL, then CLOSED; closed PO takes no more material", async () => {
  const pn = uid("PO-Q"); await mkPart(pn); const po = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 10 }] })).body;
  assert.equal((await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 4, batchNumber: "P1" }] })).status, 201);
  assert.equal((await M.PurchaseOrder.findOne({ poNo: po.poNo })).status, "PARTIAL");
  assert.equal((await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 6, batchNumber: "P2" }] })).status, 201);
  assert.equal((await M.PurchaseOrder.findOne({ poNo: po.poNo })).status, "CLOSED");
  assert.equal((await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 1, batchNumber: "P3" }] })).body.error, "PO_CLOSED");
});
test("PO: tolerance percentage allows a small over-receipt", async () => {
  const pn = uid("PO-T"); await mkPart(pn); const po = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 100 }] })).body;
  config.poOverTolerancePct = 5;
  try { assert.equal((await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 105, batchNumber: "T1" }] })).status, 201); }
  finally { config.poOverTolerancePct = 0; }
  const po2 = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 100 }] })).body;
  assert.equal((await receive(supA, { poNumber: po2.poNo, lines: [{ partNumber: pn, quantity: 105, batchNumber: "T2" }] })).body.error, "PO_MISMATCH");
});
test("receiving: same supplier + invoice twice is refused (override with reason allowed); different supplier is fine", async () => {
  const pn = uid("INVP"); await mkPart(pn); const inv = uid("DUP");
  assert.equal((await receive(supA, { invoiceNo: inv, lines: [{ partNumber: pn, quantity: 1, batchNumber: "D1" }] })).status, 201);
  const again = await receive(supA, { invoiceNo: inv.toLowerCase(), lines: [{ partNumber: pn, quantity: 1, batchNumber: "D2" }] });
  assert.equal(again.status, 409); assert.equal(again.body.error, "DUPLICATE_INVOICE");
  assert.equal((await receive(supB, { invoiceNo: inv, lines: [{ partNumber: pn, quantity: 1, batchNumber: "D3" }] })).status, 201);
  assert.equal((await receive(supA, { invoiceNo: inv, lines: [{ partNumber: pn, quantity: 1, batchNumber: "D4" }], override: ovr })).status, 201);
});
test("receiving: 'PO required' switch", async () => {
  const pn = uid("NOPO"); await mkPart(pn); config.requirePoForReceipt = true;
  try {
    const r = await receive(supA, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "N1" }] }); assert.equal(r.status, 409); assert.equal(r.body.error, "PO_REQUIRED");
    assert.equal((await receive(supA, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "N2" }], override: ovr })).status, 201);
  } finally { config.requirePoForReceipt = false; }
  assert.equal((await receive(supA, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "N3" }] })).status, 201);
});
test("PO: close short (needs a reason and received material), cancel blocked after receipts, GRN prints with a Code 128", async () => {
  const pn = uid("PO-S"); await mkPart(pn); const po = (await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 10 }] })).body;
  assert.equal((await api("post", `/api/purchase-orders/${po._id}/close-short`, { reason: "supplier cannot deliver the rest" })).body.error, "NOTHING_RECEIVED");
  const rc = await receive(supA, { poNumber: po.poNo, lines: [{ partNumber: pn, quantity: 4, batchNumber: "S1" }] }); assert.equal(rc.status, 201);
  assert.equal((await api("post", `/api/purchase-orders/${po._id}/cancel`)).body.error, "PO_HAS_RECEIPTS");
  assert.equal((await api("post", `/api/purchase-orders/${po._id}/close-short`, { reason: "abc" })).status, 400);
  const cs = await api("post", `/api/purchase-orders/${po._id}/close-short`, { reason: "supplier cannot deliver the rest" }); assert.equal(cs.status, 200, JSON.stringify(cs.body)); assert.equal(cs.body.outstanding[0].outstanding, 6);
  const after = await M.PurchaseOrder.findOne({ poNo: po.poNo }); assert.equal(after.status, "CLOSED"); assert.equal(after.closedShort, true);
  const grn = await api("get", `/api/receipts/${rc.body.receiptId}/print`); assert.equal(grn.status, 200); assert.match(grn.headers["content-type"], /html/);
  assert.ok(grn.text.includes(rc.body.receiptNo || "GRN") && grn.text.includes("<svg") && grn.text.includes("Goods Received Note"));
});

// ---------------------------------------------------------------- approved suppliers
test("approved suppliers: list per part, preferred one kept, receiving and POs enforce it", async () => {
  const pn = uid("SUPP"); const part = await mkPart(pn);
  const set = await api("put", `/api/parts/${part._id}/suppliers`, { suppliers: [{ supplierId: String(supA._id), supplierPartNo: "A-123", leadTimeDays: 14 }, { supplierId: String(supB._id), preferred: true }] });
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.length, 2);
  const fresh = await M.PartMaster.findById(part._id); assert.equal(String(fresh.supplier), String(supB._id));            // preferred = main supplier
  assert.equal((await api("put", `/api/parts/${part._id}/suppliers`, { suppliers: [{ supplierId: String(supA._id) }, { supplierId: String(supA._id) }] })).status, 400); // twice
  const sup3 = await M.Supplier.create({ code: `SUPC${stamp % 10000}`, name: "Unapproved Co" });
  const bad = await receive(sup3, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "U1" }] }); assert.equal(bad.status, 409); assert.equal(bad.body.error, "SUPPLIER_NOT_APPROVED");
  assert.equal((await receive(supB, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "U2" }] })).status, 201);
  assert.equal((await receive(sup3, { lines: [{ partNumber: pn, quantity: 1, batchNumber: "U3" }], override: ovr })).status, 201);
  const poBad = await api("post", "/api/purchase-orders", { supplierId: String(sup3._id), lines: [{ partNumber: pn, orderedQty: 5 }] }); assert.equal(poBad.status, 400); assert.equal(poBad.body.error, "SUPPLIER_NOT_APPROVED");
  assert.equal((await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: pn, orderedQty: 5 }] })).status, 201);
  const free = uid("FREE"); await mkPart(free); assert.equal((await receive(sup3, { lines: [{ partNumber: free, quantity: 1, batchNumber: "F1" }] })).status, 201); // no list = no restriction
  const listed = (await api("get", "/api/parts")).body.find((p) => p.partNumber === pn); assert.equal(listed.approvedSuppliers.length, 2); assert.ok(listed.approvedSuppliers[0].supplier.name);
});
test("approved suppliers: CSV bulk import (dry run, real) and parts CSV column", async () => {
  const a = uid("BULKA"), b = uid("BULKB"); await mkPart(a); await mkPart(b);
  const csv = `partNumber,supplierCode,preferred,supplierPartNo,leadTimeDays\n${a},${supA.code},y,X-1,7\n${a},${supB.code},,,\n${b},${supB.code},y,,\n${b},NOPE,,,\n`;
  const dry = (await api("post", "/api/import/approved-suppliers", { csv, dryRun: true })).body; assert.equal(dry.updated, 2); assert.equal(dry.errors.length, 1);
  assert.equal((await M.PartMaster.findOne({ partNumber: a })).approvedSuppliers.length, 0);
  assert.equal((await api("post", "/api/import/approved-suppliers", { csv })).body.updated, 2);
  const pa = await M.PartMaster.findOne({ partNumber: a }); assert.equal(pa.approvedSuppliers.length, 2); assert.equal(String(pa.supplier), String(supA._id));
  const np = uid("CSVP"); const r = (await api("post", "/api/import/parts", { csv: `partNumber,partName,approvedSuppliers\n${np},CSV part,${supB.code};${supA.code}\n` })).body; assert.equal(r.created, 1, JSON.stringify(r));
  assert.equal(String((await M.PartMaster.findOne({ partNumber: np })).supplier), String(supB._id));
});

// ---------------------------------------------------------------- multi-level BOM, variants
const bomRev = (model, items, rev = "REV-A") => api("post", `/api/bom/${model}/revisions`, { revision: rev, changeReason: "test", items });
const approveRev = (model, rev = "REV-A") => api("post", `/api/bom/${model}/revisions/${rev}/approve`);
test("multi-level BOM: sub-assembly explodes into components, variants filter lines, loops are refused", async () => {
  const P = { asm: uid("ASM"), c1: uid("C1"), c2: uid("C2"), c3: uid("C3"), vs: uid("VSTD"), vl: uid("VLR"), asm2: uid("ASM2") };
  for (const k of Object.keys(P)) await mkPart(P[k], k.startsWith("asm") ? { category: "MECHANICAL" } : {});
  assert.equal((await api("post", "/api/bom", { assemblyPartNumber: P.asm })).status, 201);
  assert.equal((await M.PartMaster.findOne({ partNumber: P.asm })).isAssembly, true);
  assert.equal((await bomRev(P.asm, [{ partNumber: P.c1, requiredQuantity: 2 }, { partNumber: P.c2, requiredQuantity: 1 }])).status, 201);
  // a vehicle BOM that uses a sub-assembly whose BOM is not approved yet cannot be approved
  const model = uid("TV").replace(/-/g, ""); assert.equal((await api("post", "/api/bom", { vehicleModel: model, variants: ["std", "lr"] })).status, 201);
  const items = [{ partNumber: P.asm, requiredQuantity: 1 }, { partNumber: P.c3, requiredQuantity: 4 }, { partNumber: P.vs, requiredQuantity: 1, variants: ["STD"] }, { partNumber: P.vl, requiredQuantity: 1, variants: ["LR"] }];
  assert.equal((await bomRev(model, items)).status, 201);
  const early = await approveRev(model); assert.equal(early.status, 400); assert.equal(early.body.error, "ASSEMBLY_NO_BOM");
  assert.equal((await approveRev(P.asm)).status, 200); assert.equal((await approveRev(model)).status, 200);
  // the vehicle revision pinned the assembly's revision
  const stored = (await api("get", `/api/bom/${model}/revisions`)).body[0]; assert.equal(stored.items.find((i) => i.partNumber === P.asm).requiredRevision, "REV-A");
  const ex = (await api("get", `/api/bom/${model}/explode?variant=STD&qty=2`)).body; const q = Object.fromEntries(ex.components.map((c) => [c.partNumber, c.quantity]));
  assert.deepEqual(q, { [P.c1]: 4, [P.c2]: 2, [P.c3]: 8, [P.vs]: 2 });                                      // x2 vehicles, LR line absent
  assert.equal(ex.rows.filter((r) => r.isAssembly).length, 1); assert.equal(ex.rows.find((r) => r.partNumber === P.c1).level, 1);
  assert.deepEqual(Object.keys(Object.fromEntries((await api("get", `/api/bom/${model}/explode?variant=LR`)).body.components.map((c) => [c.partNumber, 1]))).sort(), [P.c1, P.c2, P.c3, P.vl].sort());
  assert.equal((await api("get", `/api/bom/${model}/explode?variant=XX`)).status, 400);
  // vehicles: variant is mandatory, and the vehicle's progress lists the exploded components
  assert.equal((await api("post", "/api/vehicles", { vehicleNumber: uid("V"), model, vehicleType: "BUZZ" })).body.error, "VARIANT_REQUIRED");
  const veh = await api("post", "/api/vehicles", { vehicleNumber: uid("V"), model, vehicleType: "BUZZ", variant: "std" }); assert.equal(veh.status, 201, JSON.stringify(veh.body));
  const view = (await api("get", `/api/vehicles/${veh.body._id || veh.body.id}`)).body; const need = Object.fromEntries(view.items.map((i) => [i.partNumber, i.required]));
  assert.deepEqual(need, { [P.c1]: 2, [P.c2]: 1, [P.c3]: 4, [P.vs]: 1 });
  assert.equal((await api("post", "/api/vehicles", { vehicleNumber: uid("V"), model: P.asm, vehicleType: "BUZZ" })).body.error, "NOT_A_VEHICLE");
  // where used
  const wu = (await api("get", `/api/parts/${(await M.PartMaster.findOne({ partNumber: P.c1 }))._id}/where-used`)).body; assert.ok(wu.some((x) => x.model === P.asm));
  // loops: asm2 contains asm, then asm tries to contain asm2 -> refused; a part cannot contain itself
  assert.equal((await api("post", "/api/bom", { assemblyPartNumber: P.asm2 })).status, 201);
  assert.equal((await bomRev(P.asm2, [{ partNumber: P.asm, requiredQuantity: 1 }])).status, 201);
  const loop = await bomRev(P.asm, [{ partNumber: P.asm2, requiredQuantity: 1 }], "REV-B"); assert.equal(loop.status, 400); assert.equal(loop.body.error, "BOM_CYCLE");
  assert.equal((await bomRev(P.asm, [{ partNumber: P.asm, requiredQuantity: 1 }], "REV-C")).body.error, "BOM_CYCLE");
  // variants cannot be removed while a line uses them
  assert.equal((await api("put", `/api/bom/${model}`, { variants: ["STD"] })).body.error, "VARIANT_IN_USE");
});
test("BOM Excel import: VARIANT column declares variants; a model equal to an existing part number becomes a sub-assembly BOM", async () => {
  const c1 = uid("XC"), c2 = uid("XD"), asm = uid("XASM"); for (const p of [c1, c2]) await mkPart(p); await mkPart(asm, { category: "MECHANICAL" });
  const rows = [["PART NO", "DESCRIPTION", "QTY", "VARIANT"], [c1, "Common bolt", 4, ""], [c2, "Only long range", 1, "LR; XL"]];
  const dry = (await api("post", "/api/import/bom-excel", { model: asm, revision: "REV-A", changeReason: "t", rows, dryRun: true })).body; assert.equal(dry.subAssembly, true); assert.deepEqual(dry.variantsFound.sort(), ["LR", "XL"]);
  const model = uid("XV").replace(/-/g, ""); assert.equal((await api("post", "/api/import/bom-excel", { model, revision: "REV-A", changeReason: "t", rows })).status, 201);
  assert.deepEqual((await M.BOM.findOne({ vehicleModel: model })).variants.sort(), ["LR", "XL"]);
  assert.equal((await api("post", "/api/import/bom-excel", { model: asm, revision: "REV-A", changeReason: "t", rows: [["PART NO", "DESCRIPTION", "QTY"], [c1, "Common bolt", 4]] })).status, 201);
  const b = await M.BOM.findOne({ vehicleModel: asm }); assert.ok(b.assemblyPart); assert.equal((await M.PartMaster.findOne({ partNumber: asm })).isAssembly, true);
});

// ---------------------------------------------------------------- planning
test("production planning: requirements x quantity, usable vs QC-pending vs on order, shortage, pick list by rack", async () => {
  const a = uid("PLA"), b = uid("PLB"), c = uid("PLC"); for (const p of [a, b, c]) await mkPart(p);
  const model = uid("PM").replace(/-/g, ""); await api("post", "/api/bom", { vehicleModel: model });
  assert.equal((await bomRev(model, [{ partNumber: a, requiredQuantity: 2 }, { partNumber: b, requiredQuantity: 3 }, { partNumber: c, requiredQuantity: 1, optional: true }])).status, 201); await approveRev(model);
  // A: 30 approved + put away in two racks; B: 4 received, still waiting for QC + 5 on order
  for (const [batch, qty, rack] of [["PA1", 6, "RACK-B / BIN-2"], ["PA2", 4, "RACK-A / BIN-1"]]) {
    await api("put", `/api/parts/${(await M.PartMaster.findOne({ partNumber: a }))._id}`, { rackLocation: rack });
    const r = await receive(supA, { lines: [{ partNumber: a, quantity: qty, batchNumber: batch }] }); const it = r.body.items[0];
    assert.equal((await api("post", `/api/receiving/${r.body.receiptId}/qc`, { materialItemId: it.id, result: "PASS" })).status, 200);
    const loc = (await M.Location.findOne({ locationCode: rack.replace(" / ", "/") })).locationCode; const pa = await api("post", `/api/materials/${it.id}/put-away`, { scannedLocation: loc }); assert.equal(pa.status, 200, JSON.stringify(pa.body));
  }
  await receive(supA, { lines: [{ partNumber: b, quantity: 4, batchNumber: "PB1" }] });
  await api("post", "/api/purchase-orders", { supplierId: String(supA._id), lines: [{ partNumber: b, orderedQty: 5 }] });
  const plan = (await api("post", "/api/planning/requirements", { model, quantity: 5 })).body;
  const L = Object.fromEntries(plan.lines.map((l) => [l.partNumber, l]));
  assert.equal(L[a].required, 10); assert.equal(L[a].usable, 10); assert.equal(L[a].status, "OK");
  assert.equal(L[b].required, 15); assert.equal(L[b].usable, 0); assert.equal(L[b].awaitingQc, 4); assert.equal(L[b].onOrder, 5); assert.equal(L[b].shortage, 15); assert.equal(L[b].shortageAfterIncoming, 6); assert.equal(L[b].status, "SHORT");
  assert.equal(L[c], undefined); assert.equal(plan.optionalSkipped, 1); assert.equal(plan.summary.canBuild, false);
  const picks = plan.pickList.filter((p) => p.partNumber === a); assert.deepEqual(picks.map((p) => p.rack), ["RACK-A / BIN-1", "RACK-B / BIN-2"]); assert.equal(picks.reduce((t, p) => t + p.qty, 0), 10); // sorted by rack
  assert.ok(plan.pickList.some((p) => p.partNumber === b && p.rack === "SHORT"));
  assert.equal((await api("post", "/api/planning/requirements", { model, quantity: 1, includeOptional: true })).body.lines.length, 3);
  assert.equal((await api("post", "/api/planning/requirements", { model: "NOPE", quantity: 1 })).status, 404);
});

// ---------------------------------------------------------------- stock accuracy
test("stock accuracy check: clean after real movements, flags a balance changed behind the ledger's back", async () => {
  const before = await stockReconciliation(); assert.equal(before.mismatches, 0, JSON.stringify(before.rows.slice(0, 3))); assert.equal(before.ok, true); assert.ok(before.transactions > 0);
  const bal = await M.StockBalance.findOne({ quantity: { $gt: 1 } }); await M.StockBalance.updateOne({ _id: bal._id }, { $inc: { quantity: 3 } });
  const api1 = (await api("get", "/api/reports/stock-reconciliation")).body; assert.equal(api1.ok, false); assert.equal(api1.mismatches, 1); assert.equal(api1.rows[0].difference, 3); assert.ok(api1.rows[0].partNumber);
  await M.StockBalance.updateOne({ _id: bal._id }, { $inc: { quantity: -3 } }); assert.equal((await stockReconciliation()).ok, true);
});

// ---------------------------------------------------------------- permissions
test("permissions: /search and /qr need a real permission; roles without it get 403", async () => {
  await M.Role.updateOne({ name: "ghost" }, { $set: { name: "ghost", permissions: [] } }, { upsert: true });
  const bcrypt = require("bcryptjs"); await M.User.create({ name: "Ghost", emailId: "ghost@example.com", role: "ghost", passwordHash: await bcrypt.hash(PW, 4) });
  const t = (await request(app).post("/login").send({ email: "ghost@example.com", password: PW })).body.token; assert.ok(t);
  for (const u of ["/api/search?q=a", "/api/qr?text=abc", "/api/planning/requirements", "/api/reports/stock-reconciliation"]) { const r = await (u.includes("planning") ? request(app).post(u).send({ model: "X", quantity: 1 }) : request(app).get(u)).set("Authorization", `Bearer ${t}`); assert.equal(r.status, 403, u); }
  assert.notEqual((await api("get", "/api/search?q=a")).status, 403);
});
