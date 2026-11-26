const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { chromium, expect } = require('@playwright/test');
const express = require('express');
const { privateMysql } = require('../support/private-mysql');
const { PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
const { freshReportFixAt, setFixtureResidency } = require('../support/citizens');

test('publication lifecycle on isolated MySQL and real browser UI', { timeout: 300000 }, async t => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  t.beforeEach(() => { offset += 61000; });
  const database = await privateMysql(t);
  const { pool, adapter, directory } = database;
  let server, frontend, browser;
  try {
    const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
    for (const file of (await runner.listMigrationFiles()).filter(name => name < '011')) {
      for (const sql of (await runner.readMigration(file)).statements) await pool.query(sql);
    }
    const password = await bcrypt.hash('FixturePass123!', 4);
    async function user(username, role, barangay = 'Villamonte') {
      const [created] = await pool.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id, full_name) SELECT ?, ?, ?, name, id, ? FROM barangays WHERE name = ?', [username, password, role, 'Private fictional identity', barangay]);
      return { id: created.insertId, username, role };
    }
    const owner = await user('publication_owner', 'citizen');
    const neighbor = await user('publication_neighbor', 'citizen');
    const outside = await user('publication_outside', 'citizen', 'Mandalagan');
    const admin = await user('publication_admin', 'admin');
    const second = await user('publication_admin_two', 'admin');
    const official = await user('publication_official', 'barangay');
    const outsideOfficial = await user('publication_other_official', 'barangay', 'Mandalagan');
    async function report(description = 'Fictional road hazard', status = 'pending') {
      return (await pool.execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, status, ai_category) SELECT ?, ?, name, id, ?, ?, ? FROM barangays WHERE name = ?', [description, 'Private precise address', owner.id, status, 'pothole', 'Villamonte']))[0].insertId;
    }
    const legacyReport = await report();
    const [legacy] = await pool.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) SELECT barangay_id, submitted_by, ?, id, ?, ? FROM reports WHERE id = ?', ['Legacy public content', randomUUID(), 'a'.repeat(64), legacyReport]);
    await t.test('forward, legacy preservation, rollback and reapplication do not modify existing reports or posts', async () => {
      const migration = await runner.readMigration('011_community_publication.sql');
      for (const sql of migration.statements) await pool.query(sql);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_publication_legacy'))[0][0].total, 1);
      assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_publication_requests'))[0][0].total, 0);
      const rollback = await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/011_community_publication.sql', 'utf8');
      for (const sql of runner.parseStatements(rollback)) await pool.query(sql);
      assert.equal((await pool.query('SELECT body FROM community_posts'))[0][0].body, 'Legacy public content');
      for (const sql of migration.statements) await pool.query(sql);
      assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [legacyReport]))[0][0].status, 'pending');
    });
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    await t.test('migration 012 preserves existing rows and safely rolls back before new jurisdiction data is used', async () => {
      const beforeReports = (await pool.query('SELECT * FROM reports ORDER BY id'))[0];
      const beforePosts = (await pool.query('SELECT * FROM community_posts ORDER BY id'))[0];
      const forward = await runner.readMigration('012_pending_publication_jurisdiction.sql');
      const rollback = runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/012_pending_publication_jurisdiction.sql', 'utf8'));
      for (const sql of forward.statements) await pool.query(sql);
      const column = (await pool.query("SHOW COLUMNS FROM community_publication_requests LIKE 'barangay_id'"))[0][0];
      assert.equal(column.Null, 'YES');
      const connection = await pool.getConnection();
      try { for (const sql of rollback) await connection.query(sql); }
      finally { connection.release(); }
      assert.equal((await pool.query("SHOW COLUMNS FROM community_publication_requests LIKE 'barangay_id'"))[0][0].Null, 'NO');
      for (const sql of forward.statements) await pool.query(sql);
      assert.deepEqual((await pool.query('SELECT * FROM reports ORDER BY id'))[0], beforeReports);
      assert.deepEqual((await pool.query('SELECT * FROM community_posts ORDER BY id'))[0], beforePosts);
    });
    process.env.UPLOAD_DIR = path.join(directory, 'uploads'); process.env.STORAGE_DRIVER = 'local';
    for (const file of (await runner.listMigrationFiles()).filter(name => name > '012_pending_publication_jurisdiction.sql')) {
      for (const sql of (await runner.readMigration(file)).statements) await pool.query(sql);
    }
    require('../../server/infrastructure/database').useTestDatabase(adapter);
    await setFixtureResidency(owner.username, 'Villamonte', adapter);
    const app = require('../../server/app');
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function login(actor) {
      const response = await fetch(`${base}/api/auth/${actor.role}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: actor.username, password: 'FixturePass123!' }) });
      assert.equal(response.status, 200); Object.assign(actor, await response.json());
    }
    for (const actor of [owner, neighbor, outside, admin, second, official, outsideOfficial]) await login(actor);
    async function request(route, actor = owner, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    }
    const community = '/api/community';
    const moderation = id => `/api/admin/community-publications/${id}`;
    let reportId, pending, post;
    await t.test('missing publication setup fails closed with actionable 503 responses on both endpoints', async () => {
      await pool.query('RENAME TABLE community_publication_requests TO publication_requests_temporarily_unavailable');
      try {
        for (const [route, actor] of [[community + '/posts', owner], [moderation(legacyReport), admin]]) {
          const result = await request(route, actor);
          assert.equal(result.status, 503);
          assert.equal(result.data.code, 'COMMUNITY_SETUP_REQUIRED');
          assert.doesNotMatch(JSON.stringify(result.data), /community_publication_requests|SELECT|community_isolated/);
        }
        assert.equal((await request(community + '/posts', null)).status, 401);
        assert.equal((await request(moderation(legacyReport), owner)).status, 403);
      } finally {
        await pool.query('RENAME TABLE publication_requests_temporarily_unavailable TO community_publication_requests');
      }
      assert.equal((await request(community + '/posts', owner)).status, 200);
    });
    await t.test('concurrent citizen requests persist one pending request with zero new posts and no public event', async () => {
      reportId = await report();
      const events = require('../../server/infrastructure/events/notificationEvents');
      const received = [];
      const stop = events.subscribeCommunity(owner.user.barangayId, event => received.push(event));
      try {
        const input = { reportId, body: 'Public fictional hazard', requestKey: randomUUID(), state: 'approved', assigned_admin_id: owner.id };
        const responses = await Promise.all(Array.from({ length: 5 }, () => request(community + '/posts', owner, 'POST', input)));
        assert.ok(responses.every(row => row.status === 201), JSON.stringify(responses));
        assert.equal(responses.filter(row => row.data.created).length, 1);
        pending = responses[0].data.publication;
        assert.equal(pending.state, 'pending_approval');
        assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_publication_requests'))[0][0].total, 1);
        assert.equal((await pool.query('SELECT COUNT(*) AS total FROM community_posts'))[0][0].total, 1);
        assert.deepEqual(received, []);
        assert.equal((await request(community + '/posts')).data.posts.length, 1);
        assert.equal((await request(community + '/posts', neighbor)).data.posts[0].id, legacy.insertId);
        assert.equal((await request(community + '/posts', owner, 'POST', { ...input, body: 'Tampered retry' })).status, 409);
        assert.equal((await request(community + '/posts', owner, 'POST', { ...input, requestKey: randomUUID() })).status, 409);
      } finally { stop(); }
    });
    await t.test('roles, ownership and barangay authorization reject direct bypass and private resource access', async () => {
      for (const actor of [owner, neighbor, official, outsideOfficial]) {
        assert.equal((await request('/api/admin/community-publications', actor)).status, 403);
        assert.equal((await request(moderation(reportId) + '/decision', actor, 'POST', { state: 'approved', version: pending.version })).status, 403);
        assert.equal((await request(moderation(reportId) + '/assign', actor, 'POST')).status, 403);
      }
      for (const actor of [neighbor, outside]) assert.equal((await request(community + '/posts', actor, 'POST', { reportId, requestKey: randomUUID() })).status, 403);
      assert.equal((await request(`/api/reports/${reportId}`, outsideOfficial)).status, 403);
      assert.equal((await request(`/api/reports/${reportId}`, neighbor)).status, 403);
      assert.equal((await request(community + '/posts', owner, 'POST', { body: 'Unlinked bypass', requestKey: randomUUID() })).status, 400);
      assert.equal((await request('/api/admin/community-publications', null)).status, 401);
    });
    await t.test('only assigned reviewer decides; conflicting concurrent decisions create one post and one notification', async () => {
      const detail = (await request(moderation(reportId), admin)).data.publication;
      assert.equal(detail.assignedToMe, true);
      const reportClock = require('../../server/infrastructure/database/reportClock');
      const stored = (await pool.execute('SELECT requested_at FROM community_publication_requests WHERE report_id = ?', [reportId]))[0][0];
      assert.equal(detail.requestedAt, reportClock.utc(stored.requested_at, await reportClock.offsetMinutes(adapter)));
      assert.equal((await request(moderation(reportId) + '/decision', second, 'POST', { state: 'approved', version: detail.version })).status, 403);
      assert.equal((await request(moderation(reportId) + '/assign', second, 'POST')).status, 409);
      const responses = await Promise.all(Array.from({ length: 4 }, () => request(moderation(reportId) + '/decision', admin, 'POST', { state: 'approved', version: detail.version })));
      assert.equal(responses.filter(row => row.status === 200).length, 1);
      assert.equal(responses.filter(row => row.status === 409).length, 3);
      post = responses.find(row => row.status === 200).data.publication.postId;
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [reportId]))[0][0].total, 1);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM notifications WHERE report_id = ? AND user_id = ?', [reportId, owner.id]))[0][0].total, 1);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM notifications WHERE report_id = ? AND title = ?', [reportId, 'New post awaiting approval']))[0][0].total, 1);
      assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [reportId]))[0][0].status, 'pending');
      const visible = await request(`${community}/posts/${post}`, neighbor);
      assert.equal(visible.status, 200);
      assert.doesNotMatch(JSON.stringify(visible), /publication_owner|Private|requested_by|assigned_admin|reviewed_by|storage_reference|latitude|longitude/);
      assert.equal((await request(`${community}/posts/${post}`, owner, 'PATCH', { body: 'Unreviewed replacement' })).status, 409);
      assert.equal((await request(`${community}/posts/${post}`, outside)).status, 200);
    });
    await t.test('publication outcomes notify only the citizen after a committed decision', async () => {
      const events = require('../../server/infrastructure/events/notificationEvents');
      const id = await report();
      const created = await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() });
      const row = (await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
      const actor = row.assigned_admin_id === admin.id ? admin : second;
      const own = [], other = [];
      const stops = [events.subscribe(owner.id, event => own.push(event)), events.subscribe(neighbor.id, event => other.push(event))];
      try {
        assert.equal((await request(moderation(id) + '/decision', actor, 'POST', { state: 'rejected', version: created.data.publication.version, reason: 'Fictional sensitive address removed before sharing.' })).status, 200);
        assert.equal(own.length, 1); assert.deepEqual(other, []);
        assert.equal(own[0].title, 'Community publication rejected');
        assert.equal(own[0].reportId, id);
        assert.doesNotMatch(JSON.stringify(own), /reviewer|assigned_admin|password|token/);
        assert.equal((await request('/api/notifications', owner)).data.notifications.filter(item => item.reportId === id).length, 1);
      } finally { stops.forEach(stop => stop()); }
    });
    await t.test('rejection requires reason; owner sees outcome, controlled resubmission and reassignment are auditable', async () => {
      const id = await report();
      const created = await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() });
      const queue = await request('/api/admin/community-publications', admin);
      const assigned = queue.data.requests.find(row => row.reportId === id).assignedToMe ? admin : second;
      const version = created.data.publication.version;
      assert.equal((await request(moderation(id) + '/decision', assigned, 'POST', { state: 'rejected', version, reason: ' ' })).status, 400);
      assert.equal((await request(moderation(id) + '/decision', assigned, 'POST', { state: 'rejected', version, reason: 'Remove private details.' })).status, 200);
      const own = (await request(community + '/publication-requests')).data.requests.find(row => row.reportId === id);
      assert.equal(own.reason, 'Remove private details.');
      const notices = (await pool.execute('SELECT message FROM notifications WHERE report_id = ? AND user_id = ?', [id, owner.id]))[0];
      assert.equal(notices.length, 1); assert.match(notices[0].message, /Remove private details/);
      assert.equal((await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() })).status, 409);
      const retried = await request(community + '/posts', owner, 'POST', { reportId: id, body: 'Reviewed public description', requestKey: randomUUID(), version: own.version });
      assert.equal(retried.status, 201);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [id]))[0][0].total, 0);
      const assignedRow = (await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
      const suspended = assignedRow.assigned_admin_id === admin.id ? admin : second;
      const available = suspended === admin ? second : admin;
      await pool.execute("UPDATE users SET status = 'suspended' WHERE id = ?", [suspended.id]);
      assert.equal((await request(moderation(id) + '/decision', suspended, 'POST', { state: 'approved', version: retried.data.publication.version })).status, 401);
      assert.equal((await request(moderation(id) + '/assign', available, 'POST')).status, 200);
      assert.equal((await pool.execute("SELECT COUNT(*) AS total FROM audit_logs WHERE action LIKE 'community_publication_assigned_%'"))[0][0].total, 1);
      await pool.execute("UPDATE users SET status = 'active' WHERE id = ?", [suspended.id]);
    });
    await t.test('notification failure rolls back publication, decision and realtime delivery', async () => {
      const id = await report();
      const created = await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() });
      const row = (await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
      const actor = row.assigned_admin_id === admin.id ? admin : second;
      const notifications = require('../../server/infrastructure/repositories/notification.repository');
      const original = notifications.create;
      const events = require('../../server/infrastructure/events/notificationEvents'), received = [];
      const stop = events.subscribeCommunity(owner.user.barangayId, event => received.push(event));
      notifications.create = async () => { throw new Error('Isolated notification write failure'); };
      try { assert.equal((await request(moderation(id) + '/decision', actor, 'POST', { state: 'approved', version: created.data.publication.version })).status, 500); }
      finally { notifications.create = original; stop(); }
      assert.equal((await pool.execute('SELECT state FROM community_publication_requests WHERE report_id = ?', [id]))[0][0].state, 'pending_approval');
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [id]))[0][0].total, 0);
      assert.deepEqual(received, []);
    });
    await t.test('no active reviewer leaves a private unassigned request until transactional reassignment', async () => {
      await pool.query("UPDATE users SET status = 'suspended' WHERE role = 'admin'");
      const id = await report();
      const result = await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() });
      assert.equal(result.status, 201);
      assert.equal((await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0].assigned_admin_id, null);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [id]))[0][0].total, 0);
      await pool.query("UPDATE users SET status = 'active' WHERE role = 'admin'");
      const attempts = await Promise.all([request(moderation(id) + '/assign', admin, 'POST'), request(moderation(id) + '/assign', second, 'POST')]);
      assert.deepEqual(attempts.map(row => row.status).sort(), [200, 409]);
    });
    await t.test('three attempts retain rejection history and full length reasons without changing operational status', async () => {
      const id = await report('Resubmission policy fixture', 'ongoing');
      let version;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const created = await request(community + '/posts', owner, 'POST', { reportId: id, body: `Public attempt ${attempt}`, requestKey: randomUUID(), ...(version ? { version } : {}) });
        assert.equal(created.status, 201);
        const row = (await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
        const actor = row.assigned_admin_id === admin.id ? admin : second;
        const result = await request(moderation(id) + '/decision', actor, 'POST', { state: 'rejected', version: created.data.publication.version, reason: 'x'.repeat(500) });
        assert.equal(result.status, 200);
        version = result.data.publication.version;
      }
      assert.equal((await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID(), version })).status, 409);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_publication_reviews review JOIN community_publication_requests request ON request.id = review.request_id WHERE request.report_id = ?', [id]))[0][0].total, 3);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM notifications WHERE report_id = ? AND CHAR_LENGTH(message) = 500', [id]))[0][0].total, 3);
      assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [id]))[0][0].status, 'ongoing');
    });
    await t.test('unapproved directly inserted citizen posts are hidden from list, detail, media and engagement endpoints', async () => {
      const id = await report();
      const [inserted] = await pool.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) SELECT barangay_id, submitted_by, ?, id, ?, ? FROM reports WHERE id = ?', ['Unauthorized direct insert', randomUUID(), 'b'.repeat(64), id]);
      const direct = inserted.insertId;
      assert.ok(!(await request(community + '/posts')).data.posts.some(row => row.id === direct));
      for (const suffix of ['', '/comments', '/report', '/media/1']) assert.equal((await request(`${community}/posts/${direct}${suffix}`)).status, 404);
      assert.equal((await request(`${community}/posts/${direct}/reaction`, owner, 'PUT', { reaction: 'like' })).status, 404);
      assert.equal((await request(`${community}/posts/${direct}/comments`, owner, 'POST', { body: 'Hidden', requestKey: randomUUID() })).status, 404);
    });
    await t.test('comments, nested replies, stable pseudonyms, desired-state likes and public endpoint isolation persist', async () => {
      const make = async (actor, body, parentCommentId = null) => {
        const result = await request(`${community}/posts/${post}/comments`, actor, 'POST', { body, parentCommentId, requestKey: randomUUID() });
        assert.equal(result.status, 200); return result.data.comment;
      };
      const root = await make(owner, 'Fictional root'), child = await make(neighbor, 'Fictional reply', root.id), grandchild = await make(owner, 'Nested reply', child.id);
      for (let i = 0; i < 6; i++) await make(neighbor, `Additional root ${i}`);
      const page = await request(`${community}/posts/${post}/comments?pageSize=5`);
      assert.equal(page.data.comments.filter(row => !row.parentId).length, 5);
      assert.equal(page.data.comments.find(row => row.id === grandchild.id).parentId, child.id);
      assert.equal(page.data.comments.find(row => row.id === grandchild.id).author.pseudonym, page.data.comments.find(row => row.id === root.id).author.pseudonym);
      const likes = await Promise.all(Array.from({ length: 8 }, () => request(`${community}/posts/${post}/reaction`, neighbor, 'PUT', { reaction: 'like' })));
      assert.ok(likes.every(row => row.status === 200));
      assert.equal((await request(`${community}/posts/${post}`)).data.reactions.total, 1);
      await request(`${community}/posts/${post}/reaction`, neighbor, 'PUT', { reaction: null });
      assert.equal((await request(`${community}/posts/${post}`)).data.reactions.total, 0);
      for (const suffix of ['', '/comments', '/report']) assert.equal((await request(`${community}/posts/${post}${suffix}`, outsideOfficial)).status, 200);
      assert.equal((await request(`${community}/posts/${post}/media/1`, outsideOfficial)).status, 404);
    });
    const staticApp = express();
    staticApp.use(['/shared', '/frontend/shared'], express.static(path.resolve('shared')));
    staticApp.use('/frontend', express.static(path.resolve('frontend')));
    frontend = await new Promise(resolve => { const listener = staticApp.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = `http://127.0.0.1:${frontend.address().port}/frontend`;
    browser = await chromium.launch();
    const screenshotDir = path.resolve('.data/publication-screenshots'); await fs.mkdir(screenshotDir, { recursive: true });
    const context = async actor => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(({ base, actor }) => {
        Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} });
        sessionStorage.setItem('up_session', JSON.stringify({ ...actor.user, apiToken: actor.token }));
      }, { base, actor });
      return context;
    };
    await t.test('report API automatically queues review and assigned Admin opens approval from the persisted notification', async () => {
      const services = require('../../server/composition');
      t.mock.method(services.damageDetectionService, 'detectForReport', async () => null);
      t.mock.method(services.damageDetectionService, 'verifyReportImages', async () => null);
      async function submit(overrides = {}) {
        const form = new FormData();
        for (const [key, value] of Object.entries({ description: 'Automatic publication fixture', barangay: 'Villamonte', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15',
          gpsFixAt: freshReportFixAt(), requestCommunityPublication: 'false', publicationState: 'approved', assignedAdminId: String(owner.id), ...overrides })) form.append(key, value);
        form.append('images', new File([PNG_BYTES], 'automatic-1.png', { type: 'image/png' }));
        form.append('images', new File([JPEG_BYTES], 'automatic-2.jpg', { type: 'image/jpeg' }));
        const response = await fetch(base + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
        return { status: response.status, data: await response.json() };
      }
      const counts = async () => ({
        reports: (await pool.query('SELECT COUNT(*) AS total FROM reports'))[0][0].total,
        requests: (await pool.query('SELECT COUNT(*) AS total FROM community_publication_requests'))[0][0].total,
        notifications: (await pool.query('SELECT COUNT(*) AS total FROM notifications'))[0][0].total,
        files: (await fs.readdir(process.env.UPLOAD_DIR)).sort()
      });
      const before = await counts();
      await pool.query("CREATE TRIGGER fail_review_notification BEFORE INSERT ON notifications FOR EACH ROW BEGIN IF NEW.title = 'New post awaiting approval' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Isolated notification failure'; END IF; END");
      try {
        const failed = await submit(); assert.equal(failed.status, 500);
        assert.deepEqual(await counts(), before);
      } finally { await pool.query('DROP TRIGGER fail_review_notification'); }
      const saved = await submit();
      assert.equal(saved.status, 201, JSON.stringify(saved.data));
      assert.equal(saved.data.status, 'pending');
      assert.equal(saved.data.publication.state, 'pending_approval');
      const id = saved.data.id;
      const row = (await pool.execute('SELECT * FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
      assert.notEqual(row.assigned_admin_id, owner.id);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_publication_media WHERE request_id = ?', [row.id]))[0][0].total, 2);
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [id]))[0][0].total, 0);
      const reviewer = row.assigned_admin_id === admin.id ? admin : second;
      const otherAdmin = reviewer === admin ? second : admin;
      const reviewNotifications = await request('/api/notifications?limit=100', reviewer);
      const notice = reviewNotifications.data.notifications.find(item => item.reportId === id && item.title === 'New post awaiting approval');
      assert.ok(notice);
      assert.equal((await request('/api/notifications?limit=100', otherAdmin)).data.notifications.some(item => item.reportId === id), false);
      assert.equal((await request('/api/notifications?limit=100', neighbor)).data.notifications.some(item => item.reportId === id), false);
      assert.equal((await request(`${community}/posts`, owner, 'POST', { reportId: id, body: 'Duplicate publication', requestKey: randomUUID() })).status, 409);
      const adminContext = await context(reviewer), page = await adminContext.newPage();
      await page.goto(`${url}/admin.html#overview`);
      const queueBefore = (await request('/api/admin/community-publications', reviewer)).data;
      await expect(page.locator('#statPendingPosts')).toHaveText(String(queueBefore.pendingCount));
      await expect(page.locator('#adminActivityBadge')).toHaveText(String(reviewNotifications.data.unreadCount));
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
        for (const width of [1920, 1671, 1440, 1280, 1024, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const cards = await page.locator('[data-report-summary="admin"] > .portal-report-stat').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { y: box.y, width: box.width, height: box.height }; }));
          assert.equal(cards.length, 6);
          const columns = width <= 600 ? 2 : width <= 1100 ? 3 : 6;
          assert.ok(cards.every((box, index) => {
            const first = cards[Math.floor(index / columns) * columns];
            return Math.abs(box.y - first.y) < 1 && Math.abs(box.width - first.width) < 1 && Math.abs(box.height - first.height) < 1;
          }), JSON.stringify({ theme, width, cards }));
          await page.screenshot({ path: path.join(screenshotDir, `pending-posts-summary-${theme}-${width}.png`), fullPage: true });
          const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('main, header, .admin-stats, #overviewSection, .admin-analytics, .admin-overview')].map(node => ({ class: node.className, x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width, scroll: node.scrollWidth })) }));
          assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
        }
      }
      await page.locator('#adminActivityBell').click();
      const link = page.locator(`#adminActivityList a[data-read-report="notification:${notice.id}"]`);
      await expect(link).toContainText('Pending Community Review');
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const popover = await page.locator('#adminActivityPopover').boundingBox();
        assert.ok(popover.x >= 0 && popover.x + popover.width <= width + 1);
        await page.screenshot({ path: path.join(screenshotDir, `automatic-admin-notification-${width}.png`), fullPage: true });
      }
      await link.click();
      const dialog = page.locator('#adminReportDialog');
      await expect(dialog.locator('.rd-publication')).toContainText('Assigned to you');
      await expect.poll(async () => (await request('/api/notifications?limit=100', reviewer)).data.notifications.find(item => item.id === notice.id)?.readAt).toBeTruthy();
      await dialog.getByRole('button', { name: 'Approve & Publish', exact: true }).click();
      await page.locator('.portal-confirm').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal((await request(moderation(id), reviewer)).data.publication.state, 'pending_approval');
      await dialog.getByRole('button', { name: 'Approve & Publish', exact: true }).click();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await page.locator('.portal-confirm').getByRole('button', { name: 'Approve & Publish', exact: true }).click();
      await expect(dialog.locator('.rd-publication')).toContainText('Published to Community Feed');
      assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [id]))[0][0].status, 'pending');
      const feed = await request(`${community}/posts`, neighbor);
      assert.ok(feed.data.posts.some(item => item.linkedReport?.id === id));
      await page.screenshot({ path: path.join(screenshotDir, 'automatic-admin-approved.png'), fullPage: true });
      await adminContext.close();
      const beforeUnresolved = await counts();
      const unresolved = await submit({ barangay: '', latitude: '', longitude: '', gpsAccuracy: '' });
      assert.equal(unresolved.status, 400);
      assert.equal(unresolved.data.code, 'REPORT_LOCATION_RETRY');
      assert.deepEqual(await counts(), beforeUnresolved);
      const { insertId: unknownId } = await adapter.execute(
        'INSERT INTO reports (description, barangay, submitted_by, status) VALUES (?, ?, ?, ?)',
        ['Legacy report with an unresolved location', '', owner.id, 'pending']);
      const queued = await request(community + '/posts', owner, 'POST', {
        reportId: unknownId, requestKey: randomUUID(), body: 'Legacy incident location needs review.'
      });
      assert.equal(queued.status, 201);
      assert.equal((await request(community + '/publication-requests', owner)).data.requests.find(item => item.reportId === unknownId).state, 'pending_approval');
      assert.equal((await pool.execute('SELECT COUNT(*) AS total FROM community_posts WHERE report_id = ?', [unknownId]))[0][0].total, 0);
      const original = (await pool.execute('SELECT * FROM reports WHERE id = ?', [unknownId]))[0][0];
      const review = (await request(moderation(unknownId), admin)).data.publication;
      const assigned = review.assignedToMe ? admin : second;
      assert.equal((await request(moderation(unknownId) + '/decision', assigned, 'POST', { state: 'approved', version: review.version })).status, 400);
      const connection = await pool.getConnection();
      try {
        const rollback = runner.parseStatements(await fs.readFile('server/infrastructure/database/mysql/migrations/rollback/012_pending_publication_jurisdiction.sql', 'utf8'));
        await connection.query(rollback[0]);
        await assert.rejects(connection.query(rollback[1]), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      } finally { await connection.query('DROP TEMPORARY TABLE IF EXISTS migration012_guard'); connection.release(); }
      assert.equal((await request(moderation(unknownId) + '/decision', assigned, 'POST', { state: 'rejected', version: review.version, reason: 'Incident location needs clarification.' })).status, 200);
      assert.deepEqual((await pool.execute('SELECT * FROM reports WHERE id = ?', [unknownId]))[0][0], original);
      const rejected = (await request(community + '/publication-requests', owner)).data.requests.find(item => item.reportId === unknownId);
      const resubmitted = await request(community + '/posts', owner, 'POST', { reportId: unknownId, requestKey: randomUUID(), version: rejected.version, body: 'Clarified fictional incident.' });
      assert.equal(resubmitted.status, 201, JSON.stringify(resubmitted));
      const currentReview = (await request(moderation(unknownId), admin)).data.publication;
      const resolver = currentReview.assignedToMe ? admin : second;
      const wrongAdmin = resolver === admin ? second : admin;
      const barangay = (await pool.execute('SELECT id FROM barangays WHERE name = ?', ['Mandalagan']))[0][0];
      const change = { version: currentReview.version, barangayId: barangay.id };
      for (const actor of [owner, official, wrongAdmin]) assert.equal((await request(moderation(unknownId), actor, 'PATCH', change)).status, 403);
      assert.equal((await request(moderation(unknownId), resolver, 'PATCH', { ...change, barangayId: 999999 })).status, 403);
      assert.equal((await request(moderation(unknownId), resolver, 'PATCH', change)).status, 403);
      await pool.execute("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'report:assign-jurisdiction')", [resolver.id]);
      const secureChange = { barangayId: barangay.id, expectedRoutingVersion: 0, reason: 'Jurisdiction requires verified original GPS and boundary evidence.', evidenceImageIds: [], requestKey: randomUUID() };
      assert.equal((await request(moderation(unknownId), resolver, 'PATCH', secureChange)).status, 400);
      assert.deepEqual((await pool.execute('SELECT * FROM reports WHERE id = ?', [unknownId]))[0][0], original);
      const ready = (await request(moderation(unknownId), resolver)).data.publication;
      assert.equal(ready.history.length, 1);
      assert.equal(ready.history[0].reviewerId, assigned.id);
      assert.equal(ready.state, 'pending_approval');
      assert.equal((await request(moderation(unknownId) + '/decision', resolver, 'POST', { state: 'approved', version: ready.version })).status, 400);
    });
    await t.test('real citizen sharing stays pending, assigned Admin approves in existing Report Details and outcome is visible after refresh', async () => {
      const id = await report('Browser publication fixture');
      await pool.execute('UPDATE reports SET latitude = ?, longitude = ?, gps_accuracy = ? WHERE id = ?', [10.6685, 122.9647, 15, id]);
      await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });
      for (const order of [1, 2]) {
        const name = `${randomUUID()}.png`;
        await fs.writeFile(path.join(process.env.UPLOAD_DIR, name), PNG_BYTES);
        await pool.execute('INSERT INTO report_images (report_id, image_path, image_order, mime_type) VALUES (?, ?, ?, ?)', [id, `/uploads/${name}`, order, 'image/png']);
      }
      const citizenContext = await context(owner), page = await citizenContext.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${url}/citizen.html#community`);
      await page.evaluate(() => CommunityFeed.chooseReport());
      const share = page.locator(`[data-share-report-id="${id}"]`);
      await share.click();
      await expect(page.locator('#communitySelectorStatus')).toContainText('Pending Community Review');
      await expect(page.locator('.cf-post').filter({ hasText: 'Browser publication fixture' })).toHaveCount(0);
      const row = (await pool.execute('SELECT assigned_admin_id FROM community_publication_requests WHERE report_id = ?', [id]))[0][0];
      const reviewer = row.assigned_admin_id === admin.id ? admin : second;
      const adminContext = await context(reviewer), adminPage = await adminContext.newPage();
      await adminPage.goto(`${url}/admin.html#reports`);
      await adminPage.locator('[data-admin-filter="community-review"]').click();
      await expect(adminPage.locator('[data-admin-filter="community-review"]')).toHaveAttribute('aria-pressed', 'true');
      await adminPage.locator(`#adminReportsBody [data-review-post="${id}"]`).click();
      const dialog = adminPage.locator('#adminReportDialog');
      await expect(dialog.locator('.rd-publication')).toContainText('Assigned to you');
      for (const theme of ['light', 'dark']) {
        await adminPage.evaluate(theme => PortalTheme.setPreference(theme), theme);
        for (const width of [320, 375, 768, 1440]) {
          await adminPage.setViewportSize({ width, height: 900 });
          await dialog.locator('.rd-publication').scrollIntoViewIfNeeded();
          assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
          for (const button of await dialog.locator('.rd-publication .rd-publication-button').all()) {
            const size = await button.boundingBox(); assert.ok(size.height >= (width <= 600 ? 36 : 44));
            assert.notEqual(await button.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
          }
          await adminPage.screenshot({ path: path.join(screenshotDir, `publication-layout-${theme}-${width}.png`), fullPage: true });
        }
      }
      await adminPage.setViewportSize({ width: 1440, height: 1000 });
      await adminPage.evaluate(() => PortalTheme.setPreference('light'));
      await expect(dialog.locator('.rd-review-section')).toHaveCount(0);
      await expect.poll(() => dialog.locator('.rd-publication-photos img').evaluateAll(images => images.length === 2 && images.every(image => image.naturalWidth > 0 && image.src.startsWith('blob:')))).toBe(true);
      await dialog.getByRole('button', { name: 'Reject Publication', exact: true }).click();
      await expect(dialog.locator('.rd-publication [role=status]')).toHaveText('Enter a meaningful rejection reason (at least 5 characters).');
      await adminPage.screenshot({ path: path.join(screenshotDir, 'admin-pending-light.png'), fullPage: true });
      await adminPage.evaluate(() => PortalTheme.setPreference('dark'));
      await adminPage.screenshot({ path: path.join(screenshotDir, 'admin-pending-dark.png'), fullPage: true });
      await adminPage.evaluate(() => PortalTheme.setPreference('light'));
      await dialog.getByRole('button', { name: 'Approve & Publish', exact: true }).click();
      await adminPage.locator('.portal-confirm').getByRole('button', { name: 'Approve & Publish', exact: true }).click();
      await expect(dialog.locator('.rd-publication')).toContainText('Published to Community Feed');
      await adminPage.screenshot({ path: path.join(screenshotDir, 'admin-approved.png'), fullPage: true });
      await page.reload();
      await expect(page.locator('.cf-post').filter({ hasText: 'Browser publication fixture' })).toHaveCount(1);
      await expect.poll(() => page.locator('.cf-post').filter({ hasText: 'Browser publication fixture' }).locator('img[data-evidence-url]').evaluateAll(images => images.length === 2 && images.every(image => image.naturalWidth > 0))).toBe(true);
      await page.evaluate(async () => { await CitizenNotificationCenter.refresh(); CitizenNotificationCenter.open(); });
      const notification = page.locator(`.notification-item[data-report-id="${id}"]`);
      await expect(notification).toContainText('Community publication approved');
      await notification.click();
      await expect(page).toHaveURL(`${url}/report-details.html?id=${id}`);
      await expect(page.locator('.rd-publication')).toContainText('Published to Community Feed');
      await expect(page.locator('.rd-map.leaflet-container')).toBeVisible();
      await expect(page.locator('.rd-map .leaflet-control-zoom')).toBeVisible();
      await expect(page.locator('.rd-map .leaflet-interactive')).toHaveCount(2);
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(screenshotDir, `citizen-${width}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      await citizenContext.close(); await adminContext.close();
    });
    await t.test('Pending Posts card preserves oldest-first pagination, refresh state and real unread counts independently', async () => {
      for (let index = 0; index < 7; index++) {
        const id = await report(`Queue order fixture ${index}`);
        assert.equal((await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() })).status, 201);
      }
      await pool.execute('INSERT INTO notifications (user_id, report_id, type, title, message) VALUES (?, ?, ?, ?, ?)', [admin.id, legacyReport, 'status_update', 'Separate report update', 'Unrelated to publication review.']);
      const adminContext = await context(admin), page = await adminContext.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const queue = (await request('/api/admin/community-publications', admin)).data;
      const unread = (await request('/api/notifications?limit=100', admin)).data.unreadCount;
      const expected = queue.requests.filter(item => item.state === 'pending_approval').sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt) || a.reportId - b.reportId).map(item => item.reportId);
      await page.goto(`${url}/admin.html#overview`);
      await expect(page.locator('#statPendingPosts')).toHaveText(String(queue.pendingCount));
      await expect(page.locator('#adminActivityBadge')).toHaveText(String(unread));
      await page.locator('#pendingPostsCard').click();
      await expect(page).toHaveURL(/#reports\?view=community-review$/);
      await expect(page.locator('[data-admin-filter="community-review"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#adminClearFiltersBtn')).toBeEnabled();
      const visibleIds = () => page.locator('#adminReportsBody .report-cell-actions a').evaluateAll(nodes => nodes.map(node => Number(new URL(node.href).searchParams.get('id'))));
      await expect.poll(visibleIds).toEqual(expected.slice(0, 5));
      await page.locator('#reportsNext').click();
      await expect.poll(visibleIds).toEqual(expected.slice(5, 10));
      await page.reload();
      await expect(page.locator('[data-admin-filter="community-review"]')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(visibleIds).toEqual(expected.slice(5, 10));
      await page.locator('#adminActivityBell').click();
      await page.locator('#adminActivityMarkAll').click();
      await expect(page.locator('#adminActivityBadge')).toBeHidden();
      assert.equal((await request('/api/notifications?limit=100', admin)).data.unreadCount, 0);
      assert.equal((await request('/api/admin/community-publications', admin)).data.pendingCount, queue.pendingCount);
      await page.reload();
      await expect(page.locator('#adminActivityBadge')).toBeHidden();
      await page.route('**/api/notifications?limit=100', route => route.fulfill({ status: 503, json: { error: 'Isolated notification outage' } }));
      await page.reload();
      await expect(page.locator('#statPendingPosts')).toHaveText(String(queue.pendingCount));
      await page.locator('#adminActivityBell').click();
      await expect(page.locator('#adminActivityList')).toContainText('Notifications could not be refreshed.');
      await page.unroute('**/api/notifications?limit=100');
      await page.route('**/api/admin/community-publications', route => route.fulfill({ status: 503, json: { error: 'Isolated queue outage' } }));
      await page.reload();
      await expect(page.locator('#statPendingPosts')).toHaveText('Unavailable');
      await expect(page.locator('#adminReportsBody')).toContainText('Pending posts could not be loaded.');
      await page.unroute('**/api/admin/community-publications');
      await page.evaluate(() => openPendingPosts());
      await expect(page.locator('#statPendingPosts')).toHaveText(String(queue.pendingCount));
      await page.route('**/api/admin/community-publications', async route => {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ status: 200, json: { requests: [], pendingCount: 0 } });
      });
      await page.route('**/api/reports?publication=pending_approval', route => route.fulfill({ json: { reports: [], stats: {} } }));
      await page.evaluate(() => { loadPublicationQueue(); });
      await expect(page.locator('#pendingPostsCard')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#statPendingPosts')).toHaveText('0');
      await expect(page.locator('#adminReportsBody')).toContainText('No pending posts awaiting review.');
      await expect(page.locator('#pendingPostsCard')).toHaveAttribute('aria-busy', 'false');
      await page.unroute('**/api/admin/community-publications');
      await page.unroute('**/api/reports?publication=pending_approval');
      assert.deepEqual(errors, []);
      await adminContext.close();
    });
    await t.test('server-filtered review membership and Excel scope remain independent of operational status', async () => {
      const id = await report('Mode scope fixture', 'resolved');
      await pool.execute('UPDATE reports SET created_at = ? WHERE id = ?', ['2020-01-01 12:00:00', id]);
      assert.equal((await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() })).status, 201);
      const pending = await request('/api/reports?publication=pending_approval', admin);
      assert.equal(pending.status, 200);
      assert.ok(pending.data.reports.some(row => row.id === id && row.status === 'resolved'));
      assert.ok(!pending.data.reports.some(row => row.id === reportId || row.id === legacyReport));
      for (const actor of [owner, official, outsideOfficial]) {
        assert.equal((await request('/api/reports?publication=pending_approval', actor)).status, 403);
        assert.equal((await request('/api/reports/export?publication=pending_approval', actor)).status, 403);
      }
      assert.equal((await request('/api/reports?publication=approved', admin)).status, 400);
      const response = await fetch(base + '/api/reports/export?publication=pending_approval&search=Mode%20scope', { headers: { Authorization: `Bearer ${admin.token}` } });
      assert.equal(response.status, 200);
      const Excel = require('exceljs'), book = new Excel.Workbook();
      await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
      assert.equal(book.getWorksheet('Reports').rowCount, 2);
      assert.equal(book.getWorksheet('Reports').getCell('A2').value, `RPT-${id}`);
      const review = (await request(moderation(id), admin)).data.publication;
      const reviewer = review.assignedToMe ? admin : second;
      assert.equal((await request(moderation(id) + '/decision', reviewer, 'POST', { state: 'rejected', version: review.version, reason: 'Fictional moderation regression reason.' })).status, 200);
      assert.ok(!(await request('/api/reports?publication=pending_approval', admin)).data.reports.some(row => row.id === id));
      assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [id]))[0][0].status, 'resolved');
    });
    await t.test('shared Admin and Barangay controls support separate dialogs, views and responsive themes', async () => {
      const adminContext = await context(admin), adminPage = await adminContext.newPage();
      await adminPage.goto(`${url}/admin.html#reports`);
      await expect(adminPage.locator('.report-management[data-role="admin"]')).toBeVisible();
      await expect(adminPage.locator('#adminReportsTitle')).toHaveText('All Reports');
      const details = adminPage.locator('#adminReportsBody .view-btn').first();
      await details.click();
      await expect(adminPage.locator('#reportDetails .rd-review-section')).toBeVisible();
      await expect(adminPage.locator('#reportDetails .rd-publication')).toHaveCount(0);
      await adminPage.locator('#backToReports').click();
      await adminPage.locator('[data-admin-filter="community-review"]').click();
      await expect(adminPage.locator('#adminReportsTitle')).toHaveText('Community Publication Review');
      const input = adminPage.locator('#adminSearch');
      await input.fill('Queue order fixture');
      await expect.poll(() => adminPage.locator('#adminReportsBody .report-cell-actions').count()).toBe(5);
      await adminPage.locator('#adminClearFiltersBtn').click();
      await expect(input).toHaveValue('');
      await expect(adminPage.locator('#adminFilterSort')).toHaveValue('oldest');
      await expect(adminPage.locator('[data-admin-filter="community-review"]')).toHaveAttribute('aria-pressed', 'true');
      await adminPage.locator('#adminViewToggle [data-view-mode="grid"]').click();
      await expect(adminPage.locator('#adminReportCards .report-card').first()).toBeVisible();
      await adminPage.locator('#adminViewToggle [data-view-mode="split"]').click();
      await adminPage.locator('#adminReportCards [data-action="review"]').first().click();
      await expect(adminPage.locator('.rm-detail-pane .rd-publication')).toBeVisible();
      await expect(adminPage.locator('dialog[open]')).toHaveCount(0);
      assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await adminPage.screenshot({ path: path.join(screenshotDir, 'report-management-admin-split.png'), fullPage: true });
      await adminPage.locator('#adminViewToggle [data-view-mode="row"]').click();
      await adminPage.locator('#adminReportsBody [data-review-post]').first().click();
      await expect(adminPage.locator('#adminReportDialog .rd-publication')).toBeVisible();
      await expect(adminPage.locator('#adminReportDialog .rd-review-section')).toHaveCount(0);
      await adminPage.locator('#adminReportDialog [data-report-dialog-close]').click();
      await adminPage.locator('[data-admin-filter="all"]').click();
      let entered, release, finished;
      const observed = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const completed = new Promise(resolve => { finished = resolve; });
      const latePattern = '**/api/reports?publication=pending_approval';
      await adminPage.route(latePattern, async route => {
        entered(); await gate;
        try { await route.fulfill({ json: { reports: [{ id: 999999, description: 'Late review response sentinel', status: 'pending', barangay: 'Villamonte' }] } }); } catch {}
        finished();
      });
      await adminPage.locator('[data-admin-filter="community-review"]').click();
      await observed;
      await adminPage.locator('[data-admin-filter="all"]').click();
      release(); await completed;
      await expect(adminPage.locator('#adminReportsTitle')).toHaveText('All Reports');
      await expect(adminPage.locator('#adminReportsBody')).not.toContainText('Late review response sentinel');
      await adminPage.unroute(latePattern);
      await adminPage.locator('[data-admin-filter="community-review"]').click();
      await expect(adminPage.locator('#adminReportsBody [data-review-post]').first()).toBeVisible();
      const officialContext = await context(official), officialPage = await officialContext.newPage();
      await officialPage.goto(`${url}/barangay.html`);
      await expect(officialPage.locator('.report-management[data-role="barangay"]')).toBeVisible();
      await expect(officialPage.locator('[data-review-post], [data-admin-filter="community-review"]')).toHaveCount(0);
      await expect(officialPage.locator('#reportsBody .report-card').first()).toBeVisible();
      await officialPage.locator('#barangayViewToggle [data-view-mode="split"]').click();
      await officialPage.locator('#reportsBody .report-card-title').first().click();
      await expect(officialPage.locator('.rm-detail-pane .rd-review-section')).toBeVisible();
      await expect(officialPage.locator('.rd-publication')).toHaveCount(0);
      assert.equal(await officialPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await officialPage.screenshot({ path: path.join(screenshotDir, 'report-management-barangay-split.png'), fullPage: true });
      await officialPage.locator('#barangayViewToggle [data-view-mode="row"]').click();
      for (const page of [adminPage, officialPage]) {
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
          for (const width of [375, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await expect.poll(() => page.locator('.rm-tabs').evaluate(tabs => { const active = tabs.querySelector('[aria-pressed="true"]'); if (!active) return { visible: false }; const a = active.getBoundingClientRect(), b = tabs.getBoundingClientRect(); return { visible: a.left >= b.left - 1 && a.right <= b.right + 1, label: active.textContent, left: a.left, right: a.right, start: b.left, end: b.right }; })).toMatchObject({ visible: true });
            if (page === adminPage) {
              await expect(page.locator(width <= 900 ? '#adminReportCards .report-card' : '#adminReportsBody [data-review-post]').first()).toBeVisible();
              if (width > 900) assert.equal(await page.locator('#reportsSection thead th').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
            }
            await page.screenshot({ path: path.join(screenshotDir, `report-management-${page === adminPage ? 'admin' : 'barangay'}-${theme}-${width}.png`), fullPage: true });
          }
        }
      }
      await adminContext.close(); await officialContext.close();
    });
    await t.test('review decisions update the active queue and card without deleting operational reports', async () => {
      for (const decision of ['approved', 'rejected']) {
        const id = await report(`UI mode decision ${decision}`, 'ongoing');
        const created = await request(community + '/posts', owner, 'POST', { reportId: id, requestKey: randomUUID() });
        assert.equal(created.status, 201);
        const detail = (await request(moderation(id), admin)).data.publication;
        const actor = detail.assignedToMe ? admin : second;
        const before = (await request('/api/admin/community-publications', actor)).data.pendingCount;
        const actorContext = await context(actor), page = await actorContext.newPage();
        await page.goto(`${url}/admin.html#reports?view=community-review`);
        await page.locator('#adminSearch').fill(`UI mode decision ${decision}`);
        const review = page.locator(`#adminReportsBody [data-review-post="${id}"]`);
        await review.click();
        const modal = page.locator('#adminReportDialog');
        if (decision === 'approved') {
          await modal.getByRole('button', { name: 'Approve & Publish', exact: true }).click();
          await page.locator('.portal-confirm').getByRole('button', { name: 'Approve & Publish', exact: true }).click();
          await expect(modal.locator('.rd-publication')).toContainText('Published to Community Feed');
        } else {
          await modal.locator('.rd-publication textarea').fill('Public preview requires clarification.');
          await modal.getByRole('button', { name: 'Reject Publication', exact: true }).click();
          await expect(modal.locator('.rd-publication')).toContainText('Publication Rejected');
        }
        await expect(page.locator('#statPendingPosts')).toHaveText(String(before - 1));
        await expect(review).toHaveCount(0);
        await expect(page.locator('[data-admin-filter="community-review"]')).toHaveAttribute('aria-pressed', 'true');
        assert.equal((await pool.execute('SELECT status FROM reports WHERE id = ?', [id]))[0][0].status, 'ongoing');
        await modal.locator('[data-report-dialog-close]').click();
        await page.locator('[data-admin-filter="all"]').click();
        await expect(page).toHaveURL(/#reports$/);
        await expect(page.locator('#adminReportsTitle')).toHaveText('All Reports');
        await actorContext.close();
      }
    });
    await t.test('feed and publication error layouts recover on retry without hiding setup failures', async () => {
      const citizenContext = await context(owner), page = await citizenContext.newPage();
      const error = { error: 'Community publication is temporarily unavailable. An administrator must complete the database setup.', code: 'COMMUNITY_SETUP_REQUIRED' };
      const feedPattern = '**/api/community/posts?*';
      await page.route(feedPattern, route => route.fulfill({ status: 503, json: error }));
      await page.goto(`${url}/citizen.html#community`);
      await expect(page.locator('.cf-request-error')).toContainText('database setup');
      const retryFeed = page.locator('.cf-retry:not([data-feed-more])');
      await expect(retryFeed).toBeHidden();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
        for (const width of [320, 375, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: path.join(screenshotDir, `feed-setup-${theme}-${width}.png`), fullPage: true });
        }
      }
      await page.unroute(feedPattern);
      await page.route(feedPattern, route => route.fulfill({ status: 503, json: { error: 'Temporary isolated outage' } }), { times: 1 });
      await page.reload();
      await expect(page.locator('.cf-request-error')).toContainText('Temporary isolated outage');
      await retryFeed.click();
      await expect(page.locator('.cf-request-error')).toHaveCount(0);
      await expect(page.locator('.cf-post').first()).toBeVisible();
      await page.route('**/api/community/publication-requests', route => route.fulfill({ status: 503, json: error }));
      await page.goto(`${url}/report-details.html?id=${reportId}`);
      await expect(page.locator('.rd-publication')).toContainText('database setup');
      await expect(page.getByRole('button', { name: 'Retry publication status' })).toHaveCount(0);
      await page.unroute('**/api/community/publication-requests');
      await page.route('**/api/community/publication-requests', route => route.fulfill({ status: 503, json: { error: 'Temporary isolated outage' } }), { times: 1 });
      await page.reload();
      await expect(page.locator('.rd-publication')).toContainText('Temporary isolated outage');
      const retry = page.getByRole('button', { name: 'Retry publication status' });
      await expect(retry).toBeVisible();
      assert.ok((await retry.boundingBox()).height >= 44);
      await retry.click();
      await expect(page.locator('.rd-publication')).toContainText('Published to Community Feed');
      await citizenContext.close();
    });
  } finally {
    if (browser) await browser.close();
    if (frontend) await new Promise(resolve => frontend.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    await database.close();
  }
});
