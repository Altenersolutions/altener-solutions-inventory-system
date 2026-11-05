// Excel BOM import for ONE vehicle model.  Works when most lines have NO part number yet:
//   * a line with a part number  -> that part is used (created if it does not exist yet)
//   * a line without one         -> matched to an existing part by name, otherwise a PROVISIONAL part (TMP-xxxxx) is created
//   * re-importing the same sheet never creates duplicates (same name -> same part)
// Provisional parts are flagged (`provisional: true`) and can later be given their real number
// (POST /api/parts/:id/assign-number) - the BOM lines follow automatically.
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const M = require("../models");
const C = require("./constants");
const { BusinessError, invalid } = require("./errors");
const { atomic } = require("./uow");
const { audit } = require("./audit");
const { defaultsFor } = require("./partRules");
const { ensureRackBin, rackLabel } = require("./locations");
const partIds = require("./partIds");

const s = (v) => (v == null ? "" : String(v).trim());
const key = (v) => s(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const normName = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// header synonyms (compared after key())
const HEAD = {
  partNumber: ["partno", "partnumber", "partid", "partcode", "pn", "itemcode", "itemno", "itemnumber"],
  name: ["description", "partname", "partdescription", "itemdescription", "itemname", "componentname", "component", "item", "part", "name", "material", "particulars"],
  qty: ["qty", "quantity", "qtyveh", "qtyperveh", "qtyperunit", "reqqty", "requiredqty", "requiredquantity", "nos", "noff", "count"],
  position: ["position", "installationposition", "assembly", "assy", "subassembly", "assemblyname", "usedin", "application", "location", "section"],
  mainSub: ["mainsub", "mainsa", "masa"],
  stage: ["stage", "station", "stagepart"],
  supplier: ["supplier", "vendor", "make", "manufacturer", "source"],
  spec: ["spec", "specification", "specs", "remarks"],
  unitCost: ["unitcost", "cost", "rate", "price", "unitprice"],
  category: ["category", "partcategory"],
  status: ["status", "designstatus", "linestatus", "bomstatus"],
  resource: ["resource", "resourcetype"],
  kind: ["mpmainpart", "partkind", "parttype", "mpcpasp", "mainchildasp"],
  qtyVerified: ["qtyverified", "quantityverified", "verified"],
  proposedId: ["proposedid", "proposedpartid", "draftid", "draftpartid"],
  variants: ["variant", "variants", "applicablevariants", "variantapplicability", "variantsapplicable"],
  rack: ["racklocation", "rackbin", "rackno", "rack", "binlocation", "storagelocation", "storage", "storebin", "bin", "binno", "bincode", "rackbinlocation", "rackandbin"],
};

function cellValue(c) {
  if (c == null) return "";
  if (typeof c === "object") {
    if (c instanceof Date) return c.toISOString().slice(0, 10);
    if (c.error) return "";                                   // #REF! etc.
    if (c.richText) return c.richText.map((r) => r.text).join("");
    if ("result" in c) return cellValue(c.result);            // formula
    if (c.text != null) return cellValue(c.text);             // hyperlink
    return "";
  }
  return c;
}

async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid("This is not a valid .xlsx file (save it as Excel Workbook and try again)."); }
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const arr = []; row.eachCell({ includeEmpty: true }, (cell, i) => { arr[i - 1] = cellValue(cell.value); }); rows.push(arr); });
    return { name: ws.name, rows };
  });
}

function pickSheet(sheets, model, wanted) {
  if (!sheets.length) throw invalid("The workbook has no sheets.");
  if (wanted) { const f = sheets.find((x) => x.name.trim().toLowerCase() === wanted.trim().toLowerCase()); if (!f) throw invalid(`Sheet "${wanted}" not found. Sheets in the file: ${sheets.map((x) => x.name).join(", ")}`); return f; }
  return sheets.find((x) => key(x.name) === key(model)) || sheets.find((x) => key(x.name).includes(key(model))) || sheets[0];
}

// rows = array of arrays. Walks the WHOLE sheet because real BOM sheets contain title banners, repeated header rows
// (e.g. a MECHANICAL part followed by an ELECTRICAL part), and numbered assembly rows above their parts.
//   hierarchical layout:  [1,"","","Head Light"]            <- assembly row (number in the first column)
//                         ["",1,"A","RH Head Light Bkt",..]  <- part row (number in the second column); assembly name becomes its position
const splitVariants = (v) => [...new Set(s(v).split(/[;,|]/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
const clean = (v) => (/^[-–—_.\s]*$/.test(s(v)) ? "" : s(v));
const isNum = (v) => /^\d+(\.\d+)?$/.test(s(v));
function matchHeader(r) {
  const cols = {}; let hits = 0;
  (r || []).forEach((h, ci) => { const k = key(h); if (!k) return; for (const [f, syn] of Object.entries(HEAD)) if (cols[f] == null && syn.includes(k)) { cols[f] = ci; hits++; break; } });
  return cols.name != null && hits >= 2 && (cols.qty != null || cols.partNumber != null || cols.position != null) ? cols : null;
}
function supMode_unknown(names, known) { return [...names.entries()].filter(([k]) => !known.has(k)).map(([, v]) => v); }
const SOURCING_WORDS = { local: "LOCAL", lccal: "LOCAL", inhouse: "INHOUSE", inhousemade: "INHOUSE", online: "ONLINE", imported: "IMPORTED", standard: "STANDARD", proprietary: "PROPRIETARY" };
const statusKey = (v) => s(v).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function parseRows(rows) {
  const hierarchical = rows.filter((r) => r && isNum(r[1]) && /^[A-Za-z]$/.test(s(r[2])) && s(r[0]) === "").length >= 3;
  const warnings = []; const merged = new Map(); let map = null, firstHeader = null, group = "", sub = "", hint = "", skipped = 0, headers = 0, lastHeaderLine = -9;
  const idNames = new Map(); // proposed ID -> descriptions that use it
  rows.forEach((r, idx) => {
    r = r || []; const line = idx + 1; const vals = r.map(s).filter(Boolean);
    if (!vals.length) return;
    const h = matchHeader(r);
    if (h) {
      if (map && lastHeaderLine === line - 1) { for (const [f, i] of Object.entries(h)) if (map[f] == null) map[f] = i; lastHeaderLine = line; skipped++; return; } // 2nd heading line of the same table (e.g. code names under the headings)
      map = h; headers++; group = ""; sub = ""; lastHeaderLine = line; if (!firstHeader) firstHeader = { row: line, columns: Object.fromEntries(Object.entries(h).map(([f, i]) => [f, i + 1])) }; return;
    }
    if (new Set(vals).size === 1 && /\bBOM\b|REVISION|LAST UPDATED/i.test(vals[0])) { // section banner
      if (/BOM|REVISION/i.test(vals[0]) && !/LAST UPDATED/i.test(vals[0])) { hint = /MECHANICAL/i.test(vals[0]) ? "MECHANICAL" : /ELECTRICAL/i.test(vals[0]) ? "ELECTRICAL" : ""; group = ""; sub = ""; map = null; }
      skipped++; return;
    }
    if (!map) { skipped++; return; }
    if (hierarchical && isNum(r[0]) && !s(r[1])) { group = s(r[map.name]) || s(r[2]) || s(r[3]); sub = ""; skipped++; return; } // assembly row
    const get = (f) => (map[f] == null ? "" : clean(r[map[f]]));
    // sub-group heading inside an assembly (e.g. 7.1 Gear Box): a description with no letter, no quantity and no part type
    if (hierarchical && get("name") && !/^[A-Za-z]$/.test(s(r[2])) && !(isNum(r[1]) && Number.isInteger(Number(r[1]))) && !get("qty") && !get("kind")) { sub = get("name"); skipped++; return; }
    const name = get("name"); const cls = partIds.classifyPartNumber(get("partNumber"));
    if (cls.type === "INVALID") throw invalid(`Row ${line}: part number "${cls.value}" is not accepted - ${cls.message}`);
    const pn = cls.type === "REAL" ? cls.value : ""; const proposed = cls.type === "PROPOSED" ? cls.value : s(get("proposedId")).toUpperCase();
    if (!name && !pn) { if (proposed) warnings.push(`Row ${line}: ID ${proposed} has no description - row skipped.`); skipped++; return; }
    if (/^(total|grand total|sub ?total)\b/i.test(name)) { skipped++; return; }
    if (!name) warnings.push(`Row ${line}: part number ${pn} has no description - description set to the part number.`);
    const raw = get("qty"); let qty = raw === "" ? null : Number(raw);
    if (qty != null && (!Number.isFinite(qty) || qty <= 0)) { warnings.push(`Row ${line}: quantity "${raw}" is not valid - treated as 1.`); qty = null; }
    if (qty != null && !Number.isInteger(qty)) { warnings.push(`Row ${line}: quantity ${qty} rounded up to ${Math.ceil(qty)}.`); qty = Math.ceil(qty); }
    const specTxt = get("spec") && get("spec") !== name ? get("spec") : "";
    // real ID = the key. A draft ID only merges lines that also have the same description (LH / RH parts that were given one ID by mistake stay separate).
    const k = pn || (proposed ? `P:${proposed}|${normName(name)}|${normName(specTxt)}` : `${normName(name)}|${normName(specTxt)}`);
    if (proposed) { if (!idNames.has(proposed)) idNames.set(proposed, new Set()); idNames.get(proposed).add(name); }
    const cost = get("unitCost") === "" ? NaN : Number(get("unitCost").replace(/,/g, ""));
    const pos = hierarchical ? (sub ? `${group} > ${sub}` : group) : get("position");
    const supRaw = get("supplier"), sw = SOURCING_WORDS[key(supRaw)]; const supplierName = sw ? "" : supRaw; const sourcing = sw || SOURCING_WORDS[key(get("resource"))] || "";
    const st = statusKey(get("status")); const vcol = get("qtyVerified");
    const verified = vcol !== "" ? /^(y|yes|true|1|verified|ok)$/i.test(vcol) : qty != null && (!st || st === "FINALIZED");
    const cur = merged.get(k);
    if (cur) {
      if (!cur.rack && get("rack")) cur.rack = get("rack"); splitVariants(get("variants")).forEach((v) => !cur.variants.includes(v) && cur.variants.push(v));
      cur.qty += qty == null ? 1 : qty; cur.qtyDefaulted = cur.qtyDefaulted && qty == null; cur.qtyVerified = cur.qtyVerified && verified;
      if (st && (!cur.status || (cur.status === "FINALIZED" && st !== "FINALIZED"))) cur.status = st; if (!cur.supplier && supplierName) cur.supplier = supplierName; if (cur.unitCost == null && Number.isFinite(cost)) cur.unitCost = cost; if (!cur.sourcing) cur.sourcing = sourcing;
      if (pos && !cur.positions.includes(pos)) cur.positions.push(pos); cur.rows.push(line);
    } else merged.set(k, { partNumber: pn, proposedId: proposed, idType: pn ? "REAL" : proposed ? "PROPOSED" : cls.type === "PLACEHOLDER" ? "PLACEHOLDER" : "NONE", name: name || pn, qty: qty == null ? 1 : qty, qtyDefaulted: qty == null, qtyVerified: verified, status: st, kind: get("kind").toUpperCase(), positions: pos ? [pos] : [], supplier: supplierName, sourcing, spec: specTxt, unitCost: Number.isFinite(cost) ? cost : null, category: (get("category") || hint).toUpperCase(), rack: get("rack"), variants: splitVariants(get("variants")), rows: [line] });
  });
  if (!firstHeader) throw invalid("Could not find the header row. The sheet needs a column for the part description (e.g. DESCRIPTION / PART NAME) and ideally QTY.");
  const lines = [...merged.values()];
  if (!lines.length) throw invalid("No BOM lines found under the header row.");
  const idConflicts = [...idNames.entries()].filter(([, v]) => v.size > 1).map(([id, v]) => ({ id, descriptions: [...v] }));
  return { header: { ...firstHeader, sectionsFound: headers, layout: hierarchical ? "assemblies with numbered parts" : "flat list" }, lines, warnings, idConflicts, skippedRows: skipped, rawLines: lines.reduce((a, l) => a + l.rows.length, 0) };
}

// Same simple keyword rules as the presentation loader. Provisional parts are flagged so engineering can correct them.
const FAST = /\bbolt\b|\bnut\b|washer|screw|rivet|stud|circlip|split pin|cotter|grub|allen|\bclip\b|\bpin\b|shim|cable tie|lug\b/i;
const SERIAL = /motor|controller|vcu|bms|battery pack|charger|converter|hmi|\bccu\b|inverter|telematic|display/i;
const ELECTRONIC = /controller|vcu|hmi|\bccu\b|bms|\bpcb\b|board|sensor|display|telematic|gps|\bic\b/i;
const ELECTRICAL = /wire|wiring|harness|cable|relay|contactor|\bmcb\b|fuse|switch|connector|terminal|battery|charger|converter|inverter|motor|horn|light|lamp|indicator|\bfan\b/i;
function guess(l) {
  const t = `${l.name} ${l.spec}`;
  const category = C.CATEGORIES.includes(l.category) ? l.category : ELECTRONIC.test(t) ? "ELECTRONICS" : ELECTRICAL.test(t) ? "ELECTRICAL" : "MECHANICAL";
  const trackingType = FAST.test(t) ? "QUANTITY" : SERIAL.test(t) ? "SERIAL" : "BATCH";
  return { category, trackingType };
}

async function importBomExcel(user, model, meta, source, { sheet, dryRun, supplierMode = "LINK" } = {}) {
  model = s(model).toUpperCase(); if (!model) throw invalid("Vehicle model is required.");
  const sheets = Buffer.isBuffer(source) ? await readWorkbook(source) : [{ name: s(source.sheetName) || model, rows: source.rows }]; const picked = pickSheet(sheets, model, sheet); const parsed = parseRows(picked.rows);
  let bom = await M.BOM.findOne({ vehicleModel: model });
  if (bom && (await M.BOMRevision.exists({ bom: bom._id, revision: meta.revision }))) throw new BusinessError("DUPLICATE_REVISION", `${model} already has a revision named ${meta.revision}. Use a new revision name (e.g. the next letter).`, { status: 409 });

  const existing = await M.PartMaster.find({}, "partNumber partName description trackingType defaultLocation isAssembly provisional proposedPartId").lean();
  const byNumber = new Map(existing.map((p) => [p.partNumber, p])); const byName = new Map();
  const asmPart = !bom ? existing.find((p) => p.partNumber === model) || null : null; // a model name that is an existing part number = BOM of that sub-assembly
  const isAsm = !!(asmPart || (bom && bom.assemblyPart));
  const nk = (name, spec) => `${normName(name)}|${normName(spec)}`;
  for (const p of existing) { const k = nk(p.partName, p.description); if (normName(p.partName) && !byName.has(k)) byName.set(k, p); }
  const suppliers = new Map((await M.Supplier.find({}, "name").lean()).map((x) => [normName(x.name), x._id]));

  const byProp = new Map(); const provByName = new Map();
  for (const p of existing) { if (p.proposedPartId) byProp.set(`${p.proposedPartId}|${nk(p.partName, p.description)}`, p); if (p.provisional) provByName.set(nk(p.partName, p.description), p); }
  let locked = null; // parts that already have stock or purchase orders keep their number
  const isFree = async (p) => { if (!locked) locked = new Set([...(await M.MaterialItem.distinct("part", {})), ...(await M.PurchaseOrder.distinct("lines.part"))].map(String)); return !locked.has(String(p._id)); };
  const plan = []; const adoptedIds = new Set();
  for (const l of parsed.lines) {
    let part = null, how;
    if (l.partNumber) {
      part = byNumber.get(l.partNumber); how = part ? "EXISTING_ID" : "NEW_WITH_ID";
      if (!part) { // the sheet now has the real ID of a part that so far had a temporary number: give that part its real number instead of creating a second one
        const cand = provByName.get(nk(l.name, l.spec));
        if (cand && !adoptedIds.has(String(cand._id)) && (await isFree(cand))) { part = cand; how = "ADOPT_PROVISIONAL"; adoptedIds.add(String(cand._id)); }
      }
    } else if (l.proposedId) { part = byProp.get(`${l.proposedId}|${nk(l.name, l.spec)}`) || byName.get(nk(l.name, l.spec)); how = part ? "EXISTING_BY_NAME" : "NEW_PROVISIONAL"; }
    else { part = byName.get(nk(l.name, l.spec)); how = part ? "EXISTING_BY_NAME" : "NEW_PROVISIONAL"; }
    plan.push({ l, part, how });
  }
  // ---- suppliers named in the sheet (linked by name; created only when asked) and their prices
  for (const x of plan) if (/^[\d.,]+$/.test(x.l.supplier || "")) { parsed.warnings.push(`Row ${x.l.rows[0]}: supplier "${x.l.supplier}" is a number - treated as the unit cost, supplier left blank.`); if (x.l.unitCost == null) x.l.unitCost = Number(String(x.l.supplier).replace(/,/g, "")); x.l.supplier = ""; }
  const supNames = new Map(); for (const x of plan) if (x.l.supplier) supNames.set(normName(x.l.supplier), x.l.supplier);
  const unknownSuppliers = supMode_unknown(supNames, suppliers);
  const supStats = { mode: supplierMode, named: supNames.size, known: supNames.size - unknownSuppliers.length, unknown: unknownSuppliers, created: 0, pricesFromSheet: plan.filter((x) => x.l.supplier && x.l.unitCost != null).length };
  // ---- rack locations given in the sheet (RACK-A / BIN-12) ----
  const rackStats = { linesWithRack: 0, newRacksBins: 0, assignedToExistingParts: 0, differentFromSaved: 0 }; const rackErrors = []; const newBins = new Set();
  const wantLocs = plan.filter((x) => x.l.rack && x.part && x.part.defaultLocation).map((x) => x.part.defaultLocation); // only look up locations when the sheet actually has racks for saved parts
  const locOfPart = new Map(wantLocs.length ? (await M.Location.find({ _id: { $in: wantLocs } }, "locationCode").lean()).map((l) => [String(l._id), l.locationCode]) : []);
  for (const x of plan) {
    if (!x.l.rack) continue; rackStats.linesWithRack++;
    try {
      const probe = await ensureRackBin(x.l.rack, { dryRun: true }); x.rackCode = probe.code; x.rackText = x.l.rack;
      if (!probe.exists) newBins.add(probe.code);
      if (x.part) { if (!x.part.defaultLocation) { x.assignRack = true; rackStats.assignedToExistingParts++; } else if (locOfPart.get(String(x.part.defaultLocation)) !== probe.code) { rackStats.differentFromSaved++; parsed.warnings.push(`Row ${x.l.rows[0]}: ${x.part.partNumber} already has a saved rack location - the one in the sheet (${probe.label}) was NOT applied. Use Import rack locations to change it.`); } }
    } catch (e) { rackErrors.push(`Row ${x.l.rows[0]}: ${x.l.rack} - ${e.message}`); }
  }
  rackStats.newRacksBins = newBins.size;
  const count = (h) => plan.filter((p) => p.how === h).length;
  const summary = {
    model, revision: meta.revision, sheet: picked.name, sheetsInFile: sheets.map((x) => x.name), header: parsed.header,
    ids: { real: plan.filter((p) => p.l.idType === "REAL").length, proposedOnly: plan.filter((p) => p.l.idType === "PROPOSED").length, placeholder: plan.filter((p) => p.l.idType === "PLACEHOLDER").length, none: plan.filter((p) => p.l.idType === "NONE").length, adoptTemporary: count("ADOPT_PROVISIONAL") },
    verification: { unverifiedLines: plan.filter((p) => !p.l.qtyVerified).length, verifiedLines: plan.filter((p) => p.l.qtyVerified).length, notFinalized: plan.filter((p) => p.l.status && p.l.status !== "FINALIZED").length, statusCounts: plan.reduce((a, p) => { const k = p.l.status || "(none)"; a[k] = (a[k] || 0) + 1; return a; }, {}) },
    suppliers: supStats, idConflicts: (parsed.idConflicts || []).slice(0, 30),
    subAssembly: isAsm, variantsFound: [...new Set(parsed.lines.flatMap((l) => l.variants || []))], sourceRows: parsed.rawLines, bomLines: plan.length, mergedDuplicates: parsed.rawLines - plan.length,
    usedExistingById: count("EXISTING_ID"), usedExistingByName: count("EXISTING_BY_NAME"), createdWithGivenId: count("NEW_WITH_ID"), createdProvisional: count("NEW_PROVISIONAL"),
    quantityDefaultedTo1: plan.filter((p) => p.l.qtyDefaulted).length, rack: rackStats, rackErrors: rackErrors.slice(0, 30), warnings: parsed.warnings.slice(0, 50), dryRun: !!dryRun,
    preview: plan.slice(0, 15).map((p) => ({ partNumber: p.part ? p.part.partNumber : p.l.partNumber || "(new TMP-…)", name: p.l.name, qty: p.l.qty, how: p.how, idType: p.l.idType, status: p.l.status, verified: p.l.qtyVerified, rack: p.rackCode ? p.rackCode.replace("/", " / ") : "" })),
  };
  if (dryRun) return summary;
  if (rackErrors.length) throw invalid(`Fix the rack locations first (format RACK-A / BIN-12). ${rackErrors.slice(0, 5).join("  |  ")}${rackErrors.length > 5 ? `  (+${rackErrors.length - 5} more - run the dry run to see all)` : ""}`);
  const binIds = new Map(); // create the racks and bins that are new (safe to repeat)
  for (const x of plan) if (x.rackCode && !binIds.has(x.rackCode)) binIds.set(x.rackCode, (await ensureRackBin(x.rackText))._id);

  if (supplierMode === "CREATE" && unknownSuppliers.length) { // create the suppliers that do not exist yet (code = name, upper case)
    const codes = new Set((await M.Supplier.find({}, "code").lean()).map((x) => x.code));
    for (const nm of unknownSuppliers) { let code = nm.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18) || "SUP", n = 1, c = code; while (codes.has(c)) c = `${code}-${++n}`; codes.add(c); const sdoc = await M.Supplier.create({ code: c, name: nm }); suppliers.set(normName(nm), sdoc._id); supStats.created++; }
  }
  const compat = C.VEHICLE_TYPES.includes(model) ? [model] : [];
  // Build everything in memory first, then write with a handful of bulk inserts (hundreds of single writes inside one
  // transaction is slow enough to time out on Atlas / Render).
  const nProv = plan.filter((x) => !x.part && x.how === "NEW_PROVISIONAL").length; let tmpNext = 0;
  if (nProv) { const c = await M.Counter.findOneAndUpdate({ name: "tmpPart" }, { $inc: { seq: nProv } }, { new: true, upsert: true }); tmpNext = c.seq - nProv + 1; }
  const now = new Date(); const newParts = [], newRevs = [], items = []; const seen = new Set(); const adopts = [];
  const supId = (l) => (supplierMode !== "NONE" && l.supplier ? suppliers.get(normName(l.supplier)) : undefined);
  for (const { l, part, how, rackCode } of plan) {
    let p = part;
    if (how === "ADOPT_PROVISIONAL") { adopts.push({ id: part._id, from: part.partNumber, to: l.partNumber }); p = { _id: part._id, partNumber: l.partNumber, trackingType: part.trackingType }; byNumber.set(l.partNumber, p); }
    if (!p) {
      const g = guess(l); const provisional = how === "NEW_PROVISIONAL";
      const partNumber = provisional ? `TMP-${String(tmpNext++).padStart(5, "0")}` : l.partNumber;
      const d = { _id: new mongoose.Types.ObjectId(), partNumber, partName: l.name, description: l.spec || undefined, category: g.category, trackingType: g.trackingType, unit: "NOS", inventoryClass: "PRODUCTION", currentRevision: "REV-A",
        vehicleCompatibility: compat, unitCost: l.unitCost || undefined, supplier: supId(l), approvedSuppliers: supId(l) ? [{ supplier: supId(l), preferred: true, price: l.unitCost != null ? l.unitCost : undefined, priceUpdatedAt: l.unitCost != null ? now : undefined }] : [],
        sourcing: l.sourcing || undefined, proposedPartId: provisional && l.proposedId ? l.proposedId : undefined, provisional, minStock: 0,
        defaultLocation: rackCode ? binIds.get(rackCode) : undefined, lastAction: "PART_CREATED", lastUpdatedBy: user.id, lastUpdatedByName: user.name || "", lastUpdatedAt: now };
      Object.assign(d, defaultsFor(d)); newParts.push(d);
      newRevs.push({ part: d._id, revision: "REV-A", status: "APPROVED", approvedBy: user.id, approvedAt: now, changeReason: `Created by BOM import (${model} ${meta.revision})`, effectiveDate: now });
      p = { _id: d._id, partNumber, trackingType: g.trackingType };
      byName.set(nk(l.name, l.spec), p); byNumber.set(partNumber, p);
    }
    if (seen.has(String(p._id))) throw new BusinessError("DUPLICATE_BOM_ITEM", `${p.partNumber} resolves from two different rows (same part number and name used inconsistently). Fix the sheet.`, { status: 400 });
    seen.add(String(p._id));
    items.push({ part: p._id, partNumber: p.partNumber, requiredQuantity: l.qty, trackingType: p.trackingType, optional: false, installationPosition: l.positions.join("; ").slice(0, 400) || undefined, variants: l.variants || [], designStatus: l.status || undefined, qtyVerified: !!l.qtyVerified, lineKind: l.kind || undefined });
  }
  const tree = require("./bomTree");
  const asmIds = new Set(existing.filter((p) => p.isAssembly).map((p) => String(p._id)));
  const asmId = asmPart ? asmPart._id : bom && bom.assemblyPart;
  if (asmId) { if (items.some((i) => String(i.part) === String(asmId))) throw new BusinessError("BOM_CYCLE", `${model} cannot contain itself.`, { status: 400 }); await tree.assertNoLoop(asmId, items.filter((i) => asmIds.has(String(i.part)))); }
  if (asmIds.size) await tree.pinAssemblyRevisions(items.filter((i) => asmIds.has(String(i.part))));
  const declared = bom ? bom.variants || [] : []; const newVars = isAsm ? [] : [...new Set(items.flatMap((i) => i.variants))].filter((v) => !declared.includes(v));
  const rackOps = plan.filter((x) => x.assignRack).map((x) => ({ updateOne: { filter: { _id: x.part._id, defaultLocation: null }, update: { $set: { defaultLocation: binIds.get(x.rackCode) } } } }));
  const rev = await atomic(async (ctx) => {
    if (rackOps.length) { await M.PartMaster.bulkWrite(rackOps, ctx.opt); const ids = plan.filter((x) => x.assignRack).map((x) => x.part._id); ctx.onUndo(() => M.PartMaster.collection.updateMany({ _id: { $in: ids } }, { $unset: { defaultLocation: "" } })); }
    if (!bom) { bom = await ctx.create(M.BOM, { vehicleModel: model, name: asmPart ? `${model} sub-assembly BOM` : `${model} BOM`, ...(asmPart ? { assemblyPart: asmPart._id } : {}) }); if (asmPart) await ctx.set(M.PartMaster, asmPart._id, { isAssembly: true }); }
    for (const ad of adopts) { await ctx.set(M.PartMaster, ad.id, { partNumber: ad.to, provisional: false, proposedPartId: null }); await partIds.renameInBoms(ad.id, ad.to, ctx); await audit(ctx, user, { action: "PART_NUMBER_ASSIGNED", entityType: "Part", entityId: ad.id, entityLabel: ad.to, before: { partNumber: ad.from }, after: { partNumber: ad.to }, where: `BOM Excel import ${model} ${meta.revision}` }); }
    if (newVars.length) await ctx.set(M.BOM, bom._id, { variants: [...declared, ...newVars] });
    if (newParts.length) {
      const ids = newParts.map((x) => x._id);
      await M.PartMaster.insertMany(newParts, ctx.opt); ctx.onUndo(() => M.PartMaster.collection.deleteMany({ _id: { $in: ids } }));
      await M.PartRevision.insertMany(newRevs, ctx.opt); ctx.onUndo(() => M.PartRevision.collection.deleteMany({ part: { $in: ids } }));
      await audit(ctx, user, { action: "PARTS_CREATED_BY_IMPORT", entityType: "Part", entityLabel: `${newParts.length} parts`, where: `BOM Excel import ${model} ${meta.revision}`, after: { count: newParts.length, provisional: nProv, partNumbers: newParts.map((x) => x.partNumber).slice(0, 1000) } });
    }
    const r = await ctx.create(M.BOMRevision, { bom: bom._id, vehicleModel: model, revision: meta.revision, effectiveDate: now, changeReason: meta.changeReason, items, status: "DRAFT" });
    await audit(ctx, user, { action: "BOM_REVISION_CREATED", entityType: "BOM", entityId: bom._id, entityLabel: `${model} ${r.revision}`, reason: meta.changeReason, where: "Excel import", after: { items: items.length, provisionalParts: nProv } });
    return r;
  });
  return { ...summary, items: rev.items.length, status: rev.status };
}

// Give a provisional part its real number. Blocked once physical stock exists, because stock/QR labels carry the old number.
async function assignPartNumber(user, partId, newNumber) {
  const pn = partIds.assertPartNumber(newNumber);
  const part = await M.PartMaster.findById(partId); if (!part) throw invalid("Unknown part.");
  if (!partIds.isPlaceholder(part)) throw new BusinessError("NOT_PROVISIONAL", `${part.partNumber} is already a real part ID and cannot be renamed here.`, { status: 400 });
  if (await M.PartMaster.exists({ partNumber: pn })) throw new BusinessError("DUPLICATE", `Part number ${pn} already exists.`, { status: 409 });
  if (await M.MaterialItem.exists({ part: part._id }) || await M.PurchaseOrder.exists({ "lines.part": part._id })) throw new BusinessError("PART_IN_USE", `${part.partNumber} already has stock or purchase orders, so its number can no longer be changed here.`, { status: 409 });
  const old = part.partNumber;
  await atomic(async (ctx) => {
    await ctx.set(M.PartMaster, part._id, { partNumber: pn, provisional: false });
    await partIds.renameInBoms(part._id, pn, ctx);
    await audit(ctx, user, { action: "PART_NUMBER_ASSIGNED", entityType: "Part", entityId: part._id, entityLabel: pn, before: { partNumber: old }, after: { partNumber: pn } });
  });
  return { _id: part._id, partNumber: pn, previous: old };
}
module.exports = { readWorkbook, parseRows, importBomExcel, assignPartNumber, guess };
