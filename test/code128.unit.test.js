// No database needed.  node --test test/code128.unit.test.js
const test = require("node:test"); const assert = require("node:assert/strict");
const C = require("../src/domain/code128");

// Reference vectors produced by the python-barcode library (an independent implementation).
const REF = {"HELLO": "110100100001100010100010001101000100011011101000110111010001110110110001010001100011101011", "ABC-abc": "1101001000010100011000100010110001000100011010011011100100101100001001000011010000101100100110001001100011101011", "1234567890": "110100111001011001110010001011000111000101101100001010011011110110100111100101100011101011"};
test("matches the reference implementation", () => { for (const [text, bits] of Object.entries(REF)) assert.equal(C.modules(text), bits + "", text); });

// independent decoder: split into 11-module symbols, check start, checksum, stop, and read the text back
function decode(bits) {
  const STOP = C.STOP; assert.ok(bits.endsWith(STOP)); const body = bits.slice(0, -STOP.length); assert.equal(body.length % 11, 0);
  const vals = []; for (let i = 0; i < body.length; i += 11) { const k = C.PAT.indexOf(body.slice(i, i + 11)); assert.ok(k >= 0, "unknown symbol"); vals.push(k); }
  assert.ok([104, 105].includes(vals[0])); let sum = vals[0]; for (let i = 1; i < vals.length - 1; i++) sum += vals[i] * i; assert.equal(vals[vals.length - 1], sum % 103, "checksum");
  let mode = vals[0] === 105 ? "C" : "B", out = ""; for (const v of vals.slice(1, -1)) { if (v === 99) mode = "C"; else if (v === 100) mode = "B"; else out += mode === "C" ? String(v).padStart(2, "0") : String.fromCharCode(v + 32); }
  return out;
}
test("round trip with checksum for every kind of label text we print", () => {
  for (const t of ["MAT|AE-MTR-0042|R=REV-A|S=SN-0001", "MAT|X|R=REV-A|B=20260901", "LOC|RACK-A/BIN-12", "VEH|BUZZ-0001", "GRN-00012", "1234", "12345", "a1", "x123456789y", "A|B=C#~ {}"]) assert.equal(decode(C.modules(t)), t, t);
});
test("rejects text Code 128 subset B cannot hold, and empty text", () => { assert.throws(() => C.modules("caf\u00e9"), /not supported/); assert.throws(() => C.modules(""), /Nothing/); });
test("svg is well formed, keeps quiet zones, has bars only where the modules are 1", () => {
  const s = C.svg("HELLO", { height: 30 }); assert.match(s, /^<svg [^>]*viewBox="0 0 \d+ 30"/); const w = Number(/viewBox="0 0 (\d+)/.exec(s)[1]); assert.equal(w, C.modules("HELLO").length + 20);
  const bars = [...s.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]); assert.ok(bars[0][0] >= 10); assert.equal(bars.reduce((t, b) => t + b[1], 0), (C.modules("HELLO").match(/1/g) || []).length);
});
