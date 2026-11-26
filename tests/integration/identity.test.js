const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp, seedExistingCitizen } = require('../support/test-app');

const app = createTestApp();

let server;
let baseUrl;

test.before(() => new Promise(resolve => {
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => server.close());

async function registerCitizen(usernamePrefix) {
  const username = `${usernamePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const data = await seedExistingCitizen({ username, password: 'password123', barangay: 'Barangay Central' });
  return { token: data.token, id: data.user.id };
}

test('citizen can save their own OCR-assisted identity DTO', async () => {
  const citizen = await registerCitizen('idcit');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'national_id',
      idNumber: '1234-5678-9012',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2030-01-01',
      ocrConfidence: 0.87,
      formatCheckStatus: 'pass',
      documentValidationStatus: 'needs_review',
      isExpired: false
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentType, 'national_id');
  assert.equal(data.identity.fullName, 'Juan Dela Cruz');
  assert.equal(data.identity.birthDate, '1995-06-15');
  assert.equal(data.identity.ocrConfidence, 0.87);
  assert.equal(data.identity.isExpired, false);
});

test('citizen can retrieve their own saved identity DTO', async () => {
  const citizen = await registerCitizen('idcit2');
  await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Maria Santos', documentType: 'drivers_license' })
  });

  const response = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.fullName, 'Maria Santos');
  assert.equal(data.identity.documentType, 'drivers_license');
  assert.equal(data.identity.idNumber, null);
  assert.equal(data.identity.birthDate, null);
});

test('a citizen with no saved identity gets null, not a fabricated default', async () => {
  const citizen = await registerCitizen('idcit3');
  const response = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity, null);
});

test('citizen cannot retrieve another citizen identity record', async () => {
  const citizenA = await registerCitizen('idcitA');
  const citizenB = await registerCitizen('idcitB');

  await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenA.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Citizen A Secret Name' })
  });

  // /me is always scoped to the caller's JWT; no endpoint takes a user id.
  const response = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizenB.token}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.notEqual(data.identity?.fullName, 'Citizen A Secret Name');
  assert.equal(data.identity, null);
});

test('malformed identity DTO is rejected with 400', async () => {
  const citizen = await registerCitizen('idcit4');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ birthDate: 'not-a-date' })
  });
  assert.equal(response.status, 400);
});

test('out-of-range OCR confidence is rejected with 400', async () => {
  const citizen = await registerCitizen('idcit5');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ocrConfidence: 250 })
  });
  assert.equal(response.status, 400);
});

test('identity endpoints require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/identity/me`);
  assert.equal(response.status, 401);
});

test('barangay and admin roles cannot use the citizen identity endpoint', async () => {
  const loginResponse = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' })
  });
  const { token } = await loginResponse.json();
  const response = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 403);
});

test('server derives isExpired=true for past expiryDate (persisted and returned)', async () => {
  const citizen = await registerCitizen('idexp1');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'drivers_license',
      expiryDate: '2020-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.isExpired, true);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.isExpired, true);
});

test('server derives isExpired=false for future expiryDate (persisted and returned)', async () => {
  const citizen = await registerCitizen('idexp2');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'drivers_license',
      expiryDate: '2035-12-31'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.isExpired, false);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.isExpired, false);
});

test('server derives isExpired=null for missing or null expiryDate', async () => {
  const citizen = await registerCitizen('idexp3');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'national_id',
      expiryDate: null
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.isExpired, null);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.isExpired, null);
});

test('server enforces trust boundary: malicious client isExpired=false does not override expired date', async () => {
  const citizen = await registerCitizen('idexp4');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'drivers_license',
      expiryDate: '2020-01-01',
      isExpired: false
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.isExpired, true);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.isExpired, true);
});

test('deriveIsExpired unit test: normalizes referenceDate to UTC calendar date', () => {
  const { deriveIsExpired } = require('../../server/domain/identity/identity.rules');

  const refMorning = new Date(Date.UTC(2026, 8, 19, 1, 0, 0));
  const refNight = new Date(Date.UTC(2026, 8, 19, 23, 59, 59));

  // Same UTC calendar date -> false
  assert.equal(deriveIsExpired('2026-09-19', refMorning), false);
  assert.equal(deriveIsExpired('2026-09-19', refNight), false);

  // Past UTC date -> true
  assert.equal(deriveIsExpired('2026-09-18', refMorning), true);

  // Future UTC date -> false
  assert.equal(deriveIsExpired('2026-09-20', refMorning), false);

  // Null/empty/undefined -> null
  assert.equal(deriveIsExpired(null, refMorning), null);
  assert.equal(deriveIsExpired(undefined, refMorning), null);
  assert.equal(deriveIsExpired('', refMorning), null);
});

test('server derives formatCheckStatus="pass" for PHILSYS with valid format', async () => {
  const citizen = await registerCitizen('idfchk1');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'pass');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'pass');
});

test('server derives formatCheckStatus="fail" for PHILSYS with invalid format', async () => {
  const citizen = await registerCitizen('idfchk2');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: 'invalid-philsys-number'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'fail');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'fail');
});

test('server derives formatCheckStatus="pass" for PHILHEALTH with valid 2-9-1 format', async () => {
  const citizen = await registerCitizen('idfchk3');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILHEALTH',
      idNumber: '12-345678901-2'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'pass');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'pass');
});

test('server derives formatCheckStatus="fail" for PHILHEALTH with invalid format', async () => {
  const citizen = await registerCitizen('idfchk4');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILHEALTH',
      idNumber: '12-345-678'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'fail');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'fail');
});

test('server derives formatCheckStatus="needs_review" for recognized document type without deterministic backend rule (PASSPORT)', async () => {
  const citizen = await registerCitizen('idfchk5');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PASSPORT',
      idNumber: 'P1234567A'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'needs_review');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'needs_review');
});

test('server derives formatCheckStatus="needs_review" for PWD document type', async () => {
  const citizen = await registerCitizen('idfchk6');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PWD',
      idNumber: 'PWD-1234-5678'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'needs_review');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'needs_review');
});

test('server derives formatCheckStatus="unknown" for UNKNOWN document type', async () => {
  const citizen = await registerCitizen('idfchk7');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'UNKNOWN',
      idNumber: '9999-9999'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'unknown');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'unknown');
});

test('server derives formatCheckStatus="unknown" for missing or null idNumber', async () => {
  const citizen = await registerCitizen('idfchk8');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: null
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'unknown');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'unknown');
});

test('server enforces trust boundary: malicious client formatCheckStatus="pass" does not override invalid format', async () => {
  const citizen = await registerCitizen('idfchk9');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: 'invalid-id-value',
      formatCheckStatus: 'pass'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.formatCheckStatus, 'fail');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.formatCheckStatus, 'fail');
});

test('server derives documentValidationStatus="pass" for complete valid PHILSYS', async () => {
  const citizen = await registerCitizen('idval1');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2030-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'pass');
  assert.equal(data.identity.formatCheckStatus, 'pass');
  assert.equal(data.identity.isExpired, false);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'pass');
});

test('server derives documentValidationStatus="pass" for complete valid PHILHEALTH', async () => {
  const citizen = await registerCitizen('idval2');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILHEALTH',
      idNumber: '12-345678901-2',
      fullName: 'Maria Santos',
      birthDate: '1990-01-01',
      address: '456 Rizal Street, Bacolod City',
      expiryDate: '2035-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'pass');
  assert.equal(data.identity.formatCheckStatus, 'pass');
  assert.equal(data.identity.isExpired, false);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'pass');
});

test('server derives documentValidationStatus="fail" when deterministic format fails', async () => {
  const citizen = await registerCitizen('idval3');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: 'invalid-philsys-format',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2030-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'fail');
  assert.equal(data.identity.formatCheckStatus, 'fail');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'fail');
});

test('server derives documentValidationStatus="fail" for expired document', async () => {
  const citizen = await registerCitizen('idval4');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2020-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'fail');
  assert.equal(data.identity.isExpired, true);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'fail');
});

test('deriveDocumentValidationStatus unit test: table-driven missing required identity facts return "needs_review"', () => {
  const { deriveDocumentValidationStatus } = require('../../server/domain/identity/identity.rules');

  const completeValid = {
    documentType: 'PHILSYS',
    idNumber: '1234-5678-9012-3456',
    fullName: 'Juan Dela Cruz',
    birthDate: '1995-06-15',
    address: '123 Lacson Street, Bacolod City',
    formatCheckStatus: 'pass',
    isExpired: false
  };

  assert.equal(deriveDocumentValidationStatus(completeValid), 'pass');

  // Each missing required identity fact yields "needs_review"
  const missingFields = ['fullName', 'birthDate', 'address', 'idNumber'];
  for (const field of missingFields) {
    assert.equal(
      deriveDocumentValidationStatus({ ...completeValid, [field]: null }),
      'needs_review',
      `Expected missing ${field} to yield "needs_review"`
    );
    assert.equal(
      deriveDocumentValidationStatus({ ...completeValid, [field]: '' }),
      'needs_review',
      `Expected empty ${field} to yield "needs_review"`
    );
  }
});

test('server derives documentValidationStatus="needs_review" when a required fact is missing on save', async () => {
  const citizen = await registerCitizen('idval5');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: null, // missing required address
      expiryDate: '2030-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'needs_review');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'needs_review');
});

test('server derives documentValidationStatus="needs_review" for recognized document with review-only format (PASSPORT)', async () => {
  const citizen = await registerCitizen('idval6');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PASSPORT',
      idNumber: 'P1234567A',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2030-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'needs_review');
  assert.equal(data.identity.formatCheckStatus, 'needs_review');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'needs_review');
});

test('server derives documentValidationStatus="needs_review" for UNKNOWN/unrecognized document type', async () => {
  const citizen = await registerCitizen('idval7');
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'UNKNOWN',
      idNumber: '12345678',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2030-01-01'
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'needs_review');
  assert.equal(data.identity.formatCheckStatus, 'unknown');

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'needs_review');
});

test('server enforces trust boundary: malicious client conclusion overrides are rejected', async () => {
  const citizen = await registerCitizen('idval8');
  // Client maliciously attempts to assert "pass" on an expired document with invalid ID format
  const response = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentType: 'PHILSYS',
      idNumber: 'invalid-id',
      fullName: 'Juan Dela Cruz',
      birthDate: '1995-06-15',
      address: '123 Lacson Street, Bacolod City',
      expiryDate: '2020-01-01',
      documentValidationStatus: 'pass',
      formatCheckStatus: 'pass',
      isExpired: false
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.identity.documentValidationStatus, 'fail');
  assert.equal(data.identity.formatCheckStatus, 'fail');
  assert.equal(data.identity.isExpired, true);

  const getResponse = await fetch(`${baseUrl}/api/identity/me`, {
    headers: { Authorization: `Bearer ${citizen.token}` }
  });
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.identity.documentValidationStatus, 'fail');
  assert.equal(getData.identity.formatCheckStatus, 'fail');
  assert.equal(getData.identity.isExpired, true);
});

test('identity API applies the expiration policy of the submitted document type', async () => {
  const citizen = await registerCitizen('idpol');
  const headers = { Authorization: `Bearer ${citizen.token}`, 'Content-Type': 'application/json' };
  for (const [documentType, idNumber, expiryDate, expirationStatus, documentValidationStatus] of [
    ['PHILSYS', '1111-2222-3333-4444', null, 'NOT_APPLICABLE', 'pass'],
    ['UMID', '1111-2222222-3', null, 'NOT_APPLICABLE', 'needs_review'],
    ['SSS', '11-2222222-3', null, 'NOT_APPLICABLE', 'needs_review'],
    ['PASSPORT', 'P1234567A', null, 'UNKNOWN', 'needs_review'],
    ['DRIVERS_LICENSE', 'N01-23-456789', null, 'UNKNOWN', 'needs_review'],
    ['DRIVERS_LICENSE', 'N01-23-456789', '2000-01-01', 'EXPIRED', 'fail'],
    ['PHILSYS', '1111-2222222-3', null, 'NOT_APPLICABLE', 'fail'],
  ]) {
    const response = await fetch(`${baseUrl}/api/identity`, {
      method: 'POST', headers,
      body: JSON.stringify({
        documentType, idNumber, expiryDate, fullName: 'Fictional Sample Resident',
        birthDate: '1995-06-15', address: 'Fictional Address, Bacolod City',
        expirationStatus: 'VALID', documentValidationStatus: 'pass',
      }),
    });
    assert.equal(response.status, 200, documentType);
    const { identity } = await response.json();
    assert.equal(identity.expirationStatus, expirationStatus, documentType);
    assert.equal(identity.documentValidationStatus, documentValidationStatus, documentType);
    const read = await fetch(`${baseUrl}/api/identity/me`, { headers });
    assert.equal(read.status, 200);
    const saved = (await read.json()).identity;
    assert.equal(saved.expiryDate, expiryDate);
    assert.equal(saved.expirationStatus, expirationStatus);
    assert.equal(saved.isExpired, expiryDate ? true : null);
  }
});
