const test = require('node:test');
const assert = require('node:assert/strict');
const IdIdentityService = require('../../frontend/js/auth/idIdentityService');

test('extractIdentityFields maintains backward compatibility with core field names', () => {
  const sample = `
    FULL NAME: Juan Dela Cruz
    DATE OF BIRTH: 05/15/1992
    ADDRESS: 123 Lacson St, Barangay 19, Bacolod City
  `;
  const result = IdIdentityService.extractIdentityFields(sample);

  assert.equal(typeof result.fullName, 'string');
  assert.equal(typeof result.birthDate, 'string');
  assert.equal(typeof result.address, 'string');
  assert.equal(result.fullName, 'Juan Dela Cruz');
  assert.equal(result.birthDate, '05/15/1992');
  assert.ok(result.address.includes('Bacolod City'));
});

test('extractIdentityFields extracts PhilSys National ID with 16-digit PCN and no expiration', () => {
  const samplePhilSys = `
    REPUBLIKA NG PILIPINAS
    PHILIPPINE STATISTICS AUTHORITY
    PAMBANSANG PAGKAKAKILANLAN
    PHILIPPINE IDENTIFICATION CARD
    1234-5678-9012-3456
    FULL NAME: JUAN DELA CRUZ
    DATE OF BIRTH: 05/15/1990
    SEX: MALE
    ADDRESS: 45 RIZAL ST, BARANGAY 19, BACOLOD CITY
  `;

  const fields = IdIdentityService.extractIdentityFields(samplePhilSys);
  assert.equal(fields.idType, 'PHILSYS');
  assert.equal(fields.idNumber, '1234-5678-9012-3456');
  assert.equal(fields.fullName, 'Juan Dela Cruz');
  assert.equal(fields.birthDate, '05/15/1990');
  assert.equal(fields.sex, 'M');
  assert.equal(fields.expiryDate, null);
  assert.equal(fields.standardized, true);

  const validation = IdIdentityService.validateDocumentFields(fields);
  assert.equal(validation.state, 'document_detected');
  assert.equal(validation.isExpired, null);
  assert.equal(validation.expirationStatus, 'NOT_APPLICABLE');
  assert.ok(validation.confidenceScore >= 80);
});

test('extractIdentityFields extracts LTO Driver License and flags expiration when past reference date', () => {
  const sampleDL = `
    REPUBLIC OF THE PHILIPPINES
    DEPARTMENT OF TRANSPORTATION
    LAND TRANSPORTATION OFFICE
    DRIVER'S LICENSE
    LICENSE NO: N02-18-009876
    FULL NAME: MARIA CLARA SANTOS
    DATE OF BIRTH: 10/24/1995
    EXPIRY DATE: 10/24/2020
    SEX: FEMALE
    ADDRESS: BLK 4 LOT 12, BARANGAY VILLAMONTE, BACOLOD CITY
  `;

  const fields = IdIdentityService.extractIdentityFields(sampleDL);
  assert.equal(fields.idType, 'DRIVERS_LICENSE');
  assert.equal(fields.idNumber, 'N02-18-009876');
  assert.equal(fields.fullName, 'Maria Clara Santos');
  assert.equal(fields.birthDate, '10/24/1995');
  assert.equal(fields.expiryDate, '10/24/2020');
  assert.equal(fields.sex, 'F');
  assert.equal(fields.standardized, true);

  // Reference date: Sept 17, 2026 (expired in 2020)
  const validationExpired = IdIdentityService.validateDocumentFields(fields, new Date('2026-09-17'));
  assert.equal(validationExpired.isExpired, true);
  assert.equal(validationExpired.state, 'needs_manual_review');
  assert.ok(validationExpired.issues.some(i => i.includes('expired')));

  // Reference date: 2019 (before expiration)
  const validationActive = IdIdentityService.validateDocumentFields(fields, new Date('2019-01-01'));
  assert.equal(validationActive.isExpired, false);
  assert.equal(validationActive.state, 'document_detected');
});

test('extractIdentityFields extracts Philippine Passport number and unexpired validity', () => {
  const samplePassport = `
    REPUBLIKA NG PILIPINAS
    PASSPORT / PASAPORTE
    PASSPORT NO: P9876543A
    FULL NAME: JOSE PROTACIO RIZAL
    DATE OF BIRTH: 06/19/1988
    VALID UNTIL: 06/19/2035
    SEX: M
    NATIONALITY: FILIPINO
    ADDRESS: CALAMBA ST, BARANGAY MANDALAGAN, BACOLOD CITY
  `;

  const fields = IdIdentityService.extractIdentityFields(samplePassport);
  assert.equal(fields.idType, 'PASSPORT');
  assert.equal(fields.idNumber, 'P9876543A');
  assert.equal(fields.fullName, 'Jose Protacio Rizal');
  assert.equal(fields.birthDate, '06/19/1988');
  assert.equal(fields.expiryDate, '06/19/2035');
  assert.equal(fields.sex, 'M');

  const validation = IdIdentityService.validateDocumentFields(fields, new Date('2026-09-17'));
  assert.equal(validation.state, 'document_detected');
  assert.equal(validation.isExpired, false);
});

test('extractIdentityFields extracts UMID, SSS, and PhilHealth standardized numbers', () => {
  const sampleUMID = `
    REPUBLIC OF THE PHILIPPINES
    UNIFIED MULTI-PURPOSE ID (UMID)
    CRN: 0033-1234567-8
    NAME: JUAN DELA CRUZ
    DATE OF BIRTH: 01/01/1990
    ADDRESS: BARANGAY ALANGILAN, BACOLOD CITY
  `;
  const umid = IdIdentityService.extractIdentityFields(sampleUMID);
  assert.equal(umid.idType, 'UMID');
  assert.equal(umid.idNumber, '0033-1234567-8');

  const sampleSSS = `
    SOCIAL SECURITY SYSTEM
    SS NUMBER: 34-1234567-8
    NAME: JUAN DELA CRUZ
    DATE OF BIRTH: 01/01/1990
    ADDRESS: BARANGAY TACULING, BACOLOD CITY
  `;
  const sss = IdIdentityService.extractIdentityFields(sampleSSS);
  assert.equal(sss.idType, 'SSS');
  assert.equal(sss.idNumber, '34-1234567-8');

  const samplePhilHealth = `
    PHILIPPINE HEALTH INSURANCE CORPORATION
    PHILHEALTH IDENTIFICATION CARD
    PHILHEALTH NO: 12-345678901-2
    NAME: JUAN DELA CRUZ
    DOB: 01/01/1990
    ADDRESS: BARANGAY ESTEFANIA, BACOLOD CITY
  `;
  const ph = IdIdentityService.extractIdentityFields(samplePhilHealth);
  assert.equal(ph.idType, 'PHILHEALTH');
  assert.equal(ph.idNumber, '12-345678901-2');
});

test('extractIdentityFields flags unstandardized LGU formats as standardized=false', () => {
  const sampleSenior = `
    OFFICE OF THE SENIOR CITIZENS AFFAIRS
    OSCA SENIOR CITIZEN ID
    CONTROL NO: OSCA-BCD-2024-99
    NAME: PEDRO PENDUKO
    DATE OF BIRTH: 01/01/1950
    ADDRESS: BARANGAY 1, BACOLOD CITY
  `;
  const fields = IdIdentityService.extractIdentityFields(sampleSenior);
  assert.equal(fields.idType, 'SENIOR_CITIZEN');
  assert.equal(fields.standardized, false);
});

test('validateDocumentFields classifies non-ID text as REJECTED', () => {
  const receiptText = `
    SUPERMARKET GROCERY RECEIPT
    ITEM 1: FRESH MILK 1L - 95.00
    ITEM 2: WHOLE WHEAT BREAD - 65.00
    SUBTOTAL: 160.00
    VAT: 19.20
    TOTAL: 179.20
    THANK YOU FOR SHOPPING!
  `;

  const validation = IdIdentityService.validateDocumentFields(receiptText);
  assert.equal(validation.state, 'rejected');
  assert.ok(validation.confidenceScore < 40);
  assert.ok(validation.missingFields.length > 0);
  assert.ok(validation.disclaimer.includes('does not establish official government authenticity'));
});

test('createIdentityDTO produces structured candidate DTO with disclaimers', () => {
  const sampleText = `
    PHILIPPINE IDENTIFICATION CARD
    PHILIPPINE STATISTICS AUTHORITY
    1111-2222-3333-4444
    FULL NAME: ANA MARIE REYES
    DATE OF BIRTH: 1994-03-12
    SEX: FEMALE
    ADDRESS: LOT 5, BARANGAY BATA, BACOLOD CITY
  `;

  const parsed = IdIdentityService.extractIdentityFields(sampleText);
  const validation = IdIdentityService.validateDocumentFields(parsed);
  const dto = IdIdentityService.createIdentityDTO(parsed, validation);

  assert.equal(dto.documentType, 'PHILSYS');
  assert.equal(dto.documentTypeLabel, 'PhilSys National ID');
  assert.equal(dto.idNumber, '1111-2222-3333-4444');
  assert.equal(dto.fullName, 'Ana Marie Reyes');
  assert.equal(dto.birthDate, '03/12/1994');
  assert.equal(dto.sex, 'F');
  assert.equal(dto.validationState, 'document_detected');
  assert.equal(dto.standardizedFormat, true);
  assert.ok(dto.disclaimer.includes('does not establish official government authenticity'));
});

test('extractIdentityFields handles empty or malformed inputs without throwing', () => {
  assert.doesNotThrow(() => {
    const res1 = IdIdentityService.extractIdentityFields('');
    assert.equal(res1.fullName, '');
    assert.equal(res1.idType, 'UNKNOWN');

    const res2 = IdIdentityService.extractIdentityFields(null);
    assert.equal(res2.fullName, '');

    const res3 = IdIdentityService.extractIdentityFields(undefined);
    assert.equal(res3.fullName, '');
  });
});

test('compareLocationWithIdAddress returns fail-closed semantics on missing data and never fabricates Barangay 1', async () => {
  // Case 1: Missing GPS
  const noGps = await IdIdentityService.compareLocationWithIdAddress({
    idAddress: '123 Rizal St, Barangay 19, Bacolod City',
    latitude: null,
    longitude: null
  });
  assert.equal(noGps.ok, false);
  assert.equal(noGps.matches, false);
  assert.equal(noGps.idBarangay, null);
  assert.equal(noGps.liveBarangay, null);
  assert.notEqual(noGps.idBarangay, 'Barangay 1');
  assert.notEqual(noGps.liveBarangay, 'Barangay 1');

  // Case 2: Missing Address
  const noAddress = await IdIdentityService.compareLocationWithIdAddress({
    idAddress: '',
    latitude: 10.6765,
    longitude: 122.9511
  });
  assert.equal(noAddress.ok, false);
  assert.equal(noAddress.matches, false);
  assert.equal(noAddress.idBarangay, null);
  assert.equal(noAddress.liveBarangay, null);

  // Case 3: Empty object
  const emptyRes = await IdIdentityService.compareLocationWithIdAddress();
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.matches, false);
  assert.equal(emptyRes.idBarangay, null);
  assert.equal(emptyRes.liveBarangay, null);
});


test('document titles distinguish no-date National ID, UMID and SSS with date of birth only', () => {
  const extract = IdIdentityService.extractIdentityFields;
  for (const [header, number, expected] of [
    ['PAMBANSANG PAGKAKAKILANLAN / PHILIPPINE IDENTIFICATION CARD', '1111-2222-3333-4444', 'PHILSYS'],
    ['UNIFIED MULTI-PURPOSE ID / SOCIAL SECURITY SYSTEM', 'CRN: 1111-2222222-3', 'UMID'],
    ['SOCIAL SECURITY SYSTEM', 'SS NUMBER: 11-2222222-3', 'SSS'],
  ]) {
    const fields = extract(`${header}\n${number}\nFULL NAME: SAMPLE TEST USER\nDATE OF BIRTH: NOVEMBER 18, 2000\nADDRESS: SAMPLE STREET`);
    assert.equal(fields.idType, expected);
    assert.equal(fields.expiryDate, null);
    assert.equal(IdIdentityService.mergeIdentityReadings(fields, fields).expiryDate, null);
    const validity = IdIdentityService.validateDocumentFields(fields);
    assert.equal(validity.expirationStatus, 'NOT_APPLICABLE');
    assert.equal(validity.isExpired, null);
    assert.ok(!validity.missingFields.includes('expiryDate'));
  }
});

test('conflicting document titles require review and printed unreadable expirations stay unknown', () => {
  const extract = IdIdentityService.extractIdentityFields;
  const validate = IdIdentityService.validateDocumentFields;
  assert.equal(extract('NATIONAL ID').idType, 'UNKNOWN');
  assert.equal(extract('PHILIPPINE IDENTIFICATION CARD\nUNIFIED MULTI-PURPOSE ID').idType, 'UNKNOWN');
  const fields = extract('PHILIPPINE IDENTIFICATION CARD\nEXPIRATION DATE:\nDATE OF BIRTH: 2000-02-01');
  assert.equal(fields.expiryDate, null);
  assert.equal(validate(fields).expirationStatus, 'REVIEW_REQUIRED');
  assert.ok(validate(fields).missingFields.includes('expiryDate'));
  assert.equal(extract('PHILIPPINE IDENTIFICATION CARD').nationality, '');
});

test('required expiry is never supplied by DOB or an unrelated date', () => {
  for (const type of ['DRIVERS LICENSE', 'PHILIPPINE PASSPORT']) {
    const result = IdIdentityService.extractIdentityFields(`${type}\nDATE OF BIRTH: 2000-02-01\nDATE OF ISSUE: 2025-01-01\n2030-01-01`);
    assert.equal(result.expiryDate, '');
    const validity = IdIdentityService.validateDocumentFields(result);
    assert.equal(validity.expirationStatus, 'UNKNOWN');
    assert.ok(validity.missingFields.includes('expiryDate'));
  }
});
