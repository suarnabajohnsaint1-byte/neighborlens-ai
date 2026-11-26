const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen } = require('../support/citizens');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
process.env.TEST_DB_FILE = path.join(os.tmpdir(), `neighborlens-enhancements-${randomUUID()}.sqlite`);
process.env.STORAGE_DRIVER = 'local';
const { startTestServer, testDatabase } = require('../support/test-app');
const rules = require('../../server/domain/community/community.rules');
const { adminSession } = require('../support/accounts');
const { approvePublication } = require('../support/publication');

let server, base, citizenA, citizenB, post1, post2;

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

async function register(username, barangay = 'Barangay 1') {
  return seedCitizen({ username, password: 'FixturePass123!', fullName: 'Citizen Legal Name', barangay });
}

test.before(async () => {
  let sequence = 100;
  test.mock.method(require('../../server/infrastructure/security/communityPersona'), 'generate', () => ({ displayName: `FixtureOtter_${++sequence}`, avatarVariant: sequence % 4 }));
  const started = await startTestServer();
  server = started.server;
  base = started.baseUrl;
  citizenA = await register('citizen_alpha');
  citizenB = await register('citizen_beta');
  const admin = await adminSession(base);

  const report1 = (await testDatabase().execute(
    'INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
    ['Report One', 'Location One', 'Barangay 1', 1, citizenA.user.id, 'pothole']
  )).insertId;

  const report2 = (await testDatabase().execute(
    'INSERT INTO reports (description, location, barangay, barangay_id, submitted_by, ai_category) VALUES (?, ?, ?, ?, ?, ?)',
    ['Report Two', 'Location Two', 'Barangay 1', 1, citizenB.user.id, 'damaged_street_light']
  )).insertId;

  const pub1 = await (await request('/posts', citizenA, 'POST', {
    body: 'Public Post One',
    requestKey: randomUUID(),
    reportId: report1
  })).json();
  assert.equal(pub1.publication.state, 'pending_approval');
  post1 = await approvePublication(base, report1, admin, citizenA);

  const pub2 = await (await request('/posts', citizenB, 'POST', {
    body: 'Public Post Two',
    requestKey: randomUUID(),
    reportId: report2
  })).json();
  assert.equal(pub2.publication.state, 'pending_approval');
  post2 = await approvePublication(base, report2, admin, citizenB);
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  testDatabase().close();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.unlink(process.env.TEST_DB_FILE + suffix).catch(() => {});
  }
});

test('persistent anonymous identity: citizen A has same persona across multiple comments and replies', async () => {
  const c1Res = await request(`/posts/${post1.id}/comments`, citizenA, 'POST', { body: 'First comment by A', requestKey: randomUUID() });
  assert.equal(c1Res.status, 200);

  const c2Res = await request(`/posts/${post1.id}/comments`, citizenA, 'POST', { body: 'Second comment by A', requestKey: randomUUID() });
  assert.equal(c2Res.status, 200);

  const c3Res = await request(`/posts/${post1.id}/comments`, citizenA, 'POST', { body: 'Third comment by A', requestKey: randomUUID() });
  assert.equal(c3Res.status, 200);

  const list = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  assert.equal(list.comments.length, 3);

  const personaA = list.comments[0].author.pseudonym;
  const avatarA = list.comments[0].author.avatarVariant;
  assert.ok(personaA);
  assert.notEqual(personaA, 'Anonymous resident');
  assert.equal(list.comments[1].author.pseudonym, personaA);
  assert.equal(list.comments[1].author.avatarVariant, avatarA);
  assert.equal(list.comments[2].author.pseudonym, personaA);
  assert.equal(list.comments[2].author.avatarVariant, avatarA);

  const cBRes = await request(`/posts/${post1.id}/comments`, citizenB, 'POST', {
    body: 'Reply by citizen B to A',
    requestKey: randomUUID(),
    parentId: list.comments[0].id
  });
  assert.equal(cBRes.status, 200);

  const listAfterB = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  const replyB = listAfterB.comments.find(c => c.body === 'Reply by citizen B to A');
  assert.ok(replyB);
  assert.equal(replyB.parentId, list.comments[0].id);
  assert.notEqual(replyB.author.pseudonym, personaA);

  const cAReplyRes = await request(`/posts/${post1.id}/comments`, citizenA, 'POST', {
    body: 'Citizen A replies back to B',
    requestKey: randomUUID(),
    parentId: replyB.id
  });
  assert.equal(cAReplyRes.status, 200);

  const finalList = await (await request(`/posts/${post1.id}/comments`, citizenB)).json();
  const replyBackA = finalList.comments.find(c => c.body === 'Citizen A replies back to B');
  assert.ok(replyBackA);
  assert.equal(replyBackA.author.pseudonym, personaA);
  assert.equal(replyBackA.author.avatarVariant, avatarA);
});

test('isolated persona per report discussion: citizen persona on post 2 is independent from post 1', async () => {
  const commentOnPost2 = await request(`/posts/${post2.id}/comments`, citizenA, 'POST', {
    body: 'Comment on separate report discussion',
    requestKey: randomUUID()
  });
  assert.equal(commentOnPost2.status, 200);

  const listPost1 = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  const listPost2 = await (await request(`/posts/${post2.id}/comments`, citizenA)).json();

  const personaPost1 = listPost1.comments[0].author.pseudonym;
  const personaPost2 = listPost2.comments[0].author.pseudonym;
  assert.ok(personaPost1);
  assert.ok(personaPost2);
  assert.notEqual(personaPost1, personaPost2);
  const assignments = await testDatabase().query('SELECT post_id, display_name FROM community_personas WHERE user_id = ? AND post_id IN (?, ?) ORDER BY post_id', [citizenA.user.id, post1.id, post2.id]);
  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments.map(row => Number(row.post_id)), [post1.id, post2.id]);
  assert.deepEqual(assignments.map(row => row.display_name), [personaPost1, personaPost2]);
});

test('comment threading: validates parent comment belongs to the same post and rejects cross-report reply', async () => {
  const listPost2 = await (await request(`/posts/${post2.id}/comments`, citizenB)).json();
  const post2CommentId = listPost2.comments[0].id;

  const crossReportReply = await request(`/posts/${post1.id}/comments`, citizenB, 'POST', {
    body: 'Invalid cross-report reply',
    requestKey: randomUUID(),
    parentId: post2CommentId
  });
  assert.equal(crossReportReply.status, 400);

  const nonExistentReply = await request(`/posts/${post1.id}/comments`, citizenB, 'POST', {
    body: 'Invalid non-existent parent',
    requestKey: randomUUID(),
    parentId: 999999
  });
  assert.equal(nonExistentReply.status, 400);
});

test('comment deletion preserves placeholder for active conversation threads', async () => {
  const list = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  const parentComment = list.comments.find(c => c.body === 'First comment by A');
  assert.ok(parentComment);

  const deleteRes = await request(`/posts/${post1.id}/comments/${parentComment.id}`, citizenA, 'DELETE');
  assert.equal(deleteRes.status, 200);

  const afterDelete = await (await request(`/posts/${post1.id}/comments`, citizenB)).json();
  const deletedPlaceholder = afterDelete.comments.find(c => c.id === parentComment.id);
  assert.ok(deletedPlaceholder);
  assert.equal(deletedPlaceholder.isDeleted, true);
  assert.equal(deletedPlaceholder.body, 'This comment has been deleted.');
  assert.equal(deletedPlaceholder.canEdit, false);
  assert.equal(deletedPlaceholder.canDelete, false);

  const childReply = afterDelete.comments.find(c => c.parentId === parentComment.id);
  assert.ok(childReply);
  assert.equal(childReply.body, 'Reply by citizen B to A');
});

test('comment reactions: like toggle, distinct reactor tracking, and optimistic state persistence', async () => {
  const list = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  const targetComment = list.comments.find(c => c.body === 'Second comment by A');
  assert.ok(targetComment);

  const like1 = await (await request(`/posts/${post1.id}/comments/${targetComment.id}/reaction`, citizenB, 'PUT')).json();
  assert.equal(like1.reacted, true);
  assert.equal(like1.total, 1);

  const checkAfterLike1 = await (await request(`/posts/${post1.id}/comments`, citizenB)).json();
  const commentAfterLike1 = checkAfterLike1.comments.find(c => c.id === targetComment.id);
  assert.equal(commentAfterLike1.reactions.total, 1);
  assert.equal(commentAfterLike1.reactions.mine, true);

  const checkByCitizenA = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  const commentSeenByA = checkByCitizenA.comments.find(c => c.id === targetComment.id);
  assert.equal(commentSeenByA.reactions.total, 1);
  assert.equal(commentSeenByA.reactions.mine, false);

  const likeByA = await (await request(`/posts/${post1.id}/comments/${targetComment.id}/reaction`, citizenA, 'PUT')).json();
  assert.equal(likeByA.reacted, true);
  assert.equal(likeByA.total, 2);

  const unlike1 = await (await request(`/posts/${post1.id}/comments/${targetComment.id}/reaction`, citizenB, 'PUT')).json();
  assert.equal(unlike1.reacted, false);
  assert.equal(unlike1.total, 1);

  const checkFinal = await (await request(`/posts/${post1.id}/comments`, citizenB)).json();
  const commentFinal = checkFinal.comments.find(c => c.id === targetComment.id);
  assert.equal(commentFinal.reactions.total, 1);
  assert.equal(commentFinal.reactions.mine, false);
});

test('accurate ISO 8601 UTC date serialization on posts and comments', async () => {
  const postData = await (await request(`/posts/${post1.id}`, citizenA)).json();
  assert.match(postData.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const commentData = await (await request(`/posts/${post1.id}/comments`, citizenA)).json();
  assert.ok(commentData.comments.length > 0);
  assert.match(commentData.comments[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
