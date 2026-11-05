const { TransitionClaim } = require("../models");
const { BusinessError } = require("./errors");
// Call first inside a unit of work, with the document exactly as it was read. Throws CONCURRENT_UPDATE if another request already acted on that same version.
async function claim(ctx, doc, tag) {
  if (!doc || !doc.updatedAt) return;
  try { await ctx.create(TransitionClaim, { key: `${doc._id}|${tag}|${new Date(doc.updatedAt).getTime()}` }); }
  catch (e) { if (e && e.code === 11000) throw new BusinessError("CONCURRENT_UPDATE", "This record was changed by someone else at the same moment. Reload it and check its status before trying again."); throw e; }
}
module.exports = { claim };
