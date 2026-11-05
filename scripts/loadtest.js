#!/usr/bin/env node
// Simple load test (no dependencies).  node scripts/loadtest.js <API_URL> <email> <password> [concurrency=20] [seconds=20]
const [api, email, password, c = "20", secs = "20"] = process.argv.slice(2);
if (!api || !email || !password) { console.error("usage: node scripts/loadtest.js https://api email password [concurrency] [seconds]"); process.exit(2); }
const base = api.replace(/\/$/, ""); const paths = ["/api/parts?limit=50", "/api/dashboard", "/api/locations", "/api/materials?limit=50", "/api/auth/me"];
(async () => {
  const lg = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const { token } = await lg.json(); if (!token) { console.error("login failed", lg.status); process.exit(1); }
  const lat = [], errs = {}; const end = Date.now() + Number(secs) * 1000; let n = 0;
  const worker = async () => { while (Date.now() < end) { const p = paths[n++ % paths.length]; const t = performance.now();
    try { const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } }); await r.arrayBuffer(); lat.push(performance.now() - t); if (r.status >= 400) errs[r.status] = (errs[r.status] || 0) + 1; } catch (e) { errs.network = (errs.network || 0) + 1; } } };
  await Promise.all(Array.from({ length: Number(c) }, worker));
  lat.sort((a, b) => a - b); const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(0);
  console.log(`requests: ${lat.length}  (${(lat.length / Number(secs)).toFixed(0)}/s)  concurrency: ${c}\nlatency ms  p50: ${q(0.5)}  p95: ${q(0.95)}  p99: ${q(0.99)}  max: ${lat[lat.length - 1].toFixed(0)}\nerrors: ${JSON.stringify(errs)}`);
  const bad = Object.values(errs).reduce((a, b) => a + b, 0); console.log(bad === 0 && Number(q(0.95)) < 1500 ? "RESULT: PASS (no errors, p95 < 1.5 s)" : "RESULT: REVIEW"); process.exit(bad ? 1 : 0);
})();
