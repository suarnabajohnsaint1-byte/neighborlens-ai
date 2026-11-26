const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt, installFixtureBarangay } = require('../support/citizens');

const { createTestApp, stubInference, testDatabase } = require('../support/test-app');
const { DamageDetectionError } = require('../../server/domain/errors');


const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

// Each test sets `scripted.answer`; a function answer may throw to simulate a
// provider failure.
const scripted = { answer: { detections: [] } };
const app = createTestApp({
  inference: async () => (typeof scripted.answer === 'function' ? scripted.answer() : scripted.answer)
});

let server;
let baseUrl;
let citizenToken;
let otherCitizenToken;
let adminToken;

function authed(token, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
}

async function registerCitizen(prefix) {
  const { token } = await seedCitizen({ username: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay: 'Barangay Central', reporting: true });
  return token;
}

function reportForm(overrides = {}, imageCount = 2) {
  const form = new FormData();
  const fields = {
    description: 'QA probe report for backend verification',
    location: 'QA Street',
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
  for (let i = 0; i < imageCount; i++) form.append('images', jpegFile(`qa-${i + 1}.jpg`, i === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES));
  form.append('landmarkImage', jpegFile('landmark.jpg'));
  return form;
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  citizenToken = await registerCitizen('qa_citizen');
  otherCitizenToken = await registerCitizen('qa_other');

  const adminResponse = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  adminToken = (await adminResponse.json()).token;
});

test.after(() => server.close());

// ---------------------------------------------------------------- authorization

test('a tampered token is rejected without revealing why', async () => {
  const tampered = `${citizenToken.slice(0, -4)}AAAA`;
  const response = await fetch(`${baseUrl}/api/me`, authed(tampered));

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'Invalid or expired token.');
  assert.equal(body.stack, undefined);
});

test('a token with no Bearer prefix is refused', async () => {
  const response = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: citizenToken } });
  assert.equal(response.status, 401);
});

test('a citizen sees only their own reports, never another citizen submission', async () => {
  const created = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `Ownership probe ${Date.now()}` })
  }));
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const list = await fetch(`${baseUrl}/api/reports`, authed(otherCitizenToken));
  const { reports } = await list.json();
  assert.equal(reports.some(report => report.id === id), false,
    'another citizen must not be able to list this report');
});

test('a citizen cannot read the status history of a report they do not own', async () => {
  const created = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `History probe ${Date.now()}` })
  }));
  const { id } = await created.json();

  const response = await fetch(`${baseUrl}/api/reports/${id}/history`, authed(otherCitizenToken));
  assert.equal(response.status, 403);
});

test('an unknown report id is a 404, not a leak of whether it belongs to somebody', async () => {
  const response = await fetch(`${baseUrl}/api/reports/99999999/history`, authed(adminToken));
  assert.equal(response.status, 404);
});

test('a citizen cannot create a barangay official account', async () => {
  const response = await fetch(`${baseUrl}/api/admin/barangay-users`, authed(citizenToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'escalation_probe', password: 'password1234', barangay: 'Barangay Central' })
  }));
  assert.equal(response.status, 403);
});

test('registration cannot smuggle in a privileged role', async () => {
  const username = `role_probe_${Date.now()}`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123', role: 'admin', barangay: 'Barangay Central' })
  });

  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.token, undefined);
  assert.equal(result.user, undefined);
});

test('no account listing or login response exposes a password hash', async () => {
  const login = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const loginBody = await login.json();
  assert.equal(loginBody.user.password_hash, undefined);

  const users = await fetch(`${baseUrl}/api/admin/users`, authed(adminToken));
  const { users: rows } = await users.json();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.password_hash, undefined, 'the user read model must not carry a hash');
  }
});

// ------------------------------------------------------------------- validation

test('a malformed JSON body is rejected without a stack trace', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"username": "admin", '
  });

  assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
  const text = await response.text();
  assert.equal(/ at .*\.js:\d+:\d+/.test(text), false, 'a stack trace must not reach the client');
});

test('a non-image upload is refused by the file filter', async () => {
  const form = new FormData();
  form.append('description', 'Bad upload probe');
  form.append('barangay', 'Barangay Central');
  form.append('images', new File([Buffer.from('#!/bin/sh\necho hi')], 'payload.sh', { type: 'text/x-shellscript' }));
  form.append('images', jpegFile('ok.jpg'));

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, { method: 'POST', body: form }));
  assert.equal(response.status, 400);
});

test('a PNG mislabelled as JPEG is caught by content inspection, not its declared type', async () => {
  const form = new FormData();
  form.append('images', new File([PNG_BYTES], 'liar.jpg', { type: 'image/jpeg' }));

  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'IMAGE_FORMAT');
});

test('non-numeric coordinates cannot create a report', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ latitude: 'not-a-latitude', longitude: 'nonsense' })
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'REPORT_LOCATION_RETRY');
});

test('an unresolved incident barangay cannot create a report or queue publication', async () => {
  const before = await testDatabase().query('SELECT id FROM community_publication_requests');
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ barangay: '', latitude: '10.674', longitude: '122.97' })
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'REPORT_LOCATION_RETRY');
  assert.deepEqual(await testDatabase().query('SELECT id FROM community_publication_requests'), before);
});

// -------------------------------------------------------------- damage detection

test('damage detection returns a normalized result on a successful inference', async () => {
  scripted.answer = {
    model: 'qa-fake-detector',
    detections: [{ class: 'pothole', confidence: 0.91, severity_level: 'critical', bbox: { x: 1, y: 2, width: 30, height: 40 } }]
  };

  const form = new FormData();
  form.append('images', jpegFile('damage.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
  assert.equal(body.primary.damage_type, 'pothole');
  assert.equal(body.primary.severity_level, null);
  assert.equal(body.primary.severitySuggestion, null);
});

test('damage detection reports a no-detection outcome as inconclusive, not as a detection', async () => {
  scripted.answer = { detections: [] };

  const form = new FormData();
  form.append('images', jpegFile('empty.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.primary.detected, false);
  assert.equal(body.primary.inconclusive, true);
  assert.equal(body.primary.canonical_category, null);
  assert.equal(body.primary.reason, 'NO_DETECTION');
});

test('a sub-threshold detection is served as LOW_CONFIDENCE with its real confidence', async () => {
  scripted.answer = { detections: [{ class: 'road_crack', confidence: 0.22 }] };

  const form = new FormData();
  form.append('images', jpegFile('weak.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.primary.detected, false);
  assert.equal(body.primary.reason, 'LOW_CONFIDENCE');
  assert.equal(body.primary.confidence, 0.22);
  assert.equal(body.primary.canonical_category, null);
});

test('each canonical class reaches the HTTP response unchanged', async () => {
  for (const category of ['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']) {
    scripted.answer = { detections: [{ class: category, confidence: 0.8 }] };

    const form = new FormData();
    form.append('images', jpegFile(`${category}.jpg`));
    const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.primary.canonical_category, category);
    assert.equal(body.primary.source, 'yolo_backend');
    assert.equal(body.summary.damage_type, category);
  }
});

test('a provider outage surfaces as 502 without exposing the endpoint', async () => {
  scripted.answer = () => {
    throw new DamageDetectionError('Inference request failed: fetch failed', 'INFERENCE_NETWORK', 502);
  };

  const form = new FormData();
  form.append('images', jpegFile('outage.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, 'INFERENCE_NETWORK');
  assert.equal(/https?:\/\/|127\.0\.0\.1|:8000/.test(JSON.stringify(body)), false);
});

test('a provider timeout surfaces as 504', async () => {
  scripted.answer = () => {
    throw new DamageDetectionError('Inference request timed out.', 'INFERENCE_TIMEOUT', 504);
  };

  const form = new FormData();
  form.append('images', jpegFile('slow.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'INFERENCE_TIMEOUT');
});

test('a malformed provider payload is rejected rather than half-interpreted', async () => {
  scripted.answer = { detections: { unexpected: 'shape' } };

  const form = new FormData();
  form.append('images', jpegFile('malformed.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'INFERENCE_RESPONSE');
});

test('dual verification requires exactly two images', async () => {
  scripted.answer = { summary: { is_valid_match: true, damage_type_consensus: 'pothole' } };

  const form = new FormData();
  form.append('images', jpegFile('only-one.jpg'));
  const response = await fetch(`${baseUrl}/api/ai/damage-pair`, authed(citizenToken, { method: 'POST', body: form }));

  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------- geofence

test('a report inside the service area records inside_service_area', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ latitude: '10.6780', longitude: '122.9460' })
  }));

  const created = await response.json();
  assert.equal(created.boundary_check_status, 'inside_service_area');
});

test('a report outside the service area is rejected and not persisted', async () => {
  const allReportsBefore = await (await fetch(`${baseUrl}/api/reports`, authed(adminToken))).json();
  const countBefore = allReportsBefore.reports?.length || 0;

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ latitude: '14.5995', longitude: '120.9842' }) // Manila
  }));

  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /outside the Bacolod City service area/i);

  const allReportsAfter = await (await fetch(`${baseUrl}/api/reports`, authed(adminToken))).json();
  const countAfter = allReportsAfter.reports?.length || 0;
  assert.equal(countAfter, countBefore, 'no report row must be persisted');
});

test('with no authoritative polygons loaded, a citizen declaration cannot authorize reporting', async () => {
  await testDatabase().execute('UPDATE barangays SET boundary_geojson = NULL WHERE name = ?', ['Barangay Central']);
  try {
    const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
      method: 'POST',
      body: reportForm()
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'REPORT_LOCATION_UNAVAILABLE');
  } finally {
    await installFixtureBarangay('Barangay Central');
  }
});

test('a client-declared barangay cannot override the authoritative polygon match once one is loaded', async () => {
  const barangayRepository = require('../../server/infrastructure/repositories/barangay.repository');

  const anchorLat = 10.678;
  const anchorLng = 122.946;
  const authoritativeName = 'Barangay Central';
  const seeded = await barangayRepository.findByName(authoritativeName);

  const preview = await fetch(`${baseUrl}/api/config/report-area`, authed(citizenToken, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: anchorLat, longitude: anchorLng, gpsAccuracy: 15 })
  }));
  assert.equal(preview.status, 200);
  const proposed = await preview.json();
  assert.equal(proposed.barangayId, seeded.id);
  assert.equal(proposed.boundary.name, authoritativeName);

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({
      latitude: String(anchorLat),
      longitude: String(anchorLng),
      gpsAccuracy: '15',
      barangay: 'Attacker-Claimed Barangay'
    })
  }));

  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.jurisdiction_source, 'geofence_resolved');
  assert.equal(created.barangay_id, seeded.id);
  assert.equal(created.barangay, authoritativeName,
    'the authoritative polygon match must win over the client-declared barangay name');
  assert.notEqual(created.barangay, 'Attacker-Claimed Barangay');
});

// ------------------------------------------------------------------- persistence

test('a created report reloads from the database with both images in order', async () => {
  const description = `Reload probe ${Date.now()}`;
  const created = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description })
  }));
  const { id } = await created.json();

  const list = await fetch(`${baseUrl}/api/reports`, authed(citizenToken));
  const { reports } = await list.json();
  const reloaded = reports.find(report => report.id === id);

  assert.ok(reloaded, 'the report must be readable back');
  assert.equal(reloaded.description, description);
  assert.equal(reloaded.images.length, 2);
  assert.deepEqual(reloaded.images.map(image => image.imageOrder), [1, 2]);
  assert.equal(reloaded.status, 'pending');
});
