const assert = require('node:assert/strict');

const OFFICIAL_PASSWORD = 'Official1234';

async function login(baseUrl, username, password, portal = 'citizen') {
  const response = await fetch(`${baseUrl}/api/auth/${portal}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200, `login for ${username} should succeed`);
  return response.json();
}

function adminSession(baseUrl) {
  return login(baseUrl, 'admin', 'admin123', 'admin');
}

async function createOfficial(baseUrl, adminToken, barangay, prefix = 'official') {
  const username = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`.slice(0, 64);
  const response = await fetch(`${baseUrl}/api/admin/barangay-users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: OFFICIAL_PASSWORD, barangay, fullName: `Official ${barangay}` })
  });
  assert.equal(response.status, 201, `official for ${barangay} should be created`);
  const created = await response.json();
  const session = await login(baseUrl, username, OFFICIAL_PASSWORD, 'barangay');
  return { ...session, username, password: OFFICIAL_PASSWORD, id: created.user.id };
}

async function streamUrl(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/notifications/stream-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200, 'stream ticket should be issued');
  const { ticket } = await response.json();
  return `${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`;
}

module.exports = { OFFICIAL_PASSWORD, login, adminSession, createOfficial, streamUrl };
