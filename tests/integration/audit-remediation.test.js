const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const fs = require('node:fs/promises');

const { startSignedEnrollment } = require('../support/signed-enrollment');
const path = require('node:path');

// Regressions for the findings raised by the independent backend audit.

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

const detector = { answer: null, pair: null, calls: 0 };
const inference = async () => {
  detector.calls += 1;
  if (typeof detector.answer === 'function') return detector.answer();
  if (!detector.answer) throw new Error('provider unavailable');
  return detector.answer;
};
const pairInference = async () => {
  if (typeof detector.pair === 'function') return detector.pair();
  if (!detector.pair) throw new Error('pair provider unavailable');
  return detector.pair;
};

let server;
let baseUrl;
let citizenToken;
let adminToken;
let enrollment;
let testDatabase;
let stubInference;
let env;
let UPLOAD_ROOT;

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function authed(token, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
}

// Every AI field a client could try to assert, in both spellings.
const MALICIOUS_AI_FIELDS = {
  aiCategory: 'Client Forged Category',
  ai_category: 'Client Forged Category',
  aiClassification: 'MAJOR',
  ai_classification: 'MAJOR',
  aiPriority: 'Critical',
  ai_priority: 'Critical',
  aiConfidence: '100',
  ai_confidence: '100',
  visionDetected: 'true',
  vision_detected: 'true',
  verification: JSON.stringify({
    summary: {
      is_valid_match: true,
      composite_similarity_score: 0.99,
      embedding_similarity: 0.99,
      damage_type_consensus: 'client-forged-consensus',
      highest_severity: 'critical'
    },
    model: 'client-forged-model'
  })
};

function reportForm(overrides = {}, imageCount = 2) {
  const form = new FormData();
  const fields = {
    description: 'Audit remediation probe',
    barangay: 'Barangay Central',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15',
    gpsFixAt: freshReportFixAt(),
    landmarkDescription: 'Beside the school entrance.',
    ...overrides
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  for (let i = 0; i < imageCount; i++) form.append('images', jpegFile(`probe-${i + 1}.jpg`, i === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES));
  form.append('landmarkImage', jpegFile('landmark.jpg'));
  return form;
}

async function submitReport(overrides = {}) {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm(overrides)
  }));
  return { status: response.status, body: await response.json() };
}

async function uploadCount() {
  try {
    return (await fs.readdir(env.UPLOAD_DIR)).length;
  } catch {
    return 0;
  }
}

async function register(prefix) {
  const { token } = await seedCitizen({ username: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay: 'Barangay Central', reporting: true });
  return token;
}

test.before(async () => {
  enrollment = await startSignedEnrollment();
  const { startTestServer, ...fixtures } = require('../support/test-app');
  ({ testDatabase, stubInference } = fixtures);
  ({ UPLOAD_ROOT } = require('../../server/infrastructure/storage/uploadDirectory'));
  env = require('../../server/infrastructure/config/env');
  ({ server, baseUrl } = await startTestServer({ inference, pairInference }));
  citizenToken = await register('audit_citizen');

  const login = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  adminToken = (await login.json()).token;
});

test.beforeEach(() => {
  detector.answer = null;
  detector.pair = null;
  detector.calls = 0;
  stubInference(inference, pairInference);
});

test.after(() => { server?.close(); enrollment?.close(); });

// ------------------------------------------- NL-AUD-001 client AI is not truth

test('client AI fields lose to the server detection when the detector succeeds', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.93 }] };

  const { status, body } = await submitReport(MALICIOUS_AI_FIELDS);

  assert.equal(status, 201);
  assert.equal(body.ai_category, 'pothole');
  assert.equal(Number(body.ai_confidence), 93);
  assert.notEqual(body.ai_category, 'Client Forged Category');

  const row = (await testDatabase().query('SELECT * FROM reports WHERE id = ?', [body.id]))[0];
  assert.equal(row.ai_category, 'pothole');
  assert.notEqual(row.ai_category, 'Client Forged Category');
});

test('client AI fields are ignored when the detector finds no damage', async () => {
  detector.answer = { detected: false, detections: [] };

  const { status, body } = await submitReport(MALICIOUS_AI_FIELDS);

  assert.equal(status, 201);
  const row = (await testDatabase().query('SELECT * FROM reports WHERE id = ?', [body.id]))[0];
  assert.equal(row.ai_category, null);
  assert.equal(row.ai_classification, null);
  assert.equal(row.ai_priority, null);
  assert.equal(row.ai_confidence, null);
  assert.equal(Number(row.vision_detected), 0);
});

test('client AI fields are ignored when the detector throws', async () => {
  detector.answer = () => { throw new Error('inference exploded'); };

  const { status, body } = await submitReport(MALICIOUS_AI_FIELDS);

  assert.equal(status, 201);
  const row = (await testDatabase().query('SELECT * FROM reports WHERE id = ?', [body.id]))[0];
  assert.equal(row.ai_category, null);
  assert.equal(row.ai_priority, null);
  assert.equal(Number(row.vision_detected), 0);
});

test('client AI fields are ignored when the provider is unreachable', async () => {
  detector.answer = null; // the stub rejects, standing in for a dead service

  const { status, body } = await submitReport(MALICIOUS_AI_FIELDS);

  assert.equal(status, 201);
  const row = (await testDatabase().query('SELECT * FROM reports WHERE id = ?', [body.id]))[0];
  assert.equal(row.ai_category, null);
  assert.equal(row.ai_classification, null);
  assert.equal(Number(row.vision_detected), 0);
});

// ------------------------------------- NL-AUD-002 client verification is not truth

test('a forged verification payload never reaches damage_verifications', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.9 }] };
  detector.pair = null; // server-side pair check unavailable

  const { body } = await submitReport(MALICIOUS_AI_FIELDS);

  const rows = await testDatabase().query('SELECT * FROM damage_verifications WHERE report_id = ?', [body.id]);
  assert.equal(rows.length, 0, 'no verification row may exist without a server-derived result');

  const forged = await testDatabase().query(
    'SELECT * FROM damage_verifications WHERE matched_damage_type = ?',
    ['client-forged-consensus']
  );
  assert.equal(forged.length, 0);
});

test('the stored verification is the one the server derived from the uploaded pair', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.9 }] };
  detector.pair = {
    summary: {
      is_valid_match: true,
      composite_similarity_score: 0.77,
      embedding_similarity: 0.71,
      damage_type_consensus: 'pothole',
      highest_severity: 'critical',
      alignment: { perspective_aligned: true, inlier_ratio: 0.42 }
    },
    model: 'server-derived-model'
  };

  const { body } = await submitReport(MALICIOUS_AI_FIELDS);

  const [row] = await testDatabase().query('SELECT * FROM damage_verifications WHERE report_id = ?', [body.id]);
  assert.ok(row, 'a server-derived verification must be stored');
  assert.equal(row.matched_damage_type, 'pothole');
  assert.notEqual(row.matched_damage_type, 'client-forged-consensus');
  assert.equal(Number(row.composite_similarity_score), 0.77);
  assert.notEqual(Number(row.composite_similarity_score), 0.99);
});

// ----------------------------------------- NL-AUD-003 report upload cleanup

test('an invalid report body leaves no uploaded file behind', async () => {
  const before = await uploadCount();

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: '   ' })
  }));

  assert.equal(response.status, 400);
  assert.equal(await uploadCount(), before, 'a rejected body must not leave uploads on disk');
});

test('an out-of-range coordinate leaves no uploaded file behind', async () => {
  const before = await uploadCount();

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ latitude: '91' })
  }));

  assert.equal(response.status, 400);
  assert.equal(await uploadCount(), before);
});

test('an invalid image count leaves no uploaded file behind', async () => {
  const before = await uploadCount();

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({}, 1)
  }));

  assert.equal(response.status, 400);
  assert.equal(await uploadCount(), before);
});

test('a successfully stored report keeps its evidence on disk', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.9 }] };
  const before = await uploadCount();

  const { status, body } = await submitReport();

  assert.equal(status, 201);
  assert.equal(await uploadCount(), before + 5, 'original evidence images, landmark image, and private publication previews must remain');
  for (const image of body.images) {
    const [stored] = await require('../support/test-app').testDatabase().query('SELECT image_path FROM report_images WHERE id = ?', [image.id]);
    await fs.access(path.join(UPLOAD_ROOT, path.basename(stored.image_path)));
  }
});

// -------------------------------------- NL-AUD-004 inference preview cleanup

test('a damage preview removes its temporary upload on success', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.9 }] };
  const before = await uploadCount();

  const form = new FormData();
  form.append('images', jpegFile('preview.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 200);
  assert.equal(await uploadCount(), before, 'a preview upload must not persist');
});

test('a damage preview removes its temporary upload when inference fails', async () => {
  detector.answer = () => { throw new Error('provider down'); };
  const before = await uploadCount();

  const form = new FormData();
  form.append('images', jpegFile('preview-fail.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.ok(response.status >= 400);
  assert.equal(await uploadCount(), before);
});

test('a pair preview removes its temporary uploads even when the count is wrong', async () => {
  const before = await uploadCount();

  const form = new FormData();
  form.append('images', jpegFile('only-one.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage-pair`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 400);
  assert.equal(await uploadCount(), before, 'a rejected pair request must not leave files');
});

test('a pair preview removes its temporary uploads on success', async () => {
  detector.pair = { summary: { is_valid_match: true, damage_type_consensus: 'pothole' } };
  const before = await uploadCount();

  const form = new FormData();
  form.append('images', jpegFile('pair-1.jpg'));
  form.append('images', jpegFile('pair-2.jpg', SECOND_JPEG_BYTES));
  const response = await fetch(`${baseUrl}/api/ai/damage-pair`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 200);
  assert.equal(await uploadCount(), before);
});

// ------------------------------------------- NL-AUD-006 coordinate bounds

test('coordinates at the geographic limits are accepted by input validation', () => {
  const { validateReport } = require('../../server/application/use-cases/report.validation');
  for (const [latitude, longitude] of [[-90, -180], [90, 180], [0, 0]]) {
    const result = validateReport({
      description: 'Audit probe description',
      barangay: 'Barangay Central',
      latitude: String(latitude),
      longitude: String(longitude),
      gpsAccuracy: '15'
    });
    assert.equal(result.error, undefined, `${latitude},${longitude} is a valid coordinate`);
  }
});

test('coordinates outside the geographic range are refused with a validation error', async () => {
  const cases = [
    { latitude: '-90.1', longitude: '0', field: 'Latitude' },
    { latitude: '90.1', longitude: '0', field: 'Latitude' },
    { latitude: '0', longitude: '-180.1', field: 'Longitude' },
    { latitude: '0', longitude: '180.1', field: 'Longitude' }
  ];

  for (const { latitude, longitude, field } of cases) {
    const { status, body } = await submitReport({ latitude, longitude });
    assert.equal(status, 400, `${latitude},${longitude} must be refused`);
    assert.match(body.error, new RegExp(field));
  }
});

test('a report without numeric coordinates cannot be persisted', async () => {
  detector.answer = { detections: [{ class: 'pothole', confidence: 0.9 }] };

  const { status, body } = await submitReport({ latitude: 'not-a-number', longitude: 'nonsense' });
  assert.equal(status, 400);
  assert.equal(body.code, 'REPORT_LOCATION_RETRY');
});

// --------------------------------------------- NL-AUD-007 auth input limits

test('an over-long username is refused before it reaches SQL', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'u'.repeat(191), password: 'password123', barangay: 'Barangay Central' })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at most 190/);
});

test('a username at the column limit is accepted', async () => {
  // Padded to exactly 190 characters while staying unique: the test database
  // persists between runs, so a fixed name would collide on the second run.
  const unique = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const username = `u${unique}`.padEnd(190, 'x').slice(0, 190);
  assert.equal(username.length, 190);

  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await enrollment.registrationPayload(baseUrl, { username, password: 'password123', barangay: 'Villamonte' }))
  });

  assert.equal(response.status, 201);
});

test('an over-long full name or barangay is refused', async () => {
  const payload = await enrollment.registrationPayload(baseUrl, { username: `fullname_${Date.now()}`, password: 'password123', barangay: 'Villamonte' });
  const tooLongName = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, identity: { ...payload.identity, fullName: 'n'.repeat(191) } })
  });
  assert.equal(tooLongName.status, 400);
  assert.match((await tooLongName.json()).error, /must match the verified document/);

  const tooLongBarangay = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `barangay_${Date.now()}`,
      password: 'password123',
      barangay: 'b'.repeat(151)
    })
  });
  assert.equal(tooLongBarangay.status, 400);
  assert.match((await tooLongBarangay.json()).error, /Barangay must be at most 150/);
});

test('an over-long barangay official username is refused too', async () => {
  const response = await fetch(`${baseUrl}/api/admin/barangay-users`, authed(adminToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'o'.repeat(191), password: 'password1234', barangay: 'Barangay Central' })
  }));

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at most 190/);
});
