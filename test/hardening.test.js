// Hardening tests (Phase 1/2/6): token handling, account lockout, first-admin race, idempotent stock moves, concurrency.
process.env.JWT_SECRET = "test-secret-1234567890-abcdef";
process.env.LOGIN_RATE_LIMIT = "1000";
process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const db = require("../src/db");
const config = require("../src/config");
const { createApp } = require("../src/app");
const { seed } = require("../src/scripts/seed");
const M = require("../src/models");

const PW = "ChangeMe#2026";
let app; const tok = {}; let supplierId; const stamp = Date.now();
const api = (method, url, user, body, headers = {}) => { let r = request(app)[method](url); if (user) r = r.set("Authorization", `Bearer ${tok[user]}`); for (const [k, v] of Object.entries(headers)) r = r.set(k, v); return body ? r.send(body) : r; };
const login = async (email, password = PW) => request(app).post("/login").send({ email, password });

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_hard_${stamp}`);
  await seed({ quiet: true });
  app = createApp();
  for (const [k, e] of Object.entries({ admin: "admin@example.com", store: "store@example.com", qc: "qc@example.com", engineer: "engineer@example.com" })) tok[k] = (await login(e)).body.token;
  supplierId = String((await M.Supplier.findOne({ code: "ACME" }))._id);
  const np = await api("post", "/api/parts", "engineer", { partNumber: "NOFIFO-H", partName: "No-FIFO hardening part", inventoryClass: "PRODUCTION", category: "ELECTRICAL", trackingType: "BATCH", defaultLocationCode: "E-12", fifoApplicable: false });
  assert.equal(np.status, 201, JSON.stringify(np.body));
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

async function storedItem(qty) {
  const rc = await api("post", "/api/receiving", "store", { supplierId, invoiceNo: `INV-H-${Math.random().toString(36).slice(2, 9)}`, lines: [{ partNumber: "NOFIFO-H", quantity: qty, batchNumber: "B-H" }] });
  assert.equal(rc.status, 201, JSON.stringify(rc.body));
  const it = rc.body.items[0];
  if (it.status !== "APPROVED") assert.equal((await api("post", `/api/receiving/${rc.body.receiptId}/qc`, "qc", { materialItemId: it.id, result: "PASS" })).status, 200);
  assert.equal((await api("post", `/api/materials/${it.id}/put-away`, "store", { scannedLocation: "E-12" })).status, 200);
  return it;
}
const balance = async (id, code) => { const loc = await M.Location.findOne({ locationCode: code }); const b = await M.StockBalance.findOne({ materialItem: id, location: loc._id }); return b ? b.quantity : 0; };

test("H1 expired, forged and garbage tokens all return 401 (the UI signs out on 401)", async () => {
  const me = (t) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${t}`);
  const id = jwt.decode(tok.admin).id;
  assert.equal((await me(jwt.sign({ id, v: 0 }, config.jwtSecret, { expiresIn: -10 }))).status, 401);
  assert.equal((await me(jwt.sign({ id, v: 0 }, "wrong-secret-wrong-secret"))).status, 401);
  assert.equal((await me("garbage")).status, 401);
  assert.equal((await request(app).get("/api/auth/me")).status, 401);
  assert.equal((await me(tok.admin)).status, 200);
});

test("H2 permission denied is still 403 (not confused with an expired session)", async () => {
  assert.equal((await api("get", "/api/users", "store")).status, 403);
});

test("H3 account locks after repeated wrong passwords, even for the right password", async () => {
  assert.equal((await api("post", "/api/users", "admin", { name: "Lock Me", emailId: "lockme@example.com", role: "store", password: PW })).status, 201);
  for (let i = 0; i < config.maxFailedLogins; i++) assert.equal((await login("lockme@example.com", "WrongPass1")).status, 401); // config is loaded by the test preload, so read the real limit
  assert.equal((await login("lockme@example.com")).status, 423);
});

test("H4 admin changing a user's role or password signs that user out", async () => {
  const c = await api("post", "/api/users", "admin", { name: "Rev Oke", emailId: "revoke@example.com", role: "store", password: PW });
  const t = (await login("revoke@example.com")).body.token;
  assert.equal((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${t}`)).status, 200);
  assert.equal((await api("put", `/api/users/${c.body.user._id}`, "admin", { password: "Another#Pass9" })).status, 200);
  assert.equal((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${t}`)).status, 401);
});

test("H5 weak passwords are refused", async () => {
  assert.equal((await api("post", "/api/users", "admin", { name: "Weak", emailId: "weak@example.com", role: "store", password: "12345678" })).status, 400);
  assert.equal((await api("post", "/api/users", "admin", { name: "Weak", emailId: "weak2@example.com", role: "store", password: "abcdefgh" })).status, 400);
});

test("H6 first-admin creation cannot race: 10 parallel requests create exactly one admin", async () => {
  await M.User.deleteMany({}); await M.Setting.deleteMany({ key: "first-admin-claim" });
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => request(app).post("/users").send({ name: `Root ${i}`, emailId: `root${i}@example.com`, password: "FirstAdmin#1" })));
  assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.equal(await M.User.countDocuments(), 1);
  // later attempts are refused
  assert.equal((await request(app).post("/users").send({ name: "Late", emailId: "late@example.com", password: "FirstAdmin#1" })).status, 401);
  await seed({ quiet: true }); tok.admin = (await login("admin@example.com")).body.token; tok.store = (await login("store@example.com")).body.token; tok.qc = (await login("qc@example.com")).body.token;
});

test("H7 same Idempotency-Key on an issue moves stock once and replays the first answer", async () => {
  const it = await storedItem(20);
  const body = { materialItemId: it.id, quantity: 5, fromLocation: "E-12", purpose: "idem" };
  const h = { "Idempotency-Key": `idem-${stamp}-issue-1` };
  const a = await api("post", "/api/inventory/issue", "store", body, h);
  const b = await api("post", "/api/inventory/issue", "store", body, h);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(b.headers["idempotent-replay"], "true");
  assert.equal(await balance(it.id, "E-12"), 15);
  assert.equal(await M.InventoryTransaction.countDocuments({ materialItem: it.id, transactionType: "ISSUE" }), 1);
});

test("H8 concurrent issues never drive stock negative and the ledger matches balances", async () => {
  const it = await storedItem(10);
  const res = await Promise.all(Array.from({ length: 6 }, () => api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 4, fromLocation: "E-12", purpose: "race" })));
  const ok = res.filter((r) => r.status === 200).length;
  assert.equal(ok, 2, JSON.stringify(res.map((r) => r.status)));          // 10 / 4 -> only two can succeed
  assert.ok((await balance(it.id, "E-12")) >= 0);
  assert.equal(await balance(it.id, "E-12"), 10 - ok * 4);
  assert.equal(await balance(it.id, "WIP-FLOOR"), ok * 4);
});

test("H9 health and readiness probes", async () => {
  assert.equal((await request(app).get("/api/health")).status, 200);
  const r = await request(app).get("/api/ready"); assert.equal(r.status, 200); assert.equal(r.body.db, "connected");
});

test("H10 uploads: a file whose bytes do not match its declared type is refused", async () => {
  const fake = Buffer.from("<html><script>alert(1)</script></html>  padding").toString("base64");
  const r = await api("post", "/api/files", "store", { name: "x.pdf", mime: "application/pdf", purpose: "INVOICE", dataBase64: fake });
  assert.equal(r.status, 400);
});

test("H11 concurrent issues cannot take stock that is reserved for a kit (needs a replica set)", async () => {
  const { supportsTransactions } = require("../src/db");
  if (!supportsTransactions()) return; // reservation locking relies on transactions; production enforces them
  const it = await storedItem(10);
  await M.Reservation.create({ kit: new mongoose.Types.ObjectId(), materialItem: it.id, part: (await M.MaterialItem.findById(it.id)).part, partNumber: "NOFIFO-H", quantity: 6 }); // 6 reserved, 4 free
  const res = await Promise.all(Array.from({ length: 4 }, () => api("post", "/api/inventory/issue", "store", { materialItemId: it.id, quantity: 3, fromLocation: "E-12", purpose: "reserved race" })));
  const ok = res.filter((r) => r.status === 200).length;
  assert.equal(ok, 1, JSON.stringify(res.map((r) => [r.status, r.body.error]))); // only 4 free: one issue of 3 fits, the next would dip into the reservation
  assert.ok((await balance(it.id, "E-12")) >= 6, "reserved units must stay in the bin");
});
