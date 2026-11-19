// Material handover: PENDING -> ACKNOWLEDGED | REFUSED ; ACKNOWLEDGED -> RETURNED (fully or partly).
// Stock sits in IN-TRANSIT until the RECIPIENT acknowledges - it is never shown as received before that.
// Someone else (a supervisor) may answer for the recipient only with an override reason, recorded in the override register and audit trail,
// and with a named witness when HANDOVER_WITNESS_REQUIRED=true.
const { Handover, User, MaterialItem } = require("../models");
const { BusinessError, notFound, invalid, forbidden } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const ledger = require("./ledger");
const sm = require("./stateMachine");
const config = require("../config");
const { findSpecial } = require("./locations");
const { getItem, getLocation } = require("./materials");
const { nextId } = require("./counters");
const { can, P } = require("./permissions");
const { reservedQty, binQty } = require("./reservations");
const fifo = require("./fifo");
const { guarded, logOverride } = require("./overrides");
const { claim: claimVersion } = require("./claims");
const s = (v) => (v == null ? "" : String(v).trim());

async function create(user, body) {
  const lines = Array.isArray(body.lines) && body.lines.length ? body.lines : [{ materialItemId: body.materialItemId, quantity: body.quantity, fromLocation: body.fromLocation }];
  if (!s(body.purpose)) throw invalid("Purpose is required.");
  const to = await User.findById(body.toUserId).catch(() => null);
  if (!to || to.active === false) throw invalid("Recipient not found.");
  if (String(to._id) === String(user.id)) throw invalid("You cannot hand material over to yourself.");
  const seen = new Set();
  const prepared = [];
  for (const [i, ln] of lines.entries()) {
    const item = await getItem(ln.materialItemId);
    sm.assertIssuable(item);                                   // only APPROVED stock can be handed over (not Hold / Rejected / in QC)
    if (seen.has(String(item._id))) throw invalid(`Line ${i + 1}: the same material appears twice.`);
    seen.add(String(item._id));
    const from = await getLocation(ln.fromLocation);
    if (!["BIN", "WIP"].includes(from.type)) throw new BusinessError("INVALID_SOURCE", "Handover must originate from a storage bin or the WIP/issued area.");
    const qty = Number(ln.quantity);
    if (!(qty > 0)) throw new BusinessError("INVALID_QUANTITY", `Line ${i + 1}: quantity must be greater than zero.`, { status: 400 });
    const fifoErr = from.type === "BIN" ? await guarded(user, body.override, () => fifo.assertFifo(item)) : null;
    if (from.type === "BIN") { const resv = await reservedQty(item._id); const free = (await binQty(item._id)) - resv; if (resv > 0 && qty > free) throw new BusinessError("RESERVED_STOCK", `${Math.max(0, free)} unit(s) are free; the rest is reserved for a kit.`, { details: { free } }); }
    prepared.push({ item, from, qty, fifoErr });
  }
  const transit = await findSpecial("TRANSIT");
  return atomic(async (ctx) => {
    for (const p of prepared) if (p.from.type === "BIN") { // re-check reservations under a lock (see uow.lock)
      await ctx.lock(MaterialItem, p.item._id);
      const r2 = await reservedQty(p.item._id, null, ctx.session), f2 = (await binQty(p.item._id, ctx.session)) - r2;
      if (r2 > 0 && p.qty > f2) throw new BusinessError("RESERVED_STOCK", `${Math.max(0, f2)} unit(s) are free; the rest is reserved for a kit.`, { details: { free: f2 } });
    }
    const groupId = prepared.length > 1 ? await nextId("handovergroup", "HG", 6) : undefined;
    const made = [];
    for (const { item, from, qty, fifoErr } of prepared) {
      const handoverId = await nextId("handover", "HO", 6);
      const txn = await ledger.post(ctx, user, { type: "HANDOVER", item, qty, from: from._id, to: transit._id, fromStatus: item.status, toStatus: item.status, reason: `Handover ${handoverId} to ${to.name}: ${body.purpose}`, refType: "Handover", refId: handoverId, override: !!fifoErr });
      if (fifoErr) await logOverride(ctx, user, fifoErr, body.override, { operation: "HANDOVER", originalValue: { olderStock: fifoErr.details.suggested }, newValue: { handedOver: item.serialNumber || item.batchNumber }, referenceTransaction: txn.transactionId, entityType: "MaterialItem", entityId: item._id, entityLabel: item.serialNumber || item.batchNumber });
      const h = await ctx.create(Handover, {
        handoverId, groupId, materialItem: item._id, part: item.part, partNumber: item.partNumber, serialNumber: item.serialNumber, batchNumber: item.batchNumber,
        quantity: qty, fromUser: user.id, toUser: to._id, fromUserName: user.name, toUserName: to.name, fromLocation: from._id,
        department: s(body.department), purpose: s(body.purpose), status: "PENDING",
      });
      await audit(ctx, user, { action: "HANDOVER_CREATED", entityType: "Handover", entityId: h._id, entityLabel: handoverId, reason: body.purpose, after: { to: to.name, quantity: qty, material: item.serialNumber || item.batchNumber, group: groupId }, reference: txn.transactionId });
      made.push(h);
    }
    return made.length === 1 && !(Array.isArray(body.lines) && body.lines.length) ? made[0] : { groupId, handovers: made };
  });
}

async function find(id) {
  const h = /^[a-f\d]{24}$/i.test(String(id)) ? await Handover.findById(id) : await Handover.findOne({ handoverId: String(id) });
  if (!h) throw notFound("Handover", id);
  return h;
}
async function loadPending(id) {
  const h = await find(id);
  if (h.status !== "PENDING") throw new BusinessError("HANDOVER_CLOSED", `Handover is already ${h.status}.`);
  return h;
}

// Who is answering? The recipient, or (with override + reason, and a witness when required) someone else.
async function authorise(user, h, body) {
  if (String(h.toUser) === String(user.id)) return { onBehalf: false };
  const err = new BusinessError("HANDOVER_NOT_RECIPIENT", `Only the intended recipient (${h.toUserName}) can respond to this handover. A supervisor may respond on their behalf with a written reason.`, { status: 403, overridable: true, overrideKind: "HANDOVER_ON_BEHALF", overridePerm: P.OVERRIDE });
  const used = await guarded(user, body.override, async () => { throw err; });
  if (!(await can(user.role, P.OVERRIDE))) throw forbidden("Only the intended recipient can respond to this handover.");
  let witness = null;
  if (body.witnessUserId) {
    witness = await User.findById(body.witnessUserId).catch(() => null);
    if (!witness || witness.active === false) throw invalid("Witness not found.");
    if (String(witness._id) === String(user.id) || String(witness._id) === String(h.toUser)) throw invalid("The witness must be a different person from you and from the recipient.");
  } else if (config.requireHandoverWitness) throw new BusinessError("WITNESS_REQUIRED", "A witness is required when someone responds on the recipient's behalf.", { status: 400 });
  return { onBehalf: true, err: used || err, witness };
}
const respondFields = (user, who, body) => ({ respondedBy: user.id, respondedByName: user.name, onBehalf: who.onBehalf, ...(who.onBehalf ? { overrideReason: s(body.override && body.override.reason), witness: who.witness && who.witness._id, witnessName: who.witness && who.witness.name } : {}) });
async function logOnBehalf(ctx, user, who, body, h, txn) {
  if (who.onBehalf) await logOverride(ctx, user, who.err, body.override, { operation: "HANDOVER_RESPONSE", originalValue: { recipient: h.toUserName }, newValue: { respondedBy: user.name, witness: who.witness && who.witness.name }, referenceTransaction: txn.transactionId, entityType: "Handover", entityId: h._id, entityLabel: h.handoverId });
}

async function ackIn(ctx, user, h, body, who) {
  const item = await getItem(h.materialItem);
  const transit = await findSpecial("TRANSIT"); const wip = await findSpecial("WIP");
  await claimVersion(ctx, h, "RESPOND");
  const claimed = await ctx.set(Handover, h._id, { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgementNote: s(body.note), ...respondFields(user, who, body) }, { status: "PENDING" });
  if (!claimed) throw new BusinessError("HANDOVER_CLOSED", `Handover ${h.handoverId} was already answered.`);
  const txn = await ledger.post(ctx, user, { type: "HANDOVER", item, qty: h.quantity, from: transit._id, to: wip._id, fromStatus: item.status, toStatus: item.status, reason: `Acknowledged handover ${h.handoverId}${who.onBehalf ? " on behalf of " + h.toUserName : ""}`, refType: "Handover", refId: h.handoverId, override: who.onBehalf });
  await audit(ctx, user, { action: "HANDOVER_ACKNOWLEDGED", entityType: "Handover", entityId: h._id, entityLabel: h.handoverId, before: { status: "PENDING" }, after: { status: "ACKNOWLEDGED", onBehalf: who.onBehalf }, reason: who.onBehalf ? body.override.reason : undefined, reference: txn.transactionId, override: who.onBehalf });
  await logOnBehalf(ctx, user, who, body, h, txn);
  return txn;
}
async function refuseIn(ctx, user, h, body, who) {
  const item = await getItem(h.materialItem);
  const transit = await findSpecial("TRANSIT");
  await claimVersion(ctx, h, "RESPOND");
  const claimed = await ctx.set(Handover, h._id, { status: "REFUSED", refusedAt: new Date(), refusalReason: s(body.reason), ...respondFields(user, who, body) }, { status: "PENDING" });
  if (!claimed) throw new BusinessError("HANDOVER_CLOSED", `Handover ${h.handoverId} was already answered.`);
  const txn = await ledger.post(ctx, user, { type: "RETURN", item, qty: h.quantity, from: transit._id, to: h.fromLocation, fromStatus: item.status, toStatus: item.status, reason: `Handover ${h.handoverId} refused: ${body.reason}`, refType: "Handover", refId: h.handoverId, override: who.onBehalf });
  await audit(ctx, user, { action: "HANDOVER_REFUSED", entityType: "Handover", entityId: h._id, entityLabel: h.handoverId, reason: body.reason, before: { status: "PENDING" }, after: { status: "REFUSED", onBehalf: who.onBehalf }, reference: txn.transactionId, override: who.onBehalf });
  await logOnBehalf(ctx, user, who, body, h, txn);
  return txn;
}

async function acknowledge(user, id, body = {}) {
  const h = await loadPending(id); const who = await authorise(user, h, body);
  return atomic(async (ctx) => { const txn = await ackIn(ctx, user, h, body, who); return { ok: true, status: "ACKNOWLEDGED", onBehalf: who.onBehalf, transaction: txn }; });
}
async function refuse(user, id, body = {}) {
  if (!s(body.reason)) throw new BusinessError("REFUSAL_REASON_REQUIRED", "A reason is mandatory when refusing a handover.", { status: 400 });
  const h = await loadPending(id); const who = await authorise(user, h, body);
  return atomic(async (ctx) => { const txn = await refuseIn(ctx, user, h, body, who); return { ok: true, status: "REFUSED", onBehalf: who.onBehalf, transaction: txn }; });
}
// answer every pending line of a multi-item handover in one go (all or nothing)
async function respondGroup(user, groupId, kind, body = {}) {
  if (kind === "refuse" && !s(body.reason)) throw new BusinessError("REFUSAL_REASON_REQUIRED", "A reason is mandatory when refusing a handover.", { status: 400 });
  const list = await Handover.find({ groupId: s(groupId), status: "PENDING" });
  if (!list.length) throw notFound("Pending handover group", groupId);
  const who = await authorise(user, list[0], body);
  return atomic(async (ctx) => { const out = []; for (const h of list) out.push((kind === "refuse" ? await refuseIn(ctx, user, h, body, who) : await ackIn(ctx, user, h, body, who)).transactionId); return { ok: true, status: kind === "refuse" ? "REFUSED" : "ACKNOWLEDGED", count: list.length, onBehalf: who.onBehalf, transactions: out }; });
}

// Material the recipient no longer needs goes back to Receiving (then normal put-away). Fully returned = RETURNED.
async function returnHandover(user, id, body = {}) {
  if (!s(body.reason)) throw invalid("A reason is required to return material.");
  const h = await find(id);
  if (h.status !== "ACKNOWLEDGED") throw new BusinessError("INVALID_STATE_TRANSITION", `Only acknowledged material can be returned (handover is ${h.status}).`);
  if (![String(h.toUser), String(h.fromUser)].includes(String(user.id)) && !(await can(user.role, P.RETURN))) throw forbidden("Only the recipient, the issuer or a store user can return this material.");
  const remaining = h.quantity - (h.returnedQty || 0);
  const qty = body.quantity != null ? Number(body.quantity) : remaining;
  if (!(qty > 0) || qty > remaining) throw new BusinessError("INVALID_QUANTITY", `${remaining} unit(s) can still be returned; ${qty} requested.`, { status: 400 });
  const item = await getItem(h.materialItem);
  const wip = await findSpecial("WIP"); const receiving = await findSpecial("RECEIVING");
  return atomic(async (ctx) => {
    await claimVersion(ctx, h, "RETURN");
    const done = (h.returnedQty || 0) + qty >= h.quantity;
    const ok = await ctx.set(Handover, h._id, { returnedQty: (h.returnedQty || 0) + qty, returnReason: s(body.reason), returnedByName: user.name, ...(done ? { status: "RETURNED", returnedAt: new Date() } : {}) }, { status: "ACKNOWLEDGED", returnedQty: h.returnedQty || 0 });
    if (!ok) throw new BusinessError("CONCURRENT_UPDATE", `Handover ${h.handoverId} was changed by someone else at the same moment. Reload it.`);
    const txn = await ledger.post(ctx, user, { type: "RETURN", item, qty, from: wip._id, to: receiving._id, fromStatus: item.status, toStatus: item.status, reason: `Handover ${h.handoverId} returned: ${body.reason}`, refType: "Handover", refId: h.handoverId });
    await audit(ctx, user, { action: "HANDOVER_RETURNED", entityType: "Handover", entityId: h._id, entityLabel: h.handoverId, reason: body.reason, before: { status: "ACKNOWLEDGED", returnedQty: h.returnedQty || 0 }, after: { status: done ? "RETURNED" : "ACKNOWLEDGED", returnedQty: (h.returnedQty || 0) + qty }, reference: txn.transactionId });
    return { ok: true, status: done ? "RETURNED" : "ACKNOWLEDGED", returned: qty, remaining: h.quantity - (h.returnedQty || 0) - qty, transaction: txn, next: "PUT_AWAY" };
  });
}
module.exports = { create, acknowledge, refuse, respondGroup, returnHandover };
