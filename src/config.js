require("dotenv").config();

const isProd = process.env.NODE_ENV === "production";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const config = {
  isProd,
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI || (isProd ? required("MONGO_URI") : "mongodb://127.0.0.1:27017/inventory"),
  // No hardcoded fallback: the server refuses to start without a secret.
  jwtSecret: process.env.JWT_SECRET || required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  requireTransactions: process.env.REQUIRE_TRANSACTIONS ? process.env.REQUIRE_TRANSACTIONS === "true" : isProd, // production refuses to run without MongoDB multi-document transactions
  maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS || 5),
  lockMinutes: Number(process.env.LOCK_MINUTES || 15),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // Bootstrap admin is only created by the seed script / first-run when no users exist.
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || "",
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || "",
  serveLegacy: process.env.SERVE_LEGACY !== "false",
  // Purchasing rules (all can be bypassed one receipt at a time by a user with override.approve + a written reason).
  // Your Part ID format. Default: an all-digit ID must have exactly 12 digits (Model 3 + Category 3 + Material 1 + Process 1 + Resource 1 + Serial 3);
  // IDs that contain letters (AE-MTR-0042) are accepted as they are. Set PART_ID_PATTERN to your own regular expression, or ".*" to accept anything.
  partIdPattern: new RegExp(process.env.PART_ID_PATTERN || "^(?:\\d{12}|.*\\D.*)$"),
  poOverTolerancePct: Number(process.env.PO_OVER_TOLERANCE_PCT || 0),            // allowed over-receipt on a PO line, in percent
  requirePoForReceipt: process.env.REQUIRE_PO_FOR_RECEIPT === "true",             // true = every receipt must name a purchase order
};

config.requireHandoverWitness = process.env.HANDOVER_WITNESS_REQUIRED === "true"; // true = a handover answered on someone else's behalf also needs a named witness
if (isProd && (config.jwtSecret.length < 32 || /change-me/i.test(config.jwtSecret))) throw new Error("JWT_SECRET must be a random string of at least 32 characters in production (the example value is not allowed)");
if (config.jwtSecret.length < 16) throw new Error("JWT_SECRET must be at least 16 characters");
if (isProd && !config.corsOrigins.length) console.warn("WARNING: CORS_ORIGINS is empty in production - browsers on another origin (your Netlify site) will be blocked. Set it to the frontend URL.");
module.exports = config;
