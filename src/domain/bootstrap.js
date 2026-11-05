// First-admin creation that cannot race: a unique "first-admin" claim row means only ONE caller can ever win,
// even if two requests (or two server instances) arrive at the same moment on an empty users table.
const bcrypt = require("bcryptjs");
const config = require("../config");
const { User, Setting } = require("../models");

async function createFirstAdmin({ name, emailId, password }) {
  if ((await User.estimatedDocumentCount()) > 0) return null;
  try { await Setting.create({ key: "first-admin-claim", value: { at: new Date() } }); }
  catch (e) { if (e && e.code === 11000) return null; throw e; }
  try {
    if ((await User.countDocuments()) > 0) return null; // someone created a user before the claim existed (older deployments)
    return await User.create({ name, emailId, role: "admin", passwordHash: await bcrypt.hash(password, config.bcryptRounds) });
  } catch (e) {
    await Setting.deleteOne({ key: "first-admin-claim" }); // creation failed: release the claim so setup can be retried
    throw e;
  }
}
module.exports = { createFirstAdmin };
