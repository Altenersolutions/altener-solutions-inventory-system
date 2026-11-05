#!/usr/bin/env node
// Post-deploy smoke test.  node scripts/smoke.js <API_URL> <FRONTEND_ORIGIN> [email password]
// Checks health, DB + transactions, CORS from your Netlify origin, auth rules; with credentials it also logs in and reads core lists.
const [api, origin, email, password] = process.argv.slice(2);
if (!api || !origin) { console.error("usage: node scripts/smoke.js https://api.example.com https://site.netlify.app [email password]"); process.exit(2); }
const base = api.replace(/\/$/, ""); let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  - " + extra : ""}`); if (!ok) failed++; };
const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ r, body: await r.json().catch(() => null) }));
(async () => {
  const t0 = Date.now(); const h = await get("/api/health"); check("API health", h.r.status === 200, `${Date.now() - t0} ms (first call may be slow on a sleeping free plan)`);
  const rd = await get("/api/ready"); check("Database connected", rd.r.status === 200 && rd.body && rd.body.db === "connected");
  check("MongoDB transactions enabled (required in production)", rd.body && rd.body.transactions === true);
  const pre = await fetch(base + "/api/auth/login", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,idempotency-key" } });
  check("CORS allows your frontend origin", pre.headers.get("access-control-allow-origin") === origin, `got: ${pre.headers.get("access-control-allow-origin")}`);
  const bad = await fetch(base + "/api/auth/login", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  check("CORS refuses other origins", bad.headers.get("access-control-allow-origin") !== "https://evil.example");
  check("API refuses requests without a token (401)", (await get("/api/parts")).r.status === 401);
  check("Forged token refused (401)", (await get("/api/parts", { Authorization: "Bearer not.a.token" })).r.status === 401);
  check("Security headers present", !!h.r.headers.get("x-content-type-options"));
  const site = await fetch(origin, { redirect: "follow" }); const csp = site.headers.get("content-security-policy") || "";
  check("Frontend loads", site.status === 200);
  check("Frontend CSP allows the API origin", csp.includes(new URL(base).origin), csp ? "" : "no CSP header - _headers file not deployed?");
  if (email && password) {
    const lg = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password }) });
    const lb = await lg.json().catch(() => ({})); check("Login works", lg.status === 200 && !!lb.token, `status ${lg.status}`);
    if (lb.token) for (const p of ["/api/auth/me", "/api/parts", "/api/dashboard", "/api/locations"]) { const x = await get(p, { Authorization: `Bearer ${lb.token}` }); check(`GET ${p}`, x.r.status === 200, `status ${x.r.status}`); }
  } else console.log("SKIP  login checks (pass email and password as 3rd/4th argument)");
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed"); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("Smoke test crashed:", e.message); process.exit(1); });
