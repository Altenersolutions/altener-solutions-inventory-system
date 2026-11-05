// Frontend smoke test in a simulated browser (jsdom) against the real backend. Needs a MongoDB on 127.0.0.1:27017.
// Run:  npm i jsdom --no-save && FE_DIR=/path/to/frontend node tools/frontend-smoke.js   (prints PASS/FAIL lines)
process.env.JWT_SECRET = "test-secret-1234567890-abcdef-0123456789"; process.env.LOGIN_RATE_LIMIT = "100000"; process.env.RATE_LIMIT = "1000000";
const be = process.env.BE_DIR || require("path").join(__dirname, ".."); require(be + "/test/helpers/setup.js");
const { JSDOM } = require("jsdom"); const http = require("http"); const path = require("path");
const db = require(be + "/src/db"); const { createApp } = require(be + "/src/app"); const { seed } = require(be + "/src/scripts/seed"); const M = require(be + "/src/models");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = []; const ok = (name, cond, extra = "") => { results.push([cond ? "PASS" : "FAIL", name, extra]); };
(async () => {
  await db.connect("mongodb://127.0.0.1:27017/fe_smoke_" + Date.now()); await seed({ quiet: true });
  const fs = require("fs"); const mime = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
  const stat = http.createServer((req, res) => { const p = path.join((process.env.FE_DIR || "../../frontend"), req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]); fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": mime[path.extname(p)] || "application/octet-stream" }); res.end(b); }); }).listen(5000);
  const server = http.createServer(createApp()).listen(4055); const API = "http://127.0.0.1:4055";
  const login = await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "ChangeMe#2026" }) })).json();
  const open = async (hash) => {
    const dom = await JSDOM.fromFile(path.join(process.env.FE_DIR || "../../frontend", "index.html"), { url: "http://localhost:5000/" + hash, runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
      beforeParse(w) { w.localStorage.setItem("wms_token", login.token); w.localStorage.setItem("wms_user", JSON.stringify({ _id: login._id, name: login.name, role: login.role, permissions: login.permissions })); w.fetch = (u, o) => fetch(String(u).replace("https://aspl-new.onrender.com", API), o); w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, addEventListener() {} })); w.scrollTo = () => {}; w.HTMLCanvasElement.prototype.getContext = () => null; w.print = () => {}; },
    });
    dom.window.addEventListener("error", (e) => results.push(["JSERR", e.message, ""])); await sleep(1800); return dom;
  };
  const fire = (w, el, type = "change") => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  // ---- receiving with invoice document
  let dom = await open("#/receiving"); let w = dom.window, d = w.document;
  ok("version shown in sidebar", /Version 1\.0\.0/.test(d.body.textContent), (d.getElementById("ver") || {}).textContent);
  ok("receiving form has invoice document input", !!d.getElementById("r-file"));
  const pn = d.querySelector('[data-k="partNumber"]'); pn.value = "M8-NUT"; fire(w, pn); await sleep(200);
  d = w.document; d.getElementById("r-inv").value = "SMOKE-INV-1";
  const q = d.querySelector('[data-k="quantity"]'); q.value = "5"; fire(w, q); const bt = d.querySelector('[data-k="batchNumber"]'); if (bt) { bt.value = "SMK1"; fire(w, bt); }
  d.getElementById("r-go").click(); await sleep(600);
  ok("no invoice file -> refused in the UI, nothing received", (await M.Receipt.countDocuments()) === 0);
  const f = new w.File([Buffer.from("%PDF-1.4\n% smoke\n%%EOF\n")], "inv.pdf", { type: "application/pdf" }); const fi = d.getElementById("r-file"); Object.defineProperty(fi, "files", { value: [f], configurable: true }); fire(w, fi); await sleep(100);
  d.getElementById("r-go").click(); await sleep(2500);
  const rc = await M.Receipt.findOne().lean(); ok("receipt created through the UI with the invoice attached", !!rc && !!rc.invoiceFile && String(rc.invoiceFile.mime) === "application/pdf", JSON.stringify(rc && rc.invoiceFile && { name: rc.invoiceFile.name, size: rc.invoiceFile.size }));
  ok("UI shows success banner", /Received GRN/.test(d.getElementById("r-out").textContent), d.getElementById("r-out").textContent.slice(0, 80)); dom.window.close();
  // ---- vehicle lifecycle buttons
  await M.Vehicle.updateOne({ vehicleNumber: "LITE-0012" }, { $set: { status: "QC_APPROVED" } });
  await M.QCInspection.create({ inspectionId: "QC-SMOKE1", vehicle: (await M.Vehicle.findOne({ vehicleNumber: "LITE-0012" }))._id, inspectionType: "FINAL", result: "PASS", remarks: "seed" });
  dom = await open("#/assembly/LITE-0012"); w = dom.window; d = w.document; const btns = () => [...d.querySelectorAll("button")].map((b) => b.textContent.trim());
  ok("QC_APPROVED vehicle shows Release, hides Final QC", btns().includes("Release vehicle") && !btns().includes("Dispatch vehicle") && d.querySelector("#b-fin").style.display === "none", btns().join(" | ").slice(0, 160));
  [...d.querySelectorAll("button")].find((b) => b.textContent.trim() === "Release vehicle").click(); await sleep(400);
  const go = [...d.querySelectorAll(".modal button")].find((b) => /^Release$/.test(b.textContent.trim())); ok("release dialog opens", !!go); if (go) { go.click(); await sleep(1800); }
  ok("vehicle RELEASED via UI", (await M.Vehicle.findOne({ vehicleNumber: "LITE-0012" })).status === "RELEASED", (await M.Vehicle.findOne({ vehicleNumber: "LITE-0012" })).status);
  ok("RELEASED vehicle now offers Dispatch", btns().includes("Dispatch vehicle"), btns().join(" | ").slice(0, 160)); dom.window.close();
  // ---- BOM page empty state
  await M.Vehicle.updateOne({ vehicleNumber: "LITE-0012" }, { $set: { status: "PLANNED" } }); // (a released vehicle would correctly make the cleanup KEEP its BOM)
  await require(be + "/src/scripts/cleanupTempBom").run({ apply: true, demoVehicles: false, log: () => {} });
  dom = await open("#/bom"); d = dom.window.document; ok("BOM page says 'No approved BOM uploaded yet.'", /No approved BOM uploaded yet\./.test(d.body.textContent)); dom.window.close();
  dom = await open("#/assembly/BUZZ-0042"); d = dom.window.document; ok("assembly page warns when the model has no approved BOM", /No approved BOM uploaded yet\./.test(d.body.textContent)); dom.window.close();
  for (const r of results) console.log(r.join(" | "));
  server.close(); stat.close(); process.exit(0);
})().catch((e) => { console.error("SMOKE ERROR", e); process.exit(1); });
