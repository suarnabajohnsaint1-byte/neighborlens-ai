const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { chromium, expect } = require('@playwright/test');
const { privateMysql } = require('../support/private-mysql');
const { PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
const { approvePublication } = require('../support/publication');

test('private MySQL Community migration, concurrency and real browser integration', { timeout: 300000 }, async t => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  t.beforeEach(() => { offset += 61000; });
  const database = await privateMysql(t);
  let server, frontend, browser;
  const { pool, adapter, directory } = database;
  try {
    const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
    await pool.query('CREATE TABLE schema_migrations (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE, checksum VARCHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
    const reactionMigration = '019_community_comment_reaction_types.sql';
    const communityMigrations = ['009_community_feed.sql', '010_community_personas_threading.sql', '011_community_publication.sql', '012_pending_publication_jurisdiction.sql', '017_incidents_and_routing.sql', '018_community_report_uniqueness.sql', reactionMigration];
    for (const file of (await runner.listMigrationFiles()).filter(name => !communityMigrations.includes(name))) {
      const migration = await runner.readMigration(file);
      for (const statement of migration.statements) await pool.query(statement);
      await pool.execute('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [file, migration.checksum]);
    }
    await pool.query("INSERT IGNORE INTO barangays (name) VALUES ('Villamonte'), ('Mandalagan')");
    const password = await bcrypt.hash('FixturePass123!', 4);
    const [owner] = await pool.execute("INSERT INTO users (username, password_hash, role, barangay, barangay_id, full_name) SELECT 'community_browser', ?, 'citizen', name, id, 'Fictional Private Citizen' FROM barangays WHERE name = 'Villamonte'", [password]);
    const [legacy] = await pool.execute("INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) SELECT 'Private original description', 'Private original address', name, id, ?, 'pothole' FROM barangays WHERE name = 'Villamonte'", [owner.insertId]);
    await t.test('forward migration preserves legacy reports; rollback and reapplication work', async () => {
      assert.deepEqual((await runner.runMigrations(pool)).applied, communityMigrations);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_posts'))[0][0].total, 0);
      const original = (await pool.execute('SELECT description, status FROM reports WHERE id = ?', [legacy.insertId]))[0][0];
      assert.equal(original.description, 'Private original description'); assert.equal(original.status, 'pending');
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/017_incidents_and_routing.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename IN (?, ?)', ['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql']);
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/012_pending_publication_jurisdiction.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['012_pending_publication_jurisdiction.sql']);
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/011_community_publication.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['011_community_publication.sql']);
      const rollback010 = await fs.readFile(path.resolve('server/infrastructure/database/mysql/migrations/rollback/010_community_personas_threading.sql'), 'utf8');
      for (const statement of runner.parseStatements(rollback010)) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename IN (?, ?)', ['010_community_personas_threading.sql', reactionMigration]);
      const rollback = await fs.readFile(path.resolve('server/infrastructure/database/mysql/migrations/rollback/009_community_feed.sql'), 'utf8');
      for (const statement of runner.parseStatements(rollback)) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['009_community_feed.sql']);
      assert.equal((await pool.query("SHOW TABLES LIKE 'community_posts'"))[0].length, 0);
      assert.deepEqual((await runner.runMigrations(pool)).applied, communityMigrations);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM reports'))[0][0].total, 1);
    });
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.UPLOAD_DIR = path.join(directory, 'private-uploads'); process.env.STORAGE_DRIVER = 'local';
    require('../../server/infrastructure/database').useTestDatabase(adapter);
    const app = require('../../server/app');
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function login(username, portal = 'citizen') {
      const response = await fetch(base + `/api/auth/${portal}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'FixturePass123!' }) });
      assert.equal(response.status, 200); return response.json();
    }
    const citizen = await login('community_browser');
    await pool.execute("INSERT INTO users (username, password_hash, role, barangay, full_name) VALUES (?, ?, 'admin', ?, ?)", ['community_reviewer', password, 'Villamonte', 'Fictional Reviewer']);
    const admin = await login('community_reviewer', 'admin');
    const request = async (url, method = 'GET', body, token = citizen.token) => {
      const response = await fetch(base + '/api/community' + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    let published;
    await t.test('concurrent duplicate publication and reactions are atomic on MySQL', async () => {
      const input = { body: 'Public infrastructure update', requestKey: randomUUID(), reportId: legacy.insertId };
      const duplicate = await Promise.all(Array.from({ length: 5 }, () => request('/posts', 'POST', input)));
      assert.ok(duplicate.every(response => response.status === 201), JSON.stringify(duplicate));
      assert.equal(new Set(duplicate.map(response => response.data.publication.reportId)).size, 1);
      assert.ok(duplicate.every(response => response.data.publication.state === 'pending_approval'));
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_posts'))[0][0].total, 0);
      published = await approvePublication(base, legacy.insertId, admin, citizen);
      const reactions = await Promise.all(Array.from({ length: 12 }, () => request(`/posts/${published.id}/reaction`, 'PUT', { reaction: 'heart' })));
      assert.ok(reactions.every(response => response.status === 200));
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_reactions'))[0][0].total, 1);
      assert.equal((await request(`/posts/${published.id}`)).data.reactions.total, 1);
      const comments = await Promise.all(Array.from({ length: 5 }, () => request(`/posts/${published.id}/comments`, 'POST', { body: 'Anonymous comment', requestKey: 'same-comment-request-12345' })));
      assert.ok(comments.every(response => response.status === 200));
      assert.equal((await request(`/posts/${published.id}/comments`)).data.pagination.total, 1);
      await assert.rejects(pool.execute('INSERT INTO community_reactions (post_id, user_id, reaction) VALUES (?, ?, ?)', [published.id, citizen.user.id, 'bad']), /constraint|Duplicate/);
    });
    await t.test('migration 019 preserves legacy likes and enables persistent Heart reactions', async () => {
      const comments = `/posts/${published.id}/comments`;
      const [comment] = (await request(comments)).data.comments;
      const endpoint = `${comments}/${comment.id}/reaction`;
      const rollback = await fs.readFile(path.join('server/infrastructure/database/mysql/migrations/rollback', reactionMigration), 'utf8');
      for (const statement of runner.parseStatements(rollback)) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', [reactionMigration]);

      assert.equal((await request(endpoint, 'PUT', { reacted: true })).status, 200);
      const before = (await request(comments)).data;
      assert.equal(before.supportsHeart, false);
      assert.deepEqual(before.comments[0].reactions, { total: 1, mine: true, type: 'like' });
      assert.equal((await request(endpoint, 'PUT', { reaction: 'heart' })).status, 400);
      const [original] = await pool.execute('SELECT comment_id, user_id, created_at FROM community_comment_reactions WHERE comment_id = ?', [comment.id]);

      assert.deepEqual((await runner.runMigrations(pool)).applied, [reactionMigration]);
      const [migrated] = await pool.execute('SELECT comment_id, user_id, created_at, reaction FROM community_comment_reactions WHERE comment_id = ?', [comment.id]);
      assert.deepEqual(migrated, [{ ...original[0], reaction: 'like' }]);
      assert.equal((await request(comments)).data.supportsHeart, true);
      assert.equal((await request(endpoint, 'PUT', { reaction: 'bad' })).status, 400);
      for (const result of await Promise.all(Array.from({ length: 3 }, () => request(endpoint, 'PUT', { reaction: 'heart' })))) {
        assert.equal(result.status, 200);
        assert.deepEqual(result.data, { commentId: comment.id, reacted: true, reaction: 'heart', total: 1 });
      }
      assert.deepEqual((await request(comments)).data.comments[0].reactions, { total: 1, mine: true, type: 'heart' });
      assert.deepEqual((await runner.runMigrations(pool)).applied, []);
    });
    await pool.execute("INSERT INTO users (username, password_hash, role, barangay, barangay_id, full_name) SELECT 'private_official', ?, 'barangay', name, id, 'Private Official Name' FROM barangays WHERE name = 'Villamonte'", [password]);
    const official = await login('private_official', 'barangay');
    assert.equal((await request('/posts', 'POST', { body: 'Scheduled infrastructure inspection.', requestKey: randomUUID() }, official.token)).status, 201);
    const staticApp = express(); staticApp.use('/shared', express.static(path.resolve('shared'))); staticApp.use('/frontend', express.static(path.resolve('frontend')));
    frontend = await new Promise(resolve => { const listener = staticApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    const frontendUrl = `http://127.0.0.1:${frontend.address().port}/frontend`;
    t.diagnostic(`Browser frontend: ${frontendUrl}; actual isolated API on a different loopback origin. No API success responses mocked.`);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, permissions: ['geolocation'], geolocation: { latitude: 10.6685, longitude: 122.9647, accuracy: 15 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ base, citizen }) => {
      Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} });
      sessionStorage.setItem('up_session', JSON.stringify({ ...citizen.user, apiToken: citizen.token }));
    }, { base, citizen });
    const screenshots = path.resolve('.data/community-screenshots'); await fs.mkdir(screenshots, { recursive: true });
    let browserReportId;
    await t.test('existing shell requests review with photos, links owned report and refreshes after approval', async () => {
      browserReportId = (await pool.execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) SELECT ?, location, barangay, barangay_id, submitted_by, ai_category FROM reports WHERE id = ?', ['Community browser fixture <img src=x onerror=alert(1)>', legacy.insertId]))[0].insertId;
      await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });
      for (const [index, buffer] of [JPEG_BYTES, PNG_BYTES].entries()) {
        const filename = `${randomUUID()}.${index ? 'png' : 'jpg'}`;
        await fs.writeFile(path.join(process.env.UPLOAD_DIR, filename), buffer);
        await pool.execute('INSERT INTO report_images (report_id, image_path, image_order, mime_type) VALUES (?, ?, ?, ?)', [browserReportId, `/uploads/${filename}`, index + 1, index ? 'image/png' : 'image/jpeg']);
      }
      await page.goto(frontendUrl + '/citizen.html#community');
      await expect(page.locator('.cf-post')).toHaveCount(2);
      await expect(page.locator('.cf-post').filter({ hasText: 'Scheduled infrastructure inspection.' }).locator('.cf-official')).toHaveText('Official');
      await page.evaluate(() => CommunityFeed.chooseReport());
      await page.locator(`[data-share-report-id="${browserReportId}"]`).click();
      await expect(page.locator('#communitySelectorStatus')).toContainText('Pending Community Review');
      await expect(page.locator('.cf-post')).toHaveCount(2);
      await approvePublication(base, browserReportId, admin, citizen);
      await page.locator('#communityReportPicker [data-close]').first().click();
      await page.evaluate(() => CommunityFeed.refresh());
      await expect(page.locator('.cf-post')).toHaveCount(3);
      const card = page.locator('.cf-post').filter({ hasText: 'Community browser fixture' });
      await expect(card.locator('.cf-post-text')).toHaveText('Community browser fixture <img src=x onerror=alert(1)>');
      await expect.poll(() => card.locator('.cf-carousel-slide img').evaluateAll(images => images.length === 2 && images.every(image => image.naturalWidth > 0 && image.src.startsWith('blob:')))).toBe(true);
      assert.equal(await card.locator('.cf-post-text img').count(), 0);
      await page.reload(); await expect(page.locator('.cf-post')).toHaveCount(3);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_media'))[0][0].total, 2);
    });
    await t.test('reaction picker, comments and carousel work without a redundant report control or private data exposure', async () => {
      const card = page.locator('.cf-post').filter({ hasText: 'Community browser fixture' });
      const reaction = card.locator('.cf-react');
      const picker = card.getByRole('menu', { name: 'Choose a reaction', includeHidden: true });
      await reaction.click();
      await expect(picker).toBeHidden();
      await expect(card.locator('[data-reaction=like]')).toHaveAttribute('aria-checked', 'true'); await expect(card.locator('.cf-reaction-total')).toHaveText('1');
      await reaction.press('ArrowDown'); await expect(picker).toBeVisible();
      await page.keyboard.press('Escape'); await expect(picker).toBeHidden(); await expect(reaction).toBeFocused();
      await reaction.press('ArrowDown'); await page.getByRole('menuitemradio', { name: 'Heart', exact: true }).click();
      await expect(card.locator('[data-reaction=heart]')).toHaveAttribute('aria-checked', 'true'); await expect(card.locator('.cf-reaction-total')).toHaveText('1');
      await reaction.click();
      await expect(card.locator('.cf-reaction-total')).toHaveText('0');
      await card.locator('.cf-comments-toggle').click(); await card.locator('.cf-comment-form input').fill('Safe public comment <script>alert(1)</script>');
      await card.locator('.cf-comment-form button').click(); await expect(card.locator('.cf-comment')).toHaveCount(1);
      await expect(card.locator('.cf-comment strong').first()).toHaveText(/^[A-Za-z]+_\d{3}$/);
      const composer = card.locator('.cf-comment-form');
      for (const [parentText, replyText] of [['Safe public comment', 'First reply'], ['First reply', 'Reply to a reply']]) {
        const parent = card.locator('.cf-comment').filter({ has: page.locator('.cf-comment-body', { hasText: parentText }) });
        await parent.getByRole('button', { name: 'Reply', exact: true }).click();
        await expect(card.locator('.cf-reply-context')).toContainText('Replying to');
        await composer.locator('input').fill(replyText);
        await composer.getByRole('button', { name: 'Reply', exact: true }).click();
        await expect(card.getByText(replyText, { exact: true })).toBeVisible();
      }
      const replyNode = card.locator('.cf-comment-reply').filter({ has: page.locator('.cf-comment-body', { hasText: 'Reply to a reply' }) });
      await expect(replyNode.locator('.cf-replying-to-tag')).toContainText('Replying to');
      const replyLike = replyNode.getByRole('button', { name: 'Like comment' });
      await replyLike.click();
      await expect(replyLike).toHaveAttribute('aria-pressed', 'true');
      await expect(replyLike.locator('.cf-reaction-total')).toHaveText('1');
      await expect(replyLike).toBeEnabled();
      await replyLike.press('ArrowDown');
      await replyNode.getByRole('menuitemradio', { name: 'Heart' }).click();
      const replyHeart = replyNode.getByRole('button', { name: 'Heart comment' });
      await expect(replyHeart).toBeEnabled();
      await expect(replyHeart.locator('.cf-reaction-total')).toHaveText('1');
      const replyId = Number(await replyNode.getAttribute('data-comment-id'));
      const postId = await card.getAttribute('data-post-id');
      const [saved] = await pool.execute('SELECT reaction FROM community_comment_reactions WHERE comment_id = ? AND user_id = ?', [replyId, citizen.user.id]);
      assert.deepEqual(saved, [{ reaction: 'heart' }]);
      const restored = await request(`/posts/${postId}/comments`);
      assert.equal(restored.data.comments.find(comment => comment.id === replyId).reactions.type, 'heart');
      await card.locator('.cf-comment-thread > .cf-replies-wrap > .cf-toggle-replies-btn').click();
      await expect(replyNode).toBeHidden();
      await card.locator('.cf-comment-thread > .cf-replies-wrap > .cf-toggle-replies-btn').click();
      await expect(replyNode).toBeVisible();
      for (const actions of await card.locator('.cf-comment-actions').all()) {
        const boxes = await actions.getByRole('button').evaluateAll(buttons => buttons.map(button => {
          const { y, height } = button.getBoundingClientRect();
          return [y, height];
        }));
        assert.equal(boxes.length, 4);
        assert.ok(boxes.every(([y, height]) => y === boxes[0][0] && height === boxes[0][1]));
      }
      await card.locator('.cf-carousel-track').focus(); await page.keyboard.press('ArrowRight'); await expect(card.locator('.cf-carousel-dot').nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect(card.locator('[data-action=report]')).toHaveCount(0);
      await expect(page.locator('#communityReportDialog')).toBeHidden();
      const safeReport = await request(`/posts/${await card.getAttribute('data-post-id')}/report`);
      assert.equal(safeReport.status, 200);
      assert.match(safeReport.data.body, /Community browser fixture/);
      assert.doesNotMatch(JSON.stringify(safeReport.data), /Private original|Fictional Private Citizen|latitude|longitude|gps_accuracy|submitted_by/);
      await page.reload();
      await card.locator('.cf-comments-toggle').click();
      await expect(replyNode.getByRole('button', { name: 'Heart comment' })).toHaveAttribute('aria-pressed', 'true');
    });
    await t.test('light and dark preserve layout and use the appropriate feed pagination for each width', async () => {
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1050 });
        await expect(page.locator('.cf-pages')).toBeVisible({ visible: width > 900 });
        await expect(page.locator('.cf-posts')).toHaveAttribute('aria-busy', 'false');
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('.cf-post')).toHaveCount(3);
          await page.evaluate(() => { scrollTo(0, 0); document.querySelector('main').scrollTop = 0; });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const toolbar = page.locator('.cf-post').first().locator('.cf-toolbar');
          await expect(toolbar.locator('.cf-react')).toHaveCount(1); await expect(toolbar.locator('.cf-reaction-total')).toHaveCount(1);
          await page.screenshot({ path: path.join(screenshots, `community-${width}-${theme}.png`), fullPage: true });
        }
      }
      assert.deepEqual(errors, []);
    });
    await t.test('navigation, search, actual SSE and unread update banner preserve existing report screens', async () => {
      await page.evaluate(() => showSection('myReportsSection')); await expect(page.locator('#myReports')).toContainText('Private original');
      await page.evaluate(() => showSection('submitSection')); await expect(page.locator('#reportForm')).toBeVisible();
      await page.evaluate(() => showSection('communitySection'));
      await expect.poll(() => require('../../server/infrastructure/events/notificationEvents').getActiveConnections(citizen.user.id)).toBeGreaterThan(0);
      const ids = await page.locator('.cf-post').evaluateAll(nodes => nodes.map(node => node.dataset.postId));
      await request('/posts', 'POST', { body: 'A later official update', requestKey: randomUUID() }, official.token);
      await expect(page.locator('.cf-updates')).toBeVisible();
      assert.deepEqual(await page.locator('.cf-post').evaluateAll(nodes => nodes.map(node => node.dataset.postId)), ids);
      await page.locator('.cf-updates').click(); await expect(page.locator('.cf-post')).toHaveCount(4);
      await page.locator('.cf-hero-search input').fill('A later official'); await expect(page.locator('.cf-post')).toHaveCount(1);
      await page.locator('.cf-hero-search input').fill(''); await expect(page.locator('.cf-post')).toHaveCount(4);
    });
    await t.test('an interrupted acknowledgement retries one pending request and preserves the saved report', async () => {
      const reportId = (await pool.execute('INSERT INTO reports (description, barangay, barangay_id, submitted_by) SELECT ?, barangay, barangay_id, submitted_by FROM reports WHERE id = ?', ['Recoverable publication fixture', legacy.insertId]))[0].insertId;
      await page.evaluate(() => CommunityFeed.chooseReport());
      const share = page.locator(`[data-share-report-id="${reportId}"]`);
      await page.route(base + '/api/community/posts', async route => {
        const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed');
      }, { times: 1 });
      await share.click();
      await expect(share).toBeEnabled();
      const key = await share.getAttribute('data-request-key'); assert.ok(key);
      await page.route(base + '/api/community/posts', route => route.fulfill({ status: 429, json: { error: 'Isolated retry backpressure' } }), { times: 1 });
      await share.click();
      await expect(page.locator('#communitySelectorStatus')).toContainText('Isolated retry backpressure');
      await expect(share).toHaveAttribute('data-request-key', key);
      await share.click();
      await expect(page.locator('#communitySelectorStatus')).toContainText('Pending Community Review');
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_publication_requests WHERE report_id = ?', [reportId]))[0][0].total, 1);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [reportId]))[0][0].total, 0);
      assert.equal((await pool.execute('SELECT description FROM reports WHERE id = ?', [reportId]))[0][0].description, 'Recoverable publication fixture');
      await page.locator('#communityReportPicker [data-close]').first().click();
      await approvePublication(base, reportId, admin, citizen);
    });
    await t.test('feed sorting and pagination are backed by real deterministic queries', async () => {
      for (let number = 0; number < 11; number++) await pool.execute('INSERT INTO community_posts (barangay_id, author_id, is_official, body, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [citizen.user.barangayId || (await pool.execute('SELECT barangay_id FROM users WHERE id = ?', [citizen.user.id]))[0][0].barangay_id, official.user.id, 1, `Pagination fixture ${number}`, randomUUID(), 'a'.repeat(64)]);
      await page.evaluate(() => CommunityFeed.refresh()); await expect(page.locator('.cf-post')).toHaveCount(10);
      const first = await page.locator('.cf-post').evaluateAll(nodes => nodes.map(node => node.dataset.postId));
      await page.getByRole('button', { name: 'Next posts', exact: true }).click(); await expect(page.locator('.cf-pages span')).toHaveText('Page 2 of 2');
      const second = await page.locator('.cf-post').evaluateAll(nodes => nodes.map(node => node.dataset.postId));
      assert.equal(second.length, 6); assert.equal(second.some(id => first.includes(id)), false);
      await page.getByRole('tab', { name: 'Most reacted', exact: true }).click(); await expect(page.locator('.cf-pages span')).toHaveText('Page 1 of 2');
      assert.equal(await page.locator('.cf-post').first().getAttribute('data-post-id'), String(published.id));
    });
    await browser.close(); browser = null;
    await t.test('rollback of populated Community tables leaves existing users and private reports intact', async () => {
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/017_incidents_and_routing.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename IN (?, ?)', ['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql']);
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/012_pending_publication_jurisdiction.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['012_pending_publication_jurisdiction.sql']);
      for (const statement of runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/011_community_publication.sql', 'utf8'))) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['011_community_publication.sql']);
      const rollback010 = await fs.readFile(path.resolve('server/infrastructure/database/mysql/migrations/rollback/010_community_personas_threading.sql'), 'utf8');
      for (const statement of runner.parseStatements(rollback010)) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename IN (?, ?)', ['010_community_personas_threading.sql', reactionMigration]);
      const rollback = await fs.readFile(path.resolve('server/infrastructure/database/mysql/migrations/rollback/009_community_feed.sql'), 'utf8');
      for (const statement of runner.parseStatements(rollback)) await pool.query(statement);
      await pool.execute('DELETE FROM schema_migrations WHERE filename = ?', ['009_community_feed.sql']);
      assert.equal((await pool.execute('SELECT description FROM reports WHERE id = ?', [legacy.insertId]))[0][0].description, 'Private original description');
      assert.equal((await pool.execute('SELECT id FROM users WHERE id = ?', [citizen.user.id]))[0][0].id, citizen.user.id);
      assert.deepEqual((await runner.runMigrations(pool)).applied, communityMigrations);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_posts'))[0][0].total, 0);
    });
    t.diagnostic('Actual private MySQL/API persistence, concurrent operations, protected media, Live Server-compatible cross-origin browser requests and SSE verified. Supabase not contacted.');
  } finally {
    if (browser) await browser.close();
    if (frontend) await new Promise(resolve => frontend.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    await database.close();
  }
});
