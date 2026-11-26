const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const env = require('../../server/infrastructure/config/env');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const { useTestDatabase } = require('../../server/infrastructure/database');
const createMysqlAdapter = require('../../server/infrastructure/database/mysql/mysqlAdapter');
const repository = require('../../server/infrastructure/repositories/reportAnalytics.repository');
const { createReportAnalyticsService } = require('../../server/application/use-cases/reportAnalytics.service');

const databaseName = `neighborlens_analytics_${randomBytes(6).toString('hex')}_test`;
let administrator;
let database;

test.before(async () => {
  require('../support/local-test-target').assertLoopbackHost(env.DB_HOST);
  administrator = await mysql.createConnection({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD });
  await administrator.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`);
  env.DB_NAME = databaseName;
  env.DB_CONNECTION_LIMIT = 1;
  database = createMysqlAdapter();
  await runMigrations(database.pool);
  useTestDatabase(database);
});

test('MySQL printable Barangay data uses matching report addresses within the assigned jurisdiction', async () => {
  const repository = require('../../server/infrastructure/repositories/reportExport.repository');
  const { printableBarangayReports } = require('../../server/application/use-cases/printableBarangayReports');
  const { reportQuery } = require('../../server/domain/reports/reportQuery.rules');
  const citizen = await database.execute('INSERT INTO users (username, password_hash, role, barangay) VALUES (?, ?, ?, ?)',
    ['purok_fixture', 'test-fixture', 'citizen', 'Barangay 1']);
  await database.execute('INSERT INTO citizen_identities (user_id, address) VALUES (?, ?)', [citizen.insertId, 'Purok 9, Home']);
  for (const [scope, address] of [[1, 'Purok 9, Home'], [1, 'Purok 2, Bacolod City'], [2, 'Purok 4, Bacolod City']]) {
    await database.execute('INSERT INTO reports (description, barangay, barangay_id, location, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
      ['Printable Purok fixture', `Barangay ${scope}`, scope, address, citizen.insertId, 'pothole']);
  }
  const query = reportQuery({ search: 'Printable Purok fixture' });
  const data = await repository.load({ scope: 1, query, barangay: 'all', printable: true });
  const result = printableBarangayReports(data, 'Barangay 1', query);
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.puroks, [{ label: 'Purok 2', count: 1, percentage: 50 }, { label: 'Unknown Purok', count: 1, percentage: 50 }]);
});

test.after(async () => {
  await database?.close();
  if (administrator && /^neighborlens_analytics_[0-9a-f]{12}_test$/.test(databaseName)) {
    await administrator.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await administrator.end();
  }
});

for (const [zone, before, start, finish, excluded, resolution] of [
  ['+08:00', '2026-10-09 23:59:59', '2026-10-10 00:00:00', '2026-10-16 23:59:59', '2026-10-17 00:00:00', '2026-10-15 00:00:00'],
  ['+00:00', '2026-10-09 15:59:59', '2026-10-09 16:00:00', '2026-10-16 15:59:59', '2026-10-16 16:00:00', '2026-10-14 16:00:00']
]) {
  test(`MySQL aggregates Manila dates correctly from ${zone} database wall-clock timestamps`, async () => {
    await database.pool.query('SET time_zone = ?', [zone]);
    await database.execute('DELETE FROM report_status_history');
    await database.execute('DELETE FROM report_images');
    await database.execute('DELETE FROM reports');
    const report = async (time, category, status = 'pending') => (await database.execute(
      'INSERT INTO reports (description, barangay, ai_category, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ['Isolated analytics fixture', 'Villamonte', category, status, time]
    )).insertId;
    await report(before, 'pothole');
    const pothole = await report(start, 'pothole');
    await report(finish, 'road_crack');
    await report(excluded, 'pothole');
    await report(start, 'broken_streetlight');
    await report(start, 'damaged_street_light');
    await report(start, 'Infrastructure');
    const old = await report('2026-09-01 00:00:00', 'road_crack', 'resolved');
    for (let index = 0; index < 2; index++) await database.execute(
      'INSERT INTO report_status_history (report_id, old_status, new_status, created_at) VALUES (?, ?, ?, ?)', [old, 'ongoing', 'resolved', resolution]
    );
    for (const order of [1, 2]) await database.execute('INSERT INTO report_images (report_id, image_order, image_path) VALUES (?, ?, ?)', [pothole, order, '/fixture.png']);
    const service = createReportAnalyticsService({ reportAnalyticsRepository: repository, clock: () => new Date('2026-10-16T04:00:00Z') });
    const value = await service.getAnalytics({ days: '7' }, { role: 'admin' });
    assert.equal(value.totals.submitted, 5);
    assert.equal(value.totals.resolved, 1);
    assert.equal(value.daily[0].submitted, 4);
    assert.equal(value.daily.at(-1).submitted, 1);
    assert.equal(value.daily[5].resolved, 1);
    assert.deepEqual(value.categories.map(category => category.count), [1, 1, 2, 0, 1]);
    assert.equal(value.timestampOffsetMinutes, zone === '+08:00' ? 480 : 0);
    await database.execute('UPDATE reports SET barangay_id = ? WHERE id = ?', [1, pothole]);
    const scoped = await service.getAnalytics({ days: '7' }, { role: 'barangay', barangayId: 1 });
    assert.equal(scoped.totals.submitted, 1);
    assert.equal(scoped.totals.resolved, 0);
    const { findReportPage } = require('../../server/infrastructure/repositories/reportPage.query');
    const { reportQuery } = require('../../server/domain/reports/reportQuery.rules');
    const page = await findReportPage(database, reportQuery({ pageSize: '1', page: '99', category: 'Road Damage', dateFrom: '2026-10-10', dateTo: '2026-10-16' }), 1);
    assert.equal(page.pagination.total, 1);
    assert.equal(page.pagination.page, 1);
    assert.equal(page.rows[0].id, pothole);
    assert.equal(page.stats.total, 1);
  });
}

async function statusFixture() {
  const user = await database.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id) VALUES (?, ?, ?, ?, ?)',
    [`isolated_official_${Date.now()}`, 'unused-fixture-hash', 'barangay', 'Barangay 1', 1]);
  const report = await database.execute('INSERT INTO reports (description, barangay, barangay_id, status) VALUES (?, ?, ?, ?)', ['Isolated status transaction', 'Barangay 1', 1, 'pending']);
  return { id: report.insertId, actor: { id: user.insertId, role: 'barangay', barangayId: 1 } };
}

function statusService(reportRepository, notifications) {
  return require('../../server/application/use-cases/report.service').createReportService({
    getDatabase: () => database, reportRepository: Object.assign(Object.create(require('../../server/infrastructure/repositories/report.repository')), reportRepository),
    config: { STORAGE_DRIVER: 'local' }, imageInput: require('../../server/infrastructure/storage/imageInput.adapter'),
    getImageStorage: require('../../server/infrastructure/storage/storageFactory').getImageStorage,
    reportStatusHistoryRepository: require('../../server/infrastructure/repositories/reportStatusHistory.repository'),
    auditService: require('../../server/application/use-cases/audit.service'),
    reportClock: require('../../server/infrastructure/database/reportClock'),
    notificationService: { notifyReportStatusUpdate: async value => notifications.push(value) }
  });
}

test('MySQL history failure rolls back status and does not publish a notification', async () => {
  const { id, actor } = await statusFixture();
  const notifications = [];
  const service = statusService(require('../../server/infrastructure/repositories/report.repository'), notifications);
  await database.pool.query("CREATE TRIGGER isolated_history_failure BEFORE INSERT ON report_status_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Isolated history failure'");
  try {
    await assert.rejects(service.updateReportStatus(id, 'ongoing', actor), /Isolated history failure/);
    assert.equal((await database.query('SELECT status FROM reports WHERE id = ?', [id]))[0].status, 'pending');
    assert.equal((await database.query('SELECT COUNT(*) AS total FROM report_status_history WHERE report_id = ?', [id]))[0].total, 0);
    assert.equal((await database.query("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'report' AND entity_id = ? AND action = 'status_update'", [id]))[0].total, 0);
    assert.equal(notifications.length, 0);
  } finally { await database.pool.query('DROP TRIGGER isolated_history_failure'); }
});

test('MySQL concurrent transitions from the same revision commit exactly one status/history/notification', async () => {
  const { id, actor } = await statusFixture();
  const repository = require('../../server/infrastructure/repositories/report.repository');
  const notifications = [];
  let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = statusService({
    updateStatus: (...args) => repository.updateStatus(...args),
    async findById(value) {
      const report = await repository.findById(value);
      if (reads++ < 2) { if (reads === 2) release(); await gate; }
      return report;
    }
  }, notifications);
  const results = await Promise.allSettled(['ongoing', 'ongoing'].map(status => service.updateReportStatus(id, status, actor)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.kind, 'CONFLICT');
  assert.equal((await database.query('SELECT COUNT(*) AS total FROM report_status_history WHERE report_id = ?', [id]))[0].total, 1);
  assert.equal((await database.query("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'report' AND entity_id = ? AND action = 'status_update'", [id]))[0].total, 1);
  assert.equal(notifications.length, 1);
});
