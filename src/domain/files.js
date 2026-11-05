// Uploaded documents: the real bytes are checked, not just the type the browser claims.
const crypto = require("crypto");
const { FileBlob } = require("../models");
const { BusinessError, invalid } = require("./errors");

const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const INVOICE_MIMES = ["application/pdf", "image/jpeg", "image/png"];
const MAX_BYTES = 5 * 1024 * 1024;

// Returns the mime type the bytes really are, or null.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function store(user, { name, mime, dataBase64, purpose }) {
  if (!MIMES.includes(mime)) throw invalid("Only JPEG, PNG, WebP or PDF files are allowed.");
  const data = Buffer.from(dataBase64, "base64");
  if (!data.length || data.length > MAX_BYTES) throw invalid("File must be between 1 byte and 5 MB.");
  const real = sniff(data);
  if (!real || real !== mime) throw new BusinessError("FILE_CONTENT_MISMATCH", "The file content does not match its type. Upload a real PDF, JPEG, PNG or WebP file.", { status: 400 });
  if (purpose === "INVOICE" && !INVOICE_MIMES.includes(real)) throw invalid("An invoice must be a PDF, JPEG or PNG file.");
  const f = await FileBlob.create({ name, mime: real, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), purpose: purpose || undefined, data, uploadedBy: user.id });
  return f;
}

// The invoice document that must accompany every receipt. Checks it exists, is a genuine PDF/JPEG/PNG and has not been used before.
async function assertInvoiceFile(fileId, { usedBy } = {}) {
  if (!fileId || !/^[a-f\d]{24}$/i.test(String(fileId))) throw new BusinessError("INVOICE_ATTACHMENT_REQUIRED", "The invoice document (PDF, JPEG or PNG) must be attached. Material cannot be received without it.", { status: 400 });
  const f = await FileBlob.findById(fileId);
  if (!f) throw new BusinessError("INVOICE_ATTACHMENT_REQUIRED", "The attached invoice file was not found. Upload it again.", { status: 400 });
  const real = sniff(f.data);
  if (!real || !INVOICE_MIMES.includes(real)) throw new BusinessError("INVOICE_ATTACHMENT_INVALID", "The invoice attachment is not a valid PDF, JPEG or PNG file.", { status: 400 });
  if (usedBy) {
    const used = await usedBy(f._id);
    if (used) throw new BusinessError("INVOICE_ATTACHMENT_REUSED", `This invoice document is already attached to ${used}. Each receipt needs its own invoice document.`, { status: 409 });
  }
  return { file: f._id, name: f.name, mime: real, size: f.size, sha256: f.sha256 };
}
module.exports = { sniff, store, assertInvoiceFile, MIMES, INVOICE_MIMES, MAX_BYTES };
