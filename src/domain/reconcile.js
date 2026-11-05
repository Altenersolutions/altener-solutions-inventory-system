// Stock accuracy check: do the stock balances equal the sum of the immutable transactions?
// Every stock change goes through the ledger, so any difference means something wrote to the database directly or a write was interrupted.
const M = require("../models");

async function stockReconciliation({ maxRows = 500 } = {}) {
  const ledger = new Map(); const add = (k, q) => ledger.set(k, (ledger.get(k) || 0) + q); let txns = 0;
  for await (const t of M.InventoryTransaction.find({ quantity: { $gt: 0 } }, "materialItem fromLocation toLocation quantity").lean().cursor()) {
    if (!t.materialItem) continue; txns++;
    if (t.toLocation && String(t.toLocation) !== String(t.fromLocation)) add(`${t.materialItem}|${t.toLocation}`, t.quantity);
    if (t.fromLocation && String(t.toLocation) !== String(t.fromLocation)) add(`${t.materialItem}|${t.fromLocation}`, -t.quantity);
  }
  const bal = new Map(); const negative = []; let balances = 0;
  for await (const b of M.StockBalance.find({}, "materialItem location quantity").lean().cursor()) { balances++; bal.set(`${b.materialItem}|${b.location}`, (bal.get(`${b.materialItem}|${b.location}`) || 0) + b.quantity); if (b.quantity < 0) negative.push(`${b.materialItem}|${b.location}`); }
  const diffs = [];
  for (const k of new Set([...ledger.keys(), ...bal.keys()])) { const l = ledger.get(k) || 0, b = bal.get(k) || 0; if (Math.abs(l - b) > 1e-9) diffs.push({ key: k, balance: b, ledger: l, difference: b - l }); }
  const total = diffs.length; const shown = diffs.slice(0, maxRows);
  const itemIds = [...new Set([...shown.map((d) => d.key.split("|")[0]), ...negative.map((k) => k.split("|")[0])])].filter((x) => /^[a-f\d]{24}$/i.test(x));
  const locIds = [...new Set([...shown.map((d) => d.key.split("|")[1]), ...negative.map((k) => k.split("|")[1])])].filter((x) => /^[a-f\d]{24}$/i.test(x));
  const items = new Map((await M.MaterialItem.find({ _id: { $in: itemIds } }, "partNumber serialNumber batchNumber").lean()).map((i) => [String(i._id), i]));
  const locs = new Map((await M.Location.find({ _id: { $in: locIds } }, "locationCode").lean()).map((l) => [String(l._id), l.locationCode]));
  const label = (k) => { const [i, l] = k.split("|"); const it = items.get(i) || {}; return { partNumber: it.partNumber || "(unknown item)", serialNumber: it.serialNumber || "", batchNumber: it.batchNumber || "", location: locs.get(l) || l }; };
  return { ok: total === 0 && negative.length === 0, checkedAt: new Date().toISOString(), transactions: txns, balances, mismatches: total, negativeBalances: negative.length,
    rows: shown.map((d) => ({ ...label(d.key), balance: d.balance, ledger: d.ledger, difference: d.difference })), negative: negative.slice(0, 50).map(label), truncated: total > shown.length };
}
module.exports = { stockReconciliation };
