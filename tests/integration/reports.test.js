const test = require('node:test');
const assert = require('node:assert/strict');
const { startSignedEnrollment } = require('../support/signed-enrollment');
const { freshReportFixAt } = require('../support/citizens');

let server;
let baseUrl;
let enrollment;
let adminToken;
let barangayToken;
const { createOfficial } = require('../support/accounts');
let citizenToken;
let citizenId;
let createdReportId;

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function buildReportForm({ imageCount = 2, overrides = {} } = {}) {
  const form = new FormData();
  const fields = {
    description: 'Pothole on Main Street causing vehicular slowdown',
    location: '123 Main Street',
    barangay: 'Barangay 1',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15',
    gpsFixAt: freshReportFixAt(),
    aiCategory: 'Road Hazard',
    landmarkDescription: 'Beside the school entrance.',
    ...overrides
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  for (let i = 0; i < imageCount; i++) {
    form.append('images', jpegFile(`evidence-${i + 1}.jpg`, i === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES));
  }
  form.append('landmarkImage', jpegFile('landmark.jpg'));
  return form;
}

test.before(async () => {
  enrollment = await startSignedEnrollment();
  ({ server, baseUrl } = await require('../support/test-app').startTestServer());
});

test.after(() => { server?.close(); enrollment?.close(); });

async function register(username) {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await enrollment.registrationPayload(baseUrl, { username, password: 'password123' }))
  });
}

test('admin login succeeds and issues a valid JWT', async () => {
  const response = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.token);
  assert.equal(data.user.role, 'admin');
  adminToken = data.token;
  barangayToken = (await createOfficial(baseUrl, adminToken, 'Barangay 1', 'reports_workflow')).token;
});

test('citizen can register successfully', async () => {
  const username = `citizen_${Date.now()}`;
  const response = await register(username);
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.ok(data.token);
  assert.equal(data.user.username, username);
  assert.equal(data.user.role, 'citizen');
  assert.equal(data.user.barangay, 'Barangay 1');
  assert.equal(data.user.residencyVerified, true);
  citizenToken = data.token;
  citizenId = data.user.id;
});

test('duplicate registration fails with 409', async () => {
  const username = `dup_${Date.now()}`;
  assert.equal((await register(username)).status, 201);
  const dupResponse = await register(username);
  assert.equal(dupResponse.status, 409);
});

test('GET /api/me returns the authenticated user payload', async () => {
  const response = await fetch(`${baseUrl}/api/me`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.id, citizenId);
  assert.equal(data.user.role, 'citizen');
});

test('report submission with zero images is rejected (400)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ imageCount: 0 })
  });
  assert.equal(response.status, 400);
});

test('report submission with one image is rejected (400)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ imageCount: 1 })
  });
  assert.equal(response.status, 400);
});

test('report submission with three images is rejected (400)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ imageCount: 3 })
  });
  assert.equal(response.status, 400);
});

test('report submission with exactly two images is accepted (201) and persists both images in order', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ imageCount: 2 })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.ok(data.id);
  assert.equal(data.status, 'pending');
  assert.equal(data.barangay, 'Barangay 1');
  // The form posts aiCategory 'Road Hazard'. With no detector available the
  // report records no AI assessment rather than trusting that claim.
  assert.equal(data.ai_category, null);
  assert.equal(data.ai_classification, null);
  assert.equal(data.ai_priority, null);
  assert.equal(data.ai_confidence, null);
  assert.equal(Number(data.vision_detected), 0);
  assert.ok(Array.isArray(data.images));
  assert.equal(data.images.length, 2);
  assert.equal(data.images[0].imageOrder, 1);
  assert.equal(data.images[1].imageOrder, 2);
  assert.ok(data.images[0].imagePath);
  assert.ok(data.images[1].imagePath);
  createdReportId = data.id;

  assert.equal((await fetch(`${baseUrl}${data.images[0].imagePath}`)).status, 401);
  const imageResponse = await fetch(`${baseUrl}${data.images[0].imagePath}`, { headers: { Authorization: `Bearer ${citizenToken}` } });
  assert.equal(imageResponse.status, 200);
});

test('report submission validates required description', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${citizenToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description: '   ',
      barangay: 'Barangay 1'
    })
  });
  assert.equal(response.status, 400);
});

test('citizen can fetch reports list and find newly created report', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.reports));
  assert.ok(data.stats);
  const found = data.reports.find(r => r.id === createdReportId);
  assert.ok(found);
  assert.equal(found.status, 'pending');
  assert.ok(Array.isArray(found.images));
  assert.equal(found.images.length, 2);
  assert.equal(found.images[0].imageOrder, 1);
  assert.equal(found.images[1].imageOrder, 2);
});

test('citizen cannot update report status (403 forbidden)', async () => {
  const response = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${citizenToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'ongoing' })
  });
  assert.equal(response.status, 403);
});

test('Admin monitors while the assigned Barangay updates operational status', async () => {
  const denied = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ongoing' }) });
  assert.equal(denied.status, 403);
  const response = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${barangayToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'ongoing' })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ongoing');
});

test('status transition is recorded in report status history', async () => {
  const response = await fetch(`${baseUrl}/api/reports/${createdReportId}/history`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.history));
  const entry = data.history.find(h => h.new_status === 'ongoing');
  assert.ok(entry);
  assert.equal(entry.old_status, 'pending');
  assert.equal(entry.report_id, createdReportId);
});

test('citizen can view own report status history', async () => {
  const response = await fetch(`${baseUrl}/api/reports/${createdReportId}/history`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(response.status, 200);
});

test('invalid status update returns 400', async () => {
  const response = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${barangayToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'invalid_status_code' })
  });
  assert.equal(response.status, 400);
});

test('citizen cannot access admin endpoints (403 forbidden)', async () => {
  const response = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(response.status, 403);
});

test('admin can create a barangay official user', async () => {
  const officialUsername = `official_${Date.now()}`;
  const response = await fetch(`${baseUrl}/api/admin/barangay-users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username: officialUsername,
      password: 'password123',
      barangay: 'Barangay 1',
      full_name: 'Captain Central'
    })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.user.username, officialUsername);
  assert.equal(data.user.role, 'barangay');
});

test('barangay official cannot update a report outside their own barangay jurisdiction', async () => {
  const outsideUsername = `official_outside_${Date.now()}`;
  const createResponse = await fetch(`${baseUrl}/api/admin/barangay-users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username: outsideUsername,
      password: 'password123',
      barangay: 'Barangay 41',
      full_name: 'Captain Outside'
    })
  });
  assert.equal(createResponse.status, 201);

  const loginResponse = await fetch(`${baseUrl}/api/auth/barangay/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: outsideUsername, password: 'password123' })
  });
  assert.equal(loginResponse.status, 200);
  const { token: outsideOfficialToken } = await loginResponse.json();

  const patchResponse = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${outsideOfficialToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'resolved' })
  });
  assert.equal(patchResponse.status, 403);
});

test('report submission with 15m GPS accuracy is accepted (201)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ overrides: { gpsAccuracy: '15' } })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.gps_accuracy, 15);
});

test('report submission with 100m GPS accuracy is accepted (201)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ overrides: { gpsAccuracy: '100' } })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.gps_accuracy, 100);
});

test('report submission with >100m GPS accuracy is rejected (400)', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm({ overrides: { gpsAccuracy: '101' } })
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /exceeds maximum allowed threshold/i);
});

test('report submission with malformed GPS accuracy is rejected (400)', async () => {
  for (const badAccuracy of ['not-a-number', '-5', 'bad']) {
    const response = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: buildReportForm({ overrides: { gpsAccuracy: badAccuracy } })
    });
    assert.equal(response.status, 400, `accuracy ${badAccuracy} must return 400`);
    const data = await response.json();
    assert.match(data.error, /valid non-negative number/i);
  }
});

