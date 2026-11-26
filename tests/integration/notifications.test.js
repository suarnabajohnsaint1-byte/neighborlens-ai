const { streamUrl, createOfficial } = require('../support/accounts');
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const { createTestApp } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

const app = createTestApp();

let server;
let baseUrl;
let citizenToken;
let adminToken;
let barangayToken;
let createdReportId;
let notificationId;

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function buildReportForm() {
  const form = new FormData();
  form.append('description', 'Notification integration test damage');
  form.append('location', '123 Main Street');
  form.append('barangay', 'Barangay 1');
  form.append('latitude', '10.6780');
  form.append('longitude', '122.9460');
  form.append('gpsAccuracy', '15');
  form.append('gpsFixAt', String(freshReportFixAt()));
  form.append('aiCategory', 'Road Hazard');
  form.append('landmarkDescription', 'Beside the school entrance.');
  form.append('images', jpegFile('p1.jpg'));
  form.append('images', jpegFile('p2.jpg', SECOND_JPEG_BYTES));
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

  const username = `notif_cit_${Date.now()}`;
  ({ token: citizenToken } = await seedCitizen({ username, password: 'password123', fullName: 'Notification Citizen', reporting: true }));

  const adminLogin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  adminToken = (await adminLogin.json()).token;
  barangayToken = (await createOfficial(baseUrl, adminToken, 'Barangay 1', 'notification_staff')).token;

  const reportRes = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` },
    body: buildReportForm()
  });
  const reportData = await reportRes.json();
  createdReportId = reportData.id;
});

test.after(() => server.close());

test('GET /api/notifications returns 401 without authentication', async () => {
  const res = await fetch(`${baseUrl}/api/notifications`);
  assert.equal(res.status, 401);
});

test('report submission creates database-backed report_submitted notification for owner', async () => {
  const notifRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(notifRes.status, 200);
  const data = await notifRes.json();
  const submissionNotif = data.notifications.find(n => n.reportId === createdReportId && n.type === 'report_submitted');
  assert.ok(submissionNotif);
  assert.equal(submissionNotif.title, 'Report submitted');
  assert.match(submissionNotif.message, /pending review/);
});

test('updating report status creates database-backed notification for owner', async () => {
  const updateRes = await fetch(`${baseUrl}/api/reports/${createdReportId}/status`, {
    method: 'PATCH',
    headers: {
      'content-Type': 'application/json',
      Authorization: `Bearer ${barangayToken}`
    },
    body: JSON.stringify({ status: 'ongoing' })
  });
  assert.equal(updateRes.status, 200);

  const notifRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(notifRes.status, 200);
  const data = await notifRes.json();
  assert.ok(Array.isArray(data.notifications));
  assert.ok(data.notifications.length >= 1);

  const found = data.notifications.find(n => n.reportId === createdReportId);
  assert.ok(found);
  assert.equal(found.title, 'Report status updated');
  assert.match(found.message, /Ongoing/);
  assert.equal(found.readAt, null);
  notificationId = found.id;
});

test('GET /api/notifications/unread-count returns accurate count', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/unread-count`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.unreadCount >= 1);
});

test('PATCH /api/notifications/:id/read marks notification as read', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/${notificationId}/read`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.id, notificationId);

  const check = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  const notifs = (await check.json()).notifications;
  const target = notifs.find(n => n.id === notificationId);
  assert.ok(target.readAt !== null);
});

test('POST /api/notifications/mark-all-read clears all unread notifications', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/mark-all-read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.unreadCount, 0);

  const countRes = await fetch(`${baseUrl}/api/notifications/unread-count`, {
    headers: { Authorization: `Bearer ${citizenToken}` }
  });
  assert.equal((await countRes.json()).unreadCount, 0);
});

test('GET /api/notifications/stream authenticates and sends stream headers', async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(await streamUrl(baseUrl, citizenToken), {
      signal: controller.signal
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timeout);
  }
});
