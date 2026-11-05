// Removes temporary / demo / placeholder data after checking what still refers to it.  DRY RUN unless --apply.
//   npm run cleanup:bom                                   list what would be removed and what is kept (and why)
//   npm run cleanup:bom -- --apply                        remove unreferenced temporary BOM revisions
//   npm run cleanup:bom -- --temp-parts --apply           ALSO remove temporary part numbers (TMP-xxxxx / "provisional") that nothing real refers to
//   npm run cleanup:bom -- --demo-stock --apply           ALSO remove the invented demo stock (receipts whose invoice starts with DEMO-, and their items, ledger rows, QC records, NCRs)
//   npm run cleanup:bom -- --demo-vehicles --apply        ALSO remove untouched demo vehicles (no installation, kit, QC or ledger history)
//   Combine them:  npm run cleanup:bom -- --demo-stock --temp-parts --demo-vehicles --apply
// Nothing that real work refers to is ever deleted: it is KEPT and listed with the reason, so you can decide.
// A revision is "temporary" when it was created by the demo seed ("Seed") or by the BOM.xlsx presentation loader.
const TEMP_REASON = /^seed$|^loaded from bom\.xlsx/i;
const DEMO_VEHICLES = ["BUZZ-0042", "LITE-0012", "RETRO-0007", "BUZZ-0001", "BUZZ-0002", "LITE-0001", "LITE-0002", "RETRO-0001"];
const PART_CHILDREN = new Set(["WmsQcTemplate", "WmsPartRevision", "WmsPartImage"]); // belong to the part: deleted with it
const ids = (a) => a.map((x) => x._id);

// every model + path that points at a part
function partRefs(mongoose) {
  const out = [];
  const walk = (schema, prefix, paths) => { for (const [p, t] of Object.entries(schema.paths)) { const ref = (t.options && t.options.ref) || (t.caster && t.caster.options && t.caster.options.ref); if (ref === "WmsPart") paths.push(prefix + p); if (t.schema) walk(t.schema, prefix + p + ".", paths); } };
  for (const name of mongoose.modelNames()) { const paths = []; walk(mongoose.model(name).schema, "", paths); if (paths.length) out.push({ name, model: mongoose.model(name), paths }); }
  return out;
}

async function demoStockPlan(M) {
  const receipts = await M.Receipt.find({ invoiceNo: /^DEMO-/ }).select("_id").lean();
  const rid = ids(receipts); const items = await M.MaterialItem.find({ receipt: { $in: rid } }).select("_id").lean(); const iid = ids(items);
  const blockers = (await M.Installation.countDocuments({ materialItem: { $in: iid } })) + (await M.Handover.countDocuments({ materialItem: { $in: iid } }));
  return { rid, iid, counts: { receipts: rid.length, items: iid.length, transactions: await M.InventoryTransaction.countDocuments({ materialItem: { $in: iid } }), qc: await M.QCInspection.countDocuments({ materialItem: { $in: iid } }), ncr: await M.Ncr.countDocuments({ materialItem: { $in: iid } }) }, blockers };
}

async function plan(M, opts = {}) {
  const mongoose = require("mongoose");
  const revs = (await M.BOMRevision.find().lean()).filter((r) => TEMP_REASON.test(String(r.changeReason || "").trim()));
  const keep = [], remove = [];
  for (const r of revs) {
    const refs = []; const vids = await M.Vehicle.find({ model: r.vehicleModel }).distinct("_id");
    const inst = await M.Installation.countDocuments({ bomRevision: r.revision, vehicle: { $in: vids } }); if (inst) refs.push(`${inst} installation record(s)`);
    const kits = await M.Kit.countDocuments({ bomRevision: r.revision, vehicle: { $in: vids } }); if (kits) refs.push(`${kits} kit(s)`);
    const progressed = await M.Vehicle.countDocuments({ model: r.vehicleModel, currentBOMRevision: r.revision, status: { $nin: ["PLANNED"] } }); if (progressed) refs.push(`${progressed} vehicle(s) already in production on it`);
    (refs.length ? keep : remove).push({ id: r._id, model: r.vehicleModel, revision: r.revision, status: r.status, lines: r.items.length, why: refs.join("; ") });
  }
  const veh = [];
  for (const num of DEMO_VEHICLES) {
    const v = await M.Vehicle.findOne({ vehicleNumber: num }).lean(); if (!v) continue;
    const refs = (await M.Installation.countDocuments({ vehicle: v._id })) + (await M.Kit.countDocuments({ vehicle: v._id })) + (await M.QCInspection.countDocuments({ vehicle: v._id })) + (await M.InventoryTransaction.countDocuments({ vehicle: v._id }));
    veh.push({ id: v._id, vehicleNumber: num, status: v.status, history: refs });
  }
  const demo = opts.demoStock ? await demoStockPlan(M) : null;
  // temporary parts: what is left after the revisions / demo stock of THIS run are gone
  const tempParts = { remove: [], keep: [] };
  if (opts.tempParts) {
    const skip = {
      WmsBomRevision: { _id: { $nin: remove.map((r) => r.id) } },
      ...(demo ? { WmsMaterialItem: { _id: { $nin: demo.iid } }, WmsStockBalance: { materialItem: { $nin: demo.iid } }, WmsTransaction: { materialItem: { $nin: demo.iid } }, WmsQcInspection: { materialItem: { $nin: demo.iid } }, WmsNcr: { materialItem: { $nin: demo.iid } }, WmsReceipt: { _id: { $nin: demo.rid } } } : {}),
    };
    const refs = partRefs(mongoose).filter((r) => !PART_CHILDREN.has(r.name));
    for (const p of await M.PartMaster.find({ $or: [{ provisional: true }, { partNumber: /^TMP-/ }] }).lean()) {
      const why = [];
      for (const r of refs) { const n = await r.model.countDocuments({ $and: [{ $or: r.paths.map((x) => ({ [x]: p._id })) }, skip[r.name] || {}] }); if (n) why.push(`${n} in ${r.name.replace(/^Wms/, "")}`); }
      (why.length ? tempParts.keep : tempParts.remove).push({ id: p._id, partNumber: p.partNumber, name: p.partName, why: why.join("; ") });
    }
  }
  return { remove, keep, vehicles: veh, demo, tempParts };
}

async function run({ apply = false, demoVehicles = false, demoStock = false, tempParts = false, log = console.log } = {}) {
  const mongoose = require("mongoose"); const M = require("../models"); const { audit } = require("../domain/audit");
  const p = await plan(M, { demoStock, tempParts });
  log(`${apply ? "APPLY" : "DRY RUN"}: ${p.remove.length} temporary BOM revision(s) removable, ${p.keep.length} kept because they are referenced.`);
  p.remove.forEach((r) => log(`  remove  ${r.model} ${r.revision} (${r.status}, ${r.lines} lines)`));
  p.keep.forEach((r) => log(`  KEEP    ${r.model} ${r.revision}: ${r.why}`));
  const vehRemovable = p.vehicles.filter((v) => v.history === 0);
  p.vehicles.forEach((v) => log(`  vehicle ${v.vehicleNumber} (${v.status}): ${v.history ? "KEEP - has history" : demoVehicles ? "remove" : "removable with --demo-vehicles"}`));
  if (p.demo) { log(`  demo stock: ${JSON.stringify(p.demo.counts)}${p.demo.blockers ? ` - ${p.demo.blockers} installation/handover record(s) use it, so it will NOT be wiped` : ""}`); }
  if (opts_tempLog(p, tempParts, log), !apply) return { ...p, applied: false };
  const done = { revisions: 0, boms: [], parts: 0, demo: null, vehicles: [] };
  const del = async (Model, filter) => (await Model.collection.deleteMany(filter)).deletedCount; // raw: the ledger / QC collections are append-only for the app
  if (p.demo && !p.demo.blockers && p.demo.rid.length) {
    const iid = p.demo.iid;
    done.demo = { transactions: await del(M.InventoryTransaction, { materialItem: { $in: iid } }), qc: await del(M.QCInspection, { materialItem: { $in: iid } }), ncr: await del(M.Ncr, { materialItem: { $in: iid } }), balances: await del(M.StockBalance, { materialItem: { $in: iid } }), items: await del(M.MaterialItem, { _id: { $in: iid } }), receipts: await del(M.Receipt, { _id: { $in: p.demo.rid } }) };
    log(`  removed demo stock: ${JSON.stringify(done.demo)}`);
  }
  for (const r of p.remove) { await M.BOMRevision.deleteOne({ _id: r.id }); done.revisions++; }
  for (const bom of await M.BOM.find()) {
    if (!p.remove.some((r) => r.model === bom.vehicleModel)) continue;
    const left = await M.BOMRevision.find({ bom: bom._id }).lean();
    const approved = left.filter((x) => x.status === "APPROVED").sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)))[0];
    if (!left.length) { await M.BOM.deleteOne({ _id: bom._id }); done.boms.push(bom.vehicleModel); } else await M.BOM.updateOne({ _id: bom._id }, { $set: { currentRevision: approved ? approved.revision : undefined } });
  }
  if (demoVehicles) for (const v of vehRemovable) { await M.Vehicle.deleteOne({ _id: v.id }); done.vehicles.push(v.vehicleNumber); }
  if (tempParts) for (const t of p.tempParts.remove) {
    // re-check right before deleting: something real may have started using it since the plan was made
    let used = 0; for (const r of partRefs(mongoose).filter((x) => !PART_CHILDREN.has(x.name))) used += await r.model.countDocuments({ $or: r.paths.map((x) => ({ [x]: t.id })) });
    if (used) { log(`  KEEP    ${t.partNumber}: now referenced (${used})`); continue; }
    for (const name of PART_CHILDREN) await mongoose.model(name).collection.deleteMany({ part: t.id });
    await M.PartMaster.collection.deleteOne({ _id: t.id }); done.parts++;
  }
  await audit(null, { id: null, name: "cleanup script", role: "system" }, { action: "TEMP_BOM_CLEANUP", entityType: "BOM", entityLabel: "temporary BOM data", reason: "Release 1.0.0: temporary / demo data removed",
    after: { revisionsRemoved: p.remove.map((r) => `${r.model} ${r.revision}`), bomsRemoved: done.boms, kept: p.keep.map((r) => `${r.model} ${r.revision}`), vehiclesRemoved: done.vehicles, tempPartsRemoved: tempParts ? p.tempParts.remove.map((x) => x.partNumber) : [], tempPartsKept: tempParts ? p.tempParts.keep.map((x) => x.partNumber) : [], demoStock: done.demo } });
  log("Done.");
  return { ...p, applied: true, removedBoms: done.boms, removedParts: done.parts, removedDemo: done.demo };
}
function opts_tempLog(p, tempParts, log) {
  if (!tempParts) return;
  log(`  temporary parts: ${p.tempParts.remove.length} removable, ${p.tempParts.keep.length} kept because real records use them.`);
  p.tempParts.remove.slice(0, 40).forEach((t) => log(`    remove  ${t.partNumber}  ${t.name || ""}`)); if (p.tempParts.remove.length > 40) log(`    ... and ${p.tempParts.remove.length - 40} more`);
  p.tempParts.keep.forEach((t) => log(`    KEEP    ${t.partNumber}: ${t.why}`));
}
module.exports = { run, plan, TEMP_REASON };
if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  require("../db").connect().then(() => run({ apply: args.has("--apply"), demoVehicles: args.has("--demo-vehicles"), demoStock: args.has("--demo-stock"), tempParts: args.has("--temp-parts") })).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
