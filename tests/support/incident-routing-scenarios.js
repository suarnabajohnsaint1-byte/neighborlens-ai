const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

async function incidentRoutingScenarios(t, { base, database }) {
  const suffix = randomUUID().slice(0, 8), password = 'IncidentFixture123', hash = await bcrypt.hash(password, 4);
  const query = (sql, params = []) => database.query(sql, params);
  const execute = (sql, params = []) => database.execute(sql, params);
  async function actor(role, barangay = 'Villamonte') {
    const username = `${role}_${randomUUID().slice(0, 8)}_${suffix}`;
    const result = await execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id) SELECT ?, ?, ?, name, id FROM barangays WHERE name = ?', [username, hash, role, barangay]);
    const response = await fetch(`${base}/api/auth/${role}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); const session = await response.json(); return { ...session, id: result.insertId };
  }
  const admin = await actor('admin'), routing = await actor('admin'), official = await actor('barangay'), other = await actor('barangay', 'Mandalagan'), owner = await actor('citizen'), neighbor = await actor('citizen');
  await execute("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'report:assign-jurisdiction')", [routing.id]);
  const v = (await query("SELECT id FROM barangays WHERE name = 'Villamonte'"))[0].id, m = (await query("SELECT id FROM barangays WHERE name = 'Mandalagan'"))[0].id;
  async function api(path, user, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function report(user = owner, overrides = {}) {
    const values = { latitude: 10.6685, longitude: 122.9647, gps_accuracy: 15, ai_category: 'pothole', status: 'pending', ...overrides };
    const id = (await execute('INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, latitude, longitude, gps_accuracy, ai_category, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['Preserved individual evidence and description.', 'Controlled fixture location', 'Villamonte', v, user.id, values.latitude, values.longitude, values.gps_accuracy, values.ai_category, values.status])).insertId;
    const image = (await execute("INSERT INTO report_images (report_id, image_path, image_order, mime_type) VALUES (?, ?, 1, 'image/png')", [id, `/uploads/fixture-${randomUUID()}.png`])).insertId;
    return { id, image };
  }
  const route = id => `/api/reports/${id}`, review = id => route(id) + '/incident-review';
  const linkBody = target => ({ targetReportId: target, decision: 'confirmed', reason: 'Inspector confirmed the same physical unresolved damage using both reports.', expectedIncidentVersion: 0, expectedTargetIncidentVersion: 0, requestKey: randomUUID() });
  async function legacy(reportId, user) {
    const post = (await execute("INSERT INTO community_posts (barangay_id, author_id, is_official, body, report_id, request_key, request_hash) VALUES (?, ?, 0, 'Original public discussion', ?, ?, ?)", [v, user.id, reportId, randomUUID(), 'a'.repeat(64)])).insertId;
    await execute('INSERT INTO community_publication_legacy (post_id) VALUES (?)', [post]);
    return post;
  }
  const source = await report(), target = await report(neighbor), distinct = await report(owner, { ai_category: 'broken_streetlight' }), closed = await report(neighbor, { status: 'resolved' });
  await t.test('suggestions use multiple signals and distinguish category differences and recurring damage', async () => {
    const result = await api(review(source.id), official); assert.equal(result.status, 200);
    assert.ok(result.data.candidates.some(row => row.reportId === target.id && row.kind === 'possible_duplicate' && row.signals.includes('time')));
    assert.ok(result.data.candidates.some(row => row.reportId === closed.id && row.kind === 'possible_recurrence'));
    assert.ok(!result.data.candidates.some(row => row.reportId === distinct.id));
    assert.equal((await query('SELECT COUNT(*) AS total FROM report_incidents'))[0].total, 0);
    for (const user of [null, other]) assert.equal((await api(review(source.id), user)).status, user ? 403 : 401);
  });
  await t.test('only assigned Barangay confirms links; invalid and closed incidents cannot be merged', async () => {
    for (const user of [admin, routing, owner, other]) assert.equal((await api(route(source.id) + '/duplicate-review', user, 'POST', linkBody(target.id))).status, 403);
    for (const id of [distinct.id, closed.id]) assert.equal((await api(route(source.id) + '/duplicate-review', official, 'POST', linkBody(id))).status, 400);
    assert.equal((await api(route(source.id) + '/duplicate-review', official, 'POST', { ...linkBody(target.id), reason: '' })).status, 400);
  });
  let firstPost, archivedPost, archivedComment;
  await t.test('confirmed duplicate discussions preserve reports, evidence and all existing comments', async () => {
    firstPost = await legacy(target.id, neighbor); archivedPost = await legacy(source.id, owner);
    archivedComment = (await execute("INSERT INTO community_comments (post_id, author_id, is_official, body, request_key) VALUES (?, ?, 0, 'Preserved historical citizen comment', ?)", [archivedPost, owner.id, randomUUID()])).insertId;
    const before = await query('SELECT * FROM reports WHERE id IN (?, ?) ORDER BY id', [source.id, target.id]);
    const body = linkBody(target.id), linked = await api(route(source.id) + '/duplicate-review', official, 'POST', body);
    assert.equal(linked.status, 200, JSON.stringify(linked));
    assert.equal((await api(route(source.id) + '/duplicate-review', official, 'POST', body)).data.replayed, true);
    assert.deepEqual(await query('SELECT * FROM reports WHERE id IN (?, ?) ORDER BY id', [source.id, target.id]), before);
    const comment = (await query('SELECT post_id, body FROM community_comments WHERE id = ?', [archivedComment]))[0];
    assert.equal(Number(comment.post_id), Number(archivedPost)); assert.equal(comment.body, 'Preserved historical citizen comment');
    assert.equal((await query('SELECT COUNT(*) AS total FROM report_images WHERE report_id IN (?, ?)', [source.id, target.id]))[0].total, 2);
    const feed = await api('/api/community/posts', owner); assert.equal(feed.status, 200);
    assert.ok(feed.data.posts.some(post => post.id === firstPost)); assert.ok(!feed.data.posts.some(post => post.id === archivedPost));
    assert.equal((await api(`/api/community/posts/${archivedPost}`, owner)).data.canonicalDiscussionId, firstPost);
    const historyView = await api(route(source.id) + `/citizen-comments?discussion=${archivedPost}`, admin); assert.equal(historyView.status, 200); assert.ok(JSON.stringify(historyView.data).includes('Preserved historical citizen comment'));
    assert.equal((await api(route(source.id) + `/citizen-comments?discussion=999999`, admin)).status, 403);
    const comments = await api(`/api/community/posts/${archivedPost}/comments`, owner); assert.equal(comments.status, 200); assert.ok(JSON.stringify(comments.data).includes('Preserved historical citizen comment'));
    assert.equal((await api(`/api/community/posts/${archivedPost}/comments`, owner, 'POST', { body: 'Continue the old discussion', requestKey: randomUUID() })).status, 409);
    assert.equal((await api(`/api/community/posts/${archivedPost}/comments/${archivedComment}`, owner, 'PATCH', { body: 'Owner may still edit their own historical comment.' })).status, 200);
  });
  await t.test('citizens receive original status and canonical incident progress without internal routing or staff messages', async () => {
    await execute("UPDATE reports SET status = 'ongoing' WHERE id = ?", [target.id]);
    const result = await api(review(source.id), owner); assert.equal(result.status, 200); assert.equal(result.data.originalStatus, 'pending'); assert.equal(result.data.incident.status, 'ongoing');
    for (const field of ['candidates', 'history', 'routingVersion', 'barangays', 'canAssignJurisdiction']) assert.equal(Object.hasOwn(result.data, field), false);
    assert.equal((await api(review(target.id), owner)).status, 403);
  });
  await t.test('dismissal leaves publication decisions and memberships independent', async () => {
    const a = await report(), b = await report(neighbor), post = await legacy(a.id, owner);
    const result = await api(route(a.id) + '/duplicate-review', official, 'POST', { ...linkBody(b.id), decision: 'dismissed' }); assert.equal(result.status, 200);
    assert.equal((await api(review(a.id), official)).data.incident, null);
    assert.ok((await api('/api/community/posts', owner)).data.posts.some(row => row.id === post));
  });
  await t.test('concurrent identical duplicate confirmations are idempotent and stale confirmations are rejected', async () => {
    const a = await report(), b = await report(neighbor), body = linkBody(b.id);
    const results = await Promise.all([api(route(a.id) + '/duplicate-review', official, 'POST', body), api(route(a.id) + '/duplicate-review', official, 'POST', body)]);
    assert.deepEqual(results.map(row => row.status), [200, 200], JSON.stringify(results)); assert.equal(results[0].data.id, results[1].data.id);
    assert.equal((await query('SELECT COUNT(*) AS total FROM report_incident_members WHERE report_id IN (?, ?)', [a.id, b.id]))[0].total, 2);
    assert.equal((await api(route(a.id) + '/duplicate-review', official, 'POST', { ...body, requestKey: randomUUID() })).status, 409);
  });
  await t.test('failed notification persistence rolls back duplicate membership, review history and audit atomically', async () => {
    const a = await report(), b = await report(neighbor);
    const before = (await query('SELECT COUNT(*) AS total FROM report_incidents'))[0].total;
    const notifications = require('../../server/infrastructure/repositories/notification.repository');
    const stub = t.mock.method(notifications, 'create', async () => { throw new Error('Controlled incident notification persistence failure'); });
    let result;
    try { result = await api(route(a.id) + '/duplicate-review', official, 'POST', linkBody(b.id)); }
    finally { stub.mock.restore(); }
    assert.equal(result.status, 500);
    assert.equal((await query('SELECT COUNT(*) AS total FROM report_incidents'))[0].total, before);
    for (const table of ['report_incident_members', 'report_coordination_events']) assert.equal((await query(`SELECT COUNT(*) AS total FROM ${table} WHERE report_id = ?`, [a.id]))[0].total, 0);
  });
  await t.test('linked reports still require independent Admin decisions and approval creates one canonical discussion', async () => {
    const a = await report(), b = await report(neighbor);
    assert.equal((await api(route(a.id) + '/duplicate-review', official, 'POST', linkBody(b.id))).status, 200);
    for (const [item, citizen] of [[a, owner], [b, neighbor]]) await execute("INSERT INTO community_publication_requests (report_id, requested_by, barangay_id, body, request_key, request_hash, assigned_admin_id) VALUES (?, ?, ?, 'Approved public description', ?, ?, ?)", [item.id, citizen.id, v, randomUUID(), 'b'.repeat(64), admin.id]);
    assert.equal((await api(`/api/admin/community-publications/${a.id}/decision`, official, 'POST', { state: 'approved', version: 1 })).status, 403);
    const results = await Promise.all([a, b].map(item => api(`/api/admin/community-publications/${item.id}/decision`, admin, 'POST', { state: 'approved', version: 1 })));
    assert.deepEqual(results.map(row => row.status), [200, 200], JSON.stringify(results)); assert.equal(results[0].data.publication.postId, results[1].data.publication.postId);
    assert.equal((await query('SELECT COUNT(*) AS total FROM community_posts WHERE report_id IN (?, ?)', [a.id, b.id]))[0].total, 1);
    assert.deepEqual((await query('SELECT state FROM community_publication_requests WHERE report_id IN (?, ?)', [a.id, b.id])).map(row => row.state), ['approved', 'approved']);
  });
  const transfer = await report();
  const assignment = () => ({ barangayId: m, expectedRoutingVersion: 0, reason: 'Verified authoritative boundary and report evidence correct the initial jurisdiction.', evidenceImageIds: [transfer.image], requestKey: randomUUID() });
  await t.test('routing is a separate explicit permission and the old publication route cannot bypass it', async () => {
    for (const actor of [admin, routing]) for (const status of ['ongoing', 'resolved', 'rejected']) assert.equal((await api(route(source.id) + '/status', actor, 'PATCH', { status, note: 'Routing permission never grants operational authority.', requestKey: randomUUID() })).status, 403);
    assert.equal((await api(review(transfer.id), admin)).data.canAssignJurisdiction, false); assert.equal((await api(review(transfer.id), routing)).data.canAssignJurisdiction, true);
    for (const user of [admin, routing]) {
      assert.equal((await api(route(transfer.id) + '/status', user, 'PATCH', { status: 'ongoing' })).status, 403);
      assert.equal((await api(route(transfer.id) + '/severity', user, 'POST', { category: 'pothole', classification: 'MAJOR' })).status, 403);
    }
    for (const user of [admin, official, owner, other]) assert.equal((await api(route(transfer.id) + '/jurisdiction', user, 'PATCH', assignment())).status, 403);
    assert.equal((await api(`/api/admin/community-publications/${transfer.id}`, admin, 'PATCH', { barangayId: m, version: 1 })).status, 403);
    assert.equal((await api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', { ...assignment(), reason: '' })).status, 400);
    assert.equal((await api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', { ...assignment(), evidenceImageIds: [target.image] })).status, 400);
    assert.equal((await api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', assignment())).status, 400);
  });
  await t.test('Barangay flags routing with evidence and notifies designated administrators without transferring', async () => {
    const body = { expectedRoutingVersion: 0, reason: 'The recorded location appears outside our jurisdiction.', evidenceImageIds: [transfer.image], requestKey: randomUUID() };
    assert.equal((await api(route(transfer.id) + '/routing-flags', official, 'POST', body)).status, 200);
    assert.equal((await api(route(transfer.id) + '/routing-flags', other, 'POST', body)).status, 403);
    assert.equal(Number((await query('SELECT barangay_id FROM reports WHERE id = ?', [transfer.id]))[0].barangay_id), Number(v));
    const notified = await query("SELECT user_id FROM notifications WHERE report_id = ? AND title = 'Jurisdiction review requested'", [transfer.id]);
    assert.ok(notified.some(row => Number(row.user_id) === routing.id)); assert.ok(!notified.some(row => Number(row.user_id) === admin.id));
  });
  const polygon = { type: 'Polygon', coordinates: [[[122.964, 10.668], [122.966, 10.668], [122.966, 10.670], [122.964, 10.670], [122.964, 10.668]]] };
  await t.test('verified geofence resolves a unique boundary and rejects overlapping boundaries', async () => {
    await execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE id = ?', [JSON.stringify(polygon), 'Synthetic isolated test fixture', 'fixture-v1', m]);
    const service = require('../../server/composition').geofenceService;
    assert.equal(Number((await service.resolveJurisdiction({ latitude: 10.6685, longitude: 122.9647, gpsAccuracy: 15 })).barangayId), Number(m));
    await execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE id = ?', [JSON.stringify(polygon), 'Synthetic isolated conflict', 'fixture-v1', v]);
    assert.equal((await api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', assignment())).status, 400);
    await execute('UPDATE barangays SET boundary_geojson = NULL, boundary_source = NULL, boundary_version = NULL WHERE id = ?', [v]);
  });
  await t.test('concurrent routing corrections preserve ID, coordinates and private history while moving current authorization', async () => {
    assert.equal((await api(route(transfer.id) + '/messages', admin, 'POST', { body: 'Preserved private coordination history.', requestKey: randomUUID() })).status, 200);
    const original = (await query('SELECT * FROM reports WHERE id = ?', [transfer.id]))[0];
    const body = assignment();
    const results = await Promise.all([api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', body), api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', { ...body, requestKey: randomUUID() })]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409], JSON.stringify(results));
    const replayBody = results[0].status === 200 ? body : null;
    if (replayBody) assert.equal((await api(route(transfer.id) + '/jurisdiction', routing, 'PATCH', replayBody)).data.replayed, true);
    const changed = (await query('SELECT * FROM reports WHERE id = ?', [transfer.id]))[0];
    assert.equal(Number(changed.barangay_id), Number(m)); assert.equal(changed.jurisdiction_source, 'admin_assigned');
    for (const field of ['id', 'latitude', 'longitude', 'gps_accuracy', 'description', 'submitted_by', 'status', 'created_at']) assert.deepEqual(changed[field], original[field]);
    for (const suffix of ['', '/review', '/history', '/citizen-comments', '/incident-review']) assert.equal((await api(route(transfer.id) + suffix, official)).status, 403);
    assert.equal((await api(route(transfer.id) + '/review', other)).status, 200); assert.ok(JSON.stringify((await api(route(transfer.id) + '/review', other)).data).includes('Preserved private coordination history.'));
    const notices = await query("SELECT user_id FROM notifications WHERE report_id = ? AND title = 'Report jurisdiction corrected'", [transfer.id]);
    for (const user of [owner, official, other]) assert.ok(notices.some(row => Number(row.user_id) === user.id));
    assert.equal((await api(review(transfer.id), routing)).data.routingVersion, 1);
    const history = (await api(review(transfer.id), routing)).data.history.find(row => row.kind === 'jurisdiction_corrected');
    assert.equal(Number(history.details.changes[0].previousBarangayId), Number(v)); assert.equal(Number(history.details.changes[0].newBarangayId), Number(m));
    assert.ok(history.created_at); assert.equal(Number(history.actor_id), routing.id);
  });
  await t.test('linked incident transfer requires all member evidence and moves publication scope together', async () => {
    const state = (await api(review(source.id), routing)).data;
    const body = { ...assignment(), evidenceImageIds: [source.image] };
    assert.equal((await api(route(source.id) + '/jurisdiction', routing, 'PATCH', body)).status, 409);
    const result = await api(route(source.id) + '/jurisdiction', routing, 'PATCH', { ...body, applyToIncident: true, expectedIncidentVersion: state.incident.version, members: [source, target].map(item => ({ reportId: item.id, expectedRoutingVersion: 0, evidenceImageIds: [item.image] })) });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.ok((await query('SELECT barangay_id FROM reports WHERE id IN (?, ?)', [source.id, target.id])).every(row => Number(row.barangay_id) === Number(m)));
    assert.ok((await query('SELECT barangay_id FROM community_posts WHERE id IN (?, ?)', [firstPost, archivedPost])).every(row => Number(row.barangay_id) === Number(m)));
    assert.equal(Number((await query('SELECT post_id FROM community_comments WHERE id = ?', [archivedComment]))[0].post_id), Number(archivedPost));
  });
  await t.test('invalid GPS never authorizes correction and analytics retain individual report counts', async () => {
    const invalid = await report(owner, { gps_accuracy: 500 });
    assert.equal((await api(route(invalid.id) + '/jurisdiction', routing, 'PATCH', { ...assignment(), evidenceImageIds: [invalid.image] })).status, 400);
    const page = await api('/api/reports?status=all', other); assert.equal(page.status, 200);
    const rows = Array.isArray(page.data) ? page.data : page.data.reports;
    assert.ok(rows.some(row => row.id === source.id)); assert.ok(rows.some(row => row.id === target.id)); assert.ok(rows.some(row => row.id === transfer.id));
    const total = (await query('SELECT COUNT(*) AS total FROM reports WHERE barangay_id = ?', [m]))[0].total;
    assert.ok(Number(total) >= 3);
    const analytics = await api('/api/reports/analytics', other); assert.equal(analytics.status, 200); assert.equal(analytics.data.totals.submitted, Number(total));
    await execute('UPDATE barangays SET boundary_geojson = NULL, boundary_source = NULL, boundary_version = NULL WHERE id = ?', [m]);
  });
  return { admin, routing, official, other, owner, neighbor, v, m, polygon, browserReport: await report() };
}
module.exports = { incidentRoutingScenarios };
