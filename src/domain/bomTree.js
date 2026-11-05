// Multi-level BOM.
//   * A vehicle BOM (vehicleModel = BUZZ ...) lists parts. A part flagged isAssembly is a SUB-ASSEMBLY and has its own BOM
//     (BOM.assemblyPart = that part, BOM.vehicleModel = its part number). Sub-assemblies can contain sub-assemblies.
//   * A BOM line with `variants` only applies to those vehicle variants (empty = all).
//   * flatten() explodes everything down to the real components with total quantities. Kitting, assembly checks and planning all use it,
//     so a component of a sub-assembly is issued, installed and traced on the vehicle exactly like any other component.
const M = require("../models");
const { BusinessError } = require("./errors");
const MAX_DEPTH = 10;
const up = (v) => String(v == null ? "" : v).trim().toUpperCase();

const applies = (item, variant) => !(item.variants && item.variants.length) || (!!variant && item.variants.map(up).includes(up(variant)));

function makeCache() { return { parts: new Map(), boms: new Map(), revs: new Map() }; }
async function partInfo(cache, id) {
  const k = String(id); if (!cache.parts.has(k)) cache.parts.set(k, await M.PartMaster.findById(id, "partNumber partName isAssembly trackingType").lean());
  return cache.parts.get(k) || {};
}
async function assemblyRevision(cache, part, requiredRevision, { allowDraft = false } = {}) {
  const k = `${part._id}|${requiredRevision || ""}|${allowDraft}`; if (cache.revs.has(k)) return cache.revs.get(k);
  const bom = await M.BOM.findOne({ assemblyPart: part._id }).lean();
  const name = requiredRevision || (bom && bom.currentRevision);
  const rev = bom && name ? await M.BOMRevision.findOne({ bom: bom._id, revision: name }).lean() : null;
  if (!rev || (!allowDraft && !["APPROVED", "OBSOLETE"].includes(rev.status)))
    throw new BusinessError("ASSEMBLY_NO_BOM", `Sub-assembly ${part.partNumber} has no approved BOM${requiredRevision ? ` revision ${requiredRevision}` : ""}. Approve its BOM first.`, { status: 400, details: { assembly: part.partNumber } });
  cache.revs.set(k, rev); return rev;
}

// rows in tree order: { level, partId, partNumber, partName, isAssembly, qtyPer, qty (total), optional, requiredRevision, position, path[], trackingType }
async function explodeRevision(rev, { variant = "", qty = 1, allowDraft = false, cache = makeCache(), _level = 0, _path = [], _stack = [], _optional = false } = {}) {
  if (_level > MAX_DEPTH) throw new BusinessError("BOM_TOO_DEEP", `BOM nests deeper than ${MAX_DEPTH} levels - check for a loop.`, { status: 400 });
  const rows = [];
  for (const it of rev.items || []) {
    if (!applies(it, variant)) continue;
    const info = await partInfo(cache, it.part);
    const total = qty * it.requiredQuantity, opt = _optional || !!it.optional;
    const row = { level: _level, partId: it.part, partNumber: it.partNumber || info.partNumber, partName: info.partName, isAssembly: !!info.isAssembly, qtyPer: it.requiredQuantity, qty: total, optional: opt, requiredRevision: it.requiredRevision, position: it.installationPosition, path: _path, trackingType: info.trackingType || it.trackingType };
    rows.push(row);
    if (info.isAssembly) {
      if (_stack.includes(String(it.part))) throw new BusinessError("BOM_CYCLE", `BOM loop: ${[..._path, row.partNumber].join(" > ")} contains itself.`, { status: 400 });
      const sub = await assemblyRevision(cache, { _id: it.part, partNumber: row.partNumber }, it.requiredRevision, { allowDraft });
      rows.push(...(await explodeRevision(sub, { variant, qty: total, allowDraft, cache, _level: _level + 1, _path: [..._path, row.partNumber], _stack: [..._stack, String(it.part)], _optional: opt })));
    }
  }
  return rows;
}

// leaf components only, merged per part: the lines the rest of the system works with
function leafLines(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.isAssembly) continue; const k = String(r.partId); const pos = [...r.path, ...(r.position ? [r.position] : [])].join(" > ");
    const e = m.get(k);
    if (!e) m.set(k, { part: r.partId, partNumber: r.partNumber, requiredQuantity: r.qty, requiredRevision: r.requiredRevision || undefined, trackingType: r.trackingType, optional: r.optional, installationPosition: pos || undefined });
    else { e.requiredQuantity += r.qty; e.optional = e.optional && r.optional; e.requiredRevision = e.requiredRevision || r.requiredRevision; if (pos && !(e.installationPosition || "").split("; ").includes(pos)) e.installationPosition = [e.installationPosition, pos].filter(Boolean).join("; "); }
  }
  return [...m.values()];
}
async function flattenRevision(rev, opts = {}) { return leafLines(await explodeRevision(rev, opts)); }

// a copy of the revision whose `items` are the exploded components for the variant: what vehicles and kits work with
async function withFlatItems(rev, variant) { if (!rev) return rev; const o = rev.toObject ? rev.toObject() : { ...rev }; o.rawItems = o.items; o.items = await flattenRevision(rev.toObject ? rev.toObject() : rev, { variant }); return o; }

// would adding `items` to the BOM of assembly `assemblyPartId` create a loop?
async function assertNoLoop(assemblyPartId, items) {
  const target = String(assemblyPartId); const seen = new Set();
  const visit = async (partId, trail) => {
    const k = String(partId); if (k === target) throw new BusinessError("BOM_CYCLE", `BOM loop: ${[...trail, "(this assembly)"].join(" > ")}.`, { status: 400 });
    if (seen.has(k)) return; seen.add(k);
    const part = await M.PartMaster.findById(partId, "partNumber isAssembly").lean(); if (!part || !part.isAssembly) return;
    const bom = await M.BOM.findOne({ assemblyPart: partId }).lean(); if (!bom) return;
    for (const r of await M.BOMRevision.find({ bom: bom._id }).lean()) for (const it of r.items) await visit(it.part, [...trail, part.partNumber]);
  };
  for (const it of items) await visit(it.part, []);
}

// where is this part used? (every BOM revision that lists it, vehicle or sub-assembly)
async function whereUsed(partId) {
  const revs = await M.BOMRevision.find({ "items.part": partId }).select("vehicleModel revision status items.part items.requiredQuantity items.variants").lean();
  return revs.map((r) => { const it = r.items.find((i) => String(i.part) === String(partId)); return { model: r.vehicleModel, revision: r.revision, status: r.status, quantity: it.requiredQuantity, variants: it.variants || [] }; });
}

// Freeze sub-assembly structure: a line for a sub-assembly without a revision is pinned to that assembly's current BOM revision.
async function pinAssemblyRevisions(items) {
  for (const it of items) {
    if (it.requiredRevision) continue;
    const part = await M.PartMaster.findById(it.part, "isAssembly").lean(); if (!part || !part.isAssembly) continue;
    const bom = await M.BOM.findOne({ assemblyPart: it.part }).lean(); if (bom && bom.currentRevision) it.requiredRevision = bom.currentRevision;
  }
  return items;
}
// A revision may only be approved when it explodes cleanly for every declared variant (no loops, every sub-assembly has an approved BOM).
async function validateRevision(bom, rev) {
  const plain = rev.toObject ? rev.toObject() : rev;
  if (bom.assemblyPart) await assertNoLoop(bom.assemblyPart, plain.items);
  const cache = makeCache();
  for (const v of ["", ...(bom.variants || [])]) await explodeRevision(plain, { variant: v, cache, _stack: bom.assemblyPart ? [String(bom.assemblyPart)] : [] });
}
module.exports = { pinAssemblyRevisions, validateRevision, applies, explodeRevision, leafLines, flattenRevision, withFlatItems, assertNoLoop, whereUsed, makeCache, MAX_DEPTH };
