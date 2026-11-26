const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const { randomUUID } = require('node:crypto');
const { startTestServer, testDatabase } = require('../support/test-app');
const { PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
let server, baseUrl, owner;

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
  owner = await seedCitizen({ username: `qa_retry_${Date.now()}`, password: 'Fixture1234', barangay: 'Villamonte', reporting: true });
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function submit(key, description = 'QA manual submission after unavailable inference', gpsFixAt = freshReportFixAt()) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ requestKey: key, description, barangay: 'Villamonte', citizenCategory: 'Road Damage', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15', gpsFixAt, landmarkDescription: 'Beside the school entrance.' })) form.append(name, value);
  form.append('images', new Blob([PNG_BYTES], { type: 'image/png' }), 'one.png');
  form.append('images', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'two.jpg');
  form.append('landmarkImage', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'landmark.jpg');
  const response = await fetch(baseUrl + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
  return { status: response.status, body: await response.json() };
}

test('a lost acknowledgement retry creates one report, publication request and submission audit', async () => {
  const key = randomUUID();
  const gpsFixAt = freshReportFixAt();
  const first = await submit(key, undefined, gpsFixAt), retry = await submit(key, undefined, gpsFixAt);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  const database = testDatabase();
  const [reports] = await database.query('SELECT COUNT(*) AS total FROM reports WHERE id = ?', [first.body.id]);
  const [requests] = await database.query('SELECT COUNT(*) AS total FROM community_publication_requests WHERE report_id = ?', [first.body.id]);
  const [logs] = await database.query("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'report' AND action = 'create' AND entity_id = ?", [first.body.id]);
  assert.equal(reports.total, 1); assert.equal(requests.total, 1); assert.equal(logs.total, 1);
});

test('a report request key cannot be reused for different content', async () => {
  const key = randomUUID();
  assert.equal((await submit(key)).status, 201);
  assert.equal((await submit(key, 'Different issue under a used key')).status, 409);
});

test('malformed submission keys are rejected before creating a report', async () => {
  assert.equal((await submit('invalid')).status, 400);
});
