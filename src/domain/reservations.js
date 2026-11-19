const { Reservation, StockBalance } = require("../models");
async function reservedQty(itemId, excludeKit, session) {
  const q = { materialItem: itemId, status: "ACTIVE", ...(excludeKit && { kit: { $ne: excludeKit } }) };
  const query = Reservation.find(q);
  if (session) query.session(session);
  return (await query.lean()).reduce((t, r) => t + r.quantity, 0);
}
async function binQty(itemId, session) {
  const query = StockBalance.find({ materialItem: itemId, quantity: { $gt: 0 } }).populate("location", "type");
  if (session) query.session(session);
  const rows = await query.lean();
  return rows.filter((r) => r.location && r.location.type === "BIN").reduce((t, r) => t + r.quantity, 0);
}
module.exports = { reservedQty, binQty };
