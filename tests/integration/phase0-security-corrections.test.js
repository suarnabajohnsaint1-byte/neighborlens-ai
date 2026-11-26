const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-phase0-${randomUUID()}.sqlite`);
const { startTestServer, testDatabase } = require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
const { approvePublication } = require('../support/publication');
let server, base, a, b, admin, official, outside, post, otherPost;
async function request(route, actor, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const comments = () => `/api/community/posts/${post.id}/comments`;
test.before(async () => {
  const started = await startTestServer(); server = started.server; base = started.baseUrl;
  a = await seedCitizen({ username: 'phase0_alpha', password: 'Fixture1234' });
  b = await seedCitizen({ username: 'phase0_beta', password: 'Fixture1234' });
  admin = await adminSession(base);
  official = await createOfficial(base, admin.token, 'Barangay 1', 'phase0_official');
  outside = await createOfficial(base, admin.token, 'Barangay 2', 'phase0_outside');
  for (const owner of [a, b]) {
    const report = await testDatabase().execute('INSERT INTO reports (description, barangay, barangay_id, submitted_by) VALUES (?, ?, ?, ?)', ['Private fixture', 'Barangay 1', 1, owner.user.id]);
    const result = await request('/api/community/posts', owner, 'POST', { body: 'Public fixture', reportId: report.insertId, requestKey: randomUUID() });
    assert.equal(result.status, 201);
    assert.equal(result.data.publication.state, 'pending_approval');
    const approved = await approvePublication(base, report.insertId, admin, owner);
    if (owner === a) post = approved; else otherPost = approved;
  }
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve)); testDatabase().close();
  for (const suffix of ['', '-wal', '-shm']) await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {});
});
test('canonical parentCommentId persists A to B to A and preserves independent roots', async () => {
  const make = async (actor, body, parentCommentId = null) => {
    const result = await request(comments(), actor, 'POST', { body, parentCommentId, requestKey: randomUUID() });
    assert.equal(result.status, 200); return result.data.comment;
  };
  const root = await make(a, 'Thread root A'); assert.ok(root?.id);
  const child = await make(b, 'Reply B', root.id);
  const grandchild = await make(a, 'Reply A again', child.id);
  const separate = await make(b, 'Independent root');
  const data = (await request(comments(), b)).data;
  assert.equal(data.comments.find(row => row.id === child.id).parentId, root.id);
  assert.equal(data.comments.find(row => row.id === grandchild.id).parentId, child.id);
  assert.equal(data.comments.find(row => row.id === separate.id).parentId, null);
  assert.equal(data.comments.find(row => row.id === root.id).threadReplyCount, 2);
  assert.equal(data.pagination.total, 4); assert.equal(data.pagination.rootTotal, 2);
  assert.equal(root.author.pseudonym, grandchild.author.pseudonym);
  const stored = await testDatabase().query('SELECT parent_id FROM community_comments WHERE id = ?', [grandchild.id]);
  assert.equal(stored[0].parent_id, child.id);
});
test('reply request key binds its exact parent and rejects cross-discussion targets', async () => {
  const listed = (await request(comments(), a)).data.comments;
  const roots = listed.filter(row => row.parentId === null);
  const key = randomUUID();
  assert.equal((await request(comments(), b, 'POST', { body: 'Bound reply', parentCommentId: roots[0].id, requestKey: key })).status, 200);
  assert.equal((await request(comments(), b, 'POST', { body: 'Bound reply', parentCommentId: roots[1].id, requestKey: key })).status, 409);
  const external = await testDatabase().execute('INSERT INTO community_comments (post_id, author_id, body, request_key) VALUES (?, ?, ?, ?)', [otherPost.id, b.user.id, 'Other discussion', randomUUID()]);
  assert.equal((await request(comments(), a, 'POST', { body: 'Invalid reply', parentCommentId: external.insertId, requestKey: randomUUID() })).status, 400);
  assert.equal((await request(comments(), a, 'POST', { body: 'Ambiguous target', parentId: roots[0].id, parentCommentId: roots[1].id, requestKey: randomUUID() })).status, 400);
});
test('deleted ancestor chains remain attached; deleted targets reject new replies', async () => {
  const rows = (await request(comments(), a)).data.comments;
  const root = rows.find(row => row.body === 'Thread root A'), child = rows.find(row => row.body === 'Reply B');
  assert.equal((await request(`${comments()}/${child.id}`, b, 'DELETE')).status, 200);
  assert.equal((await request(`${comments()}/${root.id}`, a, 'DELETE')).status, 200);
  const data = (await request(comments(), b)).data;
  assert.equal(data.comments.find(row => row.id === root.id).isDeleted, true);
  assert.equal(data.comments.find(row => row.id === child.id).isDeleted, true);
  assert.equal(data.comments.find(row => row.body === 'Reply A again').parentId, child.id);
  assert.equal((await request(comments(), a, 'POST', { body: 'Deleted target', parentCommentId: root.id, requestKey: randomUUID() })).status, 400);
});
test('descendant responses are bounded and direct-child pages retain exact parent IDs', async () => {
  const parent = await testDatabase().execute('INSERT INTO community_comments (post_id, author_id, body, request_key) VALUES (?, ?, ?, ?)', [post.id, a.user.id, 'Large thread', randomUUID()]);
  for (let index = 0; index < 260; index++) await testDatabase().execute('INSERT INTO community_comments (post_id, parent_id, author_id, body, request_key) VALUES (?, ?, ?, ?, ?)', [post.id, parent.insertId, b.user.id, `Reply ${index}`, randomUUID()]);
  const initial = await request(comments() + '?pageSize=20', a);
  assert.ok(initial.data.comments.length <= 220);
  const children = await request(comments() + `?parentCommentId=${parent.insertId}&pageSize=20&page=2`, a);
  assert.equal(children.status, 200); assert.equal(children.data.comments.length, 20);
  assert.ok(children.data.comments.every(row => row.parentId === parent.insertId));
  assert.equal(children.data.pagination.childTotal, 260);
});
test('desired-state comment likes are citywide and retry-safe while comment ownership remains enforced', async () => {
  const rows = (await request(comments(), a)).data.comments.filter(row => !row.isDeleted);
  const id = rows[0].id;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await request(`${comments()}/${id}/reaction`, b, 'PUT', { reacted: true })).data.total, 1);
  assert.equal((await request(`${comments()}/${id}/reaction`, b, 'PUT', { reacted: false })).data.total, 0);
  assert.equal((await request(`${comments()}/${id}/reaction`, outside, 'PUT', { reacted: true })).status, 200);
  assert.equal((await request(`${comments()}/${id}/reaction`, outside, 'PUT', { reacted: false })).data.total, 0);
  const ownA = rows.find(row => row.canEdit);
  assert.equal((await request(`${comments()}/${ownA.id}`, b, 'PATCH', { body: 'Not mine' })).status, 403);
});
test('all nine credential/portal combinations are enforced before a session is issued', async () => {
  const actors = [
    { role: 'citizen', username: a.user.username, password: 'Fixture1234' },
    { role: 'admin', username: admin.user.username, password: 'admin123' },
    { role: 'barangay', username: official.username, password: official.password }
  ];
  for (const actor of actors) for (const portal of ['citizen', 'admin', 'barangay']) {
    const result = await request(`/api/auth/${portal}/login`, null, 'POST', { username: actor.username, password: actor.password, role: portal });
    assert.equal(result.status, actor.role === portal ? 200 : 401, `${actor.role} through ${portal}`);
    if (actor.role !== portal) {
      assert.equal(result.data.token, undefined); assert.equal(result.data.user, undefined);
      assert.equal(result.data.error, 'Invalid username or password.');
    } else {
      assert.equal(result.data.user.role, portal);
      if (portal === 'citizen') a = result.data;
    }
  }
  assert.equal((await request('/api/auth/login', null, 'POST', { username: admin.user.username, password: 'admin123', portal: 'admin' })).status, 401);
  for (const actor of [a, official, outside]) assert.equal((await request('/api/admin/users', actor)).status, 403);
});
test('registration rejects privileged mass assignment rather than accepting role-shaped fields', async () => {
  for (const extra of [{ role: 'admin' }, { permissions: ['admin:create'] }, { barangayId: 2 }, { isVerified: true }]) {
    const result = await request('/api/auth/register', null, 'POST', { username: 'must_not_exist', password: 'Fixture1234', barangay: 'Barangay 1', ...extra });
    assert.equal(result.status, 400); assert.equal(result.data.token, undefined);
  }
  assert.equal((await testDatabase().query('SELECT id FROM users WHERE username = ?', ['must_not_exist'])).length, 0);
});
test('persisted Major and Minor counters are filtered, disjoint and jurisdiction-scoped', async () => {
  for (const [classification, scope] of [['MAJOR', 1], ['MINOR', 1], [null, 1], ['MAJOR', 2]]) await testDatabase().execute(
    'INSERT INTO reports (description, barangay, barangay_id, submitted_by, ai_classification) VALUES (?, ?, ?, ?, ?)',
    ['phase0_metric_fixture', `Barangay ${scope}`, scope, a.user.id, classification]);
  const first = await request('/api/reports?search=phase0_metric_fixture', official);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.filteredStats, { total: 3, pending: 3, ongoing: 0, resolved: 0, major: 1, minor: 1 });
  const other = await request('/api/reports?search=phase0_metric_fixture', outside);
  assert.equal(other.data.filteredStats.total, 1); assert.equal(other.data.filteredStats.minor, 0);
  const minorId = first.data.reports.find(row => row.ai_classification === 'MINOR').id;
  await testDatabase().execute("UPDATE reports SET ai_classification = 'MAJOR' WHERE id = ?", [minorId]);
  const refreshed = await request('/api/reports?search=phase0_metric_fixture', official);
  assert.equal(refreshed.data.filteredStats.major, 2); assert.equal(refreshed.data.filteredStats.minor, 0);
  assert.equal((await request('/api/reports?barangayId=1', outside)).status, 400);
  assert.equal((await request(`/api/reports/${minorId}`, outside)).status, 403);
  assert.equal((await request(`/api/reports/${minorId}/status`, outside, 'PATCH', { status: 'resolved' })).status, 403);
});
test('forged, expired and invalidated sessions cannot retain protected access', async () => {
  const provider = require('../../server/infrastructure/security/tokenProvider');
  for (const token of [a.token.slice(0, -8) + 'AAAAAAAA', provider.issue({ ...a.user, role: 'admin' }), provider.issue(a.user, -1)]) {
    assert.equal((await request('/api/admin/users', { token })).status, 401);
  }
  assert.equal((await request('/api/auth/logout', a, 'POST')).status, 200);
  assert.equal((await request('/api/me', a)).status, 401);
  assert.equal((await request('/api/me', b)).status, 200);
});

test('GIS and activity endpoints expose only authorized scoped report data', async () => {
  for (const actor of [null, b, admin]) for (const route of ['gis', 'activity']) {
    assert.equal((await request(`/api/barangays/${route}`, actor)).status, actor ? 403 : 401);
  }
  const result = await testDatabase().execute('INSERT INTO reports (description, barangay, barangay_id, submitted_by, latitude, longitude, ai_classification) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Scoped operations fixture', 'Barangay 1', 1, b.user.id, 10.67, 122.95, 'MINOR']);
  assert.equal((await request(`/api/reports/${result.insertId}/status`, official, 'PATCH', { status: 'ongoing' })).status, 200);
  const gis = await request('/api/barangays/gis?classification=MINOR', official);
  assert.equal(gis.status, 200); assert.equal(gis.data.boundaryVerified, false);
  assert.ok(gis.data.reports.some(row => row.id === result.insertId));
  assert.ok(gis.data.reports.every(row => row.barangay === 'Barangay 1'));
  const logs = await request(`/api/barangays/activity?search=${result.insertId}`, official);
  assert.equal(logs.status, 200); assert.equal(logs.data.pagination.total, 1);
  assert.equal(logs.data.logs[0].status, 'ongoing');
  assert.deepEqual(Object.keys(logs.data.logs[0]).sort(), ['action', 'actor', 'barangay', 'createdAt', 'id', 'reportId', 'status']);
  assert.equal((await request(`/api/barangays/activity?search=${result.insertId}`, outside)).data.pagination.total, 0);
  assert.ok(!(await request('/api/barangays/gis', outside)).data.reports.some(row => row.id === result.insertId));
  for (const route of ['gis', 'activity']) {
    for (const query of ['barangayId=1', 'userId=1', 'pageSize=1000', 'dateFrom=2026-02-30']) assert.equal((await request(`/api/barangays/${route}?${query}`, outside)).status, 400);
  }
  assert.equal((await request('/api/barangays/activity?action=login', official)).status, 400);
});

test('untrusted browser origins and oversized login bodies fail closed', async () => {
  const response = await fetch(base + '/api/me', { headers: { Origin: 'https://attacker.invalid', Authorization: `Bearer ${b.token}` } });
  assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const oversized = await request('/api/auth/citizen/login', null, 'POST', { username: 'a'.repeat(10000), password: 'Fixture1234' });
  assert.equal(oversized.status, 413);
});

test('community media cannot fall back to original private report attachments', async () => {
  const [row] = await testDatabase().query('SELECT report_id FROM community_posts WHERE id = ?', [otherPost.id]);
  const image = await testDatabase().execute('INSERT INTO report_images (report_id, image_path, image_order, mime_type) VALUES (?, ?, ?, ?)', [row.report_id, 'must-not-read-original-private-evidence.jpg', 1, 'image/jpeg']);
  const listed = await request(`/api/community/posts/${otherPost.id}`, b);
  assert.deepEqual(listed.data.media, []);
  for (const id of [1, image.insertId]) {
    const response = await fetch(`${base}/api/community/posts/${otherPost.id}/media/${id}`, { headers: { Authorization: `Bearer ${b.token}` } });
    assert.equal(response.status, 404);
  }
});

test('public reverse geocoding rejects malformed and out-of-range coordinates before upstream work', async () => {
  for (const query of ['lat=NaN&lon=122', 'lat=91&lon=122', 'lat=10&lon=-181', 'lat[]=10&lon=122', 'lat=&lon=122']) assert.equal((await request('/api/config/reverse-geocode?' + query)).status, 400);
});

test('report and AI request limits reject repeated work without mutating reports', async () => {
  const actor = await seedCitizen({ username: 'phase0_limited', password: 'Fixture1234' });
  const [before] = await testDatabase().query('SELECT COUNT(*) AS count FROM reports');
  for (const [route, count] of [['/api/reports', 30], ['/api/ai/damage', 60]]) {
    for (let index = 0; index < count; index++) assert.equal((await request(route, actor, 'POST', { description: 'Invalid without evidence' })).status, 400);
    assert.equal((await request(route, actor, 'POST', { description: 'Rate limited' })).status, 429);
  }
  assert.equal((await testDatabase().query('SELECT COUNT(*) AS count FROM reports'))[0].count, before.count);
  assert.equal((await request('/api/reports', b)).status, 200);
});
