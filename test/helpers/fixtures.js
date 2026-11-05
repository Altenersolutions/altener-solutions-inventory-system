// TEST-ONLY fixtures. The application seed creates no BOMs and no vehicles; tests that exercise assembly need them, so they are built here.
// Nothing under src/ imports this file, so it can never reach a production database.
const M = require("../../src/models");
const codes = require("../../src/domain/codes");

async function addTestBoms() {
  const part = async (n) => M.PartMaster.findOne({ partNumber: n });
  for (const model of ["BUZZ", "LITE", "RETROFIT"]) if (!(await M.BOM.findOne({ vehicleModel: model }))) await M.BOM.create({ vehicleModel: model, name: `${model} BOM` });
  const mkRev = async (model, revision, items, status = "APPROVED") => {
    const bom = await M.BOM.findOne({ vehicleModel: model });
    if (await M.BOMRevision.findOne({ bom: bom._id, revision })) return;
    const rows = []; for (const [pn, q, req] of items) { const p = await part(pn); rows.push({ part: p._id, partNumber: pn, requiredQuantity: q, requiredRevision: req, trackingType: p.trackingType, installationPosition: `${pn} position` }); }
    await M.BOMRevision.create({ bom: bom._id, vehicleModel: model, revision, effectiveDate: new Date(), status, approvedAt: new Date(), changeReason: "Seed", items: rows });
    if (status === "APPROVED") await M.BOM.updateOne({ _id: bom._id }, { $set: { currentRevision: revision } });
  };
  await mkRev("BUZZ", "REV-C", [["CTRL-001", 1, "REV-C"], ["RELAY-001", 2], ["JST-8P-F", 4], ["BOLT-M8", 8]]);
  await mkRev("LITE", "REV-A", [["CTRL-LITE", 1], ["RELAY-001", 1], ["BOLT-M8", 4]]);
  await mkRev("RETROFIT", "REV-A", [["CTRL-001", 1], ["JST-8P-F", 2]]);
  for (const [num, model] of [["BUZZ-0042", "BUZZ"], ["LITE-0012", "LITE"], ["RETRO-0007", "RETROFIT"]]) {
    if (await M.Vehicle.findOne({ vehicleNumber: num })) continue;
    const bom = await M.BOM.findOne({ vehicleModel: model });
    const v = await M.Vehicle.create({ vehicleNumber: num, model, vehicleType: model, project: "Pilot", currentBOMRevision: bom.currentRevision });
    v.qrCode = codes.vehiclePayload(v); await v.save();
  }
}
module.exports = { addTestBoms };
