const mongoose = require("mongoose");
const config = require("./config");
const db = require("./db");
const { createApp } = require("./app");
const { ensureBaseData } = require("./scripts/baseData");
const { closeRateLimitStores } = require("./middleware/rateLimitStore");

let server;
const log = (level, msg, extra) => console[level === "error" ? "error" : "log"](JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

// Render sends SIGTERM on every deploy/restart: stop taking new requests, let in-flight ones (stock movements!) finish, then close the DB.
let closing = false;
async function shutdown(signal) {
  if (closing) return; closing = true;
  log("info", `${signal} received - shutting down`);
  const force = setTimeout(() => { log("error", "forced exit after 25s"); process.exit(1); }, 25000); force.unref();
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeRateLimitStores();
    await mongoose.connection.close();
    log("info", "shutdown complete"); process.exit(0);
  } catch (e) { log("error", "shutdown failed", { error: e.message }); process.exit(1); }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log("error", "unhandledRejection", { error: reason && reason.message || String(reason), stack: reason && reason.stack }));
process.on("uncaughtException", (e) => { log("error", "uncaughtException", { error: e.message, stack: e.stack }); shutdown("uncaughtException"); });

(async () => {
  await db.connect();
  await ensureBaseData();          // special locations + first-run notice; never touches existing data
  if (process.env.SEED_ON_START === "true") {
    if (config.isProd) console.warn("SEED_ON_START is ignored in production: demo data never enters a production database.");
    else await require("./scripts/seed").seed({ quiet: false }); // development only: demo parts and locations (no BOMs, no vehicles)
  }
  const app = createApp();
  server = app.listen(config.port, () => log("info", `Server running on port ${config.port}`));
  server.keepAliveTimeout = 65000; // longer than Render's proxy idle timeout, avoids sporadic 502s
})().catch((e) => { console.error("Fatal:", e); process.exit(1); });
