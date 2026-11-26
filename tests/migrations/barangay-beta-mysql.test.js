const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { privateMysql } = require('../support/private-mysql');
const { PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
const { chromium, expect } = require('@playwright/test');
const { setFixtureResidency, addReportGps } = require('../support/citizens');

test('Barangay beta workflows on isolated MySQL', { timeout: 300000 }, async t => {
  const db = await privateMysql(t);
  let server;
  try {
    const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
    const migrationResult = await runner.runMigrations(db.pool);
    assert.ok(migrationResult.applied.includes('014_report_action_proofs.sql'));
    assert.deepEqual((await runner.runMigrations(db.pool)).applied, []);
    await t.test('migration 014 rollback and reapply preserve reports and history', async () => {
      await db.pool.query("INSERT INTO reports (description, barangay, status) VALUES ('Legacy report', 'Villamonte', 'pending')");
      await db.pool.query("INSERT INTO report_status_history (report_id, old_status, new_status, note) VALUES (1, 'pending', 'ongoing', 'Preserved legacy history')");
      const before = (await db.pool.query('SELECT * FROM reports'))[0];
      const historyBefore = (await db.pool.query('SELECT id, report_id, old_status, new_status, note FROM report_status_history'))[0];
      for (const sql of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/014_report_action_proofs.sql', 'utf8'))) await db.pool.query(sql);
      await db.pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['014_report_action_proofs.sql']);
      assert.deepEqual((await runner.runMigrations(db.pool)).applied, ['014_report_action_proofs.sql']);
      assert.deepEqual((await db.pool.query('SELECT * FROM reports'))[0], before);
      assert.deepEqual((await db.pool.query('SELECT id, report_id, old_status, new_status, note FROM report_status_history'))[0], historyBefore);
    });
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.UPLOAD_DIR = path.join(db.directory, 'uploads');
    process.env.STORAGE_DRIVER = 'local';
    require('../../server/infrastructure/database').useTestDatabase(db.adapter);
    const services = require('../../server/composition');
    services.damageDetectionService.detectForReport = async () => null;
    services.damageDetectionService.verifyReportImages = async () => null;
    const app = require('../../server/app');
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const password = 'IsolatedFixture123!';
    const passwordHash = await bcrypt.hash(password, 4);
    async function actor(username, role, barangay = 'Villamonte') {
      await db.pool.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id) SELECT ?, ?, ?, name, id FROM barangays WHERE name = ?', [username, passwordHash, role, barangay]);
      const response = await fetch(`${base}/api/auth/${role}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      const session = await response.json();
      const [rows] = await db.pool.execute('SELECT barangay_id FROM users WHERE username = ?', [username]);
      session.user.barangayId = rows[0].barangay_id;
      return session;
    }
    const owner = await actor('beta_owner', 'citizen'), neighbor = await actor('beta_neighbor', 'citizen');
    await setFixtureResidency('beta_owner', 'Villamonte', db.adapter);
    const official = await actor('beta_official', 'barangay'), outside = await actor('beta_other', 'barangay', 'Mandalagan');
    const admin = await actor('beta_admin', 'admin');
    async function request(route, who = official, method = 'GET', body) {
      const multipart = body instanceof FormData;
      return fetch(base + route, { method, headers: { ...(who ? { Authorization: `Bearer ${who.token}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}), redirect: 'manual' });
    }
    async function report(category = 'Road Damage') {
      const form = new FormData();
      for (const [key, value] of Object.entries({ description: 'Synthetic road issue', barangay: 'Villamonte', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15', ...(category ? { citizenCategory: category } : {}) })) form.append(key, value);
      addReportGps(form, 'Villamonte');
      form.append('images', new Blob([PNG_BYTES], { type: 'image/png' }), 'one.png');
      form.append('images', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'two.jpg');
      const response = await request('/api/reports', owner, 'POST', form);
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    }
    function action(status, { note = 'Completed physical repair', key = randomUUID(), photos = [PNG_BYTES], type = 'image/png' } = {}) {
      const body = new FormData(); body.append('status', status); body.append('note', note); body.append('requestKey', key);
      for (const photo of photos) body.append('images', new Blob([photo], { type }), 'proof.png');
      return body;
    }
    const created = await report();
    const route = `/api/reports/${created.id}`;
    await t.test('manual category survives unavailable AI, MySQL and all three portal DTOs', async () => {
      assert.equal(created.citizenCategory, 'Road Damage'); assert.equal(created.originalAi, null);
      const [rows] = await db.pool.execute('SELECT submission_assessment FROM reports WHERE id = ?', [created.id]);
      assert.equal(rows[0].submission_assessment.citizen_category, 'Road Damage');
      const presentation = require('../../frontend/js/shared/reportPresentation');
      for (const who of [owner, official, admin]) {
        const response = await request(route, who); assert.equal(response.status, 200);
        assert.equal(presentation.damage(await response.json()).title, 'Road Damage');
      }
      const legacy = await report(null); assert.equal(legacy.citizenCategory, null);
      assert.equal(presentation.damage(legacy).title, 'Category not recorded');
      assert.equal((await request(route, outside)).status, 403);
    });
    await t.test('pending to ongoing requires no photo or note', async () => {
      assert.equal((await request(route + '/status', official, 'PATCH', { status: 'ongoing' })).status, 200);
      const result = await (await request(route + '/history', owner)).json();
      assert.equal(result.history.length, 1); assert.deepEqual(result.history[0].proofs, []);
      assert.equal(result.history[0].changed_by, undefined);
    });
    await t.test('resolution rejects absent description, missing photos and invalid image content', async () => {
      for (const body of [action('resolved', { note: '' }), action('resolved', { photos: [] }), action('resolved', { photos: [Buffer.from('not an image')] }), action('resolved', { type: 'text/plain' }), action('resolved', { photos: [Buffer.alloc(10 * 1024 * 1024 + 1)] })]) {
        const response = await request(route + '/status', official, 'PATCH', body);
        assert.ok([400, 413].includes(response.status), `${response.status}: ${await response.text()}`);
      }
      assert.equal((await (await request(route)).json()).status, 'ongoing');
    });
    await t.test('citizen and cross-barangay uploads cannot mutate reports or store evidence', async () => {
      const before = await fs.readdir(process.env.UPLOAD_DIR);
      for (const who of [owner, outside, null]) assert.equal((await request(route + '/status', who, 'PATCH', action('resolved'))).status, who ? 403 : 401);
      const jwt = require('jsonwebtoken');
      const expired = { token: jwt.sign({ ...jwt.decode(official.token), exp: 1 }, process.env.JWT_SECRET) };
      assert.equal((await request(route + '/status', expired, 'PATCH', action('resolved'))).status, 401);
      assert.equal((await request(route + '/status', { token: 'invalid' }, 'PATCH', action('resolved'))).status, 401);
      assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), before);
    });
    await t.test('storage failure leaves status/history unchanged and removes temporary uploads', async () => {
      const storage = require('../../server/infrastructure/storage/storageFactory').getImageStorage();
      const upload = storage.upload; const before = await fs.readdir(process.env.UPLOAD_DIR);
      storage.upload = async () => { throw new Error('Synthetic storage failure'); };
      try { assert.equal((await request(route + '/status', official, 'PATCH', action('resolved'))).status, 500); }
      finally { storage.upload = upload; }
      assert.equal((await (await request(route)).json()).status, 'ongoing');
      assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), before);
    });
    await t.test('database failure rolls back status, proof, history and cleans uploads', async () => {
      const before = await fs.readdir(process.env.UPLOAD_DIR);
      await db.pool.query("CREATE TRIGGER fail_action_proof BEFORE INSERT ON report_action_proofs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Synthetic proof failure'");
      try { assert.equal((await request(route + '/status', official, 'PATCH', action('resolved'))).status, 500); }
      finally { await db.pool.query('DROP TRIGGER fail_action_proof'); }
      assert.equal((await (await request(route)).json()).status, 'ongoing');
      assert.equal((await (await request(route + '/history')).json()).history.length, 1);
      assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), before);
    });
    await t.test('partial remote-storage failure compensates the first uploaded object', async () => {
      const storage = require('../../server/infrastructure/storage/storageFactory').getImageStorage();
      const upload = storage.upload, remove = storage.remove;
      const removed = []; let uploads = 0;
      const reference = 'supabase:isolated-fixture/reports/proof.png';
      storage.upload = async () => { if (++uploads === 2) throw new Error('Synthetic second upload failure'); return { reference }; };
      storage.remove = async ref => { removed.push(ref); };
      const before = await fs.readdir(process.env.UPLOAD_DIR);
      try { assert.equal((await request(route + '/status', official, 'PATCH', action('resolved', { photos: [PNG_BYTES, PNG_BYTES] }))).status, 500); }
      finally { storage.upload = upload; storage.remove = remove; }
      assert.deepEqual(removed, [reference]);
      assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), before);
      assert.equal((await (await request(route)).json()).status, 'ongoing');
    });
    await t.test('concurrent retries write one action/proof and notify once', async () => {
      const key = randomUUID();
      const [before] = await db.pool.query('SELECT COUNT(*) AS total FROM notifications');
      const responses = await Promise.all([1, 2].map(() => request(route + '/status', official, 'PATCH', action('resolved', { key }))));
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      const results = await Promise.all(responses.map(response => response.json()));
      assert.equal(results.filter(result => !result.replayed).length, 1);
      const [after] = await db.pool.query('SELECT COUNT(*) AS total FROM notifications');
      assert.equal(after[0].total - before[0].total, 1);
      assert.equal((await request(route + '/status', official, 'PATCH', action('resolved', { key, note: 'Changed payload' }))).status, 409);
      const history = (await (await request(route + '/history', owner)).json()).history;
      assert.equal(history.length, 2); assert.equal(history[1].proofs.length, 1); assert.equal(history[1].note, 'Completed physical repair');
      assert.equal(history[1].request_hash, undefined);
      for (const row of history) for (const field of ['changed_by', 'changed_by_username', 'changed_by_role']) assert.equal(row[field], undefined);
      const url = history[1].proofs[0].imagePath;
      assert.match(url, /\/images\/action-\d+$/);
      for (const who of [owner, official, admin]) {
        const response = await request(url, who); assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
      }
      for (const who of [neighbor, outside, null]) assert.equal((await request(url, who)).status, who ? 403 : 401);
      assert.equal((await request(url.replace(`/reports/${created.id}/`, '/reports/1/'), admin)).status, 404);
      assert.equal((await request(route + '/status', official, 'PATCH', { status: 'ongoing' })).status, 400);
    });
    await t.test('optional progress photo associates with the ongoing event', async () => {
      const pending = await report();
      assert.equal((await request(`/api/reports/${pending.id}/status`, official, 'PATCH', action('ongoing'))).status, 200);
      const history = (await (await request(`/api/reports/${pending.id}/history`)).json()).history;
      assert.equal(history[0].new_status, 'ongoing'); assert.equal(history[0].proofs.length, 1);
    });
    await t.test('ongoing analytics counts first dated events across Manila midnight, not current statuses', async () => {
      const reportClock = require('../../server/infrastructure/database/reportClock');
      const offset = await reportClock.offsetMinutes(db.adapter);
      const analytics = require('../../server/application/use-cases/reportAnalytics.service').createReportAnalyticsService({ reportAnalyticsRepository: require('../../server/infrastructure/repositories/reportAnalytics.repository'), clock: () => new Date('2026-09-10T05:00:00Z') });
      const ids = [];
      for (const who of [official, official, outside]) {
        const [insert] = await db.pool.execute("INSERT INTO reports (description, barangay, barangay_id, status, created_at) VALUES ('Analytics fixture', ?, ?, 'resolved', '2026-09-01 00:00:00')", [who.user.barangay, who.user.barangayId]);
        ids.push(insert.insertId);
      }
      for (const [id, date, from] of [[ids[0], '2026-09-08 15:59:59', 'pending'], [ids[0], '2026-09-09 16:00:00', 'pending'], [ids[1], '2026-09-08 16:00:00', 'pending'], [ids[1], '2026-09-09 01:00:00', 'ongoing'], [ids[2], '2026-09-08 16:00:00', 'pending']]) {
        await db.pool.execute("INSERT INTO report_status_history (report_id, old_status, new_status, created_at) VALUES (?, ?, 'ongoing', ?)", [id, from, reportClock.wallTime(date.replace(' ', 'T') + 'Z', offset)]);
      }
      const result = await analytics.getAnalytics({ days: '7' }, official.user);
      assert.equal(result.daily.find(day => day.date === '2026-09-08').ongoing, 1);
      assert.equal(result.daily.find(day => day.date === '2026-09-09').ongoing, 1);
      assert.equal(result.daily.find(day => day.date === '2026-09-10').ongoing, 0);
      assert.equal(result.totals.ongoing, 2); assert.equal(result.totals.submitted, 0);
      assert.equal((await analytics.getAnalytics({ days: '7' }, outside.user)).totals.ongoing, 1);
      await assert.rejects(analytics.getAnalytics({ days: '7', barangayId: outside.user.barangayId }, official.user));
    });
    let post;
    await t.test('Barangay feed reuses approval gates, scope, anonymity and established official participation', async () => {
      assert.equal((await (await request('/api/community/posts')).json()).posts.length, 0);
      const decision = `/api/admin/community-publications/${created.id}/decision`;
      assert.equal((await request(decision, official, 'POST', { state: 'approved', version: created.publication.version })).status, 403);
      assert.equal((await request(decision, admin, 'POST', { state: 'approved', version: created.publication.version })).status, 200);
      const feed = await (await request('/api/community/posts')).json();
      assert.equal(feed.posts.length, 1); post = feed.posts[0];
      assert.equal(post.linkedReport.status, 'resolved'); assert.ok(post.author.pseudonym);
      assert.doesNotMatch(JSON.stringify(post), /beta_owner|submitted_by|changed_by|storage_reference|latitude|longitude/);
      assert.equal((await request('/api/community/posts?unsupportedFilter=true', outside)).status, 400);
      assert.equal((await (await request('/api/community/posts', outside)).json()).posts.length, 1);
      assert.equal((await (await request('/api/community/posts?barangayId=' + outside.user.barangayId, outside)).json()).posts.length, 0);
      assert.equal((await (await request('/api/community/posts?barangayId=' + official.user.barangayId, outside)).json()).posts.length, 1);
      for (const suffix of ['', '/comments', `/media/${post.media[0].id}`, '/report']) assert.equal((await request(`/api/community/posts/${post.id}${suffix}`, outside)).status, 200);
      assert.equal((await request(post.media[0].url)).status, 200);
      const comment = await request(`/api/community/posts/${post.id}/comments`, official, 'POST', { body: 'Official progress update <script>alert(1)</script>', requestKey: randomUUID() });
      assert.equal(comment.status, 200); assert.equal((await comment.json()).comment.author.official, true);
      assert.equal((await request(`/api/community/posts/${post.id}/reaction`, official, 'PUT', { reaction: 'like' })).status, 200);
      const rejected = await report();
      assert.equal((await request(`/api/admin/community-publications/${rejected.id}/decision`, admin, 'POST', { state: 'rejected', version: rejected.publication.version, reason: 'Synthetic rejection reason' })).status, 200);
      assert.equal((await (await request('/api/community/posts')).json()).posts.length, 1);
      const page1 = await (await request('/api/community/posts?pageSize=1&page=1')).json();
      const page2 = await (await request('/api/community/posts?pageSize=1&page=2')).json();
      assert.equal(page1.posts.length, 1); assert.equal(page2.posts.length, 0);
      assert.equal((await request('/api/community/posts?pageSize=100')).status, 400);
    });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await t.test(`real browser ${viewport.width}: action form, proof viewing, analytics and community navigation`, async () => {
        const pending = await report();
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.addInitScript(() => {
            Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
          });
          await page.goto(base + '/barangay-login.html');
          await page.locator('#roleLoginUser').fill('beta_official');
          await page.locator('#roleLoginPass').fill(password);
          await page.locator('#roleLoginSubmit').click();
          await expect(page).toHaveURL(/barangay.html/);
          const button = page.locator(`[data-report-id="${pending.id}"] [data-action="view"]`);
          await button.click();
          const modal = page.locator('#reportDetails');
          if (!await modal.locator('.rd-staff-tools').evaluate(element => element.open)) await modal.locator('.rd-staff-tools > summary').click();
          await expect(modal.locator('.rd-summary')).toContainText('Road Damage');
          await modal.getByRole('button', { name: 'Mark ongoing', exact: true }).click();
          await expect(modal.locator('.rd-status strong')).toHaveText('Ongoing');
          await modal.getByRole('button', { name: 'Resolve report', exact: true }).click();
          await expect(modal.locator('.rd-review-message')).toContainText('at least one completion photo');
          await modal.locator('textarea[name="note"]').fill('Repaired in synthetic browser test');
          await modal.locator('input[type="file"]').setInputFiles({ name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES });
          await expect(modal.locator('.rd-action-previews img')).toHaveCount(1);
          await modal.getByRole('button', { name: 'Remove action photo 1' }).click();
          await expect(modal.locator('.rd-action-previews img')).toHaveCount(0);
          await modal.locator('input[type="file"]').setInputFiles({ name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES });
          await modal.getByRole('button', { name: 'Resolve report', exact: true }).click();
          await expect(modal.locator('.rd-status strong')).toHaveText('Resolved');
          await fs.mkdir('.data/barangay-beta', { recursive: true });
          await modal.screenshot({ path: `.data/barangay-beta/proof-${viewport.width}.png` });
          await expect.poll(() => modal.locator('.rd-action-photo img').evaluateAll(images => images.length > 0 && images.every(image => image.naturalWidth > 0))).toBe(true);
          await modal.getByRole('button', { name: 'Enlarge action photo' }).click();
          await expect(modal.locator('.rd-dialog')).toBeVisible();
          await modal.locator('.rd-dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
          await modal.getByRole('button', { name: 'Close action photo' }).click();
          await page.locator('#backToReports').click();
           await expect(page).toHaveURL(/\/barangay\.html/);
           await expect(page.locator('#barangaySidebar [data-section="analytics"]')).toBeAttached();
          await expect(page.locator('#barangayAnalytics')).toBeHidden();
           if (viewport.width < 768) await page.locator('#barangayMenu').click();
          await page.getByRole('link', { name: 'Analytics', exact: true }).click();
          await page.locator('#barangayAnalytics summary').click();
          await expect(page.locator('#barangayAnalytics th').filter({ hasText: /^Ongoing$/ })).toHaveCount(1);
           if (viewport.width < 768) await page.locator('#barangayMenu').click();
          await page.getByRole('link', { name: 'Community Feed', exact: true }).click();
          await expect(page.locator('#communitySection')).toBeVisible();
          await expect(page.locator('.cf-posts .cf-post')).toHaveCount(1);
          await expect(page.locator('#communitySection')).toHaveClass('community-feed');
          await expect.poll(() => page.locator('.cf-posts img[data-evidence-url]').evaluateAll(images => images.length > 0 && images.every(image => image.naturalWidth > 0))).toBe(true);
          await page.locator('[data-action="comments"]').click();
          await expect(page.locator('.cf-comment-form input')).toHaveAttribute('placeholder', /barangay official/);
          const commentText = `Browser official comment ${viewport.width}`;
          await page.locator('.cf-comment-form input').fill(commentText);
          await page.locator('.cf-comment-form button[type="submit"]').click();
          const comment = page.locator('.cf-comment').filter({ has: page.locator('.cf-comment-body', { hasText: commentText }) });
          await expect(comment.locator('.cf-official')).toHaveText('Official');
          await comment.getByRole('button', { name: 'Reply', exact: true }).click();
          await page.locator('.cf-comment-form input').fill(`Reply from ${viewport.width}`);
          await page.locator('.cf-comment-form button[type="submit"]').click();
          await expect(page.locator('.cf-comment-body').filter({ hasText: `Reply from ${viewport.width}` })).toHaveCount(1);
          await comment.getByRole('button', { name: 'Like comment', exact: true }).click();
          await expect(comment.locator('[data-reaction-target="comment"]')).toHaveAttribute('aria-pressed', 'true');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          await fs.mkdir('.data/barangay-beta', { recursive: true });
          await page.screenshot({ path: `.data/barangay-beta/feed-${viewport.width}.png`, fullPage: true });
          await page.evaluate(() => PortalTheme.setPreference('dark'));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          await page.screenshot({ path: `.data/barangay-beta/feed-dark-${viewport.width}.png`, fullPage: true });
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
