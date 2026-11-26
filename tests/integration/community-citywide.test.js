const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-community-citywide-${randomUUID()}.sqlite`);
process.env.STORAGE_DRIVER = 'local';

const sqliteHarness = process.env.CITYWIDE_MYSQL ? null : require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
const { PNG_BYTES } = require('../support/image-fixtures');
const { approvePublication } = require('../support/publication');

let server, base, db;
let citizenA, citizenB, citizenC;
let officialVillamonte, officialMandalagan, admin;
let brgyVillamonteId, brgyMandalaganId, brgyGranadaId, brgyTaculingId;
let privateDatabase;

async function request(url, user, method = 'GET', body) {
  return fetch(base + '/api/community' + url, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function register(username, barangay) {
  return seedCitizen({ username, password: 'FixturePass123!', fullName: `Legal Name ${username}`, barangay });
}

async function submitReport(user, description, barangay, barangayId, aiCategory = 'pothole', overrides = {}) {
  const result = await db.execute(
    'INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category, status, latitude, longitude, gps_accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      description,
      `${barangay} Main Road`,
      barangay,
      barangayId,
      user.user.id,
      aiCategory,
      overrides.status || 'pending',
      overrides.latitude || 10.67,
      overrides.longitude || 122.95,
      15
    ]
  );
  return result.insertId;
}

test.before(async () => {
  if (process.env.CITYWIDE_MYSQL) {
    privateDatabase = await require('../support/private-mysql').privateMysql({ diagnostic: value => console.log(value) });
    process.env.UPLOAD_DIR = path.join(privateDatabase.directory, 'uploads');
    process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
    await require('../../server/infrastructure/database/mysql/migrationRunner').runMigrations(privateDatabase.pool);
    const password = await require('bcryptjs').hash('admin123', 4);
    await privateDatabase.pool.execute("INSERT INTO users (username, password_hash, role, barangay, barangay_id, status) SELECT 'admin', ?, 'admin', name, id, 'active' FROM barangays WHERE name = 'Villamonte'", [password]);
    await privateDatabase.pool.query("INSERT INTO user_permissions (user_id, permission) SELECT id, 'admin:create' FROM users WHERE username = 'admin'");
    require('../../server/infrastructure/database').useTestDatabase(privateDatabase.adapter);
    const app = require('../../server/app');
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}`;
    db = privateDatabase.adapter;
  } else {
    const started = await sqliteHarness.startTestServer(); server = started.server; base = started.baseUrl; db = sqliteHarness.testDatabase();
  }

  for (const name of ['Villamonte', 'Mandalagan', 'Granada', 'Taculing']) {
    assert.equal((await db.query('SELECT COUNT(*) AS total FROM barangays WHERE name = ?', [name]))[0].total, 1);
  }
  brgyVillamonteId = (await db.query("SELECT id FROM barangays WHERE name = 'Villamonte'"))[0].id;
  brgyMandalaganId = (await db.query("SELECT id FROM barangays WHERE name = 'Mandalagan'"))[0].id;
  brgyGranadaId = (await db.query("SELECT id FROM barangays WHERE name = 'Granada'"))[0].id;
  brgyTaculingId = (await db.query("SELECT id FROM barangays WHERE name = 'Taculing'"))[0].id;

  citizenA = await register('citizen_villamonte', 'Villamonte');
  citizenB = await register('citizen_mandalagan', 'Mandalagan');
  citizenC = await register('citizen_granada', 'Granada');

  admin = await adminSession(base);
  officialVillamonte = await createOfficial(base, admin.token, 'Villamonte', 'official_villamonte');
  officialMandalagan = await createOfficial(base, admin.token, 'Mandalagan', 'official_mandalagan');
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (privateDatabase) await privateDatabase.close();
  else db?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {});
  }
});

test('Phase 5 — Citywide Community Feed multi-barangay audit and regression', async t => {
  // 1. Setup Approved public reports across 4 distinct Barangays:
  // - Pothole — Villamonte (Citizen A)
  // - Road Crack — Mandalagan (Citizen B)
  // - Broken Streetlight — Granada (Citizen C)
  // - Clogged Drainage — Taculing (Citizen A submitted in Taculing location or Citizen A report)
  const reportVillamonte = await submitReport(citizenA, 'Deep dangerous pothole on BS Aquino Drive', 'Villamonte', brgyVillamonteId, 'pothole');
  const reportMandalagan = await submitReport(citizenB, 'Severe road crack causing vehicle swerving', 'Mandalagan', brgyMandalaganId, 'road_crack');
  const reportGranada = await submitReport(citizenC, 'Broken streetlight along Burgos Extension', 'Granada', brgyGranadaId, 'broken_streetlight');
  const reportTaculing = await submitReport(citizenA, 'Clogged drainage causing street flooding', 'Taculing', brgyTaculingId, 'clogged_drainage');

  // Request publications for each report
  async function requestPublication(citizen, reportId, body) {
    const form = new FormData();
    form.append('body', body);
    form.append('reportId', String(reportId));
    form.append('requestKey', randomUUID());
    form.append('photos', new File([PNG_BYTES], 'evidence.png', { type: 'image/png' }));
    const res = await fetch(base + '/api/community/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizen.token}` },
      body: form
    });
    assert.equal(res.status, 201);
  }

  await requestPublication(citizenA, reportVillamonte, 'Deep dangerous pothole on BS Aquino Drive');
  await requestPublication(citizenB, reportMandalagan, 'Severe road crack causing vehicle swerving');
  await requestPublication(citizenC, reportGranada, 'Broken streetlight along Burgos Extension');
  await requestPublication(citizenA, reportTaculing, 'Clogged drainage causing street flooding');

  // Approve all 4 publications through Admin
  const postVillamonte = await approvePublication(base, reportVillamonte, admin, citizenA);
  const postMandalagan = await approvePublication(base, reportMandalagan, admin, citizenB);
  const postGranada = await approvePublication(base, reportGranada, admin, citizenC);
  const postTaculing = await approvePublication(base, reportTaculing, admin, citizenA);

  // 2. Setup Private / Unpublished scenarios:
  // - Pending publication (Citizen B)
  const reportPending = await submitReport(citizenB, 'Private unapproved hazard report', 'Mandalagan', brgyMandalaganId, 'pothole');
  await requestPublication(citizenB, reportPending, 'Private pending community share attempt');

  // - Rejected publication (Citizen C)
  const reportRejected = await submitReport(citizenC, 'Spammy or rejected public report', 'Granada', brgyGranadaId, 'pothole');
  await requestPublication(citizenC, reportRejected, 'Rejected community post content');
  const detailRejected = await (await fetch(`${base}/api/admin/community-publications/${reportRejected}`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })).json();
  const rejectRes = await fetch(`${base}/api/admin/community-publications/${reportRejected}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'rejected', reason: 'Insufficient photo evidence provided for publication.', version: detailRejected.publication.version })
  });
  assert.equal(rejectRes.status, 200);

  await t.test('The unscoped API still returns the same four published posts for legacy clients', async () => {
    const [feedA, feedB, feedC] = await Promise.all([
      (await request('/posts', citizenA)).json(),
      (await request('/posts', citizenB)).json(),
      (await request('/posts', citizenC)).json()
    ]);

    assert.equal(feedA.posts.length, 4);
    assert.equal(feedB.posts.length, 4);
    assert.equal(feedC.posts.length, 4);

    const postIdsA = feedA.posts.map(p => p.id);
    const postIdsB = feedB.posts.map(p => p.id);
    const postIdsC = feedC.posts.map(p => p.id);

    assert.deepEqual(postIdsA, postIdsB);
    assert.deepEqual(postIdsB, postIdsC);

    // Verify ordering is newest first
    assert.deepEqual(postIdsA, [postTaculing.id, postGranada.id, postMandalagan.id, postVillamonte.id]);

    // Verify all 4 expected Barangays are represented in the feed
    const barangaysInFeed = feedA.posts.map(p => p.barangay);
    assert.ok(barangaysInFeed.includes('Villamonte'));
    assert.ok(barangaysInFeed.includes('Mandalagan'));
    assert.ok(barangaysInFeed.includes('Granada'));
    assert.ok(barangaysInFeed.includes('Taculing'));
  });

  await t.test('Citizen A (Villamonte) can directly view, react, and comment on post from Mandalagan', async () => {
    const postDetail = await (await request(`/posts/${postMandalagan.id}`, citizenA)).json();
    assert.equal(postDetail.id, postMandalagan.id);
    assert.equal(postDetail.barangay, 'Mandalagan');
    assert.equal(postDetail.isOwnPost, false);

    // React to Mandalagan post
    const reactRes = await request(`/posts/${postMandalagan.id}/reaction`, citizenA, 'PUT', { reaction: 'like' });
    assert.equal(reactRes.status, 200);
    const reactData = await reactRes.json();
    assert.equal(reactData.reactions.mine, 'like');
    assert.equal(reactData.reactions.like, 1);

    // Comment on Mandalagan post
    const commentRes = await request(`/posts/${postMandalagan.id}/comments`, citizenA, 'POST', {
      body: 'Citizen A commenting on Mandalagan post',
      requestKey: randomUUID()
    });
    assert.equal(commentRes.status, 200);

    // Citizen B (Mandalagan) sees the comment
    const commentsList = await (await request(`/posts/${postMandalagan.id}/comments`, citizenB)).json();
    assert.equal(commentsList.pagination.total, 1);
    assert.equal(commentsList.comments[0].body, 'Citizen A commenting on Mandalagan post');
    assert.equal(commentsList.comments[0].author.label, 'Anonymous resident');
    assert.ok(commentsList.comments[0].author.pseudonym);

    // Citizen C (Granada) can reply to Citizen A's comment on Mandalagan's post
    const replyRes = await request(`/posts/${postMandalagan.id}/comments`, citizenC, 'POST', {
      body: 'Citizen C replying across barangays',
      parentCommentId: commentsList.comments[0].id,
      requestKey: randomUUID()
    });
    assert.equal(replyRes.status, 200);

    const updatedComments = await (await request(`/posts/${postMandalagan.id}/comments`, citizenA)).json();
    assert.equal(updatedComments.pagination.total, 2);
  });

  await t.test('Barangay feed filters approved posts by operational status before paginating in oldest order', async () => {
    await db.execute('UPDATE reports SET status = ? WHERE id IN (?, ?)', ['ongoing', reportVillamonte, reportGranada]);
    try {
      const first = await (await request('/posts?status=ongoing&sort=oldest&pageSize=1', officialVillamonte)).json();
      const second = await (await request('/posts?status=ongoing&sort=oldest&pageSize=1&page=2', officialVillamonte)).json();
      assert.equal(first.pagination.total, 2);
      assert.deepEqual(first.posts.map(post => [post.id, post.linkedReport.status]), [[postVillamonte.id, 'ongoing']]);
      assert.deepEqual(second.posts.map(post => post.id), [postGranada.id]);
      const pending = await (await request('/posts?status=pending', officialVillamonte)).json();
      assert.deepEqual(pending.posts.map(post => post.id), [postTaculing.id, postMandalagan.id]);
      assert.equal((await request('/posts?status=invalid', officialVillamonte)).status, 400);
    } finally {
      await db.execute('UPDATE reports SET status = ? WHERE id IN (?, ?)', ['pending', reportVillamonte, reportGranada]);
    }
  });

  await t.test('Filtering by specific Barangay isolates results correctly without leaking or mutating default feed', async () => {
    // Filter by Villamonte
    const villamonteOnly = await (await request('/posts?barangay=Villamonte', citizenA)).json();
    assert.equal(villamonteOnly.posts.length, 1);
    assert.equal(villamonteOnly.posts[0].id, postVillamonte.id);
    assert.equal(villamonteOnly.posts[0].barangay, 'Villamonte');

    // Filter by Mandalagan
    const mandalaganOnly = await (await request('/posts?barangay=Mandalagan', citizenC)).json();
    assert.equal(mandalaganOnly.posts.length, 1);
    assert.equal(mandalaganOnly.posts[0].id, postMandalagan.id);
    assert.equal(mandalaganOnly.posts[0].barangay, 'Mandalagan');

    // Filter by 'all' explicitly returns all 4 posts
    const allExplicit = await (await request('/posts?barangay=all', citizenB)).json();
    assert.equal(allExplicit.posts.length, 4);

    // Search filter across citywide feed
    const searchStreetlight = await (await request('/posts?search=streetlight', citizenA)).json();
    assert.equal(searchStreetlight.posts.length, 1);
    assert.equal(searchStreetlight.posts[0].id, postGranada.id);
  });

  await t.test('Private and rejected reports remain completely hidden from all Citizens', async () => {
    const feed = await (await request('/posts', citizenA)).json();
    assert.ok(!feed.posts.some(p => p.linkedReport?.id === reportPending));
    assert.ok(!feed.posts.some(p => p.linkedReport?.id === reportRejected));

    // Direct access to non-existent or unpublished post ID returns 404
    assert.equal((await request('/posts/999999', citizenA)).status, 404);
  });

  await t.test('Preserve existing security boundaries: Operational RBAC and My Reports isolation', async () => {
    // 1. Citizen My Reports isolation: Citizen A cannot view Citizen B's private report via /api/reports/:id
    const ownReport = await fetch(`${base}/api/reports/${reportVillamonte}`, {
      headers: { Authorization: `Bearer ${citizenA.token}` }
    });
    assert.equal(ownReport.status, 200);

    const otherPrivateReport = await fetch(`${base}/api/reports/${reportPending}`, {
      headers: { Authorization: `Bearer ${citizenA.token}` }
    });
    assert.equal(otherPrivateReport.status, 403); // Forbidden to access other citizen's report

    // 2. Barangay operational boundary: Official from Villamonte cannot update report in Mandalagan
    const unauthorizedStatusChange = await fetch(`${base}/api/reports/${reportMandalagan}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${officialVillamonte.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ongoing', note: 'Unauthorized cross-barangay attempt' })
    });
    assert.equal(unauthorizedStatusChange.status, 403);

    // Authorized official can update their own jurisdiction
    const authorizedStatusChange = await fetch(`${base}/api/reports/${reportVillamonte}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${officialVillamonte.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ongoing', note: 'Authorized local update in Villamonte' })
    });
    assert.equal(authorizedStatusChange.status, 200);

    // 3. Citizens cannot access staff coordination messages
    const staffMessages = await fetch(`${base}/api/reports/${reportVillamonte}/review`, {
      headers: { Authorization: `Bearer ${citizenA.token}` }
    });
    assert.equal(staffMessages.status, 403);
  });

  await t.test('citywide change events reach every Citizen without identities or private messages', () => {
    const events = require('../../server/infrastructure/events/notificationEvents');
    const { notificationService } = require('../../server/composition');
    const received = [[], [], []];
    const stops = [citizenA, citizenB, citizenC].map((actor, i) => notificationService.subscribe(actor.user.id, value => received[i].push(value), 'citizen', actor.user.barangayId));
    try {
      events.publishCommunityChanged(brgyVillamonteId, { postId: postVillamonte.id, kind: 'post_created', body: 'PRIVATE_INTERNAL_SENTINEL', username: 'private' });
      for (const values of received) assert.deepEqual(values, [{ event: 'community_changed', postId: postVillamonte.id, kind: 'post_created' }]);
    } finally { stops.forEach(stop => stop()); }
  });

  await t.test('a Citizen without an assigned home Barangay can opt into citywide viewing and engagement', async () => {
    await db.execute('UPDATE users SET barangay_id = NULL WHERE id = ?', [citizenC.user.id]);
    try {
      const local = await (await request('/posts?scope=local', citizenC)).json();
      assert.equal(local.barangay, null); assert.deepEqual(local.posts, []);
      const feed = await request('/posts?scope=citywide', citizenC); assert.equal(feed.status, 200); assert.equal((await feed.json()).posts.length, 4);
      assert.equal((await request(`/posts/${postMandalagan.id}/reaction`, citizenC, 'PUT', { reaction: 'heart' })).status, 200);
    } finally { await db.execute('UPDATE users SET barangay_id = ? WHERE id = ?', [brgyGranadaId, citizenC.user.id]); }
  });

  await t.test('ambiguous filters are rejected and Barangay-name search stays citywide', async () => {
    for (const query of ['barangay=Villamonte&barangay=Mandalagan', 'barangay=Villamonte&barangayId=Mandalagan', 'barangayId=0', 'scope=local&scope=citywide', 'scope=regional', 'scope=local&barangayId=51']) assert.equal((await request('/posts?' + query, citizenA)).status, 400);
    const found = await (await request('/posts?search=Granada', citizenA)).json();
    assert.deepEqual(found.posts.map(row => row.id), [postGranada.id]);
  });

  await t.test('local scope uses the reviewed OCR address for Citizens and assigned barangay for officials', async () => {
    async function saveAddress(address) {
      const response = await fetch(`${base}/api/identity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${citizenA.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType: 'drivers_license', idNumber: 'N01-23-456789', fullName: 'Legal Name', birthDate: '1995-06-15', address })
      });
      assert.equal(response.status, 200);
    }
    await saveAddress('Purok 5, Bacolod City');
    const fallback = await (await request('/posts?scope=local', citizenA)).json();
    assert.equal(fallback.barangay, 'Villamonte');
    assert.deepEqual(fallback.posts.map(row => row.id), [postVillamonte.id]);

    const reviewedAddress = '123 Fixture Road, Brgy. Mandalagan, Bacolod City';
    await saveAddress(reviewedAddress);
    const citizen = await (await request('/posts?scope=local', citizenA)).json();
    assert.equal(citizen.barangay, 'Mandalagan');
    assert.deepEqual(citizen.posts.map(row => row.id), [postMandalagan.id]);
    assert.ok(!JSON.stringify(citizen).includes(reviewedAddress));
    const outsideLocal = await (await request('/posts?scope=local&search=Granada', citizenA)).json();
    assert.deepEqual(outsideLocal.posts, []);

    const official = await (await request('/posts?scope=local&sort=oldest', officialVillamonte)).json();
    assert.equal(official.barangay, 'Villamonte');
    assert.deepEqual(official.posts.map(row => row.id), [postVillamonte.id]);
    for (const actor of [citizenA, officialVillamonte]) {
      const citywide = await (await request('/posts?scope=citywide', actor)).json();
      assert.equal(citywide.barangay, 'all');
      assert.equal(citywide.pagination.total, 4);
    }
  });

  await t.test('cross-Barangay official comments retain the actual official jurisdiction', async () => {
    const response = await request(`/posts/${postMandalagan.id}/comments`, officialVillamonte, 'POST', { body: 'Public coordination from Villamonte.', requestKey: randomUUID() });
    assert.equal(response.status, 200); const saved = (await response.json()).comment;
    assert.equal(saved.author.label, 'Barangay Villamonte');
    assert.equal((await request(`/posts/${postMandalagan.id}/comments`, citizenC, 'POST', { body: 'Reply from a Granada Citizen.', parentCommentId: saved.id, requestKey: randomUUID() })).status, 200);
    const comments = (await (await request(`/posts/${postMandalagan.id}/comments`, citizenA)).json()).comments;
    assert.equal(comments.find(row => row.id === saved.id).author.label, 'Barangay Villamonte');
    assert.equal(comments.find(row => row.parentId === saved.id).parentAuthor, 'Barangay Villamonte');
  });

  await t.test('canonical discussions stay citywide while linked unpublished evidence and internal conversations remain private', async () => {
    const duplicate = await submitReport(citizenC, 'Previously approved duplicate discussion.', 'Villamonte', brgyVillamonteId);
    await requestPublication(citizenC, duplicate, 'Previously approved duplicate discussion.');
    const duplicatePost = await approvePublication(base, duplicate, admin, citizenC);
    const saved = await (await request(`/posts/${duplicatePost.id}/comments`, citizenB, 'POST', { body: 'Preserved cross-Barangay historical comment.', requestKey: randomUUID() })).json();
    async function link(source) {
      const targetState = await (await fetch(`${base}/api/reports/${reportVillamonte}/incident-review`, { headers: { Authorization: `Bearer ${officialVillamonte.token}` } })).json();
      const response = await fetch(`${base}/api/reports/${source}/duplicate-review`, { method: 'POST', headers: { Authorization: `Bearer ${officialVillamonte.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ targetReportId: reportVillamonte, decision: 'confirmed', reason: 'Synthetic inspection confirms the same unresolved incident using location, category and evidence.', expectedIncidentVersion: 0, expectedTargetIncidentVersion: Number(targetState.incident?.version || 0), requestKey: randomUUID() }) });
      assert.equal(response.status, 200, await response.text());
    }
    await link(duplicate);
    const unpublished = await submitReport(citizenB, 'PRIVATE_UNAPPROVED_CANONICAL_SENTINEL', 'Villamonte', brgyVillamonteId);
    await requestPublication(citizenB, unpublished, 'PRIVATE_UNAPPROVED_CANONICAL_SENTINEL');
    await link(unpublished);
    const message = await fetch(`${base}/api/reports/${reportVillamonte}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'PRIVATE_INTERNAL_CONVERSATION_SENTINEL', requestKey: randomUUID() }) });
    assert.equal(message.status, 200);
    for (const actor of [citizenA, citizenB, citizenC]) {
      const feed = await (await request('/posts', actor)).json();
      assert.equal(feed.pagination.total, 4); assert.equal(feed.posts.some(row => row.id === duplicatePost.id), false);
      assert.ok(feed.posts.some(row => row.id === postVillamonte.id));
      assert.doesNotMatch(JSON.stringify(feed), /PRIVATE_UNAPPROVED_CANONICAL_SENTINEL|PRIVATE_INTERNAL_CONVERSATION_SENTINEL/);
      const archived = await (await request(`/posts/${duplicatePost.id}`, actor)).json();
      assert.equal(archived.canonicalDiscussionId, postVillamonte.id);
      const history = await (await request(`/posts/${duplicatePost.id}/comments`, actor)).json();
      assert.ok(history.comments.some(row => row.id === saved.comment.id));
      assert.equal((await fetch(`${base}/api/reports/${reportVillamonte}/review`, { headers: { Authorization: `Bearer ${actor.token}` } })).status, 403);
    }
    assert.equal((await db.query('SELECT post_id FROM community_comments WHERE id = ?', [saved.comment.id]))[0].post_id, duplicatePost.id);
    const state = (await db.query('SELECT state, post_id, discussion_post_id FROM community_publication_requests WHERE report_id = ?', [unpublished]))[0];
    assert.equal(state.state, 'pending_approval'); assert.equal(state.post_id, null); assert.equal(state.discussion_post_id, null);
    const inaccessible = await fetch(`${base}/api/reports/${reportVillamonte}/review`, { headers: { Authorization: `Bearer ${officialMandalagan.token}` } });
    assert.equal(inaccessible.status, 403);
  });

  await t.test('pending and rejected post rows cannot leak through direct reads, media or comments', async () => {
    const created = [];
    try {
      for (const [reportId, owner] of [[reportPending, citizenB], [reportRejected, citizenC]]) {
        const record = (await db.query('SELECT barangay_id FROM reports WHERE id = ?', [reportId]))[0];
        const post = await db.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)', [record.barangay_id, owner.user.id, 'PRIVATE_UNAPPROVED_ROW_SENTINEL', reportId, randomUUID(), 'a'.repeat(64)]);
        created.push(post.insertId);
        await db.execute('UPDATE community_publication_requests SET post_id = ? WHERE report_id = ?', [post.insertId, reportId]);
        const image = await db.execute('INSERT INTO community_media (post_id, storage_reference, image_order) VALUES (?, ?, 1)', [post.insertId, '/uploads/PRIVATE_UNAPPROVED_PHOTO_SENTINEL.png']);
        for (const actor of [citizenA, citizenB, citizenC]) for (const suffix of ['', '/comments', '/report', `/media/${image.insertId}`]) assert.equal((await request(`/posts/${post.insertId}${suffix}`, actor)).status, 404);
      }
      for (const actor of [citizenA, citizenB, citizenC]) {
        const feed = await (await request('/posts', actor)).json(); assert.equal(feed.pagination.total, 4);
        assert.doesNotMatch(JSON.stringify(feed), /PRIVATE_UNAPPROVED_ROW_SENTINEL|PRIVATE_UNAPPROVED_PHOTO_SENTINEL/);
      }
    } finally {
      for (const id of created) { await db.execute('UPDATE community_publication_requests SET post_id = NULL WHERE post_id = ?', [id]); await db.execute('DELETE FROM community_posts WHERE id = ?', [id]); }
    }
  });

  await t.test('all 61 supported Barangays paginate citywide without row multiplication or owner-scope changes', async () => {
    const catalog = await db.query("SELECT id, name FROM barangays WHERE city = 'Bacolod City' ORDER BY id");
    assert.equal(catalog.length, 61);
    const records = [], timings = [];
    try {
      for (const barangay of catalog) {
        const report = await submitReport(citizenA, `Published pagination fixture ${barangay.name}`, barangay.name, barangay.id);
        const post = await db.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)', [barangay.id, citizenA.user.id, `Public citywide fixture in ${barangay.name}`, report, randomUUID(), 'b'.repeat(64)]);
        records.push({ report, post: post.insertId });
        const review = await db.execute("INSERT INTO community_publication_requests (report_id, requested_by, barangay_id, state, body, request_key, request_hash, assigned_admin_id, reviewed_by, post_id, reviewed_at) VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", [report, citizenA.user.id, barangay.id, 'Public approved synthetic fixture', randomUUID(), 'c'.repeat(64), admin.user.id, admin.user.id, post.insertId]);
        records.at(-1).review = review.insertId;
        await db.execute("INSERT INTO community_publication_reviews (request_id, version, reviewer_id, decision) VALUES (?, 1, ?, 'approved')", [review.insertId, admin.user.id]);
      }
      const expected = 65, identitySets = [];
      for (const actor of [citizenA, citizenB, citizenC]) {
        const ids = [], names = new Set();
        for (let page = 1; page <= 4; page++) {
          const started = performance.now(); const response = await request(`/posts?pageSize=20&page=${page}`, actor); assert.equal(response.status, 200); const data = await response.json(); timings.push(performance.now() - started);
          assert.equal(data.pagination.total, expected); assert.equal(data.pagination.pages, 4); assert.equal(data.barangay, 'all');
          for (const row of data.posts) { ids.push(row.id); names.add(row.barangay); }
        }
        assert.equal(ids.length, expected); assert.equal(new Set(ids).size, expected); assert.equal(names.size, 61); identitySets.push(ids);
      }
      assert.deepEqual(identitySets[0], identitySets[1]); assert.deepEqual(identitySets[1], identitySets[2]);
      const own = await (await fetch(`${base}/api/reports`, { headers: { Authorization: `Bearer ${citizenA.token}` } })).json();
      assert.ok(own.reports.some(row => Number(row.id) === Number(reportTaculing)));
      assert.ok(!own.reports.some(row => Number(row.id) === Number(reportPending)));
      const scoped = await (await fetch(`${base}/api/reports`, { headers: { Authorization: `Bearer ${officialMandalagan.token}` } })).json();
      assert.ok(scoped.reports.length > 0); assert.ok(scoped.reports.every(row => Number(row.barangay_id) === Number(brgyMandalaganId)));
      await fs.mkdir('.data/citywide-feed-2026-10-27', { recursive: true });
      await fs.writeFile(`.data/citywide-feed-2026-10-27/pagination-${privateDatabase ? 'mysql' : 'sqlite'}.json`, JSON.stringify({ records: expected, supportedBarangays: 61, comparedCitizens: 3, requests: timings.length, maxMilliseconds: Math.max(...timings), averageMilliseconds: timings.reduce((a, b) => a + b, 0) / timings.length, identicalPublicIds: true }, null, 2));
    } finally {
      for (const record of records) {
        if (record.review) { await db.execute('DELETE FROM community_publication_reviews WHERE request_id = ?', [record.review]); await db.execute('DELETE FROM community_publication_requests WHERE id = ?', [record.review]); }
        await db.execute('DELETE FROM community_posts WHERE id = ?', [record.post]); await db.execute('DELETE FROM reports WHERE id = ?', [record.report]);
      }
    }
  });

  await t.test('private jurisdiction flags do not broadcast internal activity into the public feed', async () => {
    const image = await db.execute("INSERT INTO report_images (report_id, image_path, image_order, mime_type) VALUES (?, '/uploads/synthetic-routing-evidence.png', 1, 'image/png')", [reportPending]);
    const values = [], events = require('../../server/infrastructure/events/notificationEvents');
    const stop = events.subscribeCommunity(brgyVillamonteId, value => values.push(value));
    try {
      const response = await fetch(`${base}/api/reports/${reportPending}/routing-flags`, { method: 'POST', headers: { Authorization: `Bearer ${officialMandalagan.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRoutingVersion: 0, reason: 'Synthetic supporting evidence requests a private jurisdiction review.', evidenceImageIds: [image.insertId], requestKey: randomUUID() }) });
      assert.equal(response.status, 200); assert.deepEqual(values, []);
    } finally { stop(); }
  });

  if (privateDatabase) await t.test('real Citizen and Barangay browsers share the area filter and update the location heading', async () => {
    const { chromium, expect } = require('@playwright/test');
    const browser = await chromium.launch();
    try {
      for (const [actor, label, area] of [[citizenA, 'villamonte', 'Mandalagan'], [citizenB, 'mandalagan', 'Mandalagan'], [citizenC, 'granada', 'Granada'], [officialVillamonte, 'official-villamonte', 'Villamonte']]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(session => { sessionStorage.setItem('up_session', JSON.stringify(session)); Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} }); }, { ...actor.user, apiToken: actor.token });
        const page = await context.newPage();
        const feedRequests = []; page.on('request', value => { const url = new URL(value.url()); if (url.pathname === '/api/community/posts' && value.method() === 'GET') feedRequests.push(url.search); });
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const failures = []; page.on('pageerror', error => failures.push(error.message));
        await page.goto(`${base}/${actor.user.role}.html#community`);
        const location = page.locator('[data-community-barangay]');
        const filter = page.getByRole('button', { name: 'Filter community by area' });
        const areaMenu = page.getByRole('menu', { name: 'Community area' });
        const localArea = areaMenu.getByRole('menuitemradio', { name: 'My barangay' });
        const citywideArea = areaMenu.getByRole('menuitemradio', { name: 'Bacolod City' });
        async function chooseArea(option) {
          await filter.click();
          await option.click();
          await expect(areaMenu).toBeHidden();
        }
        await expect(location).toHaveText(area);
        await expect(page.locator('.cf-post')).toHaveCount(1);
        await filter.click();
        await expect(localArea).toHaveAttribute('aria-checked', 'true');
        await citywideArea.click();
        await expect(page.locator('.cf-post')).toHaveCount(4);
        await expect(location).toHaveText('Bacolod City');
        await page.getByLabel('Posts per page', { exact: true }).selectOption('3');
        await expect(page.locator('.cf-post')).toHaveCount(3);
        await page.getByRole('button', { name: 'Next posts', exact: true }).click();
        await expect(page.locator('.cf-post')).toHaveCount(1);
        await expect(page.getByRole('navigation', { name: 'Community pages' })).toContainText('Page 2 of 2');
        await page.getByLabel('Posts per page', { exact: true }).selectOption('10');
        await expect(page.locator('.cf-post')).toHaveCount(4);
        for (const width of [320, 390, 768, 1280, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          await expect(page.locator('.cf-post')).toHaveCount(4);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const filterBox = await filter.boundingBox();
          const latestBox = await page.getByRole('tab', { name: 'Latest', exact: true }).boundingBox();
          const reactedBox = await page.getByRole('tab', { name: 'Most reacted', exact: true }).boundingBox();
          assert.ok(filterBox.x >= reactedBox.x + reactedBox.width, `${label} at ${width}px: area filter should be to the right of the tabs`);
          assert.ok(Math.abs(reactedBox.y - latestBox.y) < 2, `${label} at ${width}px: sort tabs should share a row`);
          assert.ok(filterBox.y < reactedBox.y + reactedBox.height && reactedBox.y < filterBox.y + filterBox.height, `${label} at ${width}px: area filter should share the row`);
          if (width === 320) {
            await filter.press('ArrowDown');
            await expect(localArea).toBeFocused();
            await expect(citywideArea).toHaveAttribute('aria-checked', 'true');
            const menuBox = await areaMenu.boundingBox();
            assert.ok(menuBox.x >= 8 && menuBox.x + menuBox.width <= width - 8);
            assert.ok(Math.abs(menuBox.x + menuBox.width - (filterBox.x + filterBox.width)) < 2);
            await page.keyboard.press('ArrowDown');
            await expect(citywideArea).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(filter).toBeFocused();
            await expect(areaMenu).toBeHidden();
          }
          if (width === 390) {
            await chooseArea(localArea);
            await expect(location).toHaveText(area);
            await expect(page.locator('.cf-post')).toHaveCount(1);
            await chooseArea(citywideArea);
            await expect(location).toHaveText('Bacolod City');
            await expect(page.locator('.cf-post')).toHaveCount(4);
          }
          await page.screenshot({ path: `.data/citywide-feed-2026-10-27/${label}-${width}.png`, fullPage: true });
        }
        if (actor.user.role === 'barangay') {
          await page.reload();
          await expect(location).toHaveText(area);
          await expect(page.locator('.cf-post')).toHaveCount(1);
          assert.deepEqual(failures, []);
          await context.close();
          continue;
        }
        await page.getByRole('tab', { name: 'Most reacted', exact: true }).click();
        await expect(page.locator('.cf-post').first()).toHaveAttribute('data-post-id', String(postMandalagan.id));
        await page.getByRole('tab', { name: 'Latest', exact: true }).click();
        await page.locator('input[aria-label="Search community reports"]:visible').fill('Granada');
        await expect(page.locator('.cf-post')).toHaveCount(1);
        await expect(page.locator('.cf-post')).toHaveAttribute('data-post-id', String(postGranada.id));
        await page.locator('input[aria-label="Search community reports"]:visible').fill('');
        await expect(page.locator('.cf-post')).toHaveCount(4);
        const card = page.locator(`.cf-post[data-post-id="${postMandalagan.id}"]`);
        await card.locator('.cf-comments-toggle').click();
        await expect(card.locator('.cf-comment').first()).toBeVisible();
        await expect(card.locator('.cf-comment strong').first()).not.toHaveText(/Legal Name|citizen_/);
        const body = `Public citywide browser comment from ${label}.`;
        await card.locator('.cf-comment-form input').fill(body); await card.locator('.cf-comment-form button').click();
        await expect(card.locator('.cf-comments')).toContainText(body);
        await page.reload();
        await expect(location).toHaveText(area);
        await chooseArea(citywideArea);
        await expect(page.locator('.cf-post')).toHaveCount(4);
        const persisted = page.locator(`.cf-post[data-post-id="${postMandalagan.id}"]`);
        await persisted.locator('.cf-comments-toggle').click(); await expect(persisted.locator('.cf-comments')).toContainText(body);
        assert.equal((await db.query('SELECT COUNT(*) AS total FROM community_comments WHERE post_id = ? AND body = ?', [postMandalagan.id, body]))[0].total, 1);
        assert.ok(feedRequests[0].includes('scope=local'));
        assert.ok(feedRequests.some(search => search.includes('scope=citywide')));
        assert.ok(feedRequests.every(search => !/barangay/i.test(search)));
        assert.deepEqual(failures, []);
        await context.close();
      }
    } finally { await browser.close(); }
  });
});
