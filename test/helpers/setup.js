// Preloaded into every test process (node --require). Two test-only conveniences, neither of which touches src/:
//  1. seed() is wrapped so tests get demo BOMs + vehicles (the real seed creates none).  require("seed").rawSeed is the unwrapped one.
//  2. POST /api/receiving gets a genuine PDF attached automatically unless the test sets __noInvoice (the backend now REQUIRES the attachment).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890-abcdef-0123456789";
const seedMod = require("../../src/scripts/seed");
if (!seedMod.rawSeed) {
  const raw = seedMod.seed; seedMod.rawSeed = raw;
  seedMod.seed = async (o) => { const r = await raw(o); await require("./fixtures").addTestBoms(); return r; };
}
const crypto = require("crypto");
let Test; try { Test = require("supertest/lib/test"); } catch { Test = null; }
if (Test && !Test.prototype.__autoInvoice) {
  const origEnd = Test.prototype.end; Test.prototype.__autoInvoice = true;
  Test.prototype.end = function (fn) {
    const self = this;
    if (self.method === "POST" && /\/api\/receiving$/.test(String(self.url)) && self._data && typeof self._data === "object") {
      if (self._data.__noInvoice) { delete self._data.__noInvoice; return origEnd.call(self, fn); }
      if (self._data.invoiceFileId === undefined) {
        const M = require("../../src/models");
        const data = Buffer.from(`%PDF-1.4\n% test invoice ${crypto.randomBytes(12).toString("hex")}\n%%EOF\n`);
        M.FileBlob.create({ name: "invoice.pdf", mime: "application/pdf", size: data.length, data, sha256: crypto.createHash("sha256").update(data).digest("hex"), purpose: "INVOICE" })
          .then((f) => { self._data.invoiceFileId = String(f._id); origEnd.call(self, fn); }, (e) => fn(e));
        return self;
      }
    }
    return origEnd.call(self, fn);
  };
}
