// Cleanup of temporary parts (TMP-xxxxx) and invented demo stock: removes only what nothing real refers to, keeps the rest and says why.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef-0123456789";
const test = require("node:test"); const assert = require("node:assert"); const { before, after } = test;
const mongoose = require("mongoose"); const db = require("../src/db"); const { seed } = require("../src/scripts/seed"); const M = require("../src/models"); const cleanup = require("../src/scripts/cleanupTempBom");
const stamp = Date.now(); const oid = () => new mongoose.Types.ObjectId();
before(async () => { await db.connect(`mongodb://127.0.0.1:27017/wms_v1clean2_${stamp}`); await seed({ quiet: true }); });
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

test("cleanup: temporary parts and demo stock - dry run changes nothing; apply removes only unreferenced ones", async () => {
  const mk = (n, extra = {}) => M.PartMaster.collection.insertOne({ _id: oid(), partNumber: n, partName: n + " name", provisional: true, trackingType: "BATCH", status: "ACTIVE", createdAt: new Date(), updatedAt: new Date(), ...extra }).then((r) => r.insertedId);
  const a = await mk("TMP-90001");                       // nothing refers to it
  const b = await mk("TMP-90002");                       // a REAL stock item refers to it
  const c = await mk("TMP-90003");                       // only a temporary BOM revision refers to it
  const d = await mk("TMP-90004");                       // only demo stock refers to it
  const real = await mk("PN-REAL-1", { provisional: false }); // an ordinary part is never touched
  await M.PartRevision.collection.insertOne({ _id: oid(), part: a, revision: "REV-A", status: "APPROVED" }); // child of A: goes with it
  await M.MaterialItem.collection.insertOne({ _id: oid(), part: b, partNumber: "TMP-90002", receipt: oid(), status: "APPROVED", quantity: 5, trackingType: "BATCH", batchNumber: "REAL1" });
  const bom = await M.BOM.create({ vehicleModel: "TMPM", name: "TMPM BOM" });
  await M.BOMRevision.create({ bom: bom._id, vehicleModel: "TMPM", revision: "REV-A", status: "APPROVED", changeReason: "Seed", effectiveDate: new Date(), items: [{ part: c, partNumber: "TMP-90003", requiredQuantity: 1, trackingType: "BATCH" }] });
  const rid = oid(), iid = oid();
  await M.Receipt.collection.insertOne({ _id: rid, receiptNo: "GRN-DEMO1", invoiceNo: "DEMO-INV-X-001", notes: "DEMO DATA - not a real receipt", lines: [{ part: d }] });
  await M.MaterialItem.collection.insertOne({ _id: iid, part: d, partNumber: "TMP-90004", receipt: rid, status: "APPROVED", quantity: 9, trackingType: "BATCH", batchNumber: "DEMO1" });
  await M.StockBalance.collection.insertOne({ _id: oid(), materialItem: iid, part: d, location: oid(), quantity: 9 });
  await M.InventoryTransaction.collection.insertOne({ _id: oid(), materialItem: iid, part: d, quantity: 9, transactionId: "TXN-DEMO1" });
  const count = async () => [await M.PartMaster.countDocuments(), await M.MaterialItem.countDocuments(), await M.BOMRevision.countDocuments(), await M.Receipt.countDocuments(), await M.PartRevision.countDocuments()];
  const before = await count();

  // dry run with everything switched on: lists, changes nothing
  const dry = await cleanup.run({ apply: false, tempParts: true, demoStock: true, log: () => {} });
  assert.deepEqual(await count(), before, "dry run must not change anything");
  const names = (l) => l.map((x) => x.partNumber).sort();
  assert.deepEqual(names(dry.tempParts.remove), ["TMP-90001", "TMP-90003", "TMP-90004"], "parts only the temporary data used become removable in the same run");
  assert.deepEqual(names(dry.tempParts.keep), ["TMP-90002"]); assert.match(dry.tempParts.keep[0].why, /MaterialItem/);
  // without --demo-stock the part used by demo stock is kept
  const noDemo = await cleanup.run({ apply: false, tempParts: true, log: () => {} }); assert.deepEqual(names(noDemo.tempParts.keep), ["TMP-90002", "TMP-90004"]);
  // without --temp-parts no part is touched
  await cleanup.run({ apply: true, log: () => {} }); assert.ok(await M.PartMaster.findById(a), "parts need the --temp-parts flag"); assert.equal(await M.BOMRevision.countDocuments({ vehicleModel: "TMPM" }), 0, "the temporary revision itself is removed");

  const logs = []; const res = await cleanup.run({ apply: true, tempParts: true, demoStock: true, log: (x) => logs.push(x) }); assert.equal(res.applied, true);
  assert.equal(await M.PartMaster.findOne({ partNumber: "TMP-90001" }), null); assert.equal(await M.PartMaster.findOne({ partNumber: "TMP-90003" }), null); assert.equal(await M.PartMaster.findOne({ partNumber: "TMP-90004" }), null);
  assert.ok(await M.PartMaster.findOne({ partNumber: "TMP-90002" }), "a temporary number with REAL stock is kept"); assert.ok(await M.PartMaster.findById(real), "ordinary parts are never touched");
  assert.equal(await M.PartRevision.countDocuments({ part: a }), 0, "the part's own revisions go with it");
  assert.equal(await M.Receipt.countDocuments({ invoiceNo: /^DEMO-/ }), 0); assert.equal(await M.MaterialItem.countDocuments({ batchNumber: "DEMO1" }), 0); assert.equal(await M.StockBalance.countDocuments({ materialItem: iid }), 0); assert.equal(await M.InventoryTransaction.countDocuments({ materialItem: iid }), 0);
  assert.equal(await M.MaterialItem.countDocuments({ batchNumber: "REAL1" }), 1, "real stock untouched");
  const log = await M.AuditLog.findOne({ action: "TEMP_BOM_CLEANUP" }).sort({ _id: -1 }).lean(); assert.ok(log && log.after.tempPartsRemoved.includes("TMP-90001") && log.after.tempPartsKept.includes("TMP-90002"));
  assert.equal((await cleanup.run({ apply: true, tempParts: true, demoStock: true, log: () => {} })).removedParts, 0, "running it again removes nothing");
});
