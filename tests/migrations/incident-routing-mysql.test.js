const test = require('node:test');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { privateMysql } = require('../support/private-mysql');
const { incidentRoutingScenarios } = require('../support/incident-routing-scenarios');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const { PNG_BYTES } = require('../support/image-fixtures');
test('incident linking and controlled routing on verified private MySQL', { timeout: 180000 }, async t => {
  const database = await privateMysql(t); let server;
  try {
    process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.STORAGE_DRIVER = 'local'; process.env.UPLOAD_DIR = path.join(database.directory, 'uploads');
    const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
    await runner.runMigrations(database.pool);
    await t.test('migration 017 rolls back before use, reapplies without modifying existing records, and is idempotent', async () => {
      const connection = await database.pool.getConnection();
      try {
        for (const sql of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/017_incidents_and_routing.sql', 'utf8'))) await connection.query(sql);
        await connection.execute("DELETE FROM schema_migrations WHERE filename IN ('017_incidents_and_routing.sql', '018_community_report_uniqueness.sql')");
        await connection.execute("INSERT INTO reports (description, barangay, barangay_id, status) SELECT 'Existing report before migration 017', name, id, 'pending' FROM barangays WHERE name = 'Barangay 1'");
        const [before] = await connection.query('SELECT * FROM reports ORDER BY id');
        const readiness = await require('../../server/infrastructure/database/mysql/preflight017').inspectLocalMigration017(connection, { DB_DRIVER: 'mysql', DB_TARGET: 'local', NODE_ENV: 'development', DB_HOST: '127.0.0.1', DB_PORT: database.pool.pool.config.connectionConfig.port, DB_NAME: 'community_isolated' }, { expectedDataDirectory: database.directory });
        assert.equal(readiness.ready, true, JSON.stringify(readiness.failures));
        assert.equal(readiness.databaseWritesPerformed, false);
        assert.deepEqual((await runner.runMigrations(database.pool)).applied, ['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql']);
        assert.deepEqual((await connection.query('SELECT * FROM reports ORDER BY id'))[0], before);
        assert.deepEqual((await runner.runMigrations(database.pool)).applied, []);
      } finally { connection.release(); }
    });
    require('../../server/infrastructure/database').useTestDatabase(database.adapter);
    const app = require('../../server/app'); server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const fixture = await incidentRoutingScenarios(t, { base, database: database.adapter });
    await t.test('designated routing administrator corrects verified jurisdiction through the real shared browser view', async () => {
      await database.adapter.execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE id = ?', [JSON.stringify(fixture.polygon), 'Synthetic isolated browser fixture', 'fixture-v1', fixture.m]);
      await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });
      for (const image of await database.adapter.query('SELECT image_path FROM report_images WHERE report_id = ?', [fixture.browserReport.id])) await fs.writeFile(path.join(process.env.UPLOAD_DIR, path.basename(image.image_path)), PNG_BYTES);
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(session => {
          sessionStorage.setItem('up_session', JSON.stringify(session));
          Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
        }, { ...fixture.routing.user, apiToken: fixture.routing.token });
        const page = await context.newPage(); await page.goto(`${base}/report-details.html?id=${fixture.browserReport.id}`);
        const panel = page.locator('.rd-incident-review');
        await panel.getByText('Correct report jurisdiction', { exact: true }).click();
        await panel.getByLabel('Responsible Barangay').selectOption(String(fixture.m));
        await panel.getByLabel('Review reason').fill('Verified boundary and supporting photos confirm the responsible jurisdiction.');
        await panel.getByLabel(`Supporting location photos for report #${fixture.browserReport.id}`).selectOption(String(fixture.browserReport.image));
        const saved = page.waitForResponse(response => response.url().endsWith(`/api/reports/${fixture.browserReport.id}/jurisdiction`) && response.request().method() === 'PATCH');
        await panel.getByRole('button', { name: 'Save verified jurisdiction', exact: true }).click();
        assert.equal((await saved).status(), 200);
        await expect(page.locator('.rd-metadata')).toContainText('Mandalagan');
        await expect(page.locator('.rd-review-form, .rd-severity')).toHaveCount(0);
        await page.setViewportSize({ width: 375, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await fs.mkdir('.data/remediation-2026-10-26', { recursive: true });
        await page.screenshot({ path: '.data/remediation-2026-10-26/verified-routing-mysql-mobile.png', fullPage: true });
        await context.close();
      } finally { await browser.close(); }
    });
    await t.test('used migration 017 refuses destructive rollback and preserves incident history', async () => {
      const connection = await database.pool.getConnection();
      const [before] = await connection.query('SELECT COUNT(*) AS total FROM report_coordination_events');
      try {
        const sql = runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/017_incidents_and_routing.sql', 'utf8'));
        await connection.query(sql[0]);
        await assert.rejects(connection.query(sql[1]), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.deepEqual((await connection.query('SELECT COUNT(*) AS total FROM report_coordination_events'))[0], before);
      } finally { await connection.query('DROP TEMPORARY TABLE IF EXISTS migration017_guard'); connection.release(); }
    });
    await t.test('an unavailable migration reports setup-required without breaking existing report monitoring', async () => {
      await database.pool.query('RENAME TABLE report_incident_lock TO unavailable_incident_lock');
      const warning = t.mock.method(console, 'warn', () => {});
      try {
        const headers = { Authorization: `Bearer ${fixture.routing.token}` };
        const result = await fetch(`${base}/api/reports/${fixture.browserReport.id}/incident-review`, { headers });
        assert.equal(result.status, 503); assert.equal((await result.json()).code, 'INCIDENT_REVIEW_NOT_READY');
        assert.equal((await fetch(`${base}/api/reports/${fixture.browserReport.id}/review`, { headers })).status, 200);
        assert.equal((await fetch(`${base}/api/reports/${fixture.browserReport.id}/citizen-comments`, { headers })).status, 200);
        assert.deepEqual(warning.mock.calls[0]?.arguments, ['Incident and routing dependency unavailable.', { code: 'INCIDENT_REVIEW_NOT_READY', migration: '017_incidents_and_routing.sql' }]);
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.addInitScript(session => {
            sessionStorage.setItem('up_session', JSON.stringify(session));
            Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
          }, { ...fixture.admin.user, apiToken: fixture.admin.token });
          const unavailable = page.waitForResponse(response => response.url().endsWith(`/api/reports/${fixture.browserReport.id}/incident-review`) && response.status() === 503);
          await page.goto(`${base}/report-details.html?id=${fixture.browserReport.id}`);
          await unavailable;
          await expect(page.locator('.rd-incident-review')).toBeHidden();
          assert.equal(await page.locator('.rd-incident-review').evaluate(node => node.getBoundingClientRect().height), 0);
          await expect(page.locator('.rd-message-form')).toBeVisible();
          await expect(page.locator('.rd-incident-review form, .rd-review-form, .rd-severity')).toHaveCount(0);
        } finally { await browser.close(); }
      } finally { warning.mock.restore(); await database.pool.query('RENAME TABLE unavailable_incident_lock TO report_incident_lock'); }
    });
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await database.close(); }
});
