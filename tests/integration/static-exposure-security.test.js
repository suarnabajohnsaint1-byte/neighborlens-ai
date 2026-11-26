const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('../support/test-app');

const app = createTestApp();
let server;
let baseUrl;

test.before(() => new Promise(resolve => {
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => server.close());

test('legitimate frontend assets are served correctly', async () => {
  const loginRes = await fetch(`${baseUrl}/login.html`);
  assert.equal(loginRes.status, 200);
  const loginText = await loginRes.text();
  assert.match(loginText, /NeighborLens/i);

  const cssRes = await fetch(`${baseUrl}/styles/style.css`);
  assert.equal(cssRes.status, 200);

  const jsRes = await fetch(`${baseUrl}/js/map/geofence.js`);
  assert.equal(jsRes.status, 200);

  const rootRes = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(rootRes.status, 302);
  assert.equal(rootRes.headers.get('location'), '/login.html');
});

test('sensitive server source files cannot be retrieved via static requests', async () => {
  const probes = [
    '/server/app.js',
    '/server/config/env.js',
    '/server/infrastructure/config/env.js',
    '/server/services/report.service.js',
    '/server/neighborlens.db',
    '/package.json',
    '/package-lock.json',
    '/.env',
    '/.env.example',
    '/tests/integration/reports.test.js',
    '/scripts/yolo/train_baseline.py',
    '/ai/training/train_baseline.py',
    '/frontend/login.html',
    '/models/production/best.pt',
    '/storage/uploads/',
    '/ai/evaluate.py'
  ];

  for (const probe of probes) {
    const response = await fetch(`${baseUrl}${probe}`);
    assert.equal(response.status, 404, `${probe} must not be publicly accessible (expected 404, got ${response.status})`);
  }
});
