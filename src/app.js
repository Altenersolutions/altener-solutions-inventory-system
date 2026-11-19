const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { authenticate, errorHandler, wrap, requestLog } = require("./middleware/common");
const appVersion = require("./version");
const auth = require("./routes/auth");
const workflows = require("./routes/workflows");
const master = require("./routes/master");
const extra = require("./routes/extra");
const assetsRoutes = require("./routes/assets");
const legacyRoutes = require("./legacy/routes");
const legacyActivity = require("./legacy/activityLog");
const { sharedStore } = require("./middleware/rateLimitStore");

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(requestLog);
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }));
  const corsBase = { exposedHeaders: ["X-Total-Count", "Content-Disposition"] };
  app.use(cors(config.corsOrigins.length ? { ...corsBase, origin: config.corsOrigins } : { ...corsBase, origin: !config.isProd }));
  app.use("/api/files", express.json({ limit: "8mb" })); // document / invoice uploads (base64)
  app.use(express.json({ limit: "1500kb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.RATE_LIMIT || 900), standardHeaders: true, legacyHeaders: false, store: sharedStore({ prefix: "wms:api", windowMs: 60 * 1000 }) }));

  // ---- public ----
  app.get("/api/health", (req, res) => res.json({ ok: true, version: appVersion.version }));
  app.get("/api/ready", (req, res) => { const up = require("mongoose").connection.readyState === 1; res.status(up ? 200 : 503).json({ ok: up, db: up ? "connected" : "down", transactions: require("./db").supportsTransactions() }); });
  app.get("/api/version", (req, res) => res.json({ version: appVersion.version, major: appVersion.major }));
  const loginBody = (req, res, next) => { const r = auth.loginBody.safeParse(req.body); if (!r.success) return res.status(400).json({ message: "email and password are required" }); req.body = r.data; next(); };
  app.post("/login", auth.loginLimiter, loginBody, auth.loginHandler);            // legacy path (existing frontend)
  app.post("/api/auth/login", auth.loginLimiter, loginBody, auth.loginHandler);
  app.use(auth.bootstrap); // POST /users allowed unauthenticated ONLY while zero users exist

  // static frontends (no auth needed for assets)
  const wmsDist = path.join(__dirname, "..", "..", "client", "dist");
  const legacyDist = path.join(__dirname, "..", "..", "legacy-ui");
  if (fs.existsSync(wmsDist)) {
    app.use("/wms", express.static(wmsDist));
    app.get(/^\/wms(\/.*)?$/, (req, res) => res.sendFile(path.join(wmsDist, "index.html")));
  }
  if (config.serveLegacy && fs.existsSync(legacyDist)) {
    app.use(express.static(legacyDist, { index: false }));
    // The legacy SPA shares URL names with its API (/users, /activity-log ...). Browser page loads
    // (Accept: text/html, no Authorization header) get the SPA; API calls carry a bearer token.
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.headers.authorization && !req.path.startsWith("/api") && (req.headers.accept || "").includes("text/html")) return res.sendFile(path.join(legacyDist, "index.html"));
      next();
    });
  }

  // ---- everything below needs a valid token ----
  app.use(authenticate);

  app.use("/api/auth", auth.authed);
  app.use("/users", legacyActivity, auth.users);      // legacy path
  app.use("/api/users", auth.users);
  app.use("/api", workflows);
  app.use("/api", master);
  app.use("/api", extra);
  app.use("/api", assetsRoutes);
  app.use("/", legacyActivity, legacyRoutes);

  app.use((req, res) => res.status(404).json({ message: "Not found" }));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
