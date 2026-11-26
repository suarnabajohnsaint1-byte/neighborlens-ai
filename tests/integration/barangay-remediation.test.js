const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-barangay-remediation-'));
process.env.TEST_DB_FILE = path.join(directory, 'portal.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.STORAGE_DRIVER = 'local';
const { startTestServer, testDatabase } = require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
const { JPEG_BYTES, PNG_BYTES } = require('../support/image-fixtures');
const { getImageStorage } = require('../../server/infrastructure/storage/storageFactory');
let server, base, admin, officialA, officialB, owner, unrelated, report, otherReport;

async function request(url, token, method = 'GET', body) {
  return fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
}

async function citizen(username, barangay = 'Barangay 1') {
  return seedCitizen({ username, password: 'Fixture1234', barangay, reporting: true });
}

async function create(barangay, description = 'Disposable barangay report') {
  const form = new FormData();
  for (const [key, value] of Object.entries({ description, barangay, landmarkDescription: 'Beside the school entrance.' })) form.append(key, value);
  addReportGps(form, barangay);
  form.append('images', new File([JPEG_BYTES], 'one.jpg', { type: 'image/jpeg' }));
  form.append('images', new File([PNG_BYTES], 'two.png', { type: 'image/png' }));
  form.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  const reporter = barangay === 'Barangay 2' ? unrelated : owner;
  const response = await fetch(base + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${reporter.token}` }, body: form });
  assert.equal(response.status, 201);
  return response.json();
}

test.before(async () => {
  ({ server, baseUrl: base } = await startTestServer());
  admin = await adminSession(base);
  officialA = await createOfficial(base, admin.token, 'Barangay 1', 'remediation_a');
  officialB = await createOfficial(base, admin.token, 'Barangay 2', 'remediation_b');
  owner = await citizen('remediation_owner');
  unrelated = await citizen('remediation_unrelated', 'Barangay 2');
  report = await create('Barangay 1');
  otherReport = await create('Barangay 2');
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  testDatabase().close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true });
});

test('B01: evidence requires parent authorization and attachment membership', async () => {
  const url = report.images[0].imagePath;
  assert.match(url, /^\/api\/reports\/\d+\/images\/\d+$/);
  for (const [token, expected] of [[null, 401], [owner.token, 200], [admin.token, 200], [officialA.token, 200], [officialB.token, 403], [unrelated.token, 403]]) {
    const response = await request(url, token);
    assert.equal(response.status, expected);
    if (expected === 200) {
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG_BYTES);
    }
  }
  assert.equal((await request(`/api/reports/${report.id}/images/${otherReport.images[0].id}`, admin.token)).status, 404);
  assert.equal((await request(`/api/reports/${report.id}/images/..%2F..%2F.env`, admin.token)).status, 400);
});

test('B01: old public upload paths are denied while legacy references resolve privately', async () => {
  const rows = await testDatabase().query('SELECT image_path FROM report_images WHERE report_id = ? ORDER BY image_order', [report.id]);
  assert.equal((await request(rows[0].image_path)).status, 404);
  assert.equal((await request(rows[0].image_path, owner.token)).status, 404);
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../../.vscode/settings.json')));
  assert.equal(settings['liveServer.settings.root'], '/frontend');
  assert.ok(settings['liveServer.settings.mount'].every(([, mount]) => ['./frontend', './shared'].includes(mount)));
  await testDatabase().execute('DELETE FROM report_images WHERE report_id = ?', [otherReport.id]);
  const legacy = await (await request(`/api/reports/${otherReport.id}`, admin.token)).json();
  assert.match(legacy.images[0].imagePath, /legacy-1$/);
  assert.equal((await request(legacy.images[0].imagePath, officialB.token)).status, 200);
});

test('B01: cloud signing happens only after report and attachment authorization', async () => {
  const storage = getImageStorage();
  const original = storage.getReadUrl;
  const rows = await testDatabase().query('SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order', [report.id]);
  let calls = 0;
  await testDatabase().execute('UPDATE report_images SET image_path = ? WHERE id = ?', [`supabase:reports/${owner.user.id}/00000000-0000-4000-8000-000000000001.jpg`, rows[0].id]);
  storage.getReadUrl = async () => { calls++; return 'https://isolated-cloud.test/private.jpg?expires=300'; };
  try {
    assert.equal((await request(report.images[0].imagePath, officialB.token)).status, 403);
    assert.equal(calls, 0);
    const permitted = await request(report.images[0].imagePath, owner.token);
    assert.equal(permitted.status, 302);
    assert.equal(calls, 1);
    assert.match(permitted.headers.get('location'), /^https:\/\/isolated-cloud.test\//);
  } finally {
    storage.getReadUrl = original;
    await testDatabase().execute('UPDATE report_images SET image_path = ? WHERE id = ?', [rows[0].image_path, rows[0].id]);
  }
});

test('B05 B06 B11: scoped pagination filters before slicing and keeps global totals', async () => {
  const database = testDatabase();
  const [{ barangay_id: assigned }] = await database.query('SELECT barangay_id FROM reports WHERE id = ?', [report.id]);
  const ids = [];
  for (const [index, time] of ['2026-10-14 16:59:59', '2026-10-14 17:00:00', '2026-10-15 15:59:59.500', '2026-10-15 16:00:00'].entries()) {
    const result = await database.execute('INSERT INTO reports (description, barangay, barangay_id, ai_category, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`Date fixture ${index}`, 'Barangay 1', assigned, index === 2 ? 'road_crack' : 'pothole', 'pending', time]);
    ids.push(Number(result.lastInsertRowid ?? result.insertId));
  }
  const read = async query => {
    const response = await request('/api/reports?' + new URLSearchParams(query), officialA.token);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await request('/api/reports?barangay=Barangay%202', officialA.token)).status, 400);
  const first = await read({ pageSize: '1', sort: 'oldest', search: 'Date fixture', dateFrom: '2026-10-15', dateTo: '2026-10-15', category: 'Road Damage' });
  assert.equal(first.pagination.total, 3);
  assert.equal(first.pagination.pages, 3);
  assert.equal(first.reports.length, 1);
  assert.equal(first.reports[0].id, ids[0]);
  const last = await read({ page: '999', pageSize: '1', sort: 'oldest', search: 'Date fixture', dateFrom: '2026-10-15', dateTo: '2026-10-15' });
  assert.equal(last.pagination.page, 3);
  assert.equal(last.reports[0].id, ids[2]);
  assert.equal(first.stats.total, last.stats.total);
  assert.ok(first.stats.total > first.pagination.total);
  const empty = await read({ search: 'No such disposable record' });
  assert.equal(empty.pagination.total, 0);
  assert.equal(empty.stats.total, first.stats.total);
  assert.equal((await request('/api/reports?pageSize=101', officialA.token)).status, 400);
  assert.equal((await request('/api/reports?dateFrom=2026-02-30', officialA.token)).status, 400);
  assert.equal((await request(`/api/reports/${report.id}`, officialB.token)).status, 403);
  assert.equal((await request(`/api/reports/${report.id}/status`, officialB.token, 'PATCH', { status: 'ongoing' })).status, 403);
  const other = await (await request('/api/reports?pageSize=1', officialB.token)).json();
  assert.ok(other.reports.every(item => item.barangay === 'Barangay 2'));
});

test('analytics reuse authorized scope, all period rows, first resolution and unknown history rules', async () => {
  const database = testDatabase();
  const [{ barangay_id: a }] = await database.query('SELECT barangay_id FROM reports WHERE id = ?', [report.id]);
  const [{ barangay_id: b }] = await database.query('SELECT barangay_id FROM reports WHERE id = ?', [otherReport.id]);
  const repository = require('../../server/infrastructure/repositories/reportAnalytics.repository');
  const { createReportAnalyticsService } = require('../../server/application/use-cases/reportAnalytics.service');
  const service = createReportAnalyticsService({ reportAnalyticsRepository: repository, clock: () => new Date('2026-10-16T04:00:00Z') });
  const scoped = await service.getAnalytics({ days: '7' }, { role: 'barangay', barangayId: a });
  assert.equal(scoped.totals.submitted, 4);
  assert.equal(scoped.categories.find(item => item.key === 'pothole').count, 3);
  const outside = await service.getAnalytics({ days: '7' }, { role: 'barangay', barangayId: b });
  assert.equal(outside.totals.submitted, 0);
  for (const token of [officialA.token, officialB.token, admin.token]) assert.equal((await request('/api/reports/analytics?days=7', token)).status, 200);
  assert.equal((await request('/api/reports/analytics?days=7&barangayId=' + b, officialA.token)).status, 400);
  assert.equal((await request('/api/reports/analytics', owner.token)).status, 403);
  const legacy = await database.execute('INSERT INTO reports (description, barangay, barangay_id, status, created_at) VALUES (?, ?, ?, ?, ?)', ['Unknown history', 'Barangay 1', a, 'resolved', '2026-10-10 00:00:00']);
  const incomplete = await service.getAnalytics({ days: '7' }, { role: 'barangay', barangayId: a });
  assert.equal(incomplete.resolutionHistory.missingReports, 1);
  assert.equal(incomplete.totals.resolved, null);
  const id = legacy.insertId;
  for (const date of ['2026-10-14 17:00:00', '2026-10-15 17:00:00']) await database.execute('INSERT INTO report_status_history (report_id, old_status, new_status, created_at) VALUES (?, ?, ?, ?)', [id, 'ongoing', 'resolved', date]);
  const dated = await service.getAnalytics({ days: '7' }, { role: 'barangay', barangayId: a });
  assert.equal(dated.totals.resolved, 1);
  assert.equal(dated.daily.find(day => day.date === '2026-10-15').resolved, 1);
  assert.equal(dated.daily.find(day => day.date === '2026-10-16').resolved, 0);
});

test('the real report transport satisfies the frontend contract without unwrapping or page-count guesses', async () => {
  const calls = [];
  const window = { apiRequest: async (url, options) => {
    calls.push({ url, options });
    const response = await request(url, officialA.token);
    assert.equal(response.status, 200);
    return response.json();
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../frontend/js/barangay/reportsApi.js'), 'utf8'), { window, URLSearchParams });
  const controller = new AbortController();
  const data = await window.BarangayReportsApi.load({ pageSize: 1, page: 1, search: 'Date fixture' }, controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(data.reports.length, 1);
  assert.equal(data.pagination.total, 4);
  assert.equal(data.pagination.pages, 4);
  assert.equal(data.pagination.pageSize, 1);
  assert.ok(data.stats.total > data.pagination.total);
  for (const key of ['total', 'pending', 'ongoing', 'resolved', 'rejected', 'major', 'minor']) assert.equal(Number.isSafeInteger(data.stats[key]), true);
  assert.ok(data.reports.every(item => item.barangay === 'Barangay 1'));
  window.apiRequest = async () => ({ reports: data.reports, stats: data.stats });
  await assert.rejects(window.BarangayReportsApi.load({}), /Invalid report response/);
  window.apiRequest = async () => ({ ...data, pagination: { ...data.pagination, total: String(data.pagination.total) } });
  await assert.rejects(window.BarangayReportsApi.load({}), /Invalid report response/);
});

test('literal analytics reaches analytics while actual malformed report IDs remain invalid', async () => {
  for (const days of [7, 30, 90]) {
    const response = await request(`/api/reports/analytics?days=${days}`, officialA.token);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.range.days, days);
    assert.equal(data.daily.length, days);
    assert.ok(!data.error);
  }
  for (const id of ['not-an-id', '0', '-1', '1.5', '1e2', '9007199254740992']) {
    const response = await request(`/api/reports/${id}`, officialA.token);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Invalid report ID.');
  }
});

test('expired and suspended sessions cannot retrieve reports, evidence or analytics', async () => {
  const jwt = require('jsonwebtoken');
  const env = require('../../server/infrastructure/config/env');
  const expired = jwt.sign(jwt.decode(officialA.token), env.JWT_SECRET, { noTimestamp: true });
  const payload = jwt.decode(expired); delete payload.iat; payload.exp = 1;
  const token = jwt.sign(payload, env.JWT_SECRET);
  for (const url of ['/api/reports', report.images[0].imagePath, '/api/reports/analytics']) assert.equal((await request(url, token)).status, 401);
  const suspended = await createOfficial(base, admin.token, 'Barangay 3', 'remediation_suspended');
  await testDatabase().execute("UPDATE users SET status = 'suspended' WHERE id = ?", [suspended.id]);
  for (const url of ['/api/reports', report.images[0].imagePath, '/api/reports/analytics']) assert.ok([401, 403].includes((await request(url, suspended.token)).status));
});

test('B03: failed history persistence rolls back report status and emits no notification', async () => {
  const database = testDatabase();
  const before = await database.query('SELECT * FROM notifications');
  await database.execute("CREATE TRIGGER fail_history BEFORE INSERT ON report_status_history BEGIN SELECT RAISE(ABORT, 'Disposable history failure'); END");
  try {
    assert.equal((await request(`/api/reports/${report.id}/status`, officialA.token, 'PATCH', { status: 'ongoing' })).status, 500);
    const current = await (await request(`/api/reports/${report.id}`, officialA.token)).json();
    assert.equal(current.status, 'pending');
    assert.deepEqual(await database.query('SELECT * FROM notifications'), before);
  } finally { await database.execute('DROP TRIGGER fail_history'); }
});
