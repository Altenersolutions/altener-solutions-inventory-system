// Needs MongoDB on 127.0.0.1:27017 (same as the other end-to-end tests).  npm test runs it.
process.env.JWT_SECRET = "test-secret-1234567890-abcdef";
process.env.LOGIN_RATE_LIMIT = "1000"; process.env.RATE_LIMIT = "100000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const db = require("../src/db");
const { createApp } = require("../src/app");
const { seed } = require("../src/scripts/seed");
const M = require("../src/models");
const { resolveDestination } = require("../src/domain/locations");

const PW = "ChangeMe#2026"; let app, token; const stamp = Date.now();
const api = (method, url, body) => { const r = request(app)[method](url).set("Authorization", `Bearer ${token}`); return body ? r.send(body) : r; };
const part = (o) => ({ partName: "Test part", category: "ELECTRICAL", trackingType: "BATCH", ...o });

before(async () => {
  await db.connect(`mongodb://127.0.0.1:27017/wms_rack_${stamp}`); await seed({ quiet: true }); app = createApp();
  token = (await request(app).post("/login").send({ email: "admin@example.com", password: PW })).body.token;
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("part with rack location: rack + bin are created and shown as RACK-A / BIN-12", async () => {
  const r = await api("post", "/api/parts", part({ partNumber: "ae-mtr-0042", partName: "Hub motor", rackLocation: "RACK-A / BIN-12" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.partNumber, "AE-MTR-0042");                       // your own ID, saved in capitals
  const list = (await api("get", "/api/parts")).body.find((p) => p.partNumber === "AE-MTR-0042");
  assert.equal(list.rackLocation, "RACK-A / BIN-12"); assert.equal(list.defaultLocation.locationCode, "RACK-A/BIN-12");
  const rack = await M.Location.findOne({ locationCode: "RACK-A" }), bin = await M.Location.findOne({ locationCode: "RACK-A/BIN-12" });
  assert.equal(rack.type, "RACK"); assert.equal(bin.type, "BIN"); assert.equal(String(bin.parentLocation), String(rack._id)); assert.equal(bin.path, "RACK-A > BIN-12"); assert.equal(bin.qrCode, "LOC|RACK-A/BIN-12");
});
test("same bin name in another rack is a different location; reusing a bin does not duplicate it", async () => {
  await api("post", "/api/parts", part({ partNumber: "AE-B-1", rackLocation: "RACK-B / BIN-12" }));
  await api("post", "/api/parts", part({ partNumber: "AE-A-2", rackLocation: "rack-a/bin-12" }));
  assert.equal(await M.Location.countDocuments({ locationCode: "RACK-A/BIN-12" }), 1);
  assert.ok(await M.Location.findOne({ locationCode: "RACK-B/BIN-12" }));
  assert.equal(await M.Location.countDocuments({ type: "BIN", bin: "BIN-12" }), 2);
});
test("a bin set this way is used for put-away", async () => {
  const p = await M.PartMaster.findOne({ partNumber: "AE-MTR-0042" });
  assert.equal((await resolveDestination(p, 1)).locationCode, "RACK-A/BIN-12");
});
test("bad rack text and bad part IDs are rejected", async () => {
  for (const bad of ["RACK-A", "A/B/C", "RACK|A / BIN-1"]) { const r = await api("post", "/api/parts", part({ partNumber: "X-" + Math.random(), rackLocation: bad })); assert.equal(r.status, 400, bad); assert.equal(r.body.error, "BAD_RACK_LOCATION", bad); }
  for (const bad of ["A|B", "A=B"]) assert.equal((await api("post", "/api/parts", part({ partNumber: bad }))).status, 400, bad);
  assert.equal((await api("post", "/api/parts", part({ partNumber: "AE-MTR-0042" }))).status, 409);   // duplicate
});
test("edit rack location and clear it", async () => {
  const p = await M.PartMaster.findOne({ partNumber: "AE-A-2" });
  assert.equal((await api("put", `/api/parts/${p._id}`, { rackLocation: "RACK-C / BIN-01" })).status, 200);
  assert.equal((await api("get", `/api/parts/${p._id}`)).body.rackLocation, "RACK-C / BIN-01");
  assert.equal((await api("put", `/api/parts/${p._id}`, { rackLocation: "" })).status, 200);
  assert.equal((await api("get", `/api/parts/${p._id}`)).body.rackLocation, "");
});
test("parts CSV: own IDs, blank category/tracking guessed, rack created, dry run writes nothing, duplicates skipped", async () => {
  const csv = "partNumber,partName,category,trackingType,rackLocation,minStock\nAE-100,Wiring harness main,,,RACK-D / BIN-02,5\nae-101,Bolt M8x25,MECHANICAL,QUANTITY,RACK-D / BIN-03,100\nAE-MTR-0042,Hub motor,ELECTRICAL,SERIAL,,\nBAD|ID,Oops,,,,\nAE-102,Thing,,,RACK-ONLY,\n";
  const dry = (await api("post", "/api/import/parts", { csv, dryRun: true })).body;
  assert.equal(dry.created, 2); assert.equal(dry.skipped, 1); assert.deepEqual(dry.skippedParts, ["AE-MTR-0042"]); assert.equal(dry.errors.length, 2);
  assert.equal(await M.PartMaster.countDocuments({ partNumber: "AE-100" }), 0); assert.equal(await M.Location.countDocuments({ locationCode: "RACK-D/BIN-02" }), 0);
  const real = (await api("post", "/api/import/parts", { csv })).body; assert.equal(real.created, 2);
  const h = await M.PartMaster.findOne({ partNumber: "AE-100" }).populate("defaultLocation"); assert.equal(h.defaultLocation.locationCode, "RACK-D/BIN-02"); assert.equal(h.category, "ELECTRICAL"); // "wiring harness" guessed
  assert.ok(["BATCH", "SERIAL", "QUANTITY"].includes(h.trackingType));
});
test("rack-location import for existing parts (dry run, then real, then unchanged)", async () => {
  const csv = "partNumber,rackLocation\nAE-A-2,RACK-E / BIN-07\nAE-100,RACK-D / BIN-02\nNOPE-1,RACK-E / BIN-08\n";
  const dry = (await api("post", "/api/import/rack-locations", { csv, dryRun: true })).body;
  assert.equal(dry.updated, 1); assert.equal(dry.unchanged, 1); assert.equal(dry.errors.length, 1); assert.equal(dry.newRacksBins, 1);
  assert.equal(await M.Location.countDocuments({ locationCode: "RACK-E/BIN-07" }), 0);
  assert.equal((await api("post", "/api/import/rack-locations", { csv })).body.updated, 1);
  assert.equal((await api("get", "/api/parts")).body.find((p) => p.partNumber === "AE-A-2").rackLocation, "RACK-E / BIN-07");
  assert.equal((await api("post", "/api/import/rack-locations", { csv })).body.unchanged, 2);
});
test("BOM Excel import: own IDs + RACK LOCATION column; BOM shows racks; saved racks are not overwritten", async () => {
  const rows = [["PART NO", "DESCRIPTION", "QTY", "RACK LOCATION"], ["AE-200", "Controller", 1, "RACK-F / BIN-01"], ["AE-A-2", "Existing part", 2, "RACK-Z / BIN-99"], ["AE-100", "Wiring harness main", 1, "RACK-D / BIN-02"], ["AE-201", "Fuse box", 1, ""]];
  const dry = (await api("post", "/api/import/bom-excel", { model: "BUZZ", revision: "REV-X", changeReason: "t", rows, dryRun: true })).body;
  assert.equal(dry.rack.linesWithRack, 3); assert.equal(dry.rackErrors.length, 0); assert.equal(dry.rack.differentFromSaved, 1); assert.equal(dry.createdWithGivenId, 2);
  assert.equal(await M.PartMaster.countDocuments({ partNumber: "AE-200" }), 0);
  const bad = await api("post", "/api/import/bom-excel", { model: "BUZZ", revision: "REV-X", changeReason: "t", rows: [["PART NO", "DESCRIPTION", "QTY", "RACK"], ["AE-300", "X", 1, "NOSLASH"]] });
  assert.equal(bad.status, 400); assert.match(bad.body.message, /RACK-A \/ BIN-12/);
  const real = await api("post", "/api/import/bom-excel", { model: "BUZZ", revision: "REV-X", changeReason: "t", rows }); assert.equal(real.status, 201, JSON.stringify(real.body));
  const revs = (await api("get", "/api/bom/BUZZ/revisions")).body; const rev = revs.find((r) => r.revision === "REV-X"); const by = Object.fromEntries(rev.items.map((i) => [i.partNumber, i.rackLocation]));
  assert.equal(by["AE-200"], "RACK-F / BIN-01"); assert.equal(by["AE-201"], ""); assert.equal(by["AE-100"], "RACK-D / BIN-02"); assert.equal(by["AE-A-2"], "RACK-E / BIN-07"); // not RACK-Z
  const csv = (await api("get", "/api/export/bom")).text; assert.ok(/Rack location/.test(csv)); // current revision may not be set yet; header must exist
});
test("sample IDs (MECH-0001, TMP-) can be replaced by your own IDs; real IDs cannot", async () => {
  await api("post", "/api/parts", part({ partNumber: "MECH-0001", partName: "Sample chassis" })); await api("post", "/api/parts", part({ partNumber: "MECH-0002", partName: "Sample frame" }));
  const m1 = await M.PartMaster.findOne({ partNumber: "MECH-0001" });
  const list = (await api("get", "/api/parts")).body; assert.equal(list.find((p) => p.partNumber === "MECH-0001").placeholderId, true); assert.equal(list.find((p) => p.partNumber === "AE-100").placeholderId, false);
  assert.equal((await api("post", `/api/parts/${m1._id}/assign-number`, { partNumber: "a|b" })).status, 400);
  assert.equal((await api("post", `/api/parts/${m1._id}/assign-number`, { partNumber: "ae-chs-0001" })).body.partNumber, "AE-CHS-0001");
  const csv = "currentPartNumber,newPartNumber\nMECH-0002,AE-FRM-0001\nAE-100,AE-NEW\nMECH-0002,AE-X\n";
  const r = (await api("post", "/api/import/part-ids", { csv })).body; assert.equal(r.updated, 1); assert.ok(r.errors.some((e) => /real part ID/.test(e.message)));
  assert.ok(await M.PartMaster.findOne({ partNumber: "AE-FRM-0001" })); assert.equal(await M.PartMaster.countDocuments({ partNumber: "AE-100" }), 1);
});
test("renaming a temporary part updates its BOM lines everywhere", async () => {
  const rows = [["DESCRIPTION", "QTY"], ["Mystery bracket", 3]];
  const r = await api("post", "/api/import/bom-excel", { model: "LITE", revision: "REV-T", changeReason: "t", rows }); assert.equal(r.status, 201, JSON.stringify(r.body));
  const tmp = await M.PartMaster.findOne({ partName: "Mystery bracket" }); assert.match(tmp.partNumber, /^TMP-\d{5}$/); assert.equal(tmp.provisional, true);
  const out = (await api("post", "/api/import/part-ids", { csv: `partName,newPartNumber\nMystery bracket,AE-BRK-0001\n` })).body; assert.equal(out.updated, 1, JSON.stringify(out));
  const rev = (await api("get", "/api/bom/LITE/revisions")).body.find((x) => x.revision === "REV-T"); assert.equal(rev.items[0].partNumber, "AE-BRK-0001"); assert.equal(rev.items[0].placeholderId, false);
});
