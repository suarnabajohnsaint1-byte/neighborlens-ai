const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Excel = require('exceljs');
process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-export-${randomUUID()}.sqlite`);
const { startTestServer, testDatabase } = require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
const { createReportExportService } = require('../../server/application/use-cases/reportExport.service');
const generator = require('../../server/infrastructure/export/reportWorkbook');
let server, base, admin, official, outside, citizen;
async function download(actor, query = {}) {
  return fetch(base + '/api/reports/export?' + new URLSearchParams(query), { headers: actor ? { Authorization: `Bearer ${actor.token}` } : {} });
}
async function workbook(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml/);
  const book = new Excel.Workbook(); await book.xlsx.load(Buffer.from(await response.arrayBuffer())); return book;
}
test.before(async () => {
  const started = await startTestServer(); server = started.server; base = started.baseUrl;
  admin = await adminSession(base); official = await createOfficial(base, admin.token, 'Barangay 1', 'export_one'); outside = await createOfficial(base, admin.token, 'Barangay 2', 'export_two');
  citizen = await seedCitizen({ username: 'export_citizen', password: 'Fixture1234' });
  for (let i = 0; i < 125; i++) await testDatabase().execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category, ai_classification, status, created_at, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [i === 0 ? '=HYPERLINK("https://invalid.test")' : 'Línea ñ barangay', 'Authorized address', 'Barangay 1', 1, citizen.user.id, 'pothole', i % 2 ? 'MAJOR' : null, i % 2 ? 'ongoing' : 'pending', '2026-10-17 16:00:00', 10.67, 122.95]);
  await testDatabase().execute('INSERT INTO reports (description, barangay, barangay_id) VALUES (?, ?, ?)', ['Restricted other jurisdiction', 'Barangay 2', 2]);
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); testDatabase().close(); for (const suffix of ['', '-wal', '-shm']) await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {}); });

test('export denies missing, invalid and citizen sessions and scope/selection tampering', async () => {
  assert.equal((await download()).status, 401); assert.equal((await download({ token: 'expired.invalid' })).status, 401); assert.equal((await download(citizen)).status, 403);
  for (const query of [{ role: 'admin' }, { barangayId: '2' }, { ids: '1,126' }, { pageSize: '10' }, { dateFrom: '2026-10-20', dateTo: '2026-10-01' }]) assert.throws(() => require('../../server/domain/reports/reportExport.rules').exportQuery({ role: 'barangay', barangayId: 2 }, query), /Unsupported|valid/);
  assert.equal((await download(outside, { role: 'admin' })).status, 400);
  assert.equal((await download(outside, { barangay: 'Barangay 1' })).status, 403);
});
test('admin exports every authorized row, two sheets, correct types and a sanitized filename', async () => {
  const response = await download(admin); assert.match(response.headers.get('content-disposition'), /^attachment; filename="NeighborLens_Admin_Reports_\d{4}-\d\d-\d\d.xlsx"$/);
  const book = await workbook(response), reports = book.getWorksheet('Reports');
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Reports', 'Summary']); assert.equal(reports.rowCount, 127);
  assert.equal(reports.getCell('A2').type, Excel.ValueType.String); assert.equal(reports.getCell('J3').type, Excel.ValueType.Number);
  assert.equal(reports.views[0].state, 'frozen'); assert.ok(reports.autoFilter);
  const serialized = JSON.stringify(book.model); assert.doesNotMatch(serialized, /password_hash|apiToken|submitted_by|proof_id|export_citizen/);
});
test('barangay export includes all 125 matching records beyond pagination with exact summary counts', async () => {
  const book = await workbook(await download(official)), sheet = book.getWorksheet('Reports'), summary = book.getWorksheet('Summary');
  assert.equal(sheet.rowCount, 126); assert.equal(summary.getCell('B5').value, 125);
  sheet.eachRow((row, index) => { if (index > 1) assert.equal(row.getCell(8).value, 'Barangay 1'); });
  const measures = new Map(summary.getRows(2, summary.rowCount - 1).map(row => [row.getCell(1).value, row.getCell(2).value]));
  assert.equal(measures.get('pending'), 63); assert.equal(measures.get('ongoing'), 62); assert.equal(measures.get('MAJOR'), 62); assert.equal(measures.get('UNCLASSIFIED'), 63);
  assert.ok(sheet.getColumn(2).values.includes('Línea ñ barangay'));
  const formula = sheet.getColumn(2).values.find(value => String(value).startsWith('=')); assert.equal(typeof formula, 'string');
  sheet.eachRow(row => row.eachCell(cell => assert.notEqual(cell.type, Excel.ValueType.Formula)));
});
test('combined filters share inclusive Manila day boundaries and preserve Excel dates', async () => {
  const book = await workbook(await download(official, { status: 'ongoing', classification: 'MAJOR', category: 'Road Damage', dateFrom: '2026-10-18', dateTo: '2026-10-18', search: 'Línea' }));
  const sheet = book.getWorksheet('Reports'); assert.equal(sheet.rowCount, 63);
  assert.equal(sheet.getCell('L2').value.toISOString(), '2026-10-18T00:00:00.000Z');
  assert.equal(sheet.getCell('E2').value, 'MAJOR'); assert.equal(sheet.getCell('G2').value, 'ongoing');
});
test('Barangay print preview ranks categories and recorded Purok across all matching rows without widening scope', async () => {
  const reviewer = await createOfficial(base, admin.token, 'Barangay 1', 'print_one');
  const database = testDatabase();
  await database.execute('INSERT INTO citizen_identities (address, user_id) VALUES (?, ?)', ['Purok 8, Home address', citizen.user.id]);
  await database.execute('UPDATE reports SET location = ? WHERE barangay_id = 1 AND status = ?', ['Prk. 2, Incident address', 'ongoing']);
  await database.execute('UPDATE reports SET location = ? WHERE barangay_id = 1 AND status = ?', ['Purok 8, Home address', 'pending']);
  function preview(actor, query = '') {
    return fetch(base + '/api/reports/print-preview' + query, { headers: { Authorization: `Bearer ${actor.token}` } });
  }
  assert.equal((await preview(citizen)).status, 403);
  assert.equal((await preview(admin)).status, 403);
  assert.equal((await preview(reviewer, '?barangay=Barangay+2')).status, 403);
  const response = await preview(reviewer, '?category=Road+Damage&sort=oldest');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.reports.length, 125);
  assert.ok(result.reports.every(row => row.barangay === 'Barangay 1'));
  assert.ok(result.reports[0].id < result.reports[1].id);
  assert.deepEqual(result.categories, [{ label: 'Road Damage', count: 125, percentage: 100 }]);
  assert.deepEqual(result.puroks, [
    { label: 'Unknown Purok', count: 63, percentage: 50.4 },
    { label: 'Purok 2', count: 62, percentage: 49.6 }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /Restricted other jurisdiction|Home address|Incident address|latitude|submitted_by/);
  const filtered = await (await preview(reviewer, '?status=ongoing')).json();
  assert.deepEqual(filtered.puroks, [{ label: 'Purok 2', count: 62, percentage: 100 }]);
});
test('outside scope and empty filters never fall back to unrelated reports; exports are audited and rate limited', async () => {
  const other = await workbook(await download(outside)); assert.equal(other.getWorksheet('Reports').rowCount, 2);
  const empty = await workbook(await download(outside, { status: 'resolved' })); assert.equal(empty.getWorksheet('Reports').rowCount, 1); assert.equal(empty.getWorksheet('Summary').getCell('B5').value, 0);
  const logs = await testDatabase().query("SELECT details FROM audit_logs WHERE action = 'report_export'"); assert.ok(logs.length >= 5); assert.doesNotMatch(JSON.stringify(logs), /HYPERLINK|Línea/);
  await download(admin); await download(admin); await download(admin);
  const limited = await download(admin); assert.equal(limited.status, 429); assert.ok(limited.headers.get('Retry-After'));
});
test('generation enforces row and concurrency limits and logs failures without report content', async () => {
  let resolve, logged = [];
  const service = createReportExportService({ repository: { load: () => new Promise(done => { resolve = done; }) }, workbook: generator, audit: { writeAudit: async (...args) => logged.push(args) } });
  const running = service.execute({ id: 99, role: 'admin' }, {});
  await assert.rejects(service.execute({ id: 99, role: 'admin' }, {}), /already being prepared/);
  resolve({ rows: Array(5001).fill({}), offset: 0 }); await assert.rejects(running, /5000/); assert.equal(logged[0][5].outcome, 'failure');
});
test('all dangerous spreadsheet prefixes remain string cells and missing values stay blank', async () => {
  const payloads = ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1+1', '\r=1+1'];
  const buffer = await generator.generate({ rows: payloads.map((description, id) => ({ id, description, image_count: 0 })), offset: 0, context: { scope: 'Test', role: 'admin', filters: {}, now: new Date('2026-10-17T16:00:00Z') } });
  const book = new Excel.Workbook(); await book.xlsx.load(buffer);
  payloads.forEach((value, index) => { assert.equal(book.getWorksheet('Reports').getCell(`B${index + 2}`).value, value.replace(/\r/g, '\n')); assert.equal(book.getWorksheet('Reports').getCell(`B${index + 2}`).type, Excel.ValueType.String); });
  assert.equal(book.getWorksheet('Reports').getCell('L2').value, null);
});
test('oversized persisted text is rejected before report content leaves the database', async () => {
  const database = testDatabase();
  await database.execute('INSERT INTO reports (description, barangay, barangay_id) VALUES (?, ?, ?)', ['x'.repeat(8388609), 'Barangay 3', 3]);
  await assert.rejects(require('../../server/infrastructure/repositories/reportExport.repository').load({ scope: 3, barangay: 'all', query: require('../../server/domain/reports/reportQuery.rules').reportQuery({}) }), /8 MiB/);
});
test('maximum supported 5000-row workbook remains readable with exact totals', async t => {
  const start = performance.now(), before = process.memoryUsage().rss;
  const buffer = await generator.generate({ rows: Array.from({ length: 5000 }, (_, id) => ({ id: id + 1, description: 'Sanitized benchmark ñ', status: 'pending', ai_category: 'pothole', image_count: 2 })), offset: 0, context: { role: 'admin', scope: 'Benchmark', filters: {}, now: new Date() } });
  const elapsed = performance.now() - start, delta = process.memoryUsage().rss - before;
  const book = new Excel.Workbook(); await book.xlsx.load(buffer);
  assert.equal(book.getWorksheet('Reports').rowCount, 5001); assert.equal(book.getWorksheet('Summary').getCell('B5').value, 5000);
  t.diagnostic(`5000-row generation: ${Math.round(elapsed)} ms, ${buffer.length} bytes, RSS delta ${Math.round(delta / 1024 / 1024)} MiB; RSS is process-level, not a peak-memory measurement.`);
});
test('citizen correction remains distinct from genuine original AI detections in exports', async () => {
  const statuses = ['DETECTED', 'LOW_CONFIDENCE', 'NO_DETECTION', 'AI_UNAVAILABLE'];
  const rows = statuses.map((status, id) => ({ id, ai_category: 'pothole', image_count: 2, submission_assessment: JSON.stringify({ citizen_category: 'Street Light Damage', original_ai: { status, canonical_class: status === 'DETECTED' ? 'pothole' : null, suggested_category: status === 'DETECTED' ? 'Road Damage' : null } }) }));
  const buffer = await generator.generate({ rows, offset: 0, context: { role: 'admin', scope: 'Test', filters: {}, now: new Date() } });
  const book = new Excel.Workbook(); await book.xlsx.load(buffer); const sheet = book.getWorksheet('Reports');
  statuses.forEach((status, index) => { assert.equal(sheet.getCell(`C${index + 2}`).value, 'Street Light Damage'); assert.equal(sheet.getCell(`O${index + 2}`).value, status); assert.equal(sheet.getCell(`D${index + 2}`).value, index === 0 ? 'pothole' : ''); });
  assert.equal(sheet.getCell('P2').value, 'Road Damage');
});
test('export has a process-wide concurrency ceiling across different authorized users', async () => {
  const releases = [];
  const service = createReportExportService({ repository: { load: () => new Promise(resolve => releases.push(resolve)) }, workbook: { generate: async () => Buffer.from('fixture') }, audit: { writeAudit: async () => {} } });
  const first = service.execute({ id: 100, role: 'admin' }, {}), second = service.execute({ id: 101, role: 'admin' }, {});
  await assert.rejects(service.execute({ id: 102, role: 'admin' }, {}), /already being prepared/);
  releases.forEach(resolve => resolve({ rows: [], offset: 0 })); await Promise.all([first, second]);
});
test('shared listing and export search recognize citizen corrections and displayed report identifiers', async () => {
  const database = testDatabase();
  const [row] = await database.query('SELECT id FROM reports WHERE barangay_id = 1 ORDER BY id LIMIT 1');
  await database.execute('UPDATE reports SET submission_assessment = ? WHERE id = ?', [JSON.stringify({ citizen_category: 'Street Light Damage', original_ai: { status: 'DETECTED', canonical_class: 'pothole' } }), row.id]);
  const repository = require('../../server/infrastructure/repositories/reportExport.repository');
  const query = require('../../server/domain/reports/reportQuery.rules').reportQuery;
  const corrected = await repository.load({ scope: 1, barangay: 'all', query: query({ search: 'Street Light Damage' }) });
  assert.equal(corrected.rows.length, 1); assert.equal(corrected.rows[0].id, row.id);
  const identified = await repository.load({ scope: 1, barangay: 'all', query: query({ search: `RPT_SRV_${row.id}` }) });
  assert.ok(identified.rows.some(item => item.id === row.id));
  const listed = await require('../../server/infrastructure/repositories/reportPage.query').findReportPage(database, query({ search: 'Street Light Damage' }), 1);
  assert.deepEqual(listed.rows.map(item => item.id), corrected.rows.map(item => item.id));
});

test('Barangay severity totals agree with the filters for historical casing and whitespace', async () => {
  const database = testDatabase();
  const query = require('../../server/domain/reports/reportQuery.rules').reportQuery;
  const { findReportPage } = require('../../server/infrastructure/repositories/reportPage.query');
  const before = await findReportPage(database, query({}), 1);
  const descriptions = ['Historical Minor fixture', 'Historical Major fixture', 'Unknown severity fixture'];
  for (const [index, value] of [' minor ', ' Major ', 'unknown'].entries()) {
    await database.execute('INSERT INTO reports (description, barangay, barangay_id, ai_classification) VALUES (?, ?, ?, ?)',
      [descriptions[index], 'Barangay Central', 1, value]);
  }
  const after = await findReportPage(database, query({}), 1);
  assert.equal(after.stats.minor, before.stats.minor + 1);
  assert.equal(after.stats.major, before.stats.major + 1);
  for (const [index, classification] of ['MINOR', 'MAJOR', 'UNCLASSIFIED'].entries()) {
    const filtered = await findReportPage(database, query({ classification, search: descriptions[index] }), 1);
    assert.deepEqual(filtered.rows.map(row => row.description), [descriptions[index]]);
  }
});
