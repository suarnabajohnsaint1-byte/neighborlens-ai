const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('../support/test-app');

const app = createTestApp();

let server;
let baseUrl;
let token;

test.before(() => new Promise(resolve => {
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => server.close());

test('health endpoint is available', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'neighborlens-api' });
});

test('login returns a token for the seeded admin', async () => {
  const response = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.role, 'admin');
  assert.ok(body.token);
  token = body.token;
});

test('reports require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/reports`);
  assert.equal(response.status, 401);
});

test('damage inference requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('dual damage verification requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/ai/damage-pair`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('admin can view users and audit logs', async () => {
  const headers = { authorization: `Bearer ${token}` };
  const users = await fetch(`${baseUrl}/api/admin/users`, { headers });
  const logs = await fetch(`${baseUrl}/api/admin/audit-logs`, { headers });
  assert.equal(users.status, 200);
  assert.equal(logs.status, 200);
  assert.ok((await logs.json()).logs.length >= 1);
});

