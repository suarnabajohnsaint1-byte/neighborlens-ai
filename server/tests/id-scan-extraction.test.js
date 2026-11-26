const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractIdentityFields: extract,
} = require("../../frontend/js/auth/idIdentityService");

const license = `REPUBLIC OF THE PHILIPPINES
LAND TRANSPORTATION OFFICE
DRIVERS LICENSE
Last Name, First Name, Middle Name
SAMPLE, ALEX MORGAN
Nationality Sex Date of Birth Weight Height
PHL M 1992/04/23 70 1.75
Address
42 FICTIONAL STREET
VILLAMONTE, BACOLOD CITY
License No. Expiration Date Agency Code
N01-23-456789 2032/04/23 N01
Blood Type Restrictions Conditions
O+ 1 NONE`;

test("multi-column license labels fill all requested fields from their own rows", () => {
  const fields = extract(license);
  assert.equal(fields.fullName, "Alex Morgan Sample");
  assert.equal(fields.birthDate, "04/23/1992");
  assert.equal(fields.address, "42 FICTIONAL STREET, VILLAMONTE, BACOLOD CITY");
  assert.equal(fields.idNumber, "N01-23-456789");
  assert.equal(fields.expiryDate, "04/23/2032");
  assert.equal(fields.idType, "DRIVERS_LICENSE");
});

test("missing birth date cannot consume a later expiry date", () => {
  const fields = extract(
    "DRIVERS LICENSE\nDate of Birth\nAddress: FICTIONAL STREET\nExpiration Date\n2032/04/23",
  );
  assert.equal(fields.birthDate, "");
  assert.equal(fields.expiryDate, "04/23/2032");
});

test("two ambiguous dates beneath shared labels require manual review", () => {
  for (const values of ["1992/04/23 2032/04/23", "2032/04/23"]) {
    const fields = extract(
      `DRIVERS LICENSE\nDate of Birth Expiration Date\n${values}`,
    );
    assert.equal(fields.birthDate, "");
    assert.equal(fields.expiryDate, "");
  }
});

test("separately labeled name components retain given, middle and family names", () => {
  const fields = extract(
    "SURNAME: SAMPLE\nGIVEN NAME: ALEX\nMIDDLE NAME: MORGAN\nDATE OF BIRTH: APRIL 23, 1992",
  );
  assert.equal(fields.fullName, "Alex Morgan Sample");
  assert.equal(fields.birthDate, "04/23/1992");
});

for (const date of [
  "FEBRUARY 30 1992",
  "31 APRIL 1992",
  "1992/02/30",
  "2032/13/01",
])
  test(`invalid calendar date ${date} is never auto-filled`, () => {
    assert.equal(extract(`DATE OF BIRTH: ${date}`).birthDate, "");
    assert.equal(extract(`EXPIRATION DATE: ${date}`).expiryDate, "");
  });

test("inline dates and text months remain compatible without swapping birth and expiry", () => {
  const fields = extract(
    "DATE OF BIRTH: 23 JULY 1992 EXPIRATION DATE: OCTOBER 23, 2032",
  );
  assert.equal(fields.birthDate, "07/23/1992");
  assert.equal(fields.expiryDate, "10/23/2032");
});

test("document headers cannot become a fabricated full name", () => {
  assert.equal(
    extract(
      "REPUBLIC OF THE PHILIPPINES\nLAND TRANSPORTATION OFFICE\nDRIVERS LICENSE",
    ).fullName,
    "",
  );
  assert.equal(extract("DRIVERS LICENSE\nADDRESS\nBACOLOD CITY").fullName, "");
});

test("unreadable or missing optional fields stay missing", () => {
  const fields = extract(
    "DRIVERS LICENSE\nFULL NAME: ALEX SAMPLE\nDATE OF BIRTH: UNREADABLE\nADDRESS\nLICENSE NO: N01-23-456789",
  );
  assert.equal(fields.birthDate, "");
  assert.equal(fields.address, "");
  assert.equal(fields.expiryDate, "");
});

test("column labels and ambiguous license characters cannot become fabricated ID numbers", () => {
  const fields = extract(
    "DRIVERS LICENSE\nLicense No. Expiration Date Agency Code\nNO1-23-456789 2032/04/23 N01",
  );
  assert.equal(fields.idNumber, "");
});

test("split and misread name labels never populate Middle Nome as a citizen name", () => {
  const fields = extract(
    "DRIVERS LICENSE\nLast Name First Name\nMiddle Nome\nSAMPLE, ALEX MORGAN\nNationality Sex Date of Birth\nPHL M 1992/04/23",
  );
  assert.equal(fields.fullName, "Alex Morgan Sample");
  assert.equal(extract("DRIVERS LICENSE\nFULL NAME: Middle Nome").fullName, "");
});

test("OCR coordinates bind shared birth and expiry rows to their own columns", () => {
  const word = (text, x0, x1, y0) => ({
    text,
    bbox: { x0, x1, y0, y1: y0 + 10 },
  });
  const words = [
    word("Date", 10, 35, 0),
    word("of", 40, 50, 0),
    word("Birth", 55, 90, 0),
    word("Expiration", 200, 260, 0),
    word("Date", 265, 295, 0),
    word("1992/04/23", 10, 95, 20),
    word("2032/04/23", 200, 285, 20),
  ];
  const fields = extract(
    "Date of Birth Expiration Date\n1992/04/23 2032/04/23",
    words,
  );
  assert.equal(fields.birthDate, "04/23/1992");
  assert.equal(fields.expiryDate, "04/23/2032");
});

test("invalid OCR geometry falls back safely without inventing data", () => {
  const fields = extract("FULL NAME: ALEX SAMPLE\nDATE OF BIRTH: 1992/04/23", [
    { text: "private", bbox: { x0: NaN } },
  ]);
  assert.equal(fields.fullName, "Alex Sample");
  assert.equal(fields.birthDate, "04/23/1992");
});

test("a permanent address cannot be mistaken for lifetime document validity", () => {
  assert.equal(
    extract("DRIVERS LICENSE\nPERMANENT ADDRESS: FICTIONAL STREET").expiryDate,
    "",
  );
  assert.equal(
    extract("DRIVERS LICENSE\nEXPIRATION DATE: PERMANENT").expiryDate,
    "",
  );
});

test("MySQL setup and the login screen no longer install or advertise default demo credentials", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const migration = fs.readFileSync(
    path.join(__dirname, "../infrastructure/database/mysql/migrate.js"),
    "utf8",
  );
  const login = fs.readFileSync(
    path.join(__dirname, "../../frontend/login.html"),
    "utf8",
  );
  assert.doesNotMatch(migration, /seedDemoCitizen|seedAdminUser/);
  assert.doesNotMatch(
    login,
    /demo-creds|Demo Credentials|admin123|citizen \/ 1/,
  );
});

test("OCR-separated date punctuation and shortened address labels remain readable", () => {
  const fields = extract(
    "DRIVERS LICENSE\nDATE OF BIRTH: 1992 / 04 / 23\nADRESS\nP-7 HILLSIDE ROAD\nEXAMPLE TOWN, SAMPLE PROVINCE\nEXPIRATION DATE: 2032 / 04 / 23",
  );
  assert.equal(fields.birthDate, "04/23/1992");
  assert.equal(fields.expiryDate, "04/23/2032");
  assert.equal(
    fields.address,
    "P-7 HILLSIDE ROAD, EXAMPLE TOWN, SAMPLE PROVINCE",
  );
});

test("focused region parsing accepts one calendar date and rejects contradictory dates", () => {
  const {
    readIdentityRegion,
  } = require("../../frontend/js/auth/idIdentityService");
  assert.equal(readIdentityRegion("birthDate", "1992 / 04 / 23"), "04/23/1992");
  assert.equal(readIdentityRegion("expiryDate", "2032/04/23\n2033/04/23"), "");
  assert.equal(readIdentityRegion("birthDate", "1992/02/31"), "");
  assert.equal(
    readIdentityRegion(
      "address",
      "PHL M 1992/04/23\nAddress\nP-7 HILLSIDE ROAD\nEXAMPLE TOWN, SAMPLE PROVINCE",
    ),
    "P-7 HILLSIDE ROAD, EXAMPLE TOWN, SAMPLE PROVINCE",
  );
});

test("complementary OCR passes retain fields without inventing contradictory dates", () => {
  const {
    mergeIdentityReadings,
  } = require("../../frontend/js/auth/idIdentityService");
  const primary = {
    idType: "DRIVERS_LICENSE",
    fullName: "Alex Sample",
    birthDate: "04/23/1992",
    address: "",
    expiryDate: "",
  };
  const merged = mergeIdentityReadings(primary, {
    idType: "DRIVERS_LICENSE",
    birthDate: "04/23/1992",
    address: "FICTIONAL ROAD",
    expiryDate: "04/23/2032",
  });
  assert.equal(merged.birthDate, "04/23/1992");
  assert.equal(merged.address, "FICTIONAL ROAD");
  assert.equal(merged.expiryDate, "04/23/2032");
  assert.equal(primary.address, "");
  const conflict = mergeIdentityReadings(primary, {
    idType: "DRIVERS_LICENSE",
    birthDate: "04/23/1993",
  });
  assert.equal(conflict.birthDate, "");
  assert.deepEqual(conflict.conflicts, ["birthDate"]);
  assert.equal(
    mergeIdentityReadings(primary, {
      idType: "PASSPORT",
      address: "OTHER DOCUMENT",
    }).address,
    "",
  );
});

test("focused rectangles stay inside the actual image and require observed field anchors", () => {
  const {
    identityScanRegions,
  } = require("../../frontend/js/auth/idIdentityService");
  const word = (text, x0, y0, width = 60) => ({
    text,
    bbox: { x0, x1: x0 + width, y0, y1: y0 + 10 },
  });
  const words = [
    word("Date", 300, 100, 30),
    word("of", 335, 100, 10),
    word("Birth", 350, 100, 30),
    word("Weight", 440, 100),
    word("Address", 200, 140),
    word("License", 200, 220),
    word("No.", 265, 220, 20),
    word("Expiration", 360, 220),
    word("Date", 425, 220, 30),
    word("Agency", 520, 220),
    word("Code", 585, 220, 30),
    word("Blood", 200, 270),
  ];
  const regions = identityScanRegions(
    words,
    { width: 850, height: 530 },
    { idType: "DRIVERS_LICENSE" },
  );
  assert.deepEqual(
    regions.map((region) => region.field),
    ["birthDate", "address", "expiryDate"],
  );
  for (const region of regions) {
    assert.ok(
      region.left >= 0 &&
        region.top >= 0 &&
        region.width > 0 &&
        region.height > 0,
    );
    assert.ok(
      region.left + region.width <= 850 && region.top + region.height <= 530,
    );
  }
  assert.deepEqual(
    identityScanRegions([], { width: 850, height: 530 }, {}),
    [],
  );
  assert.equal(
    identityScanRegions(
      words,
      { width: 850, height: 530 },
      { conflicts: ["birthDate"] },
    ).some((region) => region.field === "birthDate"),
    false,
  );
});
