const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt, reportGpsFields } = require('../support/citizens');
const fs = require('node:fs/promises');
const path = require('node:path');

const { startTestServer, testDatabase, stubInference } = require('../support/test-app');
const { UPLOAD_ROOT, UPLOAD_URL_PREFIX } = require('../../server/infrastructure/storage/uploadDirectory');

// The composed POST /api/reports workflow over HTTP against the isolated SQLite
// adapter: validation, geofence, image bytes, detector, persistence, reload.
// This is isolated-integration evidence, not MySQL runtime proof.

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

// Counts calls so the test can prove both evidence images reach the detector.
function scriptedDetector(answer) {
  const state = { calls: 0, answer };
  state.inference = async () => {
    state.calls += 1;
    return typeof state.answer === 'function' ? state.answer() : state.answer;
  };
  return state;
}

const detector = scriptedDetector({ detections: [{ class: 'pothole', confidence: 0.93, severity_level: 'critical' }] });

let server;
let baseUrl;
let citizenToken;
let adminToken;
let barangayToken;

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function authed(token, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
}

function reportForm(overrides = {}, files = ['a.jpg', 'b.jpg']) {
  const form = new FormData();
  const fields = {
    description: 'Workflow probe report',
    barangay: 'Villamonte',
    latitude: '10.6685',
    longitude: '122.9647',
    gpsAccuracy: '15',
    gpsFixAt: freshReportFixAt(),
    landmarkDescription: 'Beside the school entrance.',
    ...overrides
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  for (const [index, name] of files.entries()) form.append('images', jpegFile(name, index === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES));
  form.append('landmarkImage', jpegFile('landmark.jpg'));
  return form;
}

async function register(prefix) {
  const { token } = await seedCitizen({ username: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay: 'Villamonte', reporting: true });
  return token;
}

test.before(async () => {
  ({ server, baseUrl } = await startTestServer({ inference: detector.inference }));
  citizenToken = await register('wf_citizen');

  const login = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  adminToken = (await login.json()).token;

  const username = `wf_brgy_${Date.now()}`;
  await fetch(`${baseUrl}/api/admin/barangay-users`, authed(adminToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1234', barangay: 'Villamonte' })
  }));
  const brgyLogin = await fetch(`${baseUrl}/api/auth/barangay/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1234' })
  });
  barangayToken = (await brgyLogin.json()).token;
});

test.after(() => server.close());

test('the composed workflow derives the AI result server-side and persists it', async () => {
  const callsBefore = detector.calls;
  const description = `Composed workflow ${Date.now()}`;

  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({
      description,
      aiCategory: 'Client Claimed Category',
      aiConfidence: '1',
      aiPriority: 'Low',
      aiClassification: 'MINOR'
    })
  }));

  assert.equal(response.status, 201);
  const created = await response.json();

  assert.equal(detector.calls - callsBefore, 2, 'both evidence images reach the damage detection service');
  assert.equal(created.ai_category, 'pothole', 'the server detection must win over the client claim');
  assert.equal(Number(created.ai_confidence), 93);
  assert.equal(created.ai_priority, null);
  assert.equal(created.ai_classification, null);
  assert.equal(Number(created.vision_detected), 1);
  assert.equal(created.boundary_check_status, 'inside_service_area');

  const row = (await testDatabase().query('SELECT * FROM reports WHERE id = ?', [created.id]))[0];
  assert.equal(row.ai_category, 'pothole', 'the derived result must be the persisted one');
  assert.equal(Number(row.ai_confidence), 93);
});

test('the uploaded image bytes are written to storage, not just the filename', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `Byte probe ${Date.now()}` })
  }));
  const created = await response.json();

  assert.equal(created.images.length, 2);
  for (const image of created.images) {
    const [row] = await require('../support/test-app').testDatabase().query('SELECT image_path FROM report_images WHERE id = ?', [image.id]);
    const stored = path.join(UPLOAD_ROOT, path.basename(row.image_path));
    const bytes = await fs.readFile(stored);
    const expected = image.imageOrder === 2 ? SECOND_JPEG_BYTES : JPEG_BYTES;
    assert.deepEqual(bytes, expected, 'the stored file must contain the uploaded bytes');
    assert.equal(image.fileSize, expected.length);
    assert.equal(image.mimeType, 'image/jpeg');
  }
});

test('a traversal-shaped upload filename cannot escape the upload directory', async () => {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `Traversal probe ${Date.now()}` }, ['../../../../etc/evil.jpg', 'ok.jpg'])
  }));

  assert.equal(response.status, 201);
  const created = await response.json();
  const uploadRoot = UPLOAD_ROOT;

  for (const image of created.images) {
    const [row] = await require('../support/test-app').testDatabase().query('SELECT image_path FROM report_images WHERE id = ?', [image.id]);
    assert.equal(row.image_path.includes('..'), false, 'no traversal segment may survive into the stored path');
    assert.ok(row.image_path.startsWith(`${UPLOAD_URL_PREFIX}/`));
    assert.match(image.imagePath, /^\/api\/reports\/\d+\/images\/\d+$/);
    const resolved = path.resolve(uploadRoot, path.basename(row.image_path));
    assert.ok(resolved.startsWith(uploadRoot + path.sep), `stored path escaped the upload directory: ${resolved}`);
    await fs.access(resolved);
  }
});

test('a created report reloads through GET with the same persisted data', async () => {
  const description = `Reload probe ${Date.now()}`;
  const created = await (await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description })
  }))).json();

  const { reports } = await (await fetch(`${baseUrl}/api/reports`, authed(citizenToken))).json();
  const reloaded = reports.find(report => report.id === created.id);

  assert.ok(reloaded);
  assert.equal(reloaded.description, description);
  assert.equal(reloaded.ai_category, created.ai_category);
  assert.equal(reloaded.images.length, 2);
  assert.equal(reloaded.status, 'pending');
});

test('report submission still succeeds when the detector is unavailable', async () => {
  const failing = scriptedDetector(() => {
    throw new Error('provider down');
  });
  const isolated = await startTestServer({ inference: failing.inference });

  try {
    const token = await register('wf_down');

    const form = new FormData();
    form.append('description', `Detector down ${Date.now()}`);
    form.append('barangay', 'Villamonte');
    form.append('latitude', '10.6685');
    form.append('longitude', '122.9647');
    form.append('gpsAccuracy', '15');
    form.append('gpsFixAt', String(freshReportFixAt()));
    form.append('aiCategory', 'Road Hazard');
    form.append('aiConfidence', '55');
    form.append('landmarkDescription', 'Beside the school entrance.');
    form.append('images', jpegFile('a.jpg'));
    form.append('images', jpegFile('b.jpg', SECOND_JPEG_BYTES));
    form.append('landmarkImage', jpegFile('landmark.jpg'));

    const response = await fetch(`${isolated.baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });

    assert.equal(response.status, 201, 'a detector outage must not cost the citizen their report');
    const created = await response.json();
    assert.equal(created.ai_category, null, 'client AI values must not fill the gap');
    assert.equal(created.ai_confidence, null);
    assert.equal(created.ai_classification, null);
    assert.equal(created.ai_priority, null);
    assert.equal(Number(created.vision_detected), 0);
  } finally {
    isolated.server.close();
    // stubInference is process-wide; put the shared detector back.
    stubInference(detector.inference);
  }
});

async function newReport(description) {
  const response = await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `${description} ${Date.now()}_${Math.random().toString(36).slice(2, 6)}` })
  }));
  return response.json();
}

function setStatus(id, status, token = barangayToken) {
  if (status === 'resolved') {
    const body = new FormData();
    body.append('status', status);
    body.append('note', 'Completed repair with supporting evidence');
    body.append('requestKey', require('node:crypto').randomUUID());
    body.append('images', jpegFile('completion.jpg'));
    return fetch(`${baseUrl}/api/reports/${id}/status`, authed(token, { method: 'PATCH', body }));
  }
  return fetch(`${baseUrl}/api/reports/${id}/status`, authed(token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...(status === 'rejected' ? { note: 'Duplicate incident confirmed during review.' } : {}) })
  }));
}

test('an unrecognised status string is refused', async () => {
  const created = await newReport('Status probe');
  const response = await setStatus(created.id, 'archived; DROP TABLE reports');
  assert.equal(response.status, 400);
});

test('the workflow the project implements is allowed: pending to ongoing to resolved', async () => {
  const created = await newReport('Forward transition probe');

  assert.equal((await setStatus(created.id, 'ongoing')).status, 200);
  assert.equal((await setStatus(created.id, 'resolved')).status, 200);

  const { history } = await (await fetch(`${baseUrl}/api/reports/${created.id}/history`, authed(adminToken))).json();
  assert.equal(history.length, 2, 'every accepted transition is recorded');
  assert.equal(history[0].old_status, 'pending');
  assert.equal(history[0].new_status, 'ongoing');
  assert.equal(history[1].old_status, 'ongoing');
  assert.equal(history[1].new_status, 'resolved');
});

test('a resolved report is terminal and cannot be reopened or re-closed', async () => {
  const created = await newReport('Terminal probe');
  assert.equal((await setStatus(created.id, 'resolved')).status, 200);

  for (const status of ['pending', 'ongoing', 'rejected', 'resolved']) {
    const response = await setStatus(created.id, status);
    assert.equal(response.status, 400, `resolved must not move to ${status}`);
  }

  const { history } = await (await fetch(`${baseUrl}/api/reports/${created.id}/history`, authed(adminToken))).json();
  assert.equal(history.length, 1, 'a refused transition writes no history row');
});

test('a rejected report is terminal too', async () => {
  const created = await newReport('Rejected probe');
  assert.equal((await setStatus(created.id, 'rejected')).status, 200);
  assert.equal((await setStatus(created.id, 'ongoing')).status, 400);
  assert.equal((await setStatus(created.id, 'resolved')).status, 400);
});

test('a report cannot move backwards from ongoing to pending', async () => {
  const created = await newReport('Backward probe');
  assert.equal((await setStatus(created.id, 'ongoing')).status, 200);
  assert.equal((await setStatus(created.id, 'pending')).status, 400);
});

test('setting the status a report already has is refused as a no-op', async () => {
  const created = await newReport('No-op probe');
  const response = await setStatus(created.id, 'pending');
  assert.equal(response.status, 400);

  const { history } = await (await fetch(`${baseUrl}/api/reports/${created.id}/history`, authed(adminToken))).json();
  assert.equal(history.length, 0);
});

test('a citizen cannot change report status and a barangay official is limited to their barangay', async () => {
  const created = await (await fetch(`${baseUrl}/api/reports`, authed(citizenToken, {
    method: 'POST',
    body: reportForm({ description: `Role probe ${Date.now()}` })
  }))).json();

  const asCitizen = await fetch(`${baseUrl}/api/reports/${created.id}/status`, authed(citizenToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' })
  }));
  assert.equal(asCitizen.status, 403);

  const inJurisdiction = await fetch(`${baseUrl}/api/reports/${created.id}/status`, authed(barangayToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ongoing' })
  }));
  assert.equal(inJurisdiction.status, 200, 'an official may act inside their own barangay');

  const otherCitizen = await seedCitizen({
    username: 'wf_outside', password: 'password123', barangay: 'Mandalagan', reporting: true
  });
  const otherResponse = await fetch(`${baseUrl}/api/reports`, authed(otherCitizen.token, {
    method: 'POST',
    body: reportForm({ description: `Other barangay ${Date.now()}`, barangay: 'Mandalagan', ...reportGpsFields('Mandalagan') })
  }));
  assert.equal(otherResponse.status, 201);
  const outside = await otherResponse.json();

  const outOfJurisdiction = await fetch(`${baseUrl}/api/reports/${outside.id}/status`, authed(barangayToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' })
  }));
  assert.equal(outOfJurisdiction.status, 403);
});
