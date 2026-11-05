// Single source of truth for the release version: package.json. Bumped by hand only (never automatically).
const { version } = require("../package.json");
module.exports = { version, major: Number(String(version).split(".")[0]) };
