// No database needed.  Run:  node --test test/rack.unit.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret-1234567890";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRackBin, rackLabel } = require("../src/domain/locations");
const partIds = require("../src/domain/partIds");
const { parseRows } = require("../src/domain/bomExcel");

test("rack location text is split into rack and bin", () => {
  assert.deepEqual(parseRackBin("RACK-A / BIN-12"), { rack: "RACK-A", bin: "BIN-12", code: "RACK-A/BIN-12", label: "RACK-A / BIN-12" });
  assert.equal(parseRackBin("rack-a/bin-12").code, "RACK-A/BIN-12");           // no spaces, lower case
  assert.equal(parseRackBin("  Rack A  /  Bin 12 ").code, "RACK-A/BIN-12");    // spaces inside become dashes
  assert.equal(parseRackBin(""), null);
});
test("bad rack locations are rejected with a clear message", () => {
  for (const bad of ["RACK-A", "RACK-A /", "/ BIN-1", "A/B/C", "RACK|A / BIN-1", "RACK=A / BIN-1"])
    assert.throws(() => parseRackBin(bad), /RACK-A \/ BIN-12|may only use/, bad);
});
test("same bin name can exist in two racks", () => {
  assert.notEqual(parseRackBin("RACK-A / BIN-12").code, parseRackBin("RACK-B / BIN-12").code);
});
test("rackLabel", () => {
  assert.equal(rackLabel({ rack: "RACK-A", bin: "BIN-12" }), "RACK-A / BIN-12");
  assert.equal(rackLabel({ locationCode: "E-08", path: "ES > E-08" }), "ES > E-08");
  assert.equal(rackLabel(null), "");
  assert.equal(rackLabel("5f0000000000000000000000"), ""); // not populated
});
test("your own part IDs are accepted, barcode characters are not", () => {
  for (const ok of ["AE-MTR-0042", "ae/mtr/0042", "ALT 1001", "901001243001", "BUZZ.CTRL_01"]) assert.ok(partIds.checkPartNumber(ok).ok, ok);
  assert.equal(partIds.checkPartNumber("ae-mtr-0042").partNumber, "AE-MTR-0042");
  for (const bad of ["", "A|B", "A=B", "x".repeat(61)]) assert.equal(partIds.checkPartNumber(bad).ok, false, bad);
});
test("old generated IDs and TMP numbers count as replaceable placeholders", () => {
  for (const pn of ["MECH-0001", "ELEC-0144", "ELCN-0041", "OTH-0003"]) assert.ok(partIds.isPlaceholder({ partNumber: pn }), pn);
  assert.ok(partIds.isPlaceholder({ partNumber: "TMP-00001", provisional: true }));
  assert.ok(!partIds.isPlaceholder({ partNumber: "AE-MTR-0042" }));
  assert.ok(!partIds.isPlaceholder({ partNumber: "MECHANICAL-FRAME" }));
});
test("BOM sheet: RACK column is read; own part IDs kept; bad ID rejected", () => {
  const rows = [["PART NO", "DESCRIPTION", "QTY", "RACK LOCATION"], ["AE-100", "Hub motor", 1, "RACK-A / BIN-12"], ["AE-101", "Controller", 1, "rack-b/bin-3"], ["", "Bolt M8", 10, ""]];
  const p = parseRows(rows);
  assert.equal(p.lines.length, 3);
  assert.equal(p.lines[0].partNumber, "AE-100"); assert.equal(p.lines[0].rack, "RACK-A / BIN-12"); assert.equal(p.lines[2].rack, "");
  assert.throws(() => parseRows([["PART NO", "DESCRIPTION", "QTY"], ["AE|1", "Bad", 1]]), /not accepted/);
});
test("BOM sheet: a 'Location' column is still the installation position, not the rack", () => {
  const p = parseRows([["PART NO", "DESCRIPTION", "QTY", "LOCATION"], ["AE-1", "Lamp", 1, "Front"]]);
  assert.equal(p.lines[0].positions[0], "Front"); assert.equal(p.lines[0].rack, "");
});

test("numeric Part IDs must be complete (12 digits); drafts and all-zero placeholders are recognised", () => {
  const classify = partIds.classifyPartNumber;
  for (const bad of ["1234567", "901016037", "9010012430011"]) assert.equal(partIds.checkPartNumber(bad).ok, false, bad);
  assert.match(partIds.checkPartNumber("901016037").message, /12 digits/);
  assert.deepEqual(classify("901001243001"), { type: "REAL", value: "901001243001" });
  assert.deepEqual(classify("901016037"), { type: "PROPOSED", value: "901016037" });
  assert.deepEqual(classify("AE-MTR-1"), { type: "REAL", value: "AE-MTR-1" });
  for (const z of ["000000", "0", "901000000", "901000000000"]) assert.equal(classify(z).type, "PLACEHOLDER");
  assert.equal(classify("").type, "NONE"); assert.equal(classify("A|B").type, "INVALID");
});
test("BOM sheet: placeholder and draft IDs never become part numbers; a second heading row does not remap the columns", () => {
  const rows = [["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "QTY", "Status", "MP-Main Part", " RESOURCE", "SUPPLIER", "UNIT COST", "Material Code", "PART ID"],
    ["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "SPECIFICATION", "QTY", "Status", "CP- Child Part", " RESOURCE", "SUPPLIER", "UNIT COST", "Material Code", "PART ID"],
    [1, "", "Chassis", "Chassis"],
    ["", 1, "A", "Frame", "", 1, "Finalized", "MP", "Proprietary", "Local", "", 2, "901001243001"],
    ["", 2, "B", "Bracket", "", 2, "Review", "CP", "Local", "Acme Metals", 55, 2, "901003023"],
    ["", 3, "C", "Bolt", "M8", "", "", "ASP", "Local", "Local", "", "", "000000"],
    ["", 4, "D", "Nut", "M8", 4, "Finalized", "ASP", "Local", "Local", "", "", "000000"]];
  const p = parseRows(rows); const by = Object.fromEntries(p.lines.map((l) => [l.name, l]));
  assert.equal(p.lines.length, 4);
  assert.equal(by.Frame.partNumber, "901001243001"); assert.equal(by.Frame.idType, "REAL"); assert.equal(by.Frame.qtyVerified, true);
  assert.equal(by.Bracket.partNumber, ""); assert.equal(by.Bracket.proposedId, "901003023"); assert.equal(by.Bracket.idType, "PROPOSED"); assert.equal(by.Bracket.status, "REVIEW"); assert.equal(by.Bracket.qtyVerified, false);
  assert.equal(by.Bracket.supplier, "Acme Metals"); assert.equal(by.Bracket.unitCost, 55); assert.equal(by.Bolt.supplier, ""); assert.equal(by.Bolt.sourcing, "LOCAL");
  assert.equal(by.Bolt.idType, "PLACEHOLDER"); assert.equal(by.Bolt.qtyVerified, false); assert.equal(by.Bolt.qtyDefaulted, true); assert.equal(by.Nut.qtyVerified, true); assert.equal(by.Nut.partNumber, "");
});
test("BOM sheet: sub-group headings become part of the position; an ID without description is reported and skipped; a draft ID reused for different parts is reported", () => {
  const rows = [["SL.NO", "SL.NO", "SL.NO", "DESCRIPTION", "QTY", "PART ID"], [7, "", "Power Train"],
    ["", 7.1, "", "Gear Box"], ["", 1, "A", "Gear", 1, "901001001"], ["", 2, "B", "", 1, "901001002"], ["", 3, "C", "Key LH Bracket", 1, "901084142"], ["", 4, "D", "Key RH Bracket", 1, "901084142"]];
  const p = parseRows(rows); assert.equal(p.lines.length, 3); assert.equal(p.lines[0].positions[0], "Power Train > Gear Box");
  assert.ok(p.warnings.some((w) => /901001002 has no description/.test(w))); assert.equal(p.idConflicts.length, 1); assert.equal(p.idConflicts[0].id, "901084142");
});
