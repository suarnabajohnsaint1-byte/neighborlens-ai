const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-analytics-'));
process.env.TEST_DB_FILE = path.join(directory, 'analytics.sqlite');
const { startTestServer, testDatabase } = require('../support/test-app');
const repository = require('../../server/infrastructure/repositories/reportAnalytics.repository');
const { analyticsRange } = require('../../server/domain/reports/reportAnalytics.rules');
const { createReportAnalyticsService } = require('../../server/application/use-cases/reportAnalytics.service');

let server;
let baseUrl;
let token;
const ids = [];
const now = new Date('2026-10-16T04:00:00Z');

async function report(createdAt, category, status = 'pending', snapshot = null) {
  const result = await testDatabase().execute('INSERT INTO reports (description, barangay, ai_category, status, created_at, submission_assessment) VALUES (?, ?, ?, ?, ?, ?)',
    ['Analytics fixture', 'Villamonte', category, status, createdAt, snapshot ? JSON.stringify(snapshot) : null]);
  ids.push(result.insertId);
  return result.insertId;
}

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
  const response = await fetch(`${baseUrl}/api/auth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  token = (await response.json()).token;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  testDatabase().close();
  if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('neighborlens-analytics-')) fs.rmSync(directory, { recursive: true, force: true });
});

test('database aggregates event dates in Manila without image or repeated-history duplication', async () => {
  await report('2026-10-09 15:59:59', 'pothole');
  const pothole = await report('2026-10-09 16:00:00', 'pothole');
  await testDatabase().execute('UPDATE reports SET barangay_id = (SELECT id FROM barangays WHERE name = ?) WHERE id = ?', ['Villamonte', pothole]);
  await report('2026-10-16 15:59:59', 'road_crack');
  await report('2026-10-16 16:00:00', 'pothole');
  await report('2026-10-15 05:00:00', 'broken_streetlight');
  await report('2026-10-15 05:00:00', 'damaged_street_light');
  await report('2026-10-15 05:00:00', 'Infrastructure');
  await report('2026-10-15 05:00:00', 'road_crack', 'pending', { original_ai: { status: 'DETECTED', canonical_class: 'clogged_drainage' } });
  const old = await report('2026-09-01 00:00:00', 'road_crack', 'resolved');
  await testDatabase().execute('UPDATE reports SET barangay_id = (SELECT id FROM barangays WHERE name = ?) WHERE id = ?', ['Estefania', old]);
  await testDatabase().execute('INSERT INTO report_status_history (report_id, old_status, new_status, created_at) VALUES (?, ?, ?, ?)', [old, 'ongoing', 'resolved', '2026-10-14 16:00:00']);
  await testDatabase().execute('INSERT INTO report_status_history (report_id, old_status, new_status, created_at) VALUES (?, ?, ?, ?)', [old, 'ongoing', 'resolved', '2026-10-15 16:00:00']);
  for (const order of [1, 2]) await testDatabase().execute('INSERT INTO report_images (report_id, image_order, image_path) VALUES (?, ?, ?)', [pothole, order, `/test-${order}.png`]);
  const service = createReportAnalyticsService({ reportAnalyticsRepository: repository, clock: () => now });
  const result = await service.getAnalytics({ days: '7' }, { role: 'admin' });
  assert.equal(result.totals.submitted, 6);
  assert.equal(result.totals.resolved, 1);
  assert.equal(result.daily.find(day => day.date === '2026-10-10').submitted, 1);
  assert.equal(result.daily.find(day => day.date === '2026-10-15').resolved, 1);
  assert.equal(result.daily.find(day => day.date === '2026-10-16').resolved, 0);
  assert.deepEqual(result.categories.map(category => category.count), [1, 1, 2, 1, 1]);
  assert.deepEqual(result.dailyByBarangay.find(row => row.date === '2026-10-10'), {
    date: '2026-10-10', barangayId: result.barangays.find(row => row.name === 'Villamonte').id,
    barangay: 'Villamonte', submitted: 1, ongoing: 0, knownResolved: 0, resolved: 0
  });
  assert.deepEqual(result.barangays.find(row => row.name === 'Villamonte').categoryCounts, { pothole: 1 });
  assert.equal(result.barangays.find(row => row.name === 'Villamonte').submitted, 1);
  const event = result.dailyByBarangay.find(row => row.date === '2026-10-15' && row.barangay === 'Estefania');
  assert.deepEqual([event.submitted, event.ongoing, event.resolved], [0, 0, 1]);
});

test('legacy resolved reports without history leave resolution totals unavailable', async () => {
  const missing = await report('2026-09-01 00:00:00', 'pothole', 'resolved');
  const result = await repository.aggregate(analyticsRange(7, now));
  assert.equal(Number(result.missingResolutionHistory), 1);
  await testDatabase().execute('DELETE FROM reports WHERE id = ?', [missing]);
});

test('analytics HTTP endpoint is admin-only, validates ranges and returns no-store real aggregates', async () => {
  const missing = await fetch(`${baseUrl}/api/admin/analytics/reports`);
  assert.equal(missing.status, 401);
  const citizen = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'citizen', password: '1' }) }).then(response => response.json());
  assert.equal((await fetch(`${baseUrl}/api/admin/analytics/reports`, { headers: { Authorization: `Bearer ${citizen.token}` } })).status, 403);
  for (const query of ['days=91', 'days[]=7', 'days=7&barangay=Villamonte']) {
    assert.equal((await fetch(`${baseUrl}/api/admin/analytics/reports?${query}`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
  }
  const response = await fetch(`${baseUrl}/api/admin/analytics/reports?days=30`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.daily.length, 30);
  assert.equal(data.range.timeZone, 'Asia/Manila');
  assert.ok(data.categories.length >= 4);
});
