const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

async function reportReviewScenarios(t, { base, database }) {
  const password = 'ReviewFixture1234', hash = await bcrypt.hash(password, 4), suffix = randomUUID().slice(0, 8);
  async function actor(name, role, barangay = 'Villamonte') {
    name = `${name}_${suffix}`;
    const { insertId } = await database.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id) SELECT ?, ?, ?, name, id FROM barangays WHERE name = ?', [name, hash, role, barangay]);
    assert.ok(insertId);
    const response = await fetch(`${base}/api/auth/${role}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password }) });
    assert.equal(response.status, 200); return response.json();
  }
  const admin = await actor('review_admin', 'admin'), official = await actor('review_official', 'barangay'), peer = await actor('review_peer', 'barangay'), outsider = await actor('review_outsider', 'barangay', 'Mandalagan'), citizen = await actor('review_citizen', 'citizen');
  const uninvolvedAdmin = await actor('review_uninvolved_admin', 'admin');
  const { insertId: id } = await database.execute("INSERT INTO reports (description, barangay, barangay_id, submitted_by, status, ai_category, ai_classification, ai_priority) SELECT 'Controlled workflow report', name, id, ?, 'pending', 'pothole', NULL, NULL FROM barangays WHERE name = 'Villamonte'", [citizen.user.id]);
  const route = `/api/reports/${id}`;
  await database.execute("INSERT INTO community_publication_requests (report_id, requested_by, barangay_id, body, request_key, request_hash) SELECT id, submitted_by, barangay_id, description, ?, ? FROM reports WHERE id = ?", [randomUUID(), '0'.repeat(64), id]);
  async function api(path, user, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null };
  }
  const count = async (table, where = 'report_id = ?', value = id) => Number((await database.query(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`, [value]))[0].total);
  await t.test('internal messages and severity reject anonymous, citizen and cross-barangay actors', async () => {
    for (const user of [null, citizen, outsider]) for (const [suffix, method, body] of [['/review', 'GET'], ['/citizen-comments', 'GET'], ['/messages', 'POST', { body: 'Private message', requestKey: randomUUID() }], ['/messages/read', 'POST', { lastMessageId: 1 }], ['/severity', 'POST', { category: 'pothole' }]]) {
      assert.equal((await api(route + suffix, user, method, body)).status, user ? 403 : 401);
    }
    assert.equal((await api('/api/reports/1junk/review', admin)).status, 400);
  });
  let messageId;
  await t.test('Admin monitoring can read activity and messages but cannot mutate status or severity', async () => {
    assert.equal((await api(route, admin)).status, 200);
    assert.equal((await api(route + '/review', admin)).status, 200);
    assert.equal((await api(route + '/citizen-comments', admin)).status, 200);
    for (const status of ['ongoing', 'resolved', 'rejected']) assert.equal((await api(route + '/status', admin, 'PATCH', { status, note: 'Admin is monitoring only.', requestKey: randomUUID() })).status, 403);
    assert.equal((await api(route + '/severity', admin, 'POST', { category: 'pothole', classification: 'MAJOR', evidence: { safety_impact: 'Admin cannot confirm operational severity.' }, reason: 'Only the assigned Barangay can confirm.', expectedReviewId: 0, requestKey: randomUUID() })).status, 403);
    assert.equal(await count('report_status_history'), 0); assert.equal(await count('report_severity_reviews'), 0);
    assert.equal((await database.query('SELECT status FROM reports WHERE id = ?', [id]))[0].status, 'pending');
  });
  await t.test('messages persist with exact text, sender role, one audit and staff-only notifications', async () => {
    const body = { body: '<script>window.injected=true</script> Please inspect this incident.', requestKey: randomUUID(), recipientId: outsider.user.id };
    const first = await api(route + '/messages', admin, 'POST', body), retry = await api(route + '/messages', admin, 'POST', body);
    assert.equal(first.status, 200); assert.equal(retry.status, 200); assert.equal(retry.data.id, first.data.id); assert.equal(retry.data.replayed, true);
    assert.equal((await api(route + '/messages', admin, 'POST', { ...body, body: 'Changed content under this key' })).status, 409);
    messageId = first.data.id;
    const loaded = await api(route + '/review', official);
    assert.equal(loaded.data.messages[0].body, body.body); assert.equal(loaded.data.messages[0].role, 'admin'); assert.equal(loaded.data.unreadCount, 1);
    const recipients = await database.query("SELECT user_id FROM notifications WHERE report_id = ? AND title = 'New internal report message'", [id]);
    assert.deepEqual(recipients.map(row => Number(row.user_id)).sort(), [official.user.id, peer.user.id].sort());
    assert.ok(!recipients.some(row => [citizen.user.id, outsider.user.id, admin.user.id].includes(Number(row.user_id))));
    for (const recipient of recipients) {
      const user = (await database.query('SELECT role, barangay_id FROM users WHERE id = ?', [recipient.user_id]))[0];
      const report = (await database.query('SELECT barangay_id FROM reports WHERE id = ?', [id]))[0];
      assert.ok(user.role === 'admin' || user.role === 'barangay' && Number(user.barangay_id) === Number(report.barangay_id));
    }
    assert.equal(await count('report_coordination_messages'), 1);
    assert.equal(await count('audit_logs', "entity_id = ? AND action = 'coordination_message'"), 1);
  });
  await t.test('read cursors are report-scoped, monotonic and isolate each staff reader', async () => {
    assert.equal((await api(route + '/messages/read', official, 'POST', { lastMessageId: messageId })).data.unreadCount, 0);
    assert.equal((await api(route + '/messages/read', outsider, 'POST', { lastMessageId: messageId })).status, 403);
    assert.equal((await api(route + '/messages/read', official, 'POST', { lastMessageId: messageId + 999 })).status, 400);
    assert.equal((await api(route + '/review', official)).data.unreadCount, 0);
  });
  await t.test('blank, oversized and invalid message keys do not create records', async () => {
    for (const body of ['', '  ', 'x'.repeat(501), 2]) assert.equal((await api(route + '/messages', official, 'POST', { body, requestKey: randomUUID() })).status, 400);
    assert.equal((await api(route + '/messages', official, 'POST', { body: 'Valid message', requestKey: 'bad' })).status, 400);
    assert.equal(await count('report_coordination_messages'), 1);
  });
  await t.test('concurrent message retries commit exactly once', async () => {
    const body = { body: 'Crew scheduled a controlled inspection.', requestKey: randomUUID() };
    const results = await Promise.all([api(route + '/messages', official, 'POST', body), api(route + '/messages', official, 'POST', body)]);
    assert.deepEqual(results.map(result => result.status), [200, 200]); assert.equal(results[0].data.id, results[1].data.id);
    assert.equal(await count('report_coordination_messages'), 2);
    const { notifications, unreadCount } = (await api('/api/notifications', admin)).data;
    const notices = notifications.filter(row => row.type === 'coordination_message' && Number(row.reportId) === id);
    assert.equal(notices.length, 1);
    assert.equal(unreadCount, 1);
    assert.ok(!notices[0].message.includes(body.body));
    for (const user of [peer, outsider, uninvolvedAdmin, official, citizen]) {
      assert.equal((await api(`/api/notifications/${notices[0].id}/read`, user, 'PATCH')).status, 404);
    }
    assert.equal((await api('/api/notifications', uninvolvedAdmin)).data.notifications.length, 0);
    assert.equal((await api(`/api/notifications/${notices[0].id}/read`, admin, 'PATCH')).status, 200);
    assert.ok((await api('/api/notifications', admin)).data.notifications[0].readAt);
  });
  await t.test('failed message insert cannot produce a notification', async () => {
    const repository = require('../../server/infrastructure/repositories/reportReview.repository');
    const insert = t.mock.method(repository, 'createMessage', async () => { throw new Error('Controlled message insert failure'); });
    const before = await count('notifications');
    try {
      assert.equal((await api(route + '/messages', admin, 'POST', { body: 'Failed message insert', requestKey: randomUUID() })).status, 500);
    } finally { insert.mock.restore(); }
    assert.equal(await count('report_coordination_messages'), 2);
    assert.equal(await count('notifications'), before);
  });
  await t.test('message notification failure rolls back the message and audit together', async () => {
    const notifications = require('../../server/infrastructure/repositories/notification.repository');
    const stub = t.mock.method(notifications, 'create', async () => { throw new Error('Controlled notification persistence failure'); });
    const result = await api(route + '/messages', admin, 'POST', { body: 'Rolled back message', requestKey: randomUUID() }); stub.mock.restore();
    assert.equal(result.status, 500); assert.equal(await count('report_coordination_messages'), 2);
    assert.equal(await count('audit_logs', "entity_id = ? AND action = 'coordination_message'"), 2);
  });
  await t.test('default severity is review-required and manual confirmation has an audited impact reason', async () => {
    const body = { category: 'pothole', classification: 'MAJOR', evidence: { safety_impact: 'Inspector observed an unsafe vehicle obstruction.', depth_mm: 40 }, reason: 'Inspection confirmed serious road access impact.', requestKey: randomUUID(), expectedReviewId: 0 };
    assert.equal((await api(route + '/severity', official, 'POST', { ...body, evidence: {} })).status, 400);
    assert.equal((await api(route + '/severity', official, 'POST', { ...body, evidence: { confidence: 0.99 } })).status, 400);
    assert.equal((await api(route + '/severity', official, 'POST', { ...body, reason: '  ' })).status, 400);
    const result = await api(route + '/severity', official, 'POST', body);
    assert.equal(result.status, 200); assert.equal(result.data.assessment, 'REVIEW_REQUIRED');
    assert.equal(result.data.severityHistory[0].classification, 'MAJOR'); assert.equal(result.data.severityHistory[0].recommendation, null);
    const row = (await database.query('SELECT ai_classification, ai_priority FROM reports WHERE id = ?', [id]))[0];
    assert.equal(row.ai_classification, 'MAJOR'); assert.equal(row.ai_priority, 'High');
    assert.equal((await api(route + '/severity', official, 'POST', body)).data.replayed, true);
    assert.equal(await count('report_severity_reviews'), 1);
    assert.equal((await api(route + '/severity', admin, 'POST', { ...body, requestKey: randomUUID() })).status, 403);
  });
  await t.test('authorized overrides preserve previous values and race protection; undetermined clears fabricated priority', async () => {
    const latest = (await api(route + '/review', admin)).data.severityHistory[0];
    const body = { category: 'pothole', classification: 'MINOR', evidence: { safety_impact: 'Inspected obstruction removed; low residual impact.' }, reason: 'Follow-up inspection confirms limited remaining impact.', requestKey: randomUUID(), expectedReviewId: latest.id };
    const results = await Promise.all([api(route + '/severity', peer, 'POST', body), api(route + '/severity', official, 'POST', { ...body, requestKey: randomUUID() })]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const history = (await api(route + '/review', admin)).data.severityHistory;
    assert.equal(history[0].previousClassification, 'MAJOR'); assert.equal(history[0].classification, 'MINOR');
    const cleared = await api(route + '/severity', official, 'POST', { category: 'pothole', classification: null, evidence: {}, reason: 'Further inspection is required before confirming impact.', expectedReviewId: history[0].id, requestKey: randomUUID() });
    assert.equal(cleared.status, 200);
    const row = (await database.query('SELECT ai_classification, ai_priority FROM reports WHERE id = ?', [id]))[0];
    assert.equal(row.ai_classification, null); assert.equal(row.ai_priority, null);
  });
  await t.test('severity persistence failure rolls back current triage, review history and audit', async () => {
    const repo = require('../../server/infrastructure/repositories/reportReview.repository'), original = repo.saveSeverity.bind(repo);
    const before = await count('report_severity_reviews'), latest = (await api(route + '/review', admin)).data.severityHistory[0];
    const stub = t.mock.method(repo, 'saveSeverity', async (...args) => { await original(...args); throw new Error('Controlled severity write failure'); });
    const result = await api(route + '/severity', official, 'POST', { category: 'pothole', classification: 'MAJOR', evidence: { safety_impact: 'Controlled rollback inspection evidence' }, reason: 'Controlled rollback verification reason.', expectedReviewId: latest.id, requestKey: randomUUID() }); stub.mock.restore();
    assert.equal(result.status, 500); assert.equal(await count('report_severity_reviews'), before);
    assert.equal((await database.query('SELECT ai_classification FROM reports WHERE id = ?', [id]))[0].ai_classification, null);
  });
  await t.test('failed ongoing notification persistence rolls back status, history and audit', async () => {
    const notifications = require('../../server/infrastructure/repositories/notification.repository');
    const stub = t.mock.method(notifications, 'create', async () => { throw new Error('Controlled ongoing notification failure'); });
    let result;
    try { result = await api(route + '/status', official, 'PATCH', { status: 'ongoing', note: 'Controlled ongoing action.', requestKey: randomUUID() }); }
    finally { stub.mock.restore(); }
    assert.equal(result.status, 500);
    assert.equal((await database.query('SELECT status FROM reports WHERE id = ?', [id]))[0].status, 'pending');
    assert.equal(await count('report_status_history'), 0);
    assert.equal(await count('audit_logs', "entity_id = ? AND action = 'status_update'"), 0);
  });
  await t.test('failed rejection notification persistence rolls back the status, history and audit', async () => {
    const notifications = require('../../server/infrastructure/repositories/notification.repository');
    const stub = t.mock.method(notifications, 'create', async () => { throw new Error('Controlled rejection notification failure'); });
    const result = await api(route + '/status', official, 'PATCH', { status: 'rejected', note: 'Controlled rejected incident with notification failure.', requestKey: randomUUID() }); stub.mock.restore();
    assert.equal(result.status, 500);
    assert.equal((await database.query('SELECT status FROM reports WHERE id = ?', [id]))[0].status, 'pending');
    assert.equal(await count('report_status_history', "report_id = ? AND new_status = 'rejected'"), 0);
    assert.equal(await count('audit_logs', "entity_id = ? AND action = 'status_update'"), 0);
  });
  await t.test('operational rejection records reason, actor and notification without changing publication decisions', async () => {
    assert.equal((await api(route + '/status', official, 'PATCH', { status: 'rejected' })).status, 400);
    assert.equal((await api(route + '/status', citizen, 'PATCH', { status: 'rejected', note: 'Citizen cannot reject', requestKey: randomUUID() })).status, 403);
    assert.equal((await api(route + '/status', outsider, 'PATCH', { status: 'rejected', note: 'Foreign official cannot reject', requestKey: randomUUID() })).status, 403);
    const body = { status: 'rejected', note: 'Duplicate incident already recorded under a verified report.', requestKey: randomUUID() };
    assert.equal((await api(route + '/status', official, 'PATCH', body)).status, 200);
    assert.equal((await api(route + '/status', official, 'PATCH', body)).data.replayed, true);
    const rows = await database.query("SELECT * FROM report_status_history WHERE report_id = ? AND new_status = 'rejected'", [id]);
    assert.equal(rows.length, 1); assert.equal(rows[0].note, body.note); assert.equal(Number(rows[0].changed_by), official.user.id); assert.equal(rows[0].old_status, 'pending'); assert.ok(rows[0].created_at);
    const notification = (await database.query("SELECT * FROM notifications WHERE report_id = ? AND title = 'Report rejected'", [id]))[0];
    assert.equal(Number(notification.user_id), citizen.user.id); assert.ok(notification.message.includes(body.note));
    assert.equal((await api(route + '/status', official, 'PATCH', { status: 'ongoing' })).status, 400);
    assert.equal((await database.query('SELECT state FROM community_publication_requests WHERE report_id = ?', [id]))[0].state, 'pending_approval');
  });
  await t.test('message pagination retains chronological order and older reads cannot move the cursor backward', async () => {
    for (let index = 0; index < 55; index++) await database.execute('INSERT INTO report_coordination_messages (report_id, sender_id, sender_role, body, request_key) VALUES (?, ?, ?, ?, ?)', [id, admin.user.id, 'admin', `Pagination message ${index}`, randomUUID()]);
    const page = await api(route + '/review', official);
    assert.equal(page.status, 200); assert.equal(page.data.messages.length, 50); assert.equal(page.data.hasMore, true);
    assert.ok(page.data.messages.every((row, index, rows) => !index || row.id > rows[index - 1].id));
    const older = await api(route + '/review?before=' + page.data.messages[0].id, official);
    assert.equal(older.data.messages.length, 7); assert.equal(older.data.hasMore, false);
    assert.ok(older.data.messages.every(row => row.id < page.data.messages[0].id));
    assert.equal((await api(route + '/messages/read', official, 'POST', { lastMessageId: page.data.messages.at(-1).id })).data.unreadCount, 0);
    assert.equal((await api(route + '/messages/read', official, 'POST', { lastMessageId: older.data.messages[0].id })).data.unreadCount, 0);
    assert.equal((await api(route + '/review?before=invalid', official)).status, 400);
  });
  await t.test('staff read published citizen comments and replies with read-only scope and pagination', async () => {
    assert.equal((await api(route + '/citizen-comments', admin)).data.published, false);
    const created = await database.execute('INSERT INTO community_posts (barangay_id, author_id, is_official, body, report_id, request_key, request_hash) SELECT barangay_id, submitted_by, 0, description, id, ?, ? FROM reports WHERE id = ?', [randomUUID(), '1'.repeat(64), id]);
    const postId = created.insertId;
    const root = await database.execute('INSERT INTO community_comments (post_id, author_id, body, request_key) VALUES (?, ?, ?, ?)', [postId, citizen.user.id, '<script>literal citizen comment</script>', randomUUID()]);
    assert.equal((await api(route + '/citizen-comments', admin)).data.published, false);
    await database.execute('INSERT INTO community_publication_legacy (post_id) VALUES (?)', [postId]);
    await database.execute('INSERT INTO community_personas (post_id, user_id, display_name, avatar_variant) VALUES (?, ?, ?, ?)', [postId, citizen.user.id, 'ControlledResident_42', 2]);
    await database.execute('INSERT INTO community_comments (post_id, author_id, body, parent_id, request_key) VALUES (?, ?, ?, ?, ?)', [postId, citizen.user.id, 'Citizen reply', root.insertId, randomUUID()]);
    await database.execute('INSERT INTO community_comments (post_id, author_id, is_official, body, request_key) VALUES (?, ?, 1, ?, ?)', [postId, official.user.id, 'Official is not a citizen comment', randomUUID()]);
    await database.execute('INSERT INTO community_comments (post_id, author_id, body, deleted_at, request_key) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)', [postId, citizen.user.id, 'Deleted content', randomUUID()]);
    const result = await api(route + '/citizen-comments', official);
    assert.equal(result.status, 200); assert.equal(result.data.comments.length, 2);
    assert.equal(result.data.comments[0].author, 'ControlledResident_42'); assert.equal(result.data.comments[0].avatarVariant, 2);
    assert.equal(result.data.comments[0].body, '<script>literal citizen comment</script>'); assert.equal(Number(result.data.comments[1].parentId), Number(root.insertId));
    assert.ok(result.data.comments[0].createdAt); assert.equal(result.data.comments[0].authorId, undefined); assert.equal(result.data.comments[0].canEdit, undefined);
    assert.equal((await api(route + '/citizen-comments', admin, 'POST', { body: 'Forbidden edit' })).status, 404);
    assert.equal((await api(`/api/community/posts/${postId}/comments/${root.insertId}`, admin, 'PATCH', { body: 'Forbidden edit' })).status, 403);
    for (let index = 0; index < 33; index++) await database.execute('INSERT INTO community_comments (post_id, author_id, body, request_key) VALUES (?, ?, ?, ?)', [postId, citizen.user.id, `Additional citizen comment ${index}`, randomUUID()]);
    const latest = (await api(route + '/citizen-comments', admin)).data;
    assert.equal(latest.comments.length, 30); assert.equal(latest.hasMore, true);
    const older = (await api(route + '/citizen-comments?before=' + latest.comments[0].id, admin)).data;
    assert.equal(older.comments.length, 5); assert.equal(older.hasMore, false);
    assert.equal((await api(route + '/citizen-comments?before=invalid', admin)).status, 400);
  });
  await t.test('message length boundary and spoofed sender fields retain authenticated staff authority', async () => {
    const value = 'A'.repeat(500), key = randomUUID();
    const result = await api(route + '/messages', admin, 'POST', { body: value, requestKey: key, senderId: citizen.user.id, senderRole: 'citizen', recipientId: outsider.user.id });
    assert.equal(result.status, 200);
    const row = (await database.query('SELECT sender_id, sender_role, body FROM report_coordination_messages WHERE id = ?', [result.data.id]))[0];
    assert.equal(Number(row.sender_id), Number(admin.user.id)); assert.equal(row.sender_role, 'admin'); assert.equal(row.body, value);
    assert.equal((await api(route + '/messages', admin, 'POST', { body: value, requestKey: key })).data.replayed, true);
  });
  await t.test('authorized GET endpoints do not create report events, notifications or coordination read records', async () => {
    async function snapshot() {
      const result = {};
      for (const table of ['reports', 'report_status_history', 'report_severity_reviews', 'report_coordination_messages', 'report_coordination_reads', 'notifications', 'audit_logs']) result[table] = await database.query(`SELECT * FROM ${table} ORDER BY ${table === 'report_coordination_reads' ? 'report_id, user_id' : 'id'}`);
      return JSON.stringify(result);
    }
    const before = await snapshot();
    for (const suffix of ['', '/history', '/review', '/citizen-comments']) assert.equal((await api(route + suffix, admin)).status, 200);
    assert.equal(await snapshot(), before);
  });
  await t.test('a post-commit delivery failure preserves notifications and continues delivery to the next recipient', async () => {
    const events = require('../../server/infrastructure/events/notificationEvents');
    const attempted = [];
    const publish = t.mock.method(events, 'publish', notice => {
      attempted.push(notice);
      if (attempted.length === 1) throw new Error('Controlled post-commit delivery failure');
    });
    const body = { body: 'Recoverable notification after a delivery failure', requestKey: randomUUID() };
    let result;
    try { result = await api(route + '/messages', admin, 'POST', body); }
    finally { publish.mock.restore(); }
    assert.equal(result.status, 200);
    assert.deepEqual(attempted.map(notice => Number(notice.userId)).sort(), [official.user.id, peer.user.id].sort());
    for (const notice of attempted) {
      const user = Number(notice.userId) === official.user.id ? official : peer;
      const list = await api('/api/notifications', user);
      assert.ok(list.data.notifications.some(row => Number(row.id) === Number(notice.id)));
    }
    const retry = await api(route + '/messages', admin, 'POST', body);
    assert.deepEqual(retry.data, { id: result.data.id, replayed: true });
  });
  await t.test('first Barangay message alerts each active Admin, atomically and once per request', async () => {
    const suspended = await actor('review_suspended_admin', 'admin');
    await database.execute("UPDATE users SET status = 'suspended' WHERE id = ?", [suspended.user.id]);
    const { insertId: firstId } = await database.execute(
      'INSERT INTO reports (description, barangay, barangay_id, submitted_by, status) SELECT description, barangay, barangay_id, submitted_by, status FROM reports WHERE id = ?', [id]);
    const firstRoute = `/api/reports/${firstId}`;
    const body = { body: 'First contact from the responsible Barangay', requestKey: randomUUID(), recipientId: outsider.user.id };
    const notifications = require('../../server/infrastructure/repositories/notification.repository');
    const create = notifications.create.bind(notifications);
    let inserts = 0;
    const fault = t.mock.method(notifications, 'create', async (...args) => {
      if (++inserts === 2) throw new Error('Controlled first-contact notification failure');
      return create(...args);
    });
    try { assert.equal((await api(firstRoute + '/messages', official, 'POST', body)).status, 500); }
    finally { fault.mock.restore(); }
    for (const table of ['report_coordination_messages', 'notifications']) assert.equal(await count(table, 'report_id = ?', firstId), 0);
    assert.equal(inserts, 2);
    const sent = await Promise.all(Array.from({ length: 2 }, () => api(firstRoute + '/messages', official, 'POST', body)));
    assert.deepEqual(sent.map(result => result.status), [200, 200]);
    assert.equal(sent[0].data.id, sent[1].data.id);
    assert.equal(await count('report_coordination_messages', 'report_id = ?', firstId), 1);
    const expected = await database.query("SELECT id FROM users WHERE status = 'active' AND role = 'admin' ORDER BY id");
    const actual = await database.query('SELECT user_id, type, message FROM notifications WHERE report_id = ? ORDER BY user_id', [firstId]);
    assert.deepEqual(actual.map(row => Number(row.user_id)), expected.map(row => Number(row.id)));
    assert.ok(actual.length >= 2);
    assert.ok(actual.every(row => row.type === 'coordination_message' && !row.message.includes(body.body)));
    for (const recipient of [admin, uninvolvedAdmin]) {
      assert.ok(actual.some(row => Number(row.user_id) === recipient.user.id));
      const review = await api(firstRoute + '/review', recipient);
      assert.equal(review.status, 200);
      assert.equal(review.data.messages[0].body, body.body);
    }
    assert.equal((await api(firstRoute + '/review', suspended)).status, 401);
    for (const user of [outsider, citizen]) assert.equal((await api(firstRoute + '/review', user)).status, 403);
  });
  await t.test('first contact with no eligible Admin persists and records zero recipients', async () => {
    const { insertId: firstId } = await database.execute(
      'INSERT INTO reports (description, barangay, barangay_id, submitted_by, status) SELECT description, barangay, barangay_id, submitted_by, status FROM reports WHERE id = ?', [id]);
    const active = await database.query("SELECT id FROM users WHERE status = 'active' AND role = 'admin'");
    await database.execute("UPDATE users SET status = 'suspended' WHERE status = 'active' AND role = 'admin'");
    try {
      const result = await api(`/api/reports/${firstId}/messages`, official, 'POST', { body: 'First contact with no eligible Admin', requestKey: randomUUID() });
      assert.equal(result.status, 200);
      assert.equal(await count('report_coordination_messages', 'report_id = ?', firstId), 1);
      assert.equal(await count('notifications', 'report_id = ?', firstId), 0);
      const [entry] = await database.query("SELECT details FROM audit_logs WHERE action = 'coordination_message' AND entity_id = ?", [firstId]);
      const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
      assert.equal(details.notification_recipient_count, 0);
    } finally {
      for (const user of active) await database.execute("UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    }
  });
}

module.exports = { reportReviewScenarios };
