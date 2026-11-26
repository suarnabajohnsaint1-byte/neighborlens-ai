const { streamUrl } = require('../support/accounts');
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const { createTestApp } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const { createNotificationService } = require('../../server/application/use-cases/notification.service');
const notificationEvents = require('../../server/infrastructure/events/notificationEvents');

const app = createTestApp();

let server;
let baseUrl;
let userAToken;
let userBToken;
let adminToken;
let userAReportId;
let userANotificationId;

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function buildReportForm(desc = 'Security test damage') {
  const form = new FormData();
  form.append('description', desc);
  form.append('location', '456 Security Ave');
  form.append('barangay', 'Barangay Central');
  form.append('latitude', '10.6780');
  form.append('longitude', '122.9460');
  form.append('gpsAccuracy', '15');
  form.append('gpsFixAt', String(freshReportFixAt()));
  form.append('aiCategory', 'Pothole');
  form.append('landmarkDescription', 'Beside the school entrance.');
  form.append('images', jpegFile('s1.jpg'));
  form.append('images', jpegFile('s2.jpg', SECOND_JPEG_BYTES));
  form.append('landmarkImage', jpegFile('landmark.jpg'));
  return form;
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  ({ token: userAToken } = await seedCitizen({ username: `sec_user_a_${Date.now()}`, password: 'password123', barangay: 'Barangay Central', reporting: true }));

  ({ token: userBToken } = await seedCitizen({ username: `sec_user_b_${Date.now()}`, password: 'password123', barangay: 'Barangay Central', reporting: true }));

  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  adminToken = (await adminLogin.json()).token;

  const reportRes = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userAToken}` },
    body: buildReportForm('User A initial report')
  });
  const reportData = await reportRes.json();
  userAReportId = reportData.id;

  const notifRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${userAToken}` }
  });
  const notifData = await notifRes.json();
  const notif = notifData.notifications.find(n => n.reportId === userAReportId);
  userANotificationId = notif.id;
});

test.after(() => server.close());

test('security: unauthorized requests are rejected across all notification endpoints', async () => {
  const listRes = await fetch(`${baseUrl}/api/notifications`);
  assert.equal(listRes.status, 401);

  const countRes = await fetch(`${baseUrl}/api/notifications/unread-count`);
  assert.equal(countRes.status, 401);

  const readRes = await fetch(`${baseUrl}/api/notifications/1/read`, { method: 'PATCH' });
  assert.equal(readRes.status, 401);

  const allReadRes = await fetch(`${baseUrl}/api/notifications/mark-all-read`, { method: 'POST' });
  assert.equal(allReadRes.status, 401);

  const streamRes = await fetch(`${baseUrl}/api/notifications/stream`);
  assert.equal(streamRes.status, 401);

  const invalidTokenRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: 'Bearer totally.invalid.token' }
  });
  assert.equal(invalidTokenRes.status, 401);
});

test('security: IDOR prevention - User B cannot mark User A notification as read', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/${userANotificationId}/read`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${userBToken}` }
  });
  assert.equal(res.status, 404);

  const checkA = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${userAToken}` }
  });
  const notifsA = (await checkA.json()).notifications;
  const target = notifsA.find(n => n.id === userANotificationId);
  assert.equal(target.readAt, null);
});

test('security: client-supplied user parameters cannot override authenticated user context', async () => {
  const res = await fetch(`${baseUrl}/api/notifications?userId=9999&user_id=9999`, {
    headers: { Authorization: `Bearer ${userAToken}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.notifications.every(n => n.userId !== 9999));
});

test('security: input validation rejects malformed pagination limits', async () => {
  const badLimits = ['abc', '-1', '0', '101', '1.5', '1e5', 'NaN'];
  for (const limit of badLimits) {
    const res = await fetch(`${baseUrl}/api/notifications?limit=${encodeURIComponent(limit)}`, {
      headers: { Authorization: `Bearer ${userAToken}` }
    });
    assert.equal(res.status, 400, `Expected limit=${limit} to be rejected with 400`);
    const data = await res.json();
    assert.match(data.error, /limit/i);
  }
});

test('security: input validation rejects malformed pagination offsets', async () => {
  const badOffsets = ['xyz', '-5', '2.5', 'NaN', '1e4'];
  for (const offset of badOffsets) {
    const res = await fetch(`${baseUrl}/api/notifications?offset=${encodeURIComponent(offset)}`, {
      headers: { Authorization: `Bearer ${userAToken}` }
    });
    assert.equal(res.status, 400, `Expected offset=${offset} to be rejected with 400`);
    const data = await res.json();
    assert.match(data.error, /offset/i);
  }
});

test('security: input validation rejects malformed notification IDs', async () => {
  const badIds = ['abc', '-10', '0', '1.2', '999999999999999999999', 'undefined', 'null'];
  for (const id of badIds) {
    const res = await fetch(`${baseUrl}/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userAToken}` }
    });
    assert.equal(res.status, 400, `Expected id=${id} to be rejected with 400`);
  }
});

test('security: SQL injection attempts in notification ID are safely rejected', async () => {
  const sqliPayloads = [
    '1 OR 1=1',
    '1; DROP TABLE notifications;',
    "1' UNION SELECT * FROM users --",
    '1%20OR%201=1'
  ];
  for (const payload of sqliPayloads) {
    const res = await fetch(`${baseUrl}/api/notifications/${encodeURIComponent(payload)}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userAToken}` }
    });
    assert.equal(res.status, 400);
  }
});

test('security: concurrent mark-as-read requests execute atomically and idempotently', async () => {
  const requests = Array.from({ length: 10 }, () =>
    fetch(`${baseUrl}/api/notifications/${userANotificationId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userAToken}` }
    })
  );

  const responses = await Promise.all(requests);
  for (const res of responses) {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, userANotificationId);
  }

  const check = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${userAToken}` }
  });
  const data = await check.json();
  const target = data.notifications.find(n => n.id === userANotificationId);
  assert.ok(target.readAt !== null);
});

test('security: publisher failures do not crash notification service or caller', async () => {
  const faultyEvents = {
    publish: () => {
      throw new Error('Simulated event bus failure');
    }
  };
  const mockRepo = {
    create: async (data) => ({ id: 555, ...data })
  };
  const service = createNotificationService({
    notificationRepository: mockRepo,
    notificationEvents: faultyEvents
  });

  const result = await service.notifyReportSubmitted({
    report: { id: 77, submitted_by: 12, ai_category: 'pothole' }
  });
  assert.ok(result);
  assert.equal(result.id, 555);
});

test('security: realtime event broadcaster does not emit global notification events', async () => {
  let leakedEvent = null;
  const listener = (event) => {
    leakedEvent = event;
  };
  notificationEvents.on('notification', listener);

  try {
    notificationEvents.publish({ id: 999, userId: 1234, title: 'Private' });
    assert.equal(leakedEvent, null);
  } finally {
    notificationEvents.off('notification', listener);
  }
});

test('security: stream listener cleanup on client disconnect', async () => {
  const tokens = require('../../server/infrastructure/security/tokenProvider');
  const owner = tokens.verify(userBToken), other = tokens.verify(userAToken);
  const controller = new AbortController();
  const streamRes = await fetch(`${await streamUrl(baseUrl, userBToken)}&userId=${other.id}`, {
    signal: controller.signal
  });
  assert.equal(streamRes.status, 200);
  assert.equal(notificationEvents.getActiveConnections(owner.id), 1);
  assert.equal(notificationEvents.getActiveConnections(other.id), 0);

  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 200));

  const activeCount = notificationEvents.getActiveConnections(owner.id);
  assert.equal(activeCount, 0);
});

test('security: a stream closes when its bearer session expires and unused tickets cannot extend it', async () => {
  const tokens = require('../../server/infrastructure/security/tokenProvider');
  const account = tokens.verify(userBToken);
  const shortToken = tokens.issue({ ...account, tokenVersion: account.tv }, 3);
  const [active, unused] = await Promise.all([streamUrl(baseUrl, shortToken), streamUrl(baseUrl, shortToken)]);
  const response = await fetch(active, { signal: AbortSignal.timeout(6000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), ': connected\n\n');
  assert.equal(notificationEvents.getActiveConnections(account.id), 0);
  assert.equal((await fetch(unused)).status, 401);
});

test('security: concurrent stream limit prevents unbounded listener exhaustion', async () => {
  const controllers = [];
  const authUserA = require('../../server/composition').authService.verifyToken(userAToken);

  try {
    for (let i = 0; i < 5; i++) {
      const c = new AbortController();
      controllers.push(c);
      await fetch(await streamUrl(baseUrl, userAToken), {
        signal: c.signal
      });
    }

    const excessRes = await fetch(await streamUrl(baseUrl, userAToken));
    assert.equal(excessRes.status, 429);
    const data = await excessRes.json();
    assert.match(data.error, /Too many active event streams/i);
  } finally {
    for (const c of controllers) {
      c.abort();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
});

test('security: logout closes the active stream and invalidates outstanding tickets', async () => {
  const [active, unused] = await Promise.all([streamUrl(baseUrl, userBToken), streamUrl(baseUrl, userBToken)]);
  const response = await fetch(active, { signal: AbortSignal.timeout(6000) });
  assert.equal(response.status, 200);
  const logout = await fetch(baseUrl + '/api/auth/logout', {
    method: 'POST', headers: { Authorization: `Bearer ${userBToken}` }
  });
  assert.equal(logout.status, 200);
  assert.match(await response.text(), /"event":"session_revoked"/);
  assert.equal((await fetch(unused)).status, 401);
});
