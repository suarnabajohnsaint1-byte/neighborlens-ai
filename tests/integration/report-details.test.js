const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-details-'));
process.env.TEST_DB_FILE = path.join(directory, 'details.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.STORAGE_DRIVER = 'local';
const { startTestServer, testDatabase } = require('../support/test-app');
const { JPEG_BYTES, PNG_BYTES } = require('../support/image-fixtures');
const { adminSession, createOfficial } = require('../support/accounts');
const { getImageStorage } = require('../../server/infrastructure/storage/storageFactory');
let server;
let base;
let owner;
let other;
let report;
let admin;
let officialOne;
let officialTwo;
let inferenceCalls = 0;

async function register(username) {
  return seedCitizen({ username, password: 'password123', reporting: true });
}

function get(url, token = owner.token) {
  return fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } });
}

test.before(async () => {
  ({ server, baseUrl: base } = await startTestServer({ inference: async () => { inferenceCalls++; return { detections: [{ damage_type: 'broken_streetlight', confidence_score: 0.9 }] }; } }));
  owner = await register('details_owner');
  other = await register('details_other');
  admin = await adminSession(base);
  officialOne = await createOfficial(base, admin.token, 'Barangay 1', 'details_b1');
  officialTwo = await createOfficial(base, admin.token, 'Barangay 2', 'details_b2');
  const proofs = [];
  for (const [index, bytes] of [JPEG_BYTES, PNG_BYTES].entries()) {
    const body = new FormData();
    body.append('photoOrder', String(index + 1));
    body.append('images', new File([bytes], `photo.${index ? 'png' : 'jpg'}`, { type: index ? 'image/png' : 'image/jpeg' }));
    const result = await getPreview(body);
    proofs.push(result.assessmentProof);
  }
  const body = new FormData();
  body.append('description', '<img src=x onerror=alert(1)> Citizen clarification stays literal.');
  body.append('location', 'Recorded report location');
  body.append('barangay', 'Barangay 1');
  body.append('latitude', '10.678');
  body.append('longitude', '122.946');
  body.append('gpsAccuracy', '15');
  body.append('gpsFixAt', String(freshReportFixAt()));
  body.append('citizenCategory', 'Road Damage');
  body.append('landmarkDescription', 'Beside the school entrance.');
  body.append('assessmentProofs', JSON.stringify(proofs));
  body.append('images', new File([JPEG_BYTES], 'one.jpg', { type: 'image/jpeg' }));
  body.append('images', new File([PNG_BYTES], 'two.png', { type: 'image/png' }));
  body.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  const response = await fetch(`${base}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body });
  assert.equal(response.status, 201);
  report = await response.json();
});

async function getPreview(body) {
  const response = await fetch(`${base}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body });
  assert.equal(response.status, 200);
  return response.json();
}

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  testDatabase().close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: false });
});

test('details API: authorized reload reads both original AI and correction without inference', async () => {
  const before = inferenceCalls;
  const response = await get(`/api/reports/${report.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const saved = await response.json();
  assert.equal(saved.citizenCategory, 'Road Damage');
  assert.equal(saved.originalAi.canonical_class, 'broken_streetlight');
  assert.equal(saved.originalAi.suggested_category, 'Street Light Damage');
  assert.equal(saved.description, report.description);
  assert.equal(saved.latitude, 10.678);
  assert.equal(saved.gps_accuracy, 15);
  assert.doesNotMatch(JSON.stringify(saved), /proof_id|assessmentProof|evidence_sha256|submission_assessment/);
  assert.equal(inferenceCalls, before);
});

test('details API: two submitted images load in their persisted order', async () => {
  const saved = await (await get(`/api/reports/${report.id}`)).json();
  assert.deepEqual(saved.images.map(image => image.imageOrder), [1, 2]);
  for (const [index, image] of saved.images.entries()) {
    const response = await get(image.imagePath);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), index ? PNG_BYTES : JPEG_BYTES);
  }
});

test('details API: missing authentication and different citizen cannot read report or history', async () => {
  assert.equal((await fetch(`${base}/api/reports/${report.id}`)).status, 401);
  assert.equal((await get(`/api/reports/${report.id}`, other.token)).status, 403);
  assert.equal((await get(`/api/reports/${report.id}/history`, other.token)).status, 403);
});

test('details API: admin and same-jurisdiction barangay can read; other barangay cannot', async () => {
  for (const [token, expected] of [[admin.token, 200], [officialOne.token, 200], [officialTwo.token, 403]]) {
    assert.equal((await get(`/api/reports/${report.id}`, token)).status, expected);
    assert.equal((await get(`/api/reports/${report.id}/history`, token)).status, expected);
  }
});

for (const id of ['abc', '0', '-1', '1abc', '1.5', '9007199254740992']) {
  test(`details API: invalid report ID ${id} is rejected`, async () => assert.equal((await get(`/api/reports/${id}`)).status, 400));
}

test('details API: status history contains actual transitions only', async () => {
  assert.deepEqual((await (await get(`/api/reports/${report.id}/history`)).json()).history, []);
  const token = officialOne.token;
  const response = await fetch(`${base}/api/reports/${report.id}/status`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ongoing' }) });
  assert.equal(response.status, 200);
  const { history } = await (await get(`/api/reports/${report.id}/history`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].old_status, 'pending');
  assert.equal(history[0].new_status, 'ongoing');
  assert.ok(history[0].created_at);
});

test('details API: Supabase references are signed only after authorization and renewed on reload', async () => {
  const storage = getImageStorage();
  const original = storage.getReadUrl;
  const calls = [];
  const refs = [1, 2].map(order => `supabase:reports/${owner.user.id}/00000000-0000-4000-8000-00000000000${order}.jpg`);
  const rows = await testDatabase().query('SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order', [report.id]);
  for (let index = 0; index < rows.length; index++) await testDatabase().execute('UPDATE report_images SET image_path = ? WHERE id = ?', [refs[index], rows[index].id]);
  storage.getReadUrl = async reference => { calls.push(reference); return `https://isolated-storage.test/read-${calls.length}.jpg`; };
  try {
    assert.equal((await get(`/api/reports/${report.id}`, other.token)).status, 403);
    assert.equal(calls.length, 0);
    const first = await (await get(`/api/reports/${report.id}`)).json();
    const second = await (await get(`/api/reports/${report.id}`)).json();
    assert.equal(calls.length, 4);
    assert.notEqual(first.images[0].imagePath, second.images[0].imagePath);
    assert.doesNotMatch(JSON.stringify(first), /supabase:|proof_id/);
    const unchanged = await testDatabase().query('SELECT image_path FROM report_images WHERE report_id = ? ORDER BY image_order', [report.id]);
    assert.deepEqual(unchanged.map(row => row.image_path), refs);
  } finally {
    storage.getReadUrl = original;
    for (const row of rows) await testDatabase().execute('UPDATE report_images SET image_path = ? WHERE id = ?', [row.image_path, row.id]);
  }
});

test('details API: legacy image-path-only reports retain their actual image without fabricating another', async () => {
  await testDatabase().execute('DELETE FROM report_images WHERE report_id = ?', [report.id]);
  await testDatabase().execute('UPDATE reports SET submission_assessment = NULL, image_path = ? WHERE id = ?', [report.images[0].imagePath, report.id]);
  const legacy = await (await get(`/api/reports/${report.id}`)).json();
  assert.equal(legacy.originalAi, null);
  assert.equal(legacy.images.length, 1);
  assert.equal(legacy.images[0].imageOrder, 1);
});

test('details API: missing and deleted reports return safe 404s for details and history', async () => {
  assert.equal((await get('/api/reports/99999999')).status, 404);
  await testDatabase().execute('DELETE FROM community_publication_media WHERE request_id IN (SELECT id FROM community_publication_requests WHERE report_id = ?)', [report.id]);
  await testDatabase().execute('DELETE FROM community_publication_requests WHERE report_id = ?', [report.id]);
  await testDatabase().execute('DELETE FROM reports WHERE id = ?', [report.id]);
  assert.equal((await get(`/api/reports/${report.id}`)).status, 404);
  assert.equal((await get(`/api/reports/${report.id}/history`)).status, 404);
});

test('details page is served without exposing server sources', async () => {
  assert.equal((await fetch(`${base}/report-details.html?id=1`)).status, 200);
  assert.equal((await fetch(`${base}/server/application/use-cases/report.service.js`)).status, 404);
});
