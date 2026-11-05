// Version 1.0.0 regression tests - one section per critical rule. Every rule is checked through the HTTP API (i.e. enforced on the backend).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef-0123456789"; process.env.LOGIN_RATE_LIMIT = "100000"; process.env.RATE_LIMIT = "1000000";
const test = require("node:test"); const assert = require("node:assert"); const { before, after } = test;
const request = require("supertest"); const mongoose = require("mongoose");
const db = require("../src/db"); const { createApp } = require("../src/app"); const { seed } = require("../src/scripts/seed"); const M = require("../src/models"); const L = require("../src/models/legacy");
const config = require("../src/config"); const PW = "ChangeMe#2026"; const stamp = Date.now();
const PDF = (tag = Math.random()) => Buffer.from(`%PDF-1.4\n% invoice ${tag}\n%%EOF\n`).toString("base64");
let app; const tok = {}; let acme; let n = 0; const U = () => `${stamp}-${++n}`;
const api = (m, u, who, b) => { const r = request(app)[m](u).set("Authorization", `Bearer ${tok[who]}`); return b ? r.send(b) : r; };

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_v1_${stamp}`); await seed({ quiet: true }); app = createApp();
  for (const [k, e] of [["admin", "admin@example.com"], ["store", "store@example.com"], ["qc", "qc@example.com"], ["assembly", "assembly@example.com"], ["supervisor", "supervisor@example.com"]]) tok[k] = (await request(app).post("/login").send({ email: e, password: PW })).body.token;
  acme = await M.Supplier.findOne({ code: "ACME" });
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

const recv = (pn, qty, extra = {}, who = "admin") => api("post", "/api/receiving", who, { supplierId: String(acme._id), invoiceNo: `INV-${U()}`, lines: [{ partNumber: pn, quantity: qty, ...extra }] });
async function item(pn, qty = 1, extra = {}) { const r = await recv(pn, qty, extra); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.items[0], receiptId: r.body.receiptId }; }
async function ready(pn, qty = 1, extra = {}) { const it = await item(pn, qty, extra); if (it.status !== "APPROVED") { const q = await api("post", `/api/receiving/${it.receiptId}/qc`, "admin", { materialItemId: it.id, result: "PASS" }); assert.equal(q.status, 200, JSON.stringify(q.body)); } return it; }
const sn = (p) => ({ serialNumbers: [`${p}-${U()}`] });
const veh = (num) => M.Vehicle.findOne({ vehicleNumber: num });
async function ledgerIsConsistent() {
  const bad = [];
  for (const it of await M.MaterialItem.find().lean()) {
    let net = 0; for (const t of await M.InventoryTransaction.find({ materialItem: it._id }).lean()) { if (t.toLocation) net += t.quantity; if (t.fromLocation) net -= t.quantity; }
    const bals = await M.StockBalance.find({ materialItem: it._id }).lean();
    if (bals.some((b) => b.quantity < 0)) bad.push(`${it._id}: negative balance`);
    if (Math.abs(net - bals.reduce((s, b) => s + b.quantity, 0)) > 1e-9) bad.push(`${it.partNumber}: ledger ${net} != balance`);
  } return bad;
}

// ------------------------------------------------------------------ A. version
test("A. release version is 1.0.0 and is exposed consistently by the API", async () => {
  const pkg = require("../package.json"); assert.equal(pkg.version, "1.0.0");
  assert.equal((await request(app).get("/api/version")).body.version, "1.0.0"); assert.equal((await request(app).get("/api/health")).body.version, "1.0.0");
  assert.equal(require("../package-lock.json").version, "1.0.0");
});

// ------------------------------------------------------------------ C2. invoice attachment
test("C2. receiving needs an actual invoice document: none / unknown / fake-type / reused are all refused and nothing is created", async () => {
  const before = await M.Receipt.countDocuments(); const body = (extra) => ({ supplierId: String(acme._id), invoiceNo: `INV-${U()}`, lines: [{ partNumber: "M8-NUT", quantity: 3, batchNumber: "AT" + n }], ...extra });
  const none = await api("post", "/api/receiving", "store", body({ __noInvoice: true })); assert.equal(none.status, 400); assert.equal(none.body.error, "INVOICE_ATTACHMENT_REQUIRED");
  assert.equal((await api("post", "/api/receiving", "store", body({ invoiceFileId: "5f1d7f3b9d1e8a0012345678" }))).body.error, "INVOICE_ATTACHMENT_REQUIRED");
  assert.equal((await api("post", "/api/receiving", "store", body({ invoiceFileId: "not-an-id" }))).body.error, "INVOICE_ATTACHMENT_REQUIRED");
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  const fake = await api("post", "/api/files", "store", { name: "x.pdf", mime: "application/pdf", purpose: "INVOICE", dataBase64: html }); assert.equal(fake.status, 400); assert.equal(fake.body.error, "FILE_CONTENT_MISMATCH");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]).toString("base64");
  assert.equal((await api("post", "/api/files", "store", { name: "x.webp", mime: "image/webp", purpose: "INVOICE", dataBase64: webp })).status, 400); // an invoice must be PDF/JPEG/PNG
  assert.equal((await request(app).post("/api/files").send({ name: "x.pdf", mime: "application/pdf", dataBase64: PDF() })).status, 401);
  assert.equal(await M.Receipt.countDocuments(), before, "no receipt was created by any refused attempt");
  const up = await api("post", "/api/files", "store", { name: "invoice.pdf", mime: "application/pdf", purpose: "INVOICE", dataBase64: PDF() }); assert.equal(up.status, 201, JSON.stringify(up.body));
  const ok = await api("post", "/api/receiving", "store", body({ invoiceFileId: up.body.id })); assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const rec = await M.Receipt.findById(ok.body.receiptId).lean(); assert.equal(String(rec.invoiceFile.file), up.body.id); assert.equal(rec.invoiceFile.mime, "application/pdf"); assert.ok(rec.invoiceFile.sha256);
  const again = await api("post", "/api/receiving", "store", body({ invoiceFileId: up.body.id })); assert.equal(again.status, 409); assert.equal(again.body.error, "INVOICE_ATTACHMENT_REUSED");
  assert.equal((await request(app).get(`/api/files/${up.body.id}`)).status, 401); assert.equal((await api("get", `/api/files/${up.body.id}`, "store")).status, 200);
});
test("C2b. legacy intake route enforces the same attachment rule", async () => {
  const r = await api("post", "/Incomming", "store", { invoice: "LEG-INV-1", partId: "X", partName: "x", quantity: 1 }); assert.equal(r.status, 400); assert.equal(r.body.error, "INVOICE_ATTACHMENT_REQUIRED");
});

// ------------------------------------------------------------------ C1 + E. final QC -> rework -> retest -> release -> dispatch
async function assembleLite() {
  const v = "LITE-0012";
  for (const [pn, q, ex] of [["CTRL-LITE", 1, sn("LC")], ["RELAY-001", 1, { batchNumber: "RB" + U() }], ["BOLT-M8", 4, { batchNumber: "BB" + U() }]]) {
    const it = await ready(pn, q, ex); const r = await api("post", `/api/vehicles/${v}/install`, "admin", { materialItemId: it.id, quantity: q }); assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await veh(v)).status, "ASSEMBLED");
}
test("C1/E. final QC FAIL -> rework -> retest -> PASS -> authorised release -> dispatch (full lifecycle, server-enforced)", async () => {
  const v = "LITE-0012"; const id = String((await veh(v))._id);
  // final QC cannot be recorded on a vehicle that is not assembled
  assert.equal((await api("post", "/api/qc/final", "qc", { vehicleId: String((await veh("RETRO-0007"))._id), result: "FAIL", remarks: "x" })).body.error, "VEHICLE_QC_NOT_ALLOWED");
  assert.equal((await veh("RETRO-0007")).status, "PLANNED");
  await assembleLite();
  assert.equal((await api("post", "/api/qc/retest", "qc", { vehicleId: id, result: "PASS" })).body.error, "VEHICLE_QC_NOT_ALLOWED"); // retest only follows a rework
  const f1 = await api("post", "/api/qc/final", "qc", { vehicleId: id, result: "FAIL", remarks: "connector loose", reworkRequired: true }); assert.equal(f1.status, 200, JSON.stringify(f1.body));
  assert.equal((await veh(v)).status, "FINAL_QC_FAILED");
  assert.equal((await api("post", "/api/qc/final", "qc", { vehicleId: id, result: "PASS", remarks: "skip rework" })).body.error, "VEHICLE_QC_NOT_ALLOWED"); // cannot PASS straight after a FAIL
  assert.equal((await api("post", `/api/vehicles/${v}/release`, "admin", {})).body.error, "VEHICLE_NOT_QC_APPROVED");
  assert.equal((await api("post", `/api/vehicles/${v}/rework`, "assembly", {})).status, 400); // reason required
  assert.equal((await api("post", `/api/vehicles/${v}/rework`, "assembly", { reason: "re-seat connector, replace 2 bolts" })).status, 200); assert.equal((await veh(v)).status, "REWORK");
  assert.equal((await api("post", "/api/qc/retest", "qc", { vehicleId: id, result: "PASS" })).body.error, "VEHICLE_QC_NOT_ALLOWED"); // rework not finished yet
  // rework: remove 2 bolts (no override needed during rework), vehicle cannot go to retest until complete again
  const inst = await M.Installation.findOne({ vehicle: id, partNumber: "BOLT-M8", active: true });
  const rm = await api("post", `/api/vehicles/${v}/remove`, "supervisor", { materialItemId: String(inst.materialItem), quantity: 2, reason: "damaged threads", disposition: "HOLD" }); assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal((await api("post", `/api/vehicles/${v}/rework-complete`, "assembly", {})).body.error, "VEHICLE_NOT_COMPLETE");
  const nb = await ready("BOLT-M8", 2, { batchNumber: "BR" + U() }); assert.equal((await api("post", `/api/vehicles/${v}/install`, "assembly", { materialItemId: nb.id, quantity: 2 })).status, 200);
  assert.equal((await api("post", `/api/vehicles/${v}/rework-complete`, "assembly", { note: "done" })).status, 200); assert.equal((await veh(v)).status, "PENDING_RETEST");
  // retest FAIL sends it back; a second rework cycle works too
  assert.equal((await api("post", "/api/qc/retest", "qc", { vehicleId: id, result: "FAIL", remarks: "still noisy" })).status, 200); assert.equal((await veh(v)).status, "FINAL_QC_FAILED");
  assert.equal((await api("post", `/api/vehicles/${v}/rework`, "qc", { reason: "second pass" })).status, 200);
  assert.equal((await api("post", `/api/vehicles/${v}/rework-complete`, "qc", {})).status, 200);
  assert.equal((await api("post", "/api/qc/retest", "qc", { vehicleId: id, result: "PASS", remarks: "all good" })).status, 200); assert.equal((await veh(v)).status, "QC_APPROVED");
  // approval is not release: release needs its own permission, dispatch needs release
  assert.equal((await api("post", `/api/vehicles/${v}/dispatch`, "store", {})).body.error, "VEHICLE_NOT_RELEASED");
  assert.equal((await api("post", `/api/vehicles/${v}/release`, "qc", {})).status, 403);
  assert.equal((await api("post", `/api/vehicles/${v}/release`, "supervisor", { note: "authorised" })).status, 200); assert.equal((await veh(v)).status, "RELEASED");
  assert.equal((await api("post", `/api/vehicles/${v}/release`, "supervisor", {})).status, 409);
  assert.equal((await api("post", `/api/vehicles/${v}/dispatch`, "qc", {})).status, 403);
  const gp = await api("post", "/api/gatepasses", "store", { supplier: "Customer", dispatchMode: "Truck", items: [{ name: "Vehicle LITE-0012", serialBatch: v, qty: 1 }] }); assert.equal(gp.status, 201, JSON.stringify(gp.body));
  assert.equal((await api("post", `/api/vehicles/${v}/dispatch`, "store", { gatePassNo: gp.body.refNo, note: "loaded" })).status, 200);
  const done = await veh(v); assert.equal(done.status, "DISPATCHED"); assert.equal(done.gatePassNo, gp.body.refNo); assert.ok(done.dispatchedAt);
  assert.equal((await api("post", `/api/vehicles/${v}/install`, "admin", { materialItemId: nb.id, quantity: 1 })).body.error, "VEHICLE_CLOSED");
  for (const a of ["QC_FINAL_FAIL", "QC_RETEST_FAIL", "QC_RETEST_PASS", "VEHICLE_REWORK_STARTED", "VEHICLE_REWORK_COMPLETED", "VEHICLE_RELEASED", "VEHICLE_DISPATCHED"]) assert.ok(await M.AuditLog.findOne({ action: a, entityLabel: v }), `audit ${a}`);
});
test("C3. a vehicle that is not QC-approved and released cannot leave on a gate pass or be dispatched", async () => {
  const gp = await api("post", "/api/gatepasses", "store", { supplier: "Customer", items: [{ name: "Vehicle", serialBatch: "BUZZ-0042", qty: 1 }] });
  assert.equal(gp.status, 409); assert.equal(gp.body.error, "VEHICLE_NOT_RELEASED");
  const gp2 = await api("post", "/api/gatepasses", "store", { supplier: "Customer", items: [{ name: "Vehicle", vehicleNumber: "buzz-0042", qty: 1 }] }); assert.equal(gp2.body.error, "VEHICLE_NOT_RELEASED");
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/dispatch", "store", {})).body.error, "VEHICLE_NOT_RELEASED");
  assert.equal((await api("post", "/gatepass", "store", { supplier: "x", items: [{ name: "v", serialBatch: "BUZZ-0042", qty: 1 }] })).body.error, "VEHICLE_NOT_RELEASED"); // legacy endpoint too
  assert.equal((await api("post", "/api/gatepasses", "store", { supplier: "Acme", items: [{ name: "Plain material", qty: 2 }] })).status, 201); // ordinary gate passes are unaffected
  // even a manual database edit to RELEASED without a passing QC record cannot be dispatched
  await M.Vehicle.updateOne({ vehicleNumber: "RETRO-0007" }, { $set: { status: "RELEASED" } });
  assert.equal((await api("post", "/api/vehicles/RETRO-0007/dispatch", "store", {})).body.error, "FINAL_QC_REQUIRED");
  await M.Vehicle.updateOne({ vehicleNumber: "RETRO-0007" }, { $set: { status: "PLANNED" } });
});

// ------------------------------------------------------------------ C6. blocked components
test("C6. Pending-QC (testing), Hold and Rejected components cannot be installed, issued or handed over", async () => {
  const bad = (r) => { assert.ok([409, 400].includes(r.status), JSON.stringify(r.body)); return r.body.error; };
  const pend = await item("CTRL-001", 1, sn("PQ")); assert.equal(bad(await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: pend.id })), "MATERIAL_NOT_APPROVED");
  const hold = await ready("CTRL-001", 1, sn("HD")); assert.equal((await api("post", "/api/qc/component", "qc", { materialItemId: hold.id, result: "HOLD", remarks: "suspect" })).status, 200);
  const e1 = bad(await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: hold.id })); assert.ok(/HOLD/.test(e1), e1);
  const rej = await item("CTRL-001", 1, sn("RJ")); await api("post", `/api/receiving/${rej.receiptId}/qc`, "qc", { materialItemId: rej.id, result: "FAIL", remarks: "cracked" });
  const e2 = bad(await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: rej.id })); assert.ok(/REJECT/.test(e2), e2);
  const users = await M.User.findOne({ emailId: "qc@example.com" }); const locs = await M.Location.findOne({ type: "BIN" });
  for (const it of [pend, hold, rej]) assert.equal((await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 1, toUserId: String(users._id), fromLocation: locs.locationCode, purpose: "x" })).status, 409);
  for (const it of [pend, hold, rej]) assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: it.id, override: { reason: "please", confirm: true } })).status, 409, "even an admin override cannot use blocked material");
  assert.equal(await M.Installation.countDocuments({ vehicle: (await veh("BUZZ-0042"))._id, active: true }), 0);
});

// ------------------------------------------------------------------ C5. duplicates / concurrency
test("C5. simultaneous QC results on one item: exactly one wins and status, ledger and NCR stay consistent", async () => {
  for (let t = 0; t < 4; t++) {
    const it = await item("CTRL-001", 1, sn("QQ"));
    const [a, b] = await Promise.all([api("post", `/api/receiving/${it.receiptId}/qc`, "qc", { materialItemId: it.id, result: "PASS" }), api("post", `/api/receiving/${it.receiptId}/qc`, "qc", { materialItemId: it.id, result: "FAIL", remarks: "bad" })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `trial ${t}: ${JSON.stringify([a.body, b.body])}`);
    const fin = await M.MaterialItem.findById(it.id); const loc = (await M.StockBalance.find({ materialItem: it.id, quantity: { $gt: 0 } }).populate("location").lean()).map((x) => x.location.type);
    assert.equal(await M.QCInspection.countDocuments({ materialItem: it.id }), 1, "one inspection only");
    if (fin.status === "APPROVED") assert.ok(!loc.includes("REJECT") && (await M.Ncr.countDocuments({ materialItem: it.id })) === 0); else { assert.equal(fin.status, "REJECTED"); assert.ok(loc.includes("REJECT")); assert.equal(await M.Ncr.countDocuments({ materialItem: it.id }), 1); }
  }
});
test("C5b. one serial can never be installed on two vehicles at once", async () => {
  for (let t = 0; t < 5; t++) {
    const it = await ready("CTRL-001", 1, sn("CC")); await M.Installation.updateMany({ active: true }, { $set: {} });
    const rs = await Promise.all([api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: it.id }), api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: it.id })]);
    const ok = rs.filter((r) => r.status === 200).length; const active = await M.Installation.countDocuments({ materialItem: it.id, active: true });
    assert.ok(ok <= 1 && active === ok, `trial ${t}: successes ${ok}, active installations ${active}`);
    const bal = (await M.StockBalance.find({ materialItem: it.id }).lean()).reduce((s, b) => s + b.quantity, 0); assert.equal(bal, 1);
    if (active) { await api("post", `/api/vehicles/${rs[0].status === 200 ? "BUZZ-0042" : "RETRO-0007"}/remove`, "admin", { materialItemId: it.id, reason: "test cleanup", disposition: "QC_REQUIRED" }); }
  }
});
test("C5c. an already-installed serial cannot be installed again (duplicate installation)", async () => {
  const it = await ready("CTRL-001", 1, sn("DI")); assert.equal((await api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: it.id })).status, 200);
  const dup = await api("post", "/api/vehicles/RETRO-0007/install", "admin", { materialItemId: it.id }); assert.equal(dup.status, 409);
  const other = await api("post", "/api/vehicles/BUZZ-0042/install", "admin", { materialItemId: it.id }); assert.equal(other.status, 409);
  assert.equal(await M.Installation.countDocuments({ materialItem: it.id, active: true }), 1);
});
test("C5d. the same serial received simultaneously is created once (database-enforced)", async () => {
  const serial = `DUP-${U()}`; const rs = await Promise.all([1, 2, 3, 4].map(() => recv("CTRL-001", 1, { serialNumbers: [serial] })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.body.error || r.status)));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => ["DUPLICATE_SERIAL", "CONCURRENT_UPDATE"].includes(r.body.error) || r.status === 409), JSON.stringify(rs.map((r) => r.body)));
  assert.equal(await M.MaterialItem.countDocuments({ serialNumber: serial }), 1);
  assert.equal((await recv("CTRL-001", 1, { serialNumbers: [serial] })).body.error, "DUPLICATE_SERIAL");
});
test("C5e. simultaneous over-issue never makes stock negative", async () => {
  const it = await ready("M8-NUT", 10, { batchNumber: "NG" + U() }); const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body;
  await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: `LOC|${plan.destination.code}` });
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api("post", `/api/materials/${it.id}/issue`, "store", { quantity: 4, purpose: "line" })));
  const issued = rs.filter((r) => r.status === 200).length; assert.ok(issued <= 2, `issued ${issued} x 4 from 10`);
  assert.ok((await M.StockBalance.find({ materialItem: it.id }).lean()).every((b) => b.quantity >= 0));
});

// ------------------------------------------------------------------ F. handover
async function binItem(qty = 10) {
  const it = await ready("M8-NUT", qty, { batchNumber: "HO" + U() }); const plan = (await api("get", `/api/materials/${it.id}/put-away-plan`, "store")).body;
  const pa = await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: `LOC|${plan.destination.code}` }); assert.equal(pa.status, 200, JSON.stringify(pa.body)); return { ...it, loc: plan.destination.code };
}
const uid = async (e) => String((await M.User.findOne({ emailId: e }))._id);
test("F. handover: stock stays in transit until the recipient acknowledges; on-behalf answers need override + reason and are recorded", async () => {
  const it = await binItem(); const qcId = await uid("qc@example.com");
  const h = await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 5, toUserId: qcId, fromLocation: it.loc, purpose: "line 2" }); assert.equal(h.status, 201, JSON.stringify(h.body));
  const where = async () => (await M.StockBalance.find({ materialItem: it.id, quantity: { $gt: 0 } }).populate("location").lean()).map((b) => `${b.location.type}:${b.quantity}`).sort();
  assert.ok((await where()).includes("TRANSIT:5"), "in transit, NOT with the employee"); assert.ok(!(await where()).some((x) => x.startsWith("WIP")));
  const noOv = await api("post", `/api/handover/${h.body._id}/acknowledge`, "supervisor", {}); assert.equal(noOv.status, 403); assert.equal(noOv.body.error, "HANDOVER_NOT_RECIPIENT"); assert.equal(noOv.body.overridable, true);
  assert.equal((await api("post", `/api/handover/${h.body._id}/acknowledge`, "supervisor", { override: { reason: "x", confirm: false } })).status >= 400, true);
  assert.equal((await api("post", `/api/handover/${h.body._id}/acknowledge`, "store", { override: { reason: "I will do it", confirm: true } })).status, 403); // issuer has no override right
  assert.equal((await M.Handover.findById(h.body._id)).status, "PENDING");
  const before = await M.OverrideRecord.countDocuments();
  const ak = await api("post", `/api/handover/${h.body._id}/acknowledge`, "supervisor", { override: { reason: "Recipient on leave, material needed at line", confirm: true } }); assert.equal(ak.status, 200, JSON.stringify(ak.body)); assert.equal(ak.body.onBehalf, true);
  const rec = await M.Handover.findById(h.body._id).lean(); assert.equal(rec.status, "ACKNOWLEDGED"); assert.equal(rec.onBehalf, true); assert.equal(rec.respondedByName, "Supervisor"); assert.match(rec.overrideReason, /on leave/);
  assert.equal(await M.OverrideRecord.countDocuments(), before + 1); assert.ok(await M.AuditLog.findOne({ action: "HANDOVER_ACKNOWLEDGED", entityLabel: rec.handoverId, override: true }));
  assert.ok((await where()).includes("WIP:5"));
  assert.equal((await api("post", `/api/handover/${h.body._id}/acknowledge`, "qc", {})).body.error, "HANDOVER_CLOSED");
  // returns: partial then full
  assert.equal((await api("post", `/api/handover/${h.body._id}/return`, "qc", { quantity: 2 })).status, 400); // reason needed
  const r1 = await api("post", `/api/handover/${h.body._id}/return`, "qc", { quantity: 2, reason: "not needed" }); assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.status, "ACKNOWLEDGED"); assert.equal(r1.body.remaining, 3);
  assert.equal((await api("post", `/api/handover/${h.body._id}/return`, "qc", { quantity: 9, reason: "too many" })).status, 400);
  const r2 = await api("post", `/api/handover/${h.body._id}/return`, "qc", { reason: "rest" }); assert.equal(r2.body.status, "RETURNED"); assert.equal((await M.Handover.findById(h.body._id)).status, "RETURNED");
  assert.equal((await api("post", `/api/handover/${h.body._id}/return`, "qc", { reason: "again" })).status, 409);
  // a normal acknowledgement by the recipient needs no override; a pending one cannot be "returned"; refusal needs a reason
  const h2 = await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 1, toUserId: qcId, fromLocation: it.loc, purpose: "again" });
  assert.equal((await api("post", `/api/handover/${h2.body._id}/return`, "qc", { reason: "x" })).status, 409);
  assert.equal((await api("post", `/api/handover/${h2.body._id}/refuse`, "qc", {})).body.error, "REFUSAL_REASON_REQUIRED");
  const rf = await api("post", `/api/handover/${h2.body._id}/refuse`, "qc", { reason: "wrong part" }); assert.equal(rf.status, 200); assert.equal((await M.Handover.findById(h2.body._id)).status, "REFUSED");
  const h3 = await api("post", "/api/handover", "store", { materialItemId: it.id, quantity: 1, toUserId: qcId, fromLocation: it.loc, purpose: "ok" });
  const ok3 = await api("post", `/api/handover/${h3.body._id}/acknowledge`, "qc", {}); assert.equal(ok3.body.onBehalf, false); assert.equal((await M.Handover.findById(h3.body._id)).onBehalf, false);
});
test("F2. multi-item handover is acknowledged as one group; witness is enforced when required", async () => {
  const a = await binItem(6), b = await binItem(6); const qcId = await uid("qc@example.com");
  const g = await api("post", "/api/handover", "store", { toUserId: qcId, purpose: "kit", lines: [{ materialItemId: a.id, quantity: 2, fromLocation: a.loc }, { materialItemId: b.id, quantity: 3, fromLocation: b.loc }] }); assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.handovers.length, 2); assert.ok(g.body.groupId);
  const ak = await api("post", `/api/handover/group/${g.body.groupId}/acknowledge`, "qc", {}); assert.equal(ak.status, 200, JSON.stringify(ak.body)); assert.equal(ak.body.count, 2);
  assert.equal(await M.Handover.countDocuments({ groupId: g.body.groupId, status: "ACKNOWLEDGED" }), 2);
  const one = await api("post", "/api/handover", "store", { materialItemId: a.id, quantity: 1, toUserId: qcId, fromLocation: a.loc, purpose: "w" });
  config.requireHandoverWitness = true;
  try {
    const ov = { reason: "Recipient unavailable", confirm: true };
    assert.equal((await api("post", `/api/handover/${one.body._id}/acknowledge`, "supervisor", { override: ov })).body.error, "WITNESS_REQUIRED");
    assert.equal((await api("post", `/api/handover/${one.body._id}/acknowledge`, "supervisor", { override: ov, witnessUserId: qcId })).status, 400); // witness may not be the recipient
    const w = await api("post", `/api/handover/${one.body._id}/acknowledge`, "supervisor", { override: ov, witnessUserId: await uid("admin@example.com") }); assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal((await M.Handover.findById(one.body._id)).witnessName, "Admin User");
  } finally { config.requireHandoverWitness = false; }
});

// ------------------------------------------------------------------ G. migration + final invariants
test("G. migration is idempotent: legacy FINAL_QC vehicles become FINAL_QC_FAILED and existing serials get claims", async () => {
  const { migrateV1 } = require("../src/scripts/baseData"); const part = await M.PartMaster.findOne({ partNumber: "CTRL-001" });
  await M.Vehicle.updateOne({ vehicleNumber: "RETRO-0007" }, { $set: { status: "FINAL_QC" } });
  await M.MaterialItem.collection.insertOne({ part: part._id, partNumber: "CTRL-001", serialNumber: "LEGACY-SN-1", trackingType: "SERIAL", status: "APPROVED", quantity: 1, createdAt: new Date(), updatedAt: new Date() });
  await migrateV1(); await migrateV1();
  assert.equal((await veh("RETRO-0007")).status, "FINAL_QC_FAILED"); assert.equal(await M.SerialClaim.countDocuments({ key: `${part._id}|LEGACY-SN-1` }), 1);
  assert.equal((await recv("CTRL-001", 1, { serialNumbers: ["LEGACY-SN-1"] })).body.error, "DUPLICATE_SERIAL");
  await M.Vehicle.updateOne({ vehicleNumber: "RETRO-0007" }, { $set: { status: "PLANNED" } });
});
test("G2. production safeguards: the demo seed refuses to run and SEED_ON_START is ignored in production", async () => {
  const was = config.isProd; config.isProd = true;
  try { await assert.rejects(() => require("../src/scripts/seed").rawSeed({ quiet: true }), /never run in production/); } finally { config.isProd = was; }
  const src = require("fs").readFileSync(require("path").join(__dirname, "../src/index.js"), "utf8"); assert.match(src, /SEED_ON_START is ignored in production/);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "../render.yaml"), "utf8"), /SEED_ON_START, value: "false"/);
});
test("ledger invariant: every item's ledger movements equal its stock balances, and nothing is negative", async () => { assert.deepEqual(await ledgerIsConsistent(), []); });
