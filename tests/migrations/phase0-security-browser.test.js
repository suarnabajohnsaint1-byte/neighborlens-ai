const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { chromium, expect } = require('@playwright/test');
const { privateMysql } = require('../support/private-mysql');

test('private MySQL threaded comments, role isolation and scoped dashboard browser verification', { timeout: 300000 }, async t => {
  const database = await privateMysql(t);
  let server, frontend, browser;
  const { pool, adapter, directory } = database;
  try {
    await require('../../server/infrastructure/database/mysql/migrationRunner').runMigrations(pool);
    await pool.query("INSERT IGNORE INTO barangays (name) VALUES ('Villamonte'), ('Mandalagan')");
    const password = await bcrypt.hash('FixturePass123!', 4);
    const fixtures = [ ['thread_alpha', 'citizen', 'Villamonte'], ['thread_beta', 'citizen', 'Villamonte'], ['scope_official', 'barangay', 'Villamonte'], ['outside_official', 'barangay', 'Mandalagan'], ['audit_admin', 'admin', 'Villamonte'] ];
    for (const [username, role, barangay] of fixtures) await pool.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id, full_name) SELECT ?, ?, ?, name, id, ? FROM barangays WHERE name = ?', [username, password, role, `Private fixture ${username}`, barangay]);
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.UPLOAD_DIR = path.join(directory, 'isolated-uploads'); process.env.STORAGE_DRIVER = 'local';
    require('../../server/infrastructure/database').useTestDatabase(adapter);
    server = await new Promise(resolve => { const listener = require('../../server/app').listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, actor, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    }
    const actors = {};
    await t.test('MySQL authority enforces all nine portal credential combinations', async () => {
      for (const [username, role] of [fixtures[0], fixtures[2], fixtures[4]]) for (const portal of ['citizen', 'admin', 'barangay']) {
        const result = await request(`/api/auth/${portal}/login`, null, 'POST', { username, password: 'FixturePass123!' });
        assert.equal(result.status, role === portal ? 200 : 401);
        if (role === portal) actors[role] = result.data;
        else { assert.equal(result.data.token, undefined); assert.equal(result.data.user, undefined); }
      }
    });
    const beta = (await request('/api/auth/citizen/login', null, 'POST', { username: 'thread_beta', password: 'FixturePass123!' })).data;
    const outside = (await request('/api/auth/barangay/login', null, 'POST', { username: 'outside_official', password: 'FixturePass123!' })).data;
    const [bar] = await pool.execute("SELECT id FROM barangays WHERE name = 'Villamonte'");
    let reportId;
    for (const [index, classification, status] of [[0, 'MAJOR', 'pending'], [1, 'MINOR', 'ongoing'], [2, null, 'resolved']]) {
      const [result] = await pool.execute('INSERT INTO reports (description, barangay, barangay_id, submitted_by, ai_category, ai_classification, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [`Isolated report ${index}`, 'Villamonte', bar[0].id, actors.citizen.user.id, 'pothole', classification, status, 10.6685 + index * .001, 122.9647]);
      if (index === 0) reportId = result.insertId;
    }
    const queued = await request('/api/community/posts', actors.citizen, 'POST', { body: 'Thread browser fixture', reportId, requestKey: randomUUID() });
    assert.equal(queued.status, 201);
    const post = await require('../support/publication').approvePublication(base, reportId, actors.admin, actors.citizen);
    const comments = `/api/community/posts/${post.id}/comments`;
    const rootComment = (await request(comments, actors.citizen, 'POST', { body: 'Parent by A', parentCommentId: null, requestKey: randomUUID() })).data.comment;
    const child = (await request(comments, beta, 'POST', { body: 'Child by B', parentCommentId: rootComment.id, requestKey: randomUUID() })).data.comment;
    const staticApp = express();
    staticApp.use(['/shared', '/frontend/shared'], express.static(path.resolve('shared')));
    staticApp.use('/frontend', express.static(path.resolve('frontend')));
    frontend = await new Promise(resolve => { const listener = staticApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    const frontendUrl = `http://127.0.0.1:${frontend.address().port}/frontend`;
    browser = await chromium.launch();
    const screenshots = path.resolve('.data/security-screenshots'); await fs.mkdir(screenshots, { recursive: true });
    async function pageFor(actor) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      await page.addInitScript(({ base, actor }) => {
        Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} });
        sessionStorage.setItem('up_session', JSON.stringify({ ...actor.user, apiToken: actor.token }));
      }, { base, actor });
      return page;
    }
    await t.test('real login forms enforce portal roles and direct URLs cannot unlock privileged APIs', async () => {
      const pages = { citizen: 'login.html', admin: 'admin-login.html', barangay: 'barangay-login.html' };
      for (const [username, role] of [fixtures[0], fixtures[2], fixtures[4]]) for (const portal of Object.keys(pages)) {
        const page = await browser.newPage();
        await page.addInitScript(base => Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} }), base);
        await page.goto(`${frontendUrl}/${pages[portal]}`);
        await page.locator(portal === 'citizen' ? '#loginUser' : '#roleLoginUser').fill(username);
        await page.locator(portal === 'citizen' ? '#loginPass' : '#roleLoginPass').fill('FixturePass123!');
        await page.locator(portal === 'citizen' ? '#loginForm [type="submit"]' : '#roleLoginSubmit').click();
        if (role === portal) {
          await expect(page).toHaveURL(new RegExp(`/${role}\\.html`));
          const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('up_session')));
          assert.equal(session.role, role);
          actors[role].token = session.apiToken;
        } else {
          await expect(page.locator(portal === 'citizen' ? '#loginMsg' : '#roleLoginMsg')).toContainText(/Invalid credentials/);
          assert.equal(await page.evaluate(() => sessionStorage.getItem('up_session')), null);
        }
        await page.close();
      }
      const unauthorized = await pageFor(actors.citizen);
      await unauthorized.goto(frontendUrl + '/admin.html');
      await expect(unauthorized).toHaveURL(/citizen\.html/);
      assert.equal((await request('/api/admin/audit-logs', actors.citizen)).status, 403);
      await unauthorized.close();
    });
    const citizenPage = await pageFor(actors.citizen);
    const errors = []; citizenPage.on('pageerror', error => errors.push(error.message));
    let grandchild;
    await t.test('A replies to B inside A root and refresh retains exact MySQL ancestry', async () => {
      await citizenPage.goto(frontendUrl + '/citizen.html#community');
      const card = citizenPage.locator(`.cf-post[data-post-id="${post.id}"]`);
      await card.locator('.cf-comments-toggle').click();
      await expect(card.locator(`[data-comment-node="${rootComment.id}"] [data-comment-node="${child.id}"]`)).toHaveCount(1);
      await card.locator(`[data-comment-reply="${child.id}"]`).click();
      await expect(card.locator('.cf-reply-banner-wrap')).toContainText(child.author.pseudonym);
      await card.locator('.cf-comment-form input').fill('Grandchild by A <script>bad()</script>');
      await card.locator('.cf-comment-submit-btn').click();
      await expect(card.locator('.cf-comment-body').filter({ hasText: 'Grandchild by A' })).toBeVisible();
      const listed = (await request(comments, beta)).data.comments;
      grandchild = listed.find(row => row.body.startsWith('Grandchild by A'));
      assert.ok(grandchild); assert.equal(grandchild.parentCommentId, child.id);
      assert.equal(grandchild.author.pseudonym, rootComment.author.pseudonym);
      assert.equal((await pool.execute('SELECT parent_id FROM community_comments WHERE id = ?', [grandchild.id]))[0][0].parent_id, child.id);
      const hierarchy = `[data-comment-node="${rootComment.id}"] [data-comment-node="${child.id}"] [data-comment-node="${grandchild.id}"]`;
      await expect(card.locator(hierarchy)).toHaveCount(1);
      assert.equal(await card.locator('.cf-comment-body script').count(), 0);
      await citizenPage.reload(); await card.locator('.cf-comments-toggle').click();
      await expect(card.locator(hierarchy)).toHaveCount(1);
      const childReaction = card.locator(`[data-comment-id="${child.id}"] [data-reaction-target="comment"]`);
      await childReaction.click();
      await expect(childReaction.locator('.cf-reaction-total')).toHaveText('1');
      assert.equal((await request(comments, beta)).data.comments.find(row => row.id === grandchild.id).reactions.total, 0);
      await card.locator(`[data-toggle-thread="${child.id}"]`).click();
      await expect(card.locator(`[data-comment-id="${grandchild.id}"]`)).toBeHidden();
      await card.locator(`[data-toggle-thread="${child.id}"]`).click();
      await expect(card.locator(`[data-comment-id="${grandchild.id}"]`)).toBeVisible();
      for (const width of [320, 375, 390, 768, 1440]) {
        await citizenPage.setViewportSize({ width, height: 950 });
        assert.equal(await citizenPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await citizenPage.screenshot({ path: path.join(screenshots, `thread-${width}.png`), fullPage: true });
      }
    });
    await t.test('another account sees stable aliases without identity mappings or ownership controls', async () => {
      const page = await pageFor(beta);
      await page.goto(frontendUrl + '/citizen.html#community');
      const card = page.locator(`.cf-post[data-post-id="${post.id}"]`); await card.locator('.cf-comments-toggle').click();
      await expect(card.locator(`[data-comment-id="${rootComment.id}"] .cf-comment-author`)).toHaveText(rootComment.author.pseudonym);
      await expect(card.locator(`[data-comment-id="${rootComment.id}"] [data-comment-action="edit"]`)).toHaveCount(0);
      const data = (await request(comments, beta)).data;
      assert.doesNotMatch(JSON.stringify(data), /thread_alpha|Private fixture|password_hash|author_id|user_id/);
      const citywide = await request(comments, outside);
      assert.equal(citywide.status, 200);
      assert.doesNotMatch(JSON.stringify(citywide.data), /thread_alpha|Private fixture|password_hash|author_id|user_id/);
      assert.equal((await request(`/api/reports/${reportId}`, outside)).status, 403);
      await page.close();
    });
    await t.test('large-thread pagination never skips older children after new replies change the rendered count', async () => {
      const [large] = await pool.execute('INSERT INTO community_comments (post_id, author_id, body, request_key) VALUES (?, ?, ?, ?)', [post.id, beta.user.id, 'Large browser thread', randomUUID()]);
      for (let index = 0; index < 260; index++) await pool.execute('INSERT INTO community_comments (post_id, parent_id, author_id, body, request_key) VALUES (?, ?, ?, ?, ?)', [post.id, large.insertId, beta.user.id, `Older child ${index}`, randomUUID()]);
      await citizenPage.setViewportSize({ width: 1440, height: 1050 });
      await citizenPage.reload();
      const card = citizenPage.locator(`.cf-post[data-post-id="${post.id}"]`); await card.locator('.cf-comments-toggle').click();
      for (let index = 0; index < 5; index++) {
        await card.locator(`[data-comment-reply="${large.insertId}"]`).click();
        await card.locator('.cf-comment-form input').fill(`New late child ${index}`);
        await card.locator('.cf-comment-submit-btn').click();
        await expect(card.locator('.cf-comment-body').filter({ hasText: `New late child ${index}` })).toBeVisible();
      }
      for (let index = 0; index < 60; index++) {
        const more = card.locator(`[data-load-replies="${large.insertId}"]`);
        if (!await more.count()) break;
        const response = citizenPage.waitForResponse(response => response.url().includes(`parentCommentId=${large.insertId}`));
        await more.click(); await response;
        await expect(card.locator(`[data-comment-node="${large.insertId}"]`)).toBeVisible();
      }
      await expect(card.locator(`[data-comment-node="${large.insertId}"] > .cf-replies-wrap > .cf-replies-list > .cf-comment-node`)).toHaveCount(265);
      await expect(card.locator(`[data-load-replies="${large.insertId}"]`)).toHaveCount(0);
      const childPage = await request(`${comments}?parentCommentId=${large.insertId}&pageSize=20`, beta);
      assert.equal(childPage.status, 200); assert.equal(childPage.data.pagination.childTotal, 265);
    });
    const officialPage = await pageFor(actors.barangay);
    officialPage.on('pageerror', error => errors.push(error.message));
    await t.test('six compact summary cards form equal rows without page overflow', async () => {
      await officialPage.goto(frontendUrl + '/barangay.html');
      await expect(officialPage.locator('#statTotal')).toHaveText('3');
      await expect(officialPage.locator('#statMajor')).toHaveText('1'); await expect(officialPage.locator('#statMinor')).toHaveText('1');
      for (const theme of ['light', 'dark']) for (const width of [375, 768, 1280, 1440, 1671]) {
        await officialPage.setViewportSize({ width, height: 1050 }); await officialPage.evaluate(theme => PortalTheme.setPreference(theme), theme);
        const cards = await officialPage.locator('[data-report-summary="barangay"] > .portal-report-stat').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { top: box.top, width: box.width, height: box.height }; }));
        assert.equal(cards.length, 6);
        const columns = width <= 600 ? 2 : width <= 1100 ? 3 : 6;
        assert.ok(cards.every((card, index) => {
          const first = cards[Math.floor(index / columns) * columns];
          return Math.abs(card.top - first.top) < 1 && Math.abs(card.width - first.width) < 1 && Math.abs(card.height - first.height) < 1;
        }));
        assert.equal(await officialPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await officialPage.screenshot({ path: path.join(screenshots, `dashboard-${width}-${theme}.png`), fullPage: true });
      }
      await officialPage.locator('[data-status-filter="pending"]').click();
      await expect(officialPage.locator('#statTotal')).toHaveText('1'); await expect(officialPage.locator('#statMinor')).toHaveText('0');
    });
    await t.test('GIS map and activity UI use real scoped endpoints, filters and shared detail access', async () => {
      await officialPage.setViewportSize({ width: 1440, height: 1050 });
      await officialPage.locator('#barangaySidebar a[data-section="gis-map"]').click();
      await expect(officialPage.locator('[data-operation-state="gis"]')).toHaveText('3 authorized report locations in view.');
      if (process.env.GIS_BASELINE_CAPTURE === '1') {
        await fs.mkdir(path.resolve('.data/gis-design-baseline'), { recursive: true });
        for (const width of [375, 1440]) {
          await officialPage.setViewportSize({ width, height: 1050 });
          await officialPage.screenshot({ path: path.resolve(`.data/gis-design-baseline/barangay-${width}.png`), fullPage: true });
        }
        await officialPage.setViewportSize({ width: 1440, height: 1050 });
      }
      const pins = officialPage.locator('#barangayGisMap .report-gis-marker');
      const visibleReports = () => pins.evaluateAll(markers => markers.reduce((count, marker) =>
        count + Number(marker.querySelector('.gis-cluster-count')?.textContent || '1'), 0));
      await expect.poll(visibleReports).toBe(3);
      await officialPage.locator('[data-operation-filters="gis"] select[name="classification"]').selectOption('MINOR');
      await officialPage.locator('[data-operation-filters="gis"] button').click();
      await expect.poll(visibleReports).toBe(1);
      await officialPage.reload(); await expect(officialPage.locator('#barangayGis')).toBeVisible();
      assert.equal((await request('/api/barangays/gis?barangayId=1', outside)).status, 400);
      assert.equal((await request('/api/reports/' + reportId, outside)).status, 403);
      assert.equal((await request(`/api/reports/${reportId}/status`, actors.barangay, 'PATCH', { status: 'ongoing' })).status, 200);
      await officialPage.locator('#barangaySidebar a[data-section="activity"]').click();
      await expect(officialPage.locator('#barangayActivityRows')).toContainText(`Report #${reportId}`);
      await expect(officialPage.locator('#barangayActivityRows')).toContainText('Barangay official');
      await expect(officialPage.locator('#barangayActivityRows')).not.toContainText('scope_official');
      assert.equal((await request('/api/barangays/activity', outside)).data.pagination.total, 0);
      await officialPage.screenshot({ path: path.join(screenshots, 'activity-desktop.png'), fullPage: true });
    });
    await t.test('Admin and Barangay share flat category pins, four SVG statuses and authorized popup interactions', async () => {
      const types = ['pothole', 'road_crack', 'broken_streetlight', 'clogged_drainage'];
      const statuses = ['pending', 'ongoing', 'resolved', 'rejected'];
      const positions = [[10.62, 122.91], [10.62, 123.01], [10.74, 122.91], [10.74, 123.01]];
      const fixtures = [];
      for (let index = 0; index < 4; index++) {
        const [row] = await pool.execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category, ai_classification, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['GIS fixture <script>window.gisInjected=true</script>', 'Authorized GIS location', 'Villamonte', bar[0].id, actors.citizen.user.id, types[index], 'MAJOR', statuses[index], ...positions[index]]);
        fixtures.push({ id: row.insertId, status: statuses[index], type: types[index] });
      }
      const [foreign] = await pool.execute("INSERT INTO reports (description, barangay, barangay_id, ai_category, status, latitude, longitude) SELECT 'Foreign private GIS report', name, id, 'pothole', 'pending', 10.70, 122.93 FROM barangays WHERE name = 'Mandalagan'");
      await fs.mkdir(path.resolve('.data/gis-design-final'), { recursive: true });
      for (const role of ['admin', 'barangay']) {
        const page = await pageFor(actors[role]); page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${frontendUrl}/${role}.html#gis-map`);
        const map = page.locator(role === 'admin' ? '#adminGisMapCanvas' : '#barangayGisMap');
        const state = page.locator(role === 'admin' ? '#gisMapReportCount' : '[data-operation-state="gis"]');
        const legend = page.locator(role === 'admin' ? '#adminGisLegend' : '#barangayGisLegend');
        await expect(state).toContainText('authorized report locations in view.');
        await expect(legend.locator('.gis-status')).toHaveCount(4);
        await map.getByRole('button', { name: 'Fit matching reports', exact: true }).click();
        for (const item of fixtures) {
          await expect(legend.locator(`[data-status="${item.status}"] .gis-icon`)).toBeVisible();
          const marker = map.locator(`[role="button"][aria-label$="report ${item.id}"]`);
          await marker.focus(); await page.keyboard.press('Enter');
          await expect(map.locator('.leaflet-popup')).toHaveCount(1);
          await expect(map.locator(`.gis-popup-metadata [data-status="${item.status}"]`)).toBeVisible();
          await expect(map.locator('.gis-popup-metadata .gis-status .gis-icon')).toBeVisible();
          await expect(map.locator('.gis-popup-description')).toHaveText('GIS fixture <script>window.gisInjected=true</script>');
          assert.equal(await page.evaluate(() => window.gisInjected), undefined);
          assert.equal(await map.locator('.gis-popup-description script').count(), 0);
          await map.locator('.leaflet-popup-close-button').focus();
          await page.keyboard.press('Escape');
          await expect(map.locator('.leaflet-popup')).toHaveCount(0);
          await expect(marker).toBeFocused();
        }
        await map.getByRole('button', { name: 'Fit matching reports', exact: true }).click();
        const marker = map.locator(`[role="button"][aria-label$="report ${fixtures[0].id}"]`);
        await marker.hover(); await expect(map.locator('.leaflet-tooltip').filter({ hasText: 'Pothole' })).toBeVisible();
        await marker.click();
        await map.getByRole('button', { name: 'View report details', exact: true }).click();
        await expect(page.locator('#reportDetails')).toBeVisible();
        await page.locator('#backToReports').click();
        await page.goto(`${frontendUrl}/${role}.html#gis-map`);
        for (const theme of ['light', 'dark']) for (const width of [375, 390, 768, 1280, 1440, 1671]) {
          await page.setViewportSize({ width, height: 1050 }); await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
          await map.scrollIntoViewIfNeeded();
          await map.getByRole('button', { name: 'Fit matching reports', exact: true }).click();
          await expect(state).toContainText('authorized report locations in view.');
          await expect(marker).toBeVisible(); await marker.focus(); await page.keyboard.press('Space');
          await expect(map.locator('.leaflet-popup')).toHaveCount(1);
          await expect(map.locator('.gis-report-popup')).toHaveCSS('opacity', '1');
          const contrast = await map.locator('.leaflet-popup-content-wrapper').evaluate(node => {
            const style = getComputedStyle(node), context = document.createElement('canvas').getContext('2d');
            const luminance = value => {
              context.fillStyle = value; context.fillRect(0, 0, 1, 1);
              const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
              return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
            };
            const background = luminance(style.backgroundColor);
            return ['h3', '.gis-status', '.gis-popup-action'].map(selector => {
              const foreground = luminance(getComputedStyle(node.querySelector(selector)).color);
              return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
            });
          });
          assert.ok(contrast.every(ratio => ratio >= 4.5), `${role} ${theme}: popup text contrast ${contrast.join(', ')}`);
          // Leaflet pans the map after opening the popup. Measure both boxes in one frame.
          await expect.poll(() => map.locator('.leaflet-popup-content-wrapper').evaluate(popup => {
            const box = popup.getBoundingClientRect();
            const controls = popup.closest('.report-gis-map').querySelectorAll('.leaflet-control-zoom, .gis-map-control, .gis-expand');
            const overlaps = [...controls].filter(control => {
              const rect = control.getBoundingClientRect();
              return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
            });
            return { insideViewport: box.left >= 0 && box.right <= window.innerWidth,
              overlapping: overlaps.map(control => control.className) };
          }), { message: `${role} ${width} ${theme}: popup must fit and clear the map controls` })
            .toEqual({ insideViewport: true, overlapping: [] });
          await expect(legend.locator('.gis-status')).toHaveCount(4);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await page.locator('[aria-label="GIS report pages"], [data-operation-page="gis"]').count(), 0);
          await page.screenshot({ path: path.resolve(`.data/gis-design-final/${role}-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
          await map.locator('.leaflet-popup-close-button').click();
          await expect(map.locator('.leaflet-popup')).toHaveCount(0);
        }
        await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
        assert.equal(await legend.locator('.gis-icon').first().evaluate(node => getComputedStyle(node).maskImage !== 'none'), true);
        assert.equal(await map.locator('.gis-pin').first().evaluate(node => getComputedStyle(node).animationName), 'none');
        await page.close();
      }
      assert.equal((await request('/api/reports/gis?extentOnly=1', actors.citizen)).status, 403);
      const scoped = (await request('/api/reports/gis?west=122&east=123&south=10&north=11', actors.barangay)).data;
      assert.ok(!scoped.reports.some(row => row.id === foreign.insertId));
      assert.equal((await request(`/api/reports/${foreign.insertId}`, actors.barangay)).status, 403);
    });
    await t.test('viewport map auto-loads 350 matching reports in bounded batches and keeps overlapping reports selectable', async () => {
      let lastId;
      for (let index = 0; index < 350; index++) {
        const [row] = await pool.execute('INSERT INTO reports (description, barangay, barangay_id, ai_category, ai_classification, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [`Volume GIS fixture ${index}`, 'Villamonte', bar[0].id, 'clogged_drainage', 'MINOR', 'pending', 10.72, 122.98]); lastId = row.insertId;
      }
      const page = await pageFor(actors.barangay);
      const counts = []; page.on('response', async response => { if (response.url().includes('/api/reports/gis?') && !response.url().includes('extentOnly')) { const body = await response.json().catch(() => ({})); if (body.reports) counts.push(body.reports.length); } });
      await page.goto(frontendUrl + '/barangay.html#gis-map');
      await expect(page.getByRole('combobox', { name: 'Barangay', exact: true })).toBeEnabled();
      const filters = page.locator('[data-operation-filters="gis"]');
      await filters.locator('[name="status"]').selectOption('pending'); await filters.locator('[name="classification"]').selectOption('MINOR');
      const started = Date.now(); await filters.locator('[type="submit"]').click();
      await expect(page.locator('[data-operation-state="gis"]')).toHaveText('350 authorized report locations in view.');
      t.diagnostic(`Private 350-report filtered viewport load: ${Date.now() - started} ms; clustered DOM and sequential batches of at most 200.`);
      await expect.poll(() => counts.includes(150)).toBe(true);
      assert.ok(counts.every(count => count <= 200)); assert.ok(counts.includes(200));
      await expect(page.locator('#barangayGisMap .gis-cluster')).toHaveText('350');
      await expect(page.locator('#barangayGisMap .gis-cluster .gis-icon--drainage')).toBeVisible();
      assert.match(await page.locator('#barangayGisMap .gis-cluster .gis-icon--drainage').evaluate(node => getComputedStyle(node).maskImage), /neighborlens_gis_report_icons\/icon-drainage\.svg/);
      await page.screenshot({ path: path.resolve('.data/gis-design-final/barangay-grouped-icons.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Fit matching reports', exact: true }).click();
      await expect(page.locator('[data-operation-state="gis"]')).toHaveText('350 authorized report locations in view.');
      const moved = page.waitForResponse(response => response.ok() && response.url().includes('/api/reports/gis?') && !response.url().includes('extentOnly'));
      await page.locator('#barangayGisMap .leaflet-control-zoom-in').click(); await moved;
      await expect(page.locator('[data-operation-state="gis"]')).toHaveText('350 authorized report locations in view.');
      const cluster = page.locator('#barangayGisMap .gis-cluster');
      await expect(cluster).toHaveText('350');
      await cluster.click();
      await expect(page.locator('.gis-cluster-label option')).toHaveCount(350);
      await page.locator('.gis-cluster-label select').selectOption(String(lastId));
      await expect(page.locator('.gis-cluster-preview .gis-status[data-status="pending"] .gis-icon')).toBeVisible();
      await page.getByRole('button', { name: 'View report details', exact: true }).click();
      await expect(page.locator('#reportDetails')).toContainText('Volume GIS fixture 349');
      await page.locator('#backToReports').click();
      await page.goto(frontendUrl + '/barangay.html#gis-map');
      await filters.locator('[name="status"]').selectOption('pending');
      let release, deliver, held = false;
      const delayed = new Promise(resolve => { release = resolve; });
      const delivered = new Promise(resolve => { deliver = resolve; });
      await page.route('**/api/reports/gis?**', async route => {
        const url = new URL(route.request().url());
        if (!held && url.searchParams.get('classification') === 'MAJOR' && !url.searchParams.has('extentOnly')) {
          held = true; const response = await route.fetch(); await delayed;
          await route.fulfill({ response }).catch(() => {}).finally(deliver);
        } else await route.continue();
      });
      await filters.locator('[name="classification"]').selectOption('MAJOR'); await filters.locator('[type="submit"]').click();
      await expect.poll(() => held).toBe(true);
      await filters.locator('[name="classification"]').selectOption('MINOR'); await filters.locator('[type="submit"]').click();
      await expect(page.locator('[data-operation-state="gis"]')).toHaveText('350 authorized report locations in view.');
      release(); await delivered;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(page.locator('#barangayGisMap .gis-cluster')).toHaveText('350');
      await page.close();
    });
    await t.test('real Admin and Barangay report buttons download complete filtered Excel workbooks and recover from errors', async () => {
      const Excel = require('exceljs');
      const output = path.resolve('.data/export-verification'); await fs.mkdir(output, { recursive: true });
      for (const role of ['admin', 'barangay']) {
        const page = await pageFor(actors[role]);
        await page.goto(`${frontendUrl}/${role}.html#reports`);
        if (role === 'admin') await page.evaluate(() => showAdminSection('reportsSection'));
        const search = page.locator(role === 'admin' ? '#adminSearch' : '#reportSearch');
        await search.fill('Volume GIS fixture');
        const button = page.locator(role === 'admin' ? '#adminExportReports' : '#barangayExportReports');
        await expect(button).toBeVisible();
        let requests = 0; page.on('request', request => { if (request.url().includes('/api/reports/export?')) requests++; });
        const started = Date.now(), event = page.waitForEvent('download');
        await button.evaluate(node => { node.click(); node.click(); });
        const download = await event;
        assert.match(download.suggestedFilename(), /^NeighborLens_.*_Reports_\d{4}-\d\d-\d\d\.xlsx$/);
        const target = path.join(output, role + '.xlsx'); await download.saveAs(target);
        const book = new Excel.Workbook(); await book.xlsx.readFile(target);
        assert.equal(book.getWorksheet('Reports').rowCount, 351);
        assert.equal(book.getWorksheet('Summary').getCell('B5').value, 350);
        book.getWorksheet('Reports').eachRow((row, index) => { if (index > 1) assert.equal(row.getCell(8).value, 'Villamonte'); });
        assert.equal(requests, 1); await expect(button).toBeEnabled();
        t.diagnostic(`${role}: actual browser download of 350 MySQL reports took ${Date.now() - started} ms.`);
        await page.reload();
        if (role === 'admin') await page.evaluate(() => showAdminSection('reportsSection'));
        await expect(search).toHaveValue('Volume GIS fixture');
        await search.fill('No matching export fixture');
        const emptyEvent = page.waitForEvent('download'); await button.click();
        const emptyDownload = await emptyEvent; const emptyFile = path.join(output, role + '-empty.xlsx'); await emptyDownload.saveAs(emptyFile);
        const emptyBook = new Excel.Workbook(); await emptyBook.xlsx.readFile(emptyFile);
        assert.equal(emptyBook.getWorksheet('Reports').rowCount, 1);
        assert.equal(emptyBook.getWorksheet('Summary').getCell('B5').value, 0);
        await page.route('**/api/reports/export?**', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Export permission denied.' }) }));
        await button.click(); await expect(page.locator('.report-export-feedback')).toHaveText('Export permission denied.'); await expect(button).toBeEnabled();
        for (const theme of ['light', 'dark']) for (const width of [375, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
          await button.scrollIntoViewIfNeeded(); await expect(button).toBeVisible();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: path.join(output, `${role}-${width}-${theme}.png`), animations: 'disabled' });
        }
        await page.close();
      }
      const [logs] = await pool.query("SELECT details FROM audit_logs WHERE action = 'report_export'");
      assert.equal(logs.length, 4);
      assert.doesNotMatch(JSON.stringify(logs), /Volume GIS fixture/);
    });
    await t.test('both portals show supplied category icons on grouped GIS markers in light and dark appearances', async () => {
      for (const role of ['admin', 'barangay']) {
        const page = await pageFor(actors[role]);
        await page.goto(`${frontendUrl}/${role}.html#gis-map`);
        const map = page.locator(role === 'admin' ? '#adminGisMapCanvas' : '#barangayGisMap');
        const group = map.locator('.gis-cluster').filter({ hasText: /^350$/ });
        await expect(group).toBeVisible();
        for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
          await map.scrollIntoViewIfNeeded();
          const glyph = group.locator('.gis-icon--drainage'); await expect(glyph).toBeVisible();
          assert.match(await glyph.evaluate(node => getComputedStyle(node).maskImage), /neighborlens_gis_report_icons\/icon-drainage\.svg/);
          const boxes = await group.evaluate(node => { const outer = node.getBoundingClientRect(), inner = node.querySelector('.gis-cluster-icons').getBoundingClientRect(); return { outer: { width: outer.width, height: outer.height }, inner: { width: inner.width, height: inner.height } }; });
          assert.ok(boxes.inner.width <= boxes.outer.width && boxes.inner.height <= boxes.outer.height);
          await map.screenshot({ path: path.resolve(`.data/gis-design-final/${role}-group-icons-${width}-${theme}.png`), animations: 'disabled' });
        }
        await group.click(); await expect(map.locator('.gis-cluster-label option')).toHaveCount(350);
        await page.close();
      }
    });
    await t.test('Citizen login illustration retains identical unfiltered image pixels in both themes', async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      await page.goto(frontendUrl + '/login.html');
      const buffers = [];
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
        await expect.poll(() => page.locator('.cl-backdrop').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
        assert.deepEqual(await page.locator('.cl-scene, .cl-backdrop').evaluateAll(nodes => nodes.map(node => ({ filter: getComputedStyle(node).filter, opacity: getComputedStyle(node).opacity }))), [{ filter: 'none', opacity: '1' }, { filter: 'none', opacity: '1' }]);
        await page.screenshot({ path: path.join(screenshots, `login-art-${theme}.png`) });
        buffers.push(await page.screenshot({ clip: { x: 0, y: 700, width: 500, height: 300 } }));
      }
      assert.equal(buffers[0].equals(buffers[1]), true, 'Unobstructed illustration pixels must match across themes.'); await page.close();
    });
    assert.deepEqual(errors, []);
    t.diagnostic('Actual private MySQL, real Express API and real Chromium DOM. No shared database or Supabase mutation. External basemap/CDN availability is separate from scoped data verification.');
  } finally {
    if (browser) await browser.close();
    if (frontend) await new Promise(resolve => frontend.close(resolve));
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await database.close();
  }
});
