// Purchasing rules shared by receiving and purchase orders:
//   * over-receipt is checked on the TOTAL per part (several receipt lines of one part are added up)
//   * optional tolerance (PO_OVER_TOLERANCE_PCT), optional "PO required" (REQUIRE_PO_FOR_RECEIPT)
//   * same supplier + invoice number cannot be received twice (override with a reason)
//   * approved suppliers per part
//   * close a PO short, and print a GRN
const M = require("../models");
const config = require("../config");
const { BusinessError, notFound, invalid } = require("./errors");
const { audit } = require("./audit");
const { atomic } = require("./uow");
const Code128 = require("./code128");

const s = (v) => (v == null ? "" : String(v).trim());
const rx = (v) => new RegExp(`^${s(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// the supplier-specific price that is valid on a date (undefined when none is set / it has expired)
function priceFor(part, supplierId, at = new Date()) {
  const a = (part.approvedSuppliers || []).find((x) => String(x.supplier && x.supplier._id ? x.supplier._id : x.supplier) === String(supplierId));
  if (!a || a.price == null) return undefined;
  if ((a.priceValidFrom && new Date(a.priceValidFrom) > at) || (a.priceValidTo && new Date(a.priceValidTo) < at)) return undefined;
  return { price: a.price, currency: a.currency || "INR", moq: a.moq, leadTimeDays: a.leadTimeDays };
}
const overridable = (code, kind, message, details) => new BusinessError(code, message, { overridable: true, overrideKind: kind, details });

const duplicateInvoiceError = (supplier, invoiceNo, receiptNo) => overridable("DUPLICATE_INVOICE", "DUPLICATE_INVOICE", `Invoice ${invoiceNo} from ${supplier.name} ${receiptNo ? `was already received on ${receiptNo}` : "was just received by another request"}. Receiving it again could double the stock.`, { receiptNo });
// the key the database enforces: one receipt per supplier + invoice number (an approved override gets its own key)
const dedupKeyFor = (supplierId, invoiceNo) => `${supplierId}|${s(invoiceNo).toLowerCase().replace(/\s+/g, " ")}`;

// total quantity per part in this receipt
function totalsByPart(prepared) {
  const m = new Map();
  for (const p of prepared) { const k = String(p.part._id); const e = m.get(k) || { part: p.part, qty: 0 }; e.qty += p.qty; m.set(k, e); }
  return [...m.values()];
}

// Problems between a receipt and a PO. Empty array = fine.
function poIssues(po, prepared, tolPct = config.poOverTolerancePct) {
  const issues = [];
  for (const { part, qty } of totalsByPart(prepared)) {
    const lines = po.lines.filter((l) => String(l.part) === String(part._id));
    if (!lines.length) { issues.push(`${part.partNumber} is not on ${po.poNo}`); continue; }
    const ordered = lines.reduce((t, l) => t + l.orderedQty, 0), got = lines.reduce((t, l) => t + (l.receivedQty || 0), 0);
    const limit = ordered * (1 + (tolPct || 0) / 100);
    if (got + qty > limit + 1e-9) issues.push(`${part.partNumber}: ordered ${ordered}, already received ${got}, receiving ${qty}${tolPct ? ` (tolerance ${tolPct}%)` : ""}`);
  }
  return issues;
}

// Adds a received quantity to the PO lines of that part, filling the lines in order; any excess (an approved over-receipt) lands on the last line.
function allocate(lines, partId, qty) {
  const mine = lines.filter((l) => String(l.part) === String(partId)); let left = qty;
  for (const l of mine) { const take = Math.min(Math.max(0, l.orderedQty - (l.receivedQty || 0)), left); l.receivedQty = (l.receivedQty || 0) + take; left -= take; }
  if (left > 0 && mine.length) mine[mine.length - 1].receivedQty += left;
}

// All the "soft" rule breaks of a receipt, as overridable errors (the caller lets an authorised override pass them).
async function receiptIssues({ supplier, invoiceNo, prepared, po, poGiven }) {
  const out = [];
  const dup = await M.Receipt.findOne({ supplier: supplier._id, invoiceNo: rx(invoiceNo) }).select("receiptNo createdAt").lean();
  if (dup) out.push(duplicateInvoiceError(supplier, invoiceNo, dup.receiptNo));
  if (!poGiven && config.requirePoForReceipt) out.push(overridable("PO_REQUIRED", "NO_PO", "A purchase order number is required to receive material.", {}));
  const bad = totalsByPart(prepared).filter(({ part }) => (part.approvedSuppliers || []).length && !part.approvedSuppliers.some((a) => String(a.supplier) === String(supplier._id)));
  if (bad.length) {
    const names = new Map((await M.Supplier.find({ _id: { $in: bad.flatMap(({ part }) => part.approvedSuppliers.map((a) => a.supplier)) } }, "name").lean()).map((x) => [String(x._id), x.name]));
    const issues = bad.map(({ part }) => `${part.partNumber}: approved ${part.approvedSuppliers.map((a) => names.get(String(a.supplier)) || "?").join(", ")}`);
    out.push(overridable("SUPPLIER_NOT_APPROVED", "SUPPLIER_NOT_APPROVED", `${supplier.name} is not an approved supplier for: ${issues.join("; ")}.`, { issues }));
  }
  if (po) { const issues = poIssues(po, prepared); if (issues.length) out.push(overridable("PO_MISMATCH", "PO_MISMATCH", `Receipt does not match purchase order ${po.poNo}: ${issues.join("; ")}.`, { issues })); }
  return out;
}

// Purchase order creation: parts that have an approved-supplier list can only be ordered from those suppliers.
async function assertOrderable(supplier, partDocs) {
  const bad = partDocs.filter((p) => (p.approvedSuppliers || []).length && !p.approvedSuppliers.some((a) => String(a.supplier) === String(supplier._id)));
  if (bad.length) throw new BusinessError("SUPPLIER_NOT_APPROVED", `${supplier.name} is not an approved supplier for: ${bad.map((p) => p.partNumber).join(", ")}. Add the supplier to the part first (Parts → Suppliers).`, { status: 400 });
}

async function closeShort(user, id, reason) {
  const po = await M.PurchaseOrder.findById(id); if (!po) throw notFound("Purchase order");
  if (!["OPEN", "PARTIAL"].includes(po.status)) throw new BusinessError("PO_NOT_OPEN", `Purchase order ${po.poNo} is ${po.status}.`);
  if (s(reason).length < 5) throw new BusinessError("REASON_REQUIRED", "A reason (min 5 characters) is required to close a purchase order short.", { status: 400 });
  const got = po.lines.reduce((t, l) => t + (l.receivedQty || 0), 0);
  if (!got) throw new BusinessError("NOTHING_RECEIVED", "Nothing was received on this purchase order - cancel it instead.");
  const open = po.lines.map((l) => ({ partNumber: l.partNumber, outstanding: Math.max(0, l.orderedQty - (l.receivedQty || 0)) })).filter((l) => l.outstanding > 0);
  await atomic(async (ctx) => {
    await ctx.set(M.PurchaseOrder, po._id, { status: "CLOSED", closedShort: true, closeReason: s(reason), closedByName: user.name || "", closedAt: new Date() });
    await audit(ctx, user, { action: "PO_CLOSED_SHORT", entityType: "PurchaseOrder", entityId: po._id, entityLabel: po.poNo, reason: s(reason), before: { status: po.status }, after: { status: "CLOSED", outstanding: open } });
  });
  return { ok: true, poNo: po.poNo, outstanding: open };
}

// Printable GRN (goods received note), A4, with a Code 128 of the GRN number.
async function grnHtml(receiptId) {
  const r = /^[a-f\d]{24}$/i.test(String(receiptId)) ? await M.Receipt.findById(receiptId).lean() : await M.Receipt.findOne({ receiptNo: s(receiptId).toUpperCase() }).lean();
  if (!r) throw notFound("Receipt", receiptId);
  const sup = await M.Supplier.findById(r.supplier).lean(); const by = r.receivedBy ? await M.User.findById(r.receivedBy).select("name").lean() : null;
  const items = await M.MaterialItem.find({ receipt: r._id }).sort({ partNumber: 1, serialNumber: 1 }).lean();
  const parts = new Map((await M.PartMaster.find({ _id: { $in: r.lines.map((l) => l.part) } }, "partNumber partName unit").lean()).map((p) => [String(p._id), p]));
  const rows = r.lines.map((l, i) => {
    const p = parts.get(String(l.part)) || {}; const its = items.filter((x) => String(x.part) === String(l.part));
    const ids = its.map((x) => x.serialNumber || x.batchNumber).filter(Boolean); const st = [...new Set(its.map((x) => x.status))].join(", ");
    return `<tr><td>${i + 1}</td><td><b>${esc(p.partNumber)}</b><br>${esc(p.partName)}</td><td class="r">${esc(l.quantity)} ${esc(p.unit || "")}</td><td>${esc(ids.slice(0, 12).join(", "))}${ids.length > 12 ? ` … (+${ids.length - 12})` : ""}</td><td>${esc(st)}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.receiptNo)}</title><style>
  @page{size:A4;margin:14mm}body{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#111}h1{margin:0;font-size:22px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eee}.r{text-align:right}
  .top{display:flex;justify-content:space-between;align-items:flex-start}.bc{width:230px;height:46px}.meta td{border:none;padding:2px 8px 2px 0}.sig{display:flex;gap:30px;margin-top:60px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}</style></head><body>
  <div class="top"><div><h1>Goods Received Note</h1><b>${esc(r.receiptNo)}</b></div><div>${Code128.svg(r.receiptNo, { height: 40 }).replace("<svg ", '<svg class="bc" ')}</div></div>
  <table class="meta"><tr><td>Date</td><td><b>${esc(new Date(r.createdAt).toLocaleString("en-IN"))}</b></td><td>Supplier</td><td><b>${esc(sup && sup.name)}</b></td></tr>
  <tr><td>Invoice no.</td><td><b>${esc(r.invoiceNo)}</b>${r.invoiceDate ? ` (${esc(new Date(r.invoiceDate).toLocaleDateString("en-IN"))})` : ""}</td><td>PO no.</td><td><b>${esc(r.poNo || "-")}</b></td></tr>
  <tr><td>Received by</td><td><b>${esc(by && by.name)}</b></td><td>Notes</td><td>${esc(r.notes || "")}</td></tr></table>
  <table><thead><tr><th>#</th><th>Part</th><th class="r">Quantity</th><th>Serial / batch</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="sig"><div>Received by (Store)</div><div>Checked by (QC)</div><div>Supplier / delivery person</div></div>
  <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>`;
}
module.exports = { priceFor, duplicateInvoiceError, dedupKeyFor, poIssues, allocate, receiptIssues, assertOrderable, closeShort, grnHtml, totalsByPart };
