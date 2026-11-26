const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-community-${randomUUID()}.sqlite`);
process.env.STORAGE_DRIVER = 'local';
const { startTestServer, testDatabase } = require('../support/test-app');
const { adminSession, createOfficial } = require('../support/accounts');
const { PNG_BYTES } = require('../support/image-fixtures');
const { approvePublication } = require('../support/publication');
let server, base, citizen, neighbor, outsider, official, admin, privateReport, post;

async function request(url, user, method = 'GET', body) {
  return fetch(base + '/api/community' + url, { method, headers: {
    ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {})
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function register(username, barangay = 'Barangay 1') {
  return seedCitizen({ username, password: 'FixturePass123!', fullName: 'Private Legal Name', barangay });
}
test.before(async () => {
  const started = await startTestServer(); server = started.server; base = started.baseUrl;
  citizen = await register('community_owner'); neighbor = await register('community_neighbor'); outsider = await register('community_outsider', 'Barangay 2');
  admin = await adminSession(base); official = await createOfficial(base, admin.token, 'Barangay 1', 'community_official');
  privateReport = (await testDatabase().execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
    ['Private report description', 'Private home address', 'Barangay 1', 1, citizen.user.id, 'pothole'])).insertId;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve)); testDatabase().close();
  for (const suffix of ['', '-wal', '-shm']) await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {});
});

test('private reports are not posts and invalid filters are rejected', async () => {
  assert.equal((await request('/posts')).status, 401);
  const empty = await (await request('/posts', citizen)).json();
  assert.equal(empty.posts.length, 0);
  assert.equal((await request('/posts?unsupportedParam=2', citizen)).status, 400);
});
test('explicit publication keeps anonymous DTOs, strips photo metadata and preserves the private report', async () => {
  const form = new FormData(); form.append('body', 'Public update'); form.append('reportId', String(privateReport)); form.append('requestKey', randomUUID());
  form.append('photos', new File([PNG_BYTES], 'PRIVATE-NAME-ID.png', { type: 'image/png' }));
  const response = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body: form });
  assert.equal(response.status, 201);
  const requested = await response.json();
  assert.equal(requested.publication.state, 'pending_approval');
  assert.equal((await (await request('/posts', neighbor)).json()).posts.length, 0);
  post = await approvePublication(base, privateReport, admin, citizen);
  assert.equal(post.author.label, 'Anonymous resident'); assert.equal(post.author.official, false);
  assert.equal(post.linkedReport.category, 'Road Damage');
  const publicData = await (await request(`/posts/${post.id}`, neighbor)).json();
  assert.equal(publicData.isOwnPost, false);
  assert.equal(publicData.canEdit, false);
  assert.doesNotMatch(JSON.stringify(publicData), /Private|PRIVATE|community_owner|author_id|submitted_by|username|fullName|storage_reference|token|latitude|longitude|request_key/);
  assert.equal((await request(`/posts/${post.id}`, outsider)).status, 200);
  const image = await request(`/posts/${post.id}/media/${post.media[0].id}`, neighbor);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/webp');
  const metadata = await require('sharp')(Buffer.from(await image.arrayBuffer())).metadata();
  assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
  assert.equal((await request(`/posts/${post.id}/media/${post.media[0].id}`, outsider)).status, 200);
  const linked = await (await request(`/posts/${post.id}/report`, neighbor)).json();
  assert.doesNotMatch(JSON.stringify(linked), /Private|submitted|latitude|longitude|userId/);
  const [original] = await testDatabase().query('SELECT description, status FROM reports WHERE id = ?', [privateReport]);
  assert.equal(original.description, 'Private report description'); assert.equal(original.status, 'pending');
});
test('publication is idempotent and rejects nonowned report linking and forged official attribution', async () => {
  const standalonePayload = { body: 'Standalone without report', requestKey: randomUUID() };
  assert.equal((await request('/posts', neighbor, 'POST', standalonePayload)).status, 400);
  const secondReport = (await testDatabase().execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
    ['Second report description', 'Second address', 'Barangay 1', 1, citizen.user.id, 'clogged_drainage'])).insertId;
  const eligible = await (await request('/eligible-reports', citizen)).json();
  assert.ok(eligible.reports.some(item => Number(item.id) === Number(secondReport)));
  assert.ok(!eligible.reports.some(item => Number(item.id) === Number(privateReport)));
  const payload = { body: 'Unique publication', requestKey: randomUUID(), official: true, author_id: outsider.user.id, barangayId: 2, reportId: secondReport };
  const first = await (await request('/posts', citizen, 'POST', payload)).json();
  const again = await (await request('/posts', citizen, 'POST', payload)).json();
  assert.equal(first.publication.reportId, again.publication.reportId); assert.equal(again.created, false);
  const approved = await approvePublication(base, secondReport, admin, citizen);
  assert.equal(approved.author.official, false); assert.equal(approved.barangay, 'Barangay 1');
  assert.equal((await request('/posts', citizen, 'POST', { ...payload, body: 'Changed' })).status, 409);
  assert.equal((await request('/posts', citizen, 'POST', { body: 'Duplicate share attempt', requestKey: randomUUID(), reportId: secondReport })).status, 409);
  assert.equal((await request('/posts', neighbor, 'POST', { body: 'Stolen link', requestKey: randomUUID(), reportId: privateReport })).status, 403);
  const update = await (await request('/posts', official, 'POST', { body: 'Institutional update', requestKey: randomUUID() })).json();
  assert.equal(update.post.author.official, true);
  assert.equal(update.post.author.label, 'Barangay 1');
  assert.doesNotMatch(JSON.stringify(update), new RegExp(official.username));
});
test('reactions use desired-state idempotency with one reaction per user and no public reactor identities', async () => {
  const react = (user, reaction) => request(`/posts/${post.id}/reaction`, user, 'PUT', { reaction });
  assert.equal((await react(citizen, 'like')).status, 200);
  const retried = await (await react(citizen, 'like')).json();
  assert.deepEqual(retried.reactions, { total: 1, like: 1, heart: 0, mine: 'like' });
  const switched = await (await react(citizen, 'heart')).json();
  assert.equal(switched.reactions.total, 1); assert.equal(switched.reactions.heart, 1);
  await react(neighbor, 'like');
  const removed = await (await react(citizen, null)).json();
  assert.equal(removed.reactions.total, 1); assert.equal(removed.reactions.mine, null);
  assert.ok(removed.engagementVersion > retried.engagementVersion);
  assert.equal((await react(outsider, 'like')).status, 200);
  assert.equal((await react(outsider, null)).status, 200);
  assert.equal((await react(citizen, 'affected')).status, 400);
});
test('comments stay anonymous, paginate, preserve ownership and reject duplicate request changes', async () => {
  const input = { body: '<img src=x onerror=alert(1)>', requestKey: randomUUID() };
  assert.equal((await request(`/posts/${post.id}/comments`, citizen, 'POST', input)).status, 200);
  await request(`/posts/${post.id}/comments`, citizen, 'POST', input);
  const listed = await (await request(`/posts/${post.id}/comments?pageSize=1`, neighbor)).json();
  assert.equal(listed.pagination.total, 1); assert.equal(listed.comments[0].body, input.body);
  assert.equal(listed.comments[0].author.label, 'Anonymous resident');
  assert.equal(listed.comments[0].canDelete, false);
  assert.doesNotMatch(JSON.stringify(listed), /community_owner|Private|author_id|username/);
  const id = listed.comments[0].id;
  assert.equal((await request(`/posts/${post.id}/comments/${id}`, neighbor, 'DELETE')).status, 403);
  assert.equal((await request(`/posts/${post.id}/comments/${id}`, citizen, 'PATCH', { body: 'Edited' })).status, 200);
  assert.equal((await request(`/posts/${post.id}/comments/${id}`, citizen, 'DELETE')).status, 200);
  assert.equal((await request(`/posts/${post.id}/comments`, outsider)).status, 200);
  assert.equal((await request('/posts/999999/comments', outsider)).status, 404);
});
test('identity lookup is a separate audited Admin-only workflow', async () => {
  for (const actor of [citizen, neighbor, official]) assert.equal((await request(`/posts/${post.id}/identity`, actor)).status, 403);
  const result = await (await request(`/posts/${post.id}/identity`, admin)).json();
  assert.equal(result.author.id, citizen.user.id);
  assert.equal(result.author.username, citizen.user.username);
  const logs = await testDatabase().query("SELECT * FROM audit_logs WHERE action = 'community_identity_accessed'");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /Private Legal Name|community_owner/);
});
test('image ingress rejects spoofing, oversized data and too many photos without retaining files', async () => {
  const { UPLOAD_ROOT } = require('../../server/infrastructure/storage/uploadDirectory');
  const before = (await fs.readdir(UPLOAD_ROOT)).sort();
  for (const images of [
    [{ bytes: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/png' }],
    [{ bytes: PNG_BYTES, type: 'image/jpeg' }],
    [{ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), type: 'image/png' }],
    Array.from({ length: 4 }, () => ({ bytes: PNG_BYTES, type: 'image/png' }))
  ]) {
    const form = new FormData(); form.append('body', 'Invalid photo'); form.append('requestKey', randomUUID());
    images.forEach(image => form.append('photos', new File([image.bytes], 'private-original.png', { type: image.type })));
    const response = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body: form });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /stack|SELECT|UPLOAD_ROOT|private-original/);
  }
  assert.deepEqual((await fs.readdir(UPLOAD_ROOT)).sort(), before);
});
test('real source EXIF is removed and deletion never removes original report attachments', async () => {
  const sharp = require('sharp');
  const source = await sharp(PNG_BYTES).withMetadata({ exif: { IFD0: { Artist: 'Fictional private fixture' } } }).jpeg().toBuffer();
  assert.ok((await sharp(source).metadata()).exif);
  const exifReport = (await testDatabase().execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
    ['EXIF test report', 'EXIF address', 'Barangay 1', 1, citizen.user.id, 'pothole'])).insertId;
  const form = new FormData(); form.append('body', 'Metadata test'); form.append('requestKey', randomUUID());
  form.append('reportId', String(exifReport));
  form.append('photos', new File([source], 'private-person.jpg', { type: 'image/jpeg' }));
  const response = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body: form });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).publication.state, 'pending_approval');
  const published = await approvePublication(base, exifReport, admin, citizen);
  const photo = await request(`/posts/${published.id}/media/${published.media[0].id}`, neighbor);
  assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).exif, undefined);
  const reference = (await testDatabase().query('SELECT storage_reference FROM community_media WHERE post_id = ?', [published.id]))[0].storage_reference;
  assert.equal((await fetch(base + reference)).status, 404);
  await request(`/posts/${published.id}`, citizen, 'DELETE');
  const { UPLOAD_ROOT } = require('../../server/infrastructure/storage/uploadDirectory');
  await assert.rejects(fs.access(path.join(UPLOAD_ROOT, path.basename(reference))));
  assert.ok((await testDatabase().query('SELECT id FROM reports WHERE id = ?', [privateReport]))[0]);
});
test('feed search uses only public category rather than original corrected AI subtype', async () => {
  await testDatabase().execute('UPDATE reports SET submission_assessment = ? WHERE id = ?', [JSON.stringify({ citizen_category: 'Street Light Damage' }), privateReport]);
  const visible = await (await request('/posts?search=Street%20Light', neighbor)).json();
  assert.equal(visible.posts[0].id, post.id);
  const hidden = await (await request('/posts?search=pothole', neighbor)).json();
  assert.equal(hidden.posts.length, 0);
  for (const status of ['LOW_CONFIDENCE', 'NO_DETECTION', 'AI_UNAVAILABLE']) {
    await testDatabase().execute('UPDATE reports SET submission_assessment = ? WHERE id = ?', [JSON.stringify({ citizen_category: null, original_ai: { status, canonical_class: null } }), privateReport]);
    const record = await (await request(`/posts/${post.id}`, neighbor)).json();
    assert.equal(record.linkedReport.category, 'Uncategorized');
    assert.equal((await (await request('/posts?search=Road%20Damage', neighbor)).json()).posts.length, 0);
  }
});
test('community realtime is citywide, identity-free and unsubscribed on cleanup', () => {
  const events = require('../../server/infrastructure/events/notificationEvents');
  const { notificationService } = require('../../server/composition');
  const first = [], other = [], adminEvents = [];
  const stops = [notificationService.subscribe(citizen.user.id, event => first.push(event), 'citizen', 1),
    notificationService.subscribe(outsider.user.id, event => other.push(event), 'citizen', 2),
    notificationService.subscribe(admin.user.id, event => adminEvents.push(event), 'admin', 1)];
  events.publishCommunityChanged(1, { postId: post.id, kind: 'post_created', author_id: citizen.user.id, fullName: 'Private' });
  assert.deepEqual(first, [{ event: 'community_changed', postId: post.id, kind: 'post_created' }]);
  assert.deepEqual(other, first); assert.deepEqual(adminEvents, []);
  stops.forEach(stop => stop());
  assert.equal(events.listenerCount('community:citywide'), 0);
});
test('ownership, malformed IDs, revocation and deletion protect all related reads', async () => {
  assert.equal((await request(`/posts/${post.id}`, neighbor, 'PATCH', { body: 'Not mine' })).status, 403);
  for (const id of ['0', '-1', '1e2', '999999999999999']) assert.equal((await request(`/posts/${id}`, citizen)).status, 400);
  await testDatabase().execute("UPDATE users SET status = 'suspended' WHERE id = ?", [outsider.user.id]);
  assert.equal((await request('/posts', outsider)).status, 401);
  assert.equal((await request(`/posts/${post.id}`, citizen, 'DELETE')).status, 200);
  for (const suffix of ['', '/comments', '/report', `/media/${post.media[0].id}`]) assert.equal((await request(`/posts/${post.id}${suffix}`, neighbor)).status, 404);
});
test('post, comment and reaction limits reject abuse before another mutation', async () => {
  for (const [suffix, method, maximum, body] of [
    ['/posts', 'POST', 10, { body: '', requestKey: randomUUID() }],
    [`/posts/${post.id}/comments`, 'POST', 30, { body: '', requestKey: randomUUID() }],
    [`/posts/${post.id}/reaction`, 'PUT', 120, { reaction: 'invalid' }]
  ]) {
    let response;
    for (let index = 0; index <= maximum; index++) {
      response = await request(suffix, neighbor, method, body);
      if (response.status === 429) break;
    }
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.doesNotMatch(await response.text(), /stack|SQL|password_hash/);
  }
});
test('deleted accounts and cookie-only requests cannot access protected community paths', async () => {
  const cookie = await fetch(base + '/api/community/posts', { headers: { Cookie: `token=${citizen.token}` } });
  assert.equal(cookie.status, 401);
  const created = await testDatabase().execute("INSERT INTO users (username, password_hash, role, barangay, barangay_id) SELECT 'deleted_fixture', password_hash, role, barangay, barangay_id FROM users WHERE id = ?", [citizen.user.id]);
  const deleted = { token: require('../../server/infrastructure/security/tokenProvider').issue({ id: created.insertId, username: 'deleted_fixture', role: 'citizen', barangay: 'Barangay 1' }) };
  assert.equal((await request('/posts', deleted)).status, 200);
  await testDatabase().execute('DELETE FROM users WHERE id = ?', [created.insertId]);
  for (const suffix of ['/posts', `/posts/${post.id}`, `/posts/${post.id}/comments`, `/posts/${post.id}/media/${post.media[0].id}`, `/posts/${post.id}/report`]) assert.equal((await request(suffix, deleted)).status, 401);
});
