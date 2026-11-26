const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-gis-${randomUUID()}.sqlite`);
const { startTestServer, testDatabase } = require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
let server, base, admin, official, outside, citizen;
async function read(query, actor) {
  const response = await fetch(`${base}/api/reports/gis?${new URLSearchParams(query)}`, { headers: actor ? { Authorization: `Bearer ${actor.token}` } : {} });
  return { status: response.status, data: await response.json() };
}
test.before(async () => {
  const started = await startTestServer(); server = started.server; base = started.baseUrl;
  admin = await adminSession(base); official = await createOfficial(base, admin.token, 'Barangay 1', 'gis_one'); outside = await createOfficial(base, admin.token, 'Barangay 2', 'gis_two');
  citizen = await seedCitizen({ username: 'gis_citizen', password: 'Fixture1234' });
  for (let index = 0; index < 235; index++) await testDatabase().execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, latitude, longitude, ai_category, status, ai_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['Safe description <script>unsafe()</script>', 'Authorized location', 'Barangay 1', 1, citizen.user.id, index < 230 ? 10.67 : 11.5, 122.95, 'pothole', ['pending', 'ongoing', 'resolved', 'rejected'][index % 4], index % 2 ? 'MAJOR' : 'MINOR']);
  await testDatabase().execute('INSERT INTO reports (description, barangay, barangay_id, latitude, longitude) VALUES (?, ?, ?, ?, ?)', ['Other private jurisdiction', 'Barangay 2', 2, 10.67, 122.95]);
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); testDatabase().close(); for (const suffix of ['', '-wal', '-shm']) await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {}); });
const bounds = { west: '122', east: '123', south: '10', north: '11' };
test('GIS rejects citizens and unauthenticated callers', async () => { assert.equal((await read(bounds)).status, 401); assert.equal((await read(bounds, citizen)).status, 403); });
test('GIS extent and marker query independently enforce the persisted barangay scope', async () => {
  assert.equal((await read({ extentOnly: '1' }, official)).data.total, 235);
  assert.equal((await read({ extentOnly: '1' }, outside)).data.total, 1);
  assert.equal((await read({ extentOnly: '1' }, admin)).data.total, 236);
  assert.ok((await read(bounds, official)).data.reports.every(row => row.barangay === 'Barangay 1'));
  for (const key of ['barangayId', 'barangay', 'userId', 'role']) assert.equal((await read({ ...bounds, [key]: '1' }, outside)).status, 400);
});
test('viewport loading traverses beyond the former first page with stable bounded cursors and no identities or proofs', async () => {
  const metadata = (await read({ extentOnly: '1' }, official)).data;
  const first = await read({ ...bounds, through: String(metadata.through) }, official);
  assert.equal(first.status, 200); assert.equal(first.data.reports.length, 200); assert.ok(first.data.nextCursor);
  const second = await read({ ...bounds, after: String(first.data.nextCursor), through: String(metadata.through) }, official);
  assert.equal(second.data.reports.length, 30); assert.equal(second.data.nextCursor, null);
  assert.equal(new Set([...first.data.reports, ...second.data.reports].map(row => row.id)).size, 230);
  assert.doesNotMatch(JSON.stringify(first.data), /submitted_by|password|apiToken|proof_id|submission_assessment|gis_citizen/);
  const moved = await read({ ...bounds, south: '11', north: '12' }, official); assert.equal(moved.data.reports.length, 5);
});
test('map status, category and classification filters retain actual values', async () => {
  for (const status of ['pending', 'ongoing', 'resolved', 'rejected']) {
    const result = await read({ ...bounds, status, classification: status === 'pending' ? 'MINOR' : 'all', category: 'Road Damage' }, official);
    assert.equal(result.status, 200); assert.ok(result.data.reports.length); assert.ok(result.data.reports.every(row => row.status === status));
  }
});
test('invalid, unbounded and malformed map requests fail validation', async () => {
  for (const query of [{}, { ...bounds, west: '-181' }, { ...bounds, south: '91' }, { ...bounds, north: '9' }, { ...bounds, after: '-1' }, { ...bounds, after: '1 OR 1=1' }, { ...bounds, pageSize: '100000' }, { ...bounds, through: '9007199254740992' }]) assert.equal((await read(query, official)).status, 400);
});
