// Loads the capital assets register (src/data/assets.json). Assets only: no BOMs, parts, stock or vehicles.
//   npm run load:assets -- --dry-run     validate only, no database needed
//   npm run load:assets                  upsert into the database in MONGO_URI
const assetData = require("../data/assets.json");
const args = new Set(process.argv.slice(2));

function buildAssets() {
  return assetData.assets.map((a) => { const d = { ...a }; delete d.sourceRow; if (d.purchaseDate) d.purchaseDate = new Date(d.purchaseDate + "T00:00:00Z"); else delete d.purchaseDate; if (d.totalAmount == null) delete d.totalAmount; d.status = "IN_USE"; return d; });
}
function validateAssets(assets) {
  const M = require("../models"); const errors = []; const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.assetNo)) errors.push(`duplicate asset number ${a.assetNo}`); seen.add(a.assetNo);
    const e = new M.CapitalAsset(a).validateSync(); if (e) errors.push(`${a.assetNo}: ${e.message}`);
  }
  return errors;
}
async function main() {
  const assets = buildAssets(); const errors = validateAssets(assets);
  if (errors.length) { console.error(errors.slice(0, 30).join("\n")); process.exit(1); }
  if (args.has("--dry-run")) { console.log(`DRY RUN: ${assets.length} assets validate; nothing written.`); return; }
  const db = require("../db"); const M = require("../models"); await db.connect();
  const r = await M.CapitalAsset.bulkWrite(assets.map((a) => ({ updateOne: { filter: { assetNo: a.assetNo }, update: { $set: a }, upsert: true } })));
  console.log(`Done. Capital assets: ${r.upsertedCount} added, ${r.modifiedCount} updated.`);
}
module.exports = { buildAssets, validateAssets };
if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
