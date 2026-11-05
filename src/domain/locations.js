const { Location, StockBalance, PartMaster } = require("../models");
const { BusinessError } = require("./errors");
const codes = require("./codes");

async function locationPath(loc) {
  const names = [loc.name];
  let cur = loc;
  for (let i = 0; i < 8 && cur.parentLocation; i++) {
    cur = await Location.findById(cur.parentLocation).lean();
    if (!cur) break;
    names.unshift(cur.name);
  }
  return names.join(" > ");
}

async function usedCapacity(locationId, opt = {}) {
  const rows = await StockBalance.aggregate([{ $match: { location: locationId } }, { $group: { _id: null, q: { $sum: "$quantity" } } }]);
  return rows.length ? rows[0].q : 0;
}

// Does this location accept this part/quantity? Returns null if OK, else a reason string.
async function rejectionReason(loc, part, qty) {
  if (!loc.active) return "Location is inactive";
  if (loc.allowedCategories && loc.allowedCategories.length && !loc.allowedCategories.includes(part.category))
    return `Location does not accept category ${part.category}`;
  if (loc.allowedPartTypes && loc.allowedPartTypes.length && !loc.allowedPartTypes.includes(part.trackingType))
    return `Location does not accept ${part.trackingType} tracked parts`;
  if (loc.capacity != null) {
    const used = await usedCapacity(loc._id);
    if (used + qty > loc.capacity) return `Location capacity exceeded (${used}/${loc.capacity})`;
  }
  return null;
}

// Storage rules come from the database: part default location -> part storage rule -> location rules.
async function resolveDestination(part, qty = 1) {
  const bins = async (q) => Location.find({ type: "BIN", active: true, ...q }).sort({ locationCode: 1 });
  const tried = [];
  if (part.defaultLocation) {
    const d = await Location.findById(part.defaultLocation);
    if (d) {
      const why = await rejectionReason(d, part, qty);
      if (!why) return d;
      tried.push(`${d.locationCode}: ${why}`);
    }
  }
  const rule = part.storageRule || {};
  const q = {};
  if (rule.store) q.store = rule.store;
  if (rule.zone) q.zone = rule.zone;
  if (rule.rack) q.rack = rule.rack;
  if (Object.keys(q).length) {
    for (const b of await bins(q)) { const why = await rejectionReason(b, part, qty); if (!why) return b; tried.push(`${b.locationCode}: ${why}`); }
  }
  for (const b of await bins({ allowedCategories: part.category })) {
    const why = await rejectionReason(b, part, qty); if (!why) return b; tried.push(`${b.locationCode}: ${why}`);
  }
  throw new BusinessError("NO_STORAGE_LOCATION", `No storage location is configured for ${part.partNumber}. Ask an administrator to set a default location or storage rule.`, { details: { tried } });
}

async function findSpecial(type) {
  const l = await Location.findOne({ type, active: true }).sort({ locationCode: 1 });
  if (!l) throw new BusinessError("SPECIAL_LOCATION_MISSING", `No active ${type} location configured. Run the seed or add one in Admin > Locations.`, { status: 500 });
  return l;
}


// ---------------------------------------------------------------------------------------------
// Rack location text, e.g. "RACK-A / BIN-12".
//   RACK-A            -> a RACK location (grouping node)
//   RACK-A/BIN-12     -> a BIN location under it. Its code is "<rack>/<bin>" so BIN-12 can exist in many racks.
// Typing an existing bin code that is not in this format (e.g. "E-08") also works.
// ---------------------------------------------------------------------------------------------
const TOKEN = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const tok = (v) => String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "-");
function parseRackBin(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  const bits = raw.split("/");
  if (bits.length !== 2 || !bits[0].trim() || !bits[1].trim())
    throw new BusinessError("BAD_RACK_LOCATION", `Rack location "${raw}" must look like RACK-A / BIN-12 (rack, a slash, then the bin).`, { status: 400 });
  const rack = tok(bits[0]), bin = tok(bits[1]);
  for (const [what, v] of [["rack", rack], ["bin", bin]])
    if (!TOKEN.test(v)) throw new BusinessError("BAD_RACK_LOCATION", `The ${what} "${v}" in "${raw}" may only use letters, numbers, dash, underscore and dot (max 40 characters).`, { status: 400 });
  return { rack, bin, code: `${rack}/${bin}`, label: `${rack} / ${bin}` };
}

// Human label for a location: "RACK-A / BIN-12". Older bins (seeded as E-08 etc.) show "<rack name> / <bin>".
function rackLabel(loc) {
  if (!loc || typeof loc !== "object") return "";
  if (loc.rack && loc.bin) return `${loc.rack} / ${loc.bin}`;
  return loc.path || loc.locationCode || "";
}

async function createOnce(data) {
  try { const l = await Location.create(data); l.path = await locationPath(l); l.qrCode = codes.locationPayload(l); await l.save(); return l; }
  catch (e) { if (e && e.code === 11000) return Location.findOne({ locationCode: data.locationCode }); throw e; }
}

// Returns the BIN location for the text, creating the rack and bin when they do not exist yet.
// Pass { dryRun: true } to only check: it returns { exists, label, code } and writes nothing.
async function ensureRackBin(input, { dryRun = false } = {}) {
  const raw = String(input == null ? "" : input).trim(); if (!raw) return null;
  if (!raw.includes("/")) { // maybe an existing bin code
    const old = await Location.findOne({ locationCode: raw.toUpperCase(), type: "BIN" });
    if (old) return dryRun ? { exists: true, label: rackLabel(old), code: old.locationCode } : old;
    throw new BusinessError("BAD_RACK_LOCATION", `Rack location "${raw}" must look like RACK-A / BIN-12 (rack, a slash, then the bin).`, { status: 400 });
  }
  const rb = parseRackBin(raw);
  let bin = await Location.findOne({ locationCode: rb.code });
  if (bin && bin.type !== "BIN") throw new BusinessError("BAD_RACK_LOCATION", `${rb.code} already exists as a ${bin.type}, not a bin.`, { status: 400 });
  if (dryRun) return { exists: !!bin, label: rb.label, code: rb.code };
  if (bin) return bin;
  let rack = await Location.findOne({ locationCode: rb.rack });
  if (rack && rack.type !== "RACK") throw new BusinessError("BAD_RACK_LOCATION", `${rb.rack} already exists as a ${rack.type}, not a rack. Use a different rack name.`, { status: 400 });
  if (!rack) rack = await createOnce({ locationCode: rb.rack, name: rb.rack, type: "RACK", rack: rb.rack });
  return createOnce({ locationCode: rb.code, name: rb.bin, type: "BIN", parentLocation: rack._id, store: rack.store, zone: rack.zone, rack: rb.rack, bin: rb.bin });
}

module.exports = { parseRackBin, rackLabel, ensureRackBin, locationPath, resolveDestination, rejectionReason, findSpecial, usedCapacity };
