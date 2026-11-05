// No temporary BOM data: the seed creates none, assembly is blocked until Engineering approves a BOM, and BOM import/approval still works.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef-0123456789"; process.env.LOGIN_RATE_LIMIT = "100000"; process.env.RATE_LIMIT = "1000000";
const test = require("node:test"); const assert = require("node:assert"); const { before, after } = test;
const request = require("supertest"); const mongoose = require("mongoose");
const db = require("../src/db"); const { createApp } = require("../src/app"); const seedMod = require("../src/scripts/seed"); const M = require("../src/models");
const stamp = Date.now(); let app; const tok = {}; let n = 0;
const api = (m, u, who, b) => { const r = request(app)[m](u).set("Authorization", `Bearer ${tok[who]}`); return b ? r.send(b) : r; };
before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_v1bom_${stamp}`); await seedMod.rawSeed({ quiet: true }); app = createApp(); // rawSeed = the real seed, without test fixtures
  for (const [k, e] of [["admin", "admin@example.com"], ["engineer", "engineer@example.com"]]) { const r = await request(app).post("/login").send({ email: e, password: "ChangeMe#2026" }); tok[k] = r.body.token; }
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("B. the seed creates no BOMs, no BOM revisions and no vehicles", async () => {
  assert.equal(await M.BOM.countDocuments(), 0); assert.equal(await M.BOMRevision.countDocuments(), 0); assert.equal(await M.Vehicle.countDocuments(), 0);
  assert.equal((await api("get", "/api/bom", "admin")).body.length, 0);
  const st = (await api("get", "/api/bom-status", "admin")).body; assert.equal(st.approvedBomAvailable, false); assert.equal(st.message, "No approved BOM uploaded yet.");
  assert.ok(!require("fs").existsSync(require("path").join(__dirname, "../src/data/bom.json")));
});
test("B2. production assembly and kitting are blocked without an approved BOM; BOM import + approval unblock it", async () => {
  const v = await M.Vehicle.create({ vehicleNumber: "BUZZ-0900", model: "BUZZ", vehicleType: "BUZZ" });
  const recv = async (pn, ex) => { const r = await api("post", "/api/receiving", "admin", { supplierId: String((await M.Supplier.findOne())._id), invoiceNo: `I-${stamp}-${++n}`, lines: [{ partNumber: pn, quantity: 1, ...ex }] }); assert.equal(r.status, 201, JSON.stringify(r.body)); const it = r.body.items[0]; await api("post", `/api/receiving/${r.body.receiptId}/qc`, "admin", { materialItemId: it.id, result: "PASS" }); return it; };
  const c1 = await recv("CTRL-001", { serialNumbers: [`B-${stamp}-1`] });
  const blocked = await api("post", "/api/vehicles/BUZZ-0900/install", "admin", { materialItemId: c1.id });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "BOM_NOT_APPROVED"); assert.match(blocked.body.message, /No approved BOM uploaded yet/); assert.equal(blocked.body.overridable, false);
  assert.equal((await api("post", "/api/vehicles/BUZZ-0900/install", "admin", { materialItemId: c1.id, override: { reason: "just do it", confirm: true } })).status, 409, "an override cannot bypass the missing-BOM block");
  assert.equal((await api("get", "/api/vehicles/BUZZ-0900", "admin")).body.bomApproved, false);
  await assert.rejects(() => require("../src/domain/kitting").create({ id: null, name: "t", role: "admin" }, { vehicle: "BUZZ-0900" }), (e) => e.code === "BOM_NOT_APPROVED" || e.error === "BOM_NOT_APPROVED" || /No approved BOM/.test(e.message));
  // import / management / approval still work: a DRAFT revision does not unblock, an APPROVED one does
  assert.equal((await api("post", "/api/bom", "engineer", { vehicleModel: "BUZZ", name: "BUZZ BOM" })).status, 201);
  const rev = await api("post", "/api/bom/BUZZ/revisions", "engineer", { revision: "REV-A", changeReason: "uploaded original BOM", items: [{ partNumber: "CTRL-001", requiredQuantity: 1 }] }); assert.equal(rev.status, 201, JSON.stringify(rev.body));
  assert.equal((await M.BOMRevision.findOne({ revision: "REV-A" })).status, "DRAFT");
  assert.equal((await api("post", "/api/vehicles/BUZZ-0900/install", "admin", { materialItemId: c1.id })).body.error, "BOM_NOT_APPROVED");
  assert.equal((await api("get", "/api/bom-status", "admin")).body.approvedBomAvailable, false);
  const ap = await api("post", "/api/bom/BUZZ/revisions/REV-A/approve", "admin", {}); assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal((await api("get", "/api/bom-status", "admin")).body.approvedBomAvailable, true);
  const ok = await api("post", "/api/vehicles/BUZZ-0900/install", "admin", { materialItemId: c1.id }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await M.Installation.findOne({ vehicle: v._id, active: true })).bomRevision, "REV-A"); // the exact BOM revision used is preserved on the installation
});
