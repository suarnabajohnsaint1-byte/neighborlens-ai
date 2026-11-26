const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../frontend/js/auth/idIdentityService');

const cases = [
  ['single-line name', 'FULL NAME: ALEX MORGAN SAMPLE', 'Alex Morgan Sample', ''],
  ['inline components', 'SURNAME: DELA CRUZ GIVEN NAMES: ALEX MORGAN MIDDLE NAME: SAMPLE', 'Alex Morgan Sample Dela Cruz', ''],
  ['separate components', 'SURNAME\nDELA CRUZ\nGIVEN NAMES\nALEX MORGAN\nMIDDLE NAME\nSAMPLE', 'Alex Morgan Sample Dela Cruz', ''],
  ['multiline name', 'FULL NAME\nALEX MORGAN\nDELA CRUZ\nDOB: 2001-09-15', 'Alex Morgan Dela Cruz', '09/15/2001'],
  ['suffix and hyphen', 'NAME: ALEX SAMPLE-CRUZ JR.\nDOB: 2001-09-15', 'Alex Sample-cruz Jr.', '09/15/2001'],
  ['bilingual components', 'Apelyido / Last Name\nSAMPLE\nMga Pangalan / Given Names\nALEX MORGAN\nGitnang Apelyido / Middle Name\nREYES', 'Alex Morgan Reyes Sample', ''],
  ['month name', 'DOB: 15 SEP 2001', '', '09/15/2001'],
  ['numeric unambiguous month first', 'BIRTH DATE: 09/15/2001', '', '09/15/2001'],
  ['numeric unambiguous day first', 'PETSANG KAPANGANAKAN: 15-09-2001', '', '09/15/2001'],
  ['punctuated label', 'D.O.B.: 2001-09-15', '', '09/15/2001'],
  ['expiry alongside birth', 'DOB: 2001-09-15 EXPIRY: 2030-09-15', '', '09/15/2001'],
  ['issue is not birth', 'DATE OF BIRTH\nDATE OF ISSUE: 2020-09-15', '', ''],
  ['issue inline is not birth', 'DOB: DATE OF ISSUE: 2020-09-15', '', ''],
  ['invalid calendar', 'DOB: 2001-02-29', '', ''],
  ['ambiguous numeric', 'DOB: 03/04/2001', '', ''],
  ['equal month and day', 'DOB: 04/04/2001', '', '04/04/2001'],
  ['missing name does not invent one', 'SYNTHETIC DOCUMENT HEADER\nDOB: 2001-09-15', '', '09/15/2001'],
  ['missing birth', 'NAME: ALEX SAMPLE\nEXPIRY: 2030-09-15', 'Alex Sample', ''],
  ['whitespace', 'FULL NAME :  ALEX   SAMPLE\nDATE OF BIRTH : 2001 - 09 - 15', 'Alex Sample', '09/15/2001'],
  ['no identity fields', 'UNRELATED SYNTHETIC TEXT', '', ''],
];
for (const [label, text, fullName, birthDate] of cases) {
  test(`OCR regression: ${label}`, () => {
    const fields = service.extractIdentityFields(text);
    assert.equal(fields.fullName, fullName);
    assert.equal(fields.birthDate, birthDate);
  });
}
test('a secondary reading recovers a missing name but preserves conflicts', () => {
  const first = { idType: 'PHILSYS', fullName: '', birthDate: '', conflicts: [] };
  const second = { idType: 'PHILSYS', fullName: 'Alex Sample', birthDate: '09/15/2001' };
  assert.equal(service.mergeIdentityReadings(first, second).fullName, 'Alex Sample');
  const conflict = service.mergeIdentityReadings(second, { ...second, fullName: 'Other Sample' });
  assert.equal(conflict.fullName, '');
  assert.ok(conflict.conflicts.includes('fullName'));
  assert.equal(service.mergeIdentityReadings(conflict, second).fullName, '');
});
test('a cropped date region cannot reinterpret an issue date as birth', () => {
  assert.equal(service.readIdentityRegion('birthDate', 'DATE OF ISSUE: 2020-09-15'), '');
});
for (const [type, header] of [
  ['PHILSYS', 'PHILIPPINE IDENTIFICATION CARD'],
  ['DRIVERS_LICENSE', 'LAND TRANSPORTATION OFFICE'],
  ['PASSPORT', 'PASSPORT'], ['UMID', 'UNIFIED MULTI-PURPOSE ID'],
  ['SSS', 'SOCIAL SECURITY SYSTEM'], ['PHILHEALTH', 'PHILHEALTH'],
  ['PRC_ID', 'PROFESSIONAL REGULATION'], ['POSTAL_ID', 'POSTAL ID'],
  ['VOTERS_ID', 'COMELEC'], ['SENIOR_CITIZEN', 'OSCA SENIOR CITIZEN'],
  ['PWD', 'PWD ID'],
]) {
  test(`supported ${type} labeled identity retains name and date`, () => {
    const fields = service.extractIdentityFields(`${header}\nNAME: ALEX SAMPLE\nDOB: 2001-09-15`);
    assert.equal(fields.idType, type);
    assert.equal(fields.fullName, 'Alex Sample');
    assert.equal(fields.birthDate, '09/15/2001');
  });
}
test('student IDs remain outside the accepted policy', () => {
  assert.equal(service.extractIdentityFields('STUDENT ID\nNAME: ALEX SAMPLE').idType, 'UNKNOWN');
});
test('punctuation-only string is never accepted as full name', () => {
  const fields = service.extractIdentityFields('REPUBLIC OF THE PHILIPPINES\nLAND TRANSPORTATION OFFICE\nFULL NAME: ..\nDOB: 2001-09-15');
  assert.equal(fields.fullName, '');
});
test('LTO license with .. noise and NN address noise extracts clean name and address', () => {
  const text = `REPUBLIC OF THE PHILIPPINES
LAND TRANSPORTATION OFFICE
DRIVERS LICENSE
Last Name, First Name, Middle Name
..
DELA CRUZ, JOSIE
Date of Birth
1999/07/11
Address
NN
#012 A-345, SAMPLE STREET, MANILA
License No. A01-23-456789`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Josie Dela Cruz');
  assert.equal(fields.birthDate, '07/11/1999');
  assert.equal(fields.address, '#012 A-345, SAMPLE STREET, MANILA');
  assert.equal(fields.idNumber, 'A01-23-456789');
});
test('LTO placeholder birthdate YYYY/MM/DD is not fabricated into a date', () => {
  const text = `REPUBLIC OF THE PHILIPPINES
LAND TRANSPORTATION OFFICE
DRIVERS LICENSE
Last Name, First Name, Middle Name
DELA CRUZ, JOSIE
Date of Birth
YYYY/MM/DD
Address
#012 A-345, SAMPLE STREET, MANILA
License No. A01-23-456789`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Josie Dela Cruz');
  assert.equal(fields.birthDate, '');
  assert.equal(fields.address, '#012 A-345, SAMPLE STREET, MANILA');
});
test('three-component comma-separated name maps to First Middle Last', () => {
  const text = `REPUBLIC OF THE PHILIPPINES
LAND TRANSPORTATION OFFICE
DRIVERS LICENSE
Last Name, First Name, Middle Name
DELA CRUZ, JOSIE, SANTOS
DOB: 1999/07/11`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Josie Santos Dela Cruz');
});
test('PhilSys bilingual Tirahan / Address does not contaminate address with slash prefix', () => {
  const text = `REPUBLIC OF THE PHILIPPINES
PHILIPPINE STATISTICS AUTHORITY
PAMBANSANG PAGKAKAKILANLAN
1234-5678-9012-3456
Apelyido / Last Name
DELA CRUZ
Mga Pangalan / Given Names
JOSIE
Gitnang Apelyido / Middle Name
SANTOS
Petsa ng Kapanganakan / Date of Birth
15 SEP 2001
Tirahan / Address
LOT 5, BARANGAY BATA, BACOLOD CITY`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Josie Santos Dela Cruz');
  assert.equal(fields.birthDate, '09/15/2001');
  assert.equal(fields.address, 'LOT 5, BARANGAY BATA, BACOLOD CITY');
});
test('Passport bilingual labels extract surname and given names without fabricating address from birthdate', () => {
  const text = `REPUBLIKA NG PILIPINAS
PHILIPPINE PASSPORT
PASAPORTE
PASSPORT NO. P1234567A
SURNAME / APELYIDO
DELA CRUZ
GIVEN NAMES / MGA PANGALAN
JOSIE
DATE OF BIRTH / PETSA NG KAPANGANAKAN
15 SEP 2001
DATE OF ISSUE / PETSA NG PAGKAPALABAS
10 OCT 2020
DATE OF EXPIRY / PETSA NG PAGKAPASO
10 OCT 2030`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Josie Dela Cruz');
  assert.equal(fields.birthDate, '09/15/2001');
  assert.equal(fields.address, '');
  assert.equal(fields.idNumber, 'P1234567A');
});
test('date-only backend validation is stable across time zones and rejects impossible dates', () => {
  const { spawnSync } = require('node:child_process');
  for (const TZ of ['Asia/Manila', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const code = `const {validateIdentityDto}=require('./server/application/use-cases/identity.validation');
      const assert=require('node:assert/strict');
      assert.equal(validateIdentityDto({birthDate:'2001-09-15'}).value.birthDate,'2001-09-15');
      assert.ok(validateIdentityDto({birthDate:'2001-02-29'}).error);`;
    const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
test('LTO Driver License extracts real card format with Date of Ber and provincial address', () => {
  const text = `LAND TRANSPORTATION OFFICE DRIVERS LICENSE
Last Name. First Name Middle
CLEMENTIR, KENT ASHLEY TUAZON
Notorarty Seu Date of Ber
grr
PHL
[x
1999/07/11
56
1.65
P-3, BASE CAMP. MARAMAG. BUKIDNON, 8714
K22-22-000371
K22
2027/07/11`;
  const fields = service.extractIdentityFields(text);
  assert.equal(fields.fullName, 'Kent Ashley Tuazon Clementir');
  assert.equal(fields.birthDate, '07/11/1999');
  assert.equal(fields.address, 'P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714');
  assert.equal(fields.idType, 'DRIVERS_LICENSE');
  assert.equal(fields.idNumber, 'K22-22-000371');
  assert.equal(fields.expiryDate, '07/11/2027');
});

test('Apelyido identifies the surname when the English label is unreadable', () => {
  for (const surname of ['Apelyido / Surname: SAMPLE', 'Apelyido / [unreadable]: SAMPLE', 'Apelyido\nSAMPLE']) {
    const fields = service.extractIdentityFields([
      'PHILIPPINE IDENTIFICATION CARD', surname,
      'Mga Pangalan / Given Names', 'ALEX', 'Gitnang Apelyido / Middle Name', 'TEST',
    ].join('\n'));
    assert.equal(fields.fullName, 'Alex Test Sample');
    assert.equal(fields.expiryDate, null);
  }
});

test('physical ID recovery rejects letters and incomplete ID digits and accepts a labeled date without comma spacing', () => {
  assert.equal(service.extractIdentityFields('CRN: O222-333X333-4').idNumber, '');
  assert.equal(service.readIdentityRegion('idNumber', '2222-333333-4', 'UMID'), '');
  assert.equal(service.readIdentityRegion('idNumber', '2222-3333333-4', 'UMID'), '2222-3333333-4');
  assert.equal(service.readIdentityRegion('idNumber', '2222-3333-4444-5555', 'PHILSYS'), '2222-3333-4444-5555');
  assert.equal(service.extractIdentityFields('DATE OF BIRTH: OCTOBER 18,1984').birthDate, '10/18/1984');
});

test('PhilSys uses the value under each bilingual label even with unrelated text on the left', () => {
  const rows = [
    [35, 45, 'PHILIPPINE IDENTIFICATION CARD'],
    [45, 76, '2222-3333-4444-5555'],
    [250, 108, 'Apelyido / Last Name'],
    [250, 130, 'DELA CRUZ'],
    [250, 158, 'Mga Pangalan / Given Names'],
    [250, 180, 'ALEX MARIE'],
    [250, 203, 'Gitnang Apelyido / Middle Name'],
    [250, 226, 'SAMPLE'],
    [250, 255, 'Petsa ng Kapanganakan / Date of Birth'],
    [250, 279, 'OCTOBER 18, 1984'],
    [43, 305, 'Tirahan / Address'],
    [43, 327, 'PUROK 4, SAMPLE STREET'],
    [43, 351, 'FICTITIOUS CITY, NEGROS OCCIDENTAL'],
    [25, 130, 'UNRELATED LEFT COLUMN'],
    [25, 180, 'PORTRAIT TEXT'],
  ];
  const words = rows.flatMap(([left, top, line]) => {
    let x = left;
    return line.split(' ').map(text => {
      const bbox = { x0: x, x1: x + text.length * 6, y0: top, y1: top + 10 };
      x = bbox.x1 + 5;
      return { text, bbox };
    });
  });
  const fields = service.extractIdentityFields(rows.map(row => row[2]).join('\n'), words);
  assert.deepEqual(
    [fields.idType, fields.fullName, fields.birthDate, fields.address, fields.idNumber, fields.expiryDate],
    ['PHILSYS', 'Alex Marie Sample Dela Cruz', '10/18/1984',
      'PUROK 4, SAMPLE STREET, FICTITIOUS CITY, NEGROS OCCIDENTAL', '2222-3333-4444-5555', null],
  );
});

test('PhilSys leaves a truncated headline, stray date, and malformed or conflicting PCNs unresolved', () => {
  const fields = service.extractIdentityFields([
    'PHILIPPINE IDENTIFICATION CARD', 'PCN: X2222-3333-4444-5555',
    'Tirahan / Addrexx', 'REPUBLIKA NG PILIP', 'OCTOBER 18, 1984',
  ].join('\n'));
  assert.equal(fields.idType, 'PHILSYS');
  assert.equal(fields.address, '');
  assert.equal(fields.birthDate, '');
  assert.equal(fields.idNumber, '');
  assert.equal(service.readIdentityRegion('address', 'REPUBLIKA NG PILIP'), '');
  assert.equal(service.readIdentityRegion('address', 'PAMBANSANG PAGKAKAKILANLAN', 'PHILSYS'), '');
  assert.equal(service.extractIdentityFields('PHILIPPINE IDENTIFICATION CARD\n2222-3333-4444-5555\n2222-3333-4444-5556').idNumber, '');

  const unknown = service.prepareScanFields({ idType: 'UNKNOWN', idNumber: 'O222-333X333-4', address: 'REPUBLIKA NG PILIP' });
  assert.deepEqual([unknown.idNumber, unknown.address], ['', '']);
  const pcns = service.mergeIdentityReadings(
    { idType: 'PHILSYS', idNumber: '2222-3333-4444-5555' },
    { idType: 'PHILSYS', idNumber: '2222-3333-4444-5556' },
  );
  assert.equal(pcns.idNumber, '');
  assert.ok(pcns.conflicts.includes('idNumber'));
  const mixed = service.mergeIdentityReadings(fields, { idType: 'UMID', idNumber: '2222-3333333-4' });
  assert.deepEqual([mixed.idType, mixed.idNumber], ['UNKNOWN', '']);
});

test('PhilSys rejects cross-field text and disputed suffixes without rejecting a labeled short surname', () => {
  const header = 'PHILIPPINE IDENTIFICATION CARD';
  assert.equal(service.extractIdentityFields(`${header}\nNAME: ZZR\nTirahan: ALEX SAMPLE`).fullName, '');
  const valid = service.extractIdentityFields(`${header}\nApelyido: GO\nMga Pangalan: ANA\nTirahan: 2 ANA GO`);
  assert.equal(valid.fullName, 'Ana Go');
  assert.equal(valid.address, '');
  assert.equal(service.agreeIdentityField('Ana Go ZZ', 'Ana Go'), '');
  assert.equal(service.agreeIdentityField('Ana Go', 'ANA GO'), 'Ana Go');
  assert.equal(service.agreeIdentityField('PUROK 3, SAMPLE CAMP', 'PUROK 3 SAMPLE CAMP'), 'PUROK 3, SAMPLE CAMP');
  assert.equal(service.agreeIdentityField('PUROK 3, SAMPLE CAMP', '3 PUROK, SAMPLE CAMP'), '');
  assert.equal(service.readIdentityRegion('address', 'Tirahan/Adarexs\nXX 24\nPUROK 3, SAMPLE CAMP\nFICTIONAL CITY', 'PHILSYS'),
    'PUROK 3, SAMPLE CAMP, FICTIONAL CITY');
});

test('a labeled PhilSys reading corroborates one usable crop when the other is blank', () => {
  const address = 'PUROK 4, SAMPLE STREET, FICTITIOUS CITY';
  const labeled = 'Tirahan / Address\nPUROK 4 SAMPLE STREET\nFICTITIOUS CITY';
  const different = 'PUROK 5, OTHER STREET, FICTITIOUS CITY';
  assert.equal(service.corroboratePhilSysAddress('', address, [labeled]), address);
  assert.equal(service.corroboratePhilSysAddress(different, address, [labeled]), address);
  assert.equal(service.corroboratePhilSysAddress('', address, [address]), '');
  assert.equal(service.corroboratePhilSysAddress('', address, ['Tirahan / Address\nREPUBLIKA NG PILIP']), '');
  assert.equal(service.corroboratePhilSysAddress('', address, ['Tirahan / Address\nPUROK 4 SAMPLE STREET']), '');
  assert.equal(service.corroboratePhilSysAddress(different, address, [labeled, `Tirahan / Address\n${different}`]), '');
});

test('PhilSys retains matching whole-document reads when the focused crops are incomplete', () => {
  const first = { idType: 'PHILSYS', fullName: 'Ana Dela Cruz', address: 'PUROK 3, SAMPLE CAMP' };
  const second = { idType: 'PHILSYS', fullName: 'ANA DELA CRUZ', address: 'PUROK 3 SAMPLE CAMP' };
  assert.equal(service.consistentPhilSysDocumentField([first, second], 'fullName', ['', '']), first.fullName);
  assert.equal(service.consistentPhilSysDocumentField([first, second], 'address', ['', second.address]), first.address);
  assert.equal(service.consistentPhilSysDocumentField([first, second], 'fullName', ['Ana Cruz', '']), '');
  assert.equal(service.consistentPhilSysDocumentField([first], 'address', ['', first.address]), '');
  assert.equal(service.consistentPhilSysDocumentField([first, { ...second, idType: 'UMID' }], 'address', []), '');
});

test('LTO license normalizes separators and preserves the digits read from the document', () => {
  const textWith900 = `LAND TRANSPORTATION OFFICE DRIVERS LICENSE
Last Name. First Name Middle
CLEMENTIR, KENT ASHLEY TUAZON
Date of Birth: 1999/07/11
P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714
K22-22-900371
2027/07/11`;
  const fields1 = service.extractIdentityFields(textWith900);
  assert.equal(fields1.idNumber, 'K22-22-900371');

  const textMissingHyphen = `LAND TRANSPORTATION OFFICE DRIVERS LICENSE
Last Name. First Name Middle
CLEMENTIR, KENT ASHLEY TUAZON
Date of Birth: 1999/07/11
P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714
K22-22000371
2027/07/11`;
  const fields2 = service.extractIdentityFields(textMissingHyphen);
  assert.equal(fields2.idNumber, 'K22-22-000371');
});

test('validateDocumentFields handles both ISO and slash expiry dates correctly', () => {
  const futureIso = service.validateDocumentFields({
    fullName: 'Josie Dela Cruz',
    birthDate: '1999-07-11',
    address: 'Sample Manila',
    idType: 'DRIVERS_LICENSE',
    idNumber: 'A01-23-456789',
    expiryDate: '2030-07-11'
  });
  assert.equal(futureIso.isExpired, false);

  const pastIso = service.validateDocumentFields({
    fullName: 'Josie Dela Cruz',
    birthDate: '1999-07-11',
    address: 'Sample Manila',
    idType: 'DRIVERS_LICENSE',
    idNumber: 'A01-23-456789',
    expiryDate: '2020-07-11'
  });
  assert.equal(pastIso.isExpired, true);

  const pastSlash = service.validateDocumentFields({
    fullName: 'Josie Dela Cruz',
    birthDate: '07/11/1999',
    address: 'Sample Manila',
    idType: 'DRIVERS_LICENSE',
    idNumber: 'A01-23-456789',
    expiryDate: '07/11/2020'
  });
  assert.equal(pastSlash.isExpired, true);
});


