// The cleanup script removes temporary BOM data only when nothing refers to it, keeps real history, and audits what it did.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef-0123456789"; process.env.LOGIN_RATE_LIMIT = "100000"; process.env.RATE_LIMIT = "1000000";
const test = require("node:test"); const assert = require("node:assert"); const { before, after } = test;
const request = require("supertest"); const mongoose = require("mongoose");
const db = require("../src/db"); const { createApp } = require("../src/app"); const { seed } = require("../src/scripts/seed"); const M = require("../src/models"); const cleanup = require("../src/scripts/cleanupTempBom");
const stamp = Date.now(); let app, tok;
const api = (m, u, b) => { const r = request(app)[m](u).set("Authorization", `Bearer ${tok}`); return b ? r.send(b) : r; };
before(async () => { await db.connect(`mongodb://127.0.0.1:27017/wms_v1clean_${stamp}`); await seed({ quiet: true }); app = createApp(); tok = (await request(app).post("/login").send({ email: "admin@example.com", password: "ChangeMe#2026" })).body.token; });
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("cleanup: dry run changes nothing; apply removes unreferenced temporary BOMs, keeps referenced ones, audits it", async () => {
  // give BUZZ real history: one installation on a BUZZ vehicle
  const acme = await M.Supplier.findOne({ code: "ACME" });
  const r = await api("post", "/api/receiving", { supplierId: String(acme._id), invoiceNo: `I-${stamp}`, lines: [{ partNumber: "CTRL-001", quantity: 1, serialNumbers: [`CL-${stamp}`] }] }); assert.equal(r.status, 201, JSON.stringify(r.body));
  await api("post", `/api/receiving/${r.body.receiptId}/qc`, { materialItemId: r.body.items[0].id, result: "PASS" });
  assert.equal((await api("post", "/api/vehicles/BUZZ-0042/install", { materialItemId: r.body.items[0].id })).status, 200);
  const logs = []; const counts = async () => [await M.BOMRevision.countDocuments(), await M.BOM.countDocuments(), await M.Vehicle.countDocuments()];
  const before = await counts(); assert.deepEqual(before, [3, 3, 3]);
  const dry = await cleanup.run({ apply: false, log: (x) => logs.push(x) }); assert.equal(dry.applied, false); assert.deepEqual(await counts(), before, "dry run must not change anything");
  assert.deepEqual(dry.remove.map((x) => x.model).sort(), ["LITE", "RETROFIT"]); assert.deepEqual(dry.keep.map((x) => x.model), ["BUZZ"]); assert.match(dry.keep[0].why, /installation/);
  const res = await cleanup.run({ apply: true, demoVehicles: true, log: (x) => logs.push(x) }); assert.equal(res.applied, true);
  assert.deepEqual((await M.BOMRevision.find().lean()).map((x) => x.vehicleModel), ["BUZZ"], "only the referenced revision survives");
  assert.equal(await M.BOM.countDocuments({ vehicleModel: { $in: ["LITE", "RETROFIT"] } }), 0);
  assert.deepEqual((await M.Vehicle.find().lean()).map((v) => v.vehicleNumber), ["BUZZ-0042"], "demo vehicles without history removed; the one with installation history kept");
  assert.equal(await M.Installation.countDocuments({ active: true }), 1, "genuine installation history untouched"); assert.ok(await M.MaterialItem.findById(r.body.items[0].id));
  assert.ok(await M.AuditLog.findOne({ action: "TEMP_BOM_CLEANUP" }));
  // a model that lost its BOM is blocked from assembly with the clear message
  await M.Vehicle.create({ vehicleNumber: "LITE-0500", model: "LITE", vehicleType: "LITE" });
  const l = await api("post", "/api/receiving", { supplierId: String(acme._id), invoiceNo: `I2-${stamp}`, lines: [{ partNumber: "CTRL-LITE", quantity: 1, serialNumbers: [`CL2-${stamp}`] }] });
  await api("post", `/api/receiving/${l.body.receiptId}/qc`, { materialItemId: l.body.items[0].id, result: "PASS" });
  const blocked = await api("post", "/api/vehicles/LITE-0500/install", { materialItemId: l.body.items[0].id }); assert.equal(blocked.body.error, "BOM_NOT_APPROVED");
  const again = await cleanup.run({ apply: true, log: () => {} }); assert.equal(again.remove.length, 0, "idempotent");
});
