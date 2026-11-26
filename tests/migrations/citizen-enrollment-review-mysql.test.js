const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const sharp = require('sharp');
const { privateMysql, waitExit } = require('../support/private-mysql');

async function startLocalScreening(t, secret) {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const python = process.env.ENROLLMENT_TEST_PYTHON || (process.platform === 'win32'
    ? path.resolve('.venv/Scripts/python.exe') : 'python3');
  const child = spawn(python, ['-m', 'uvicorn', 'ai.identity.forensics_api:app',
    '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], {
    env: { ...process.env, IDENTITY_RESEARCH_MODEL: 'none', REGISTRATION_FRAUD_SECRET: secret },
    stdio: 'ignore', windowsHide: true
  });
  const exited = waitExit(child, 120_000);
  void exited.catch(() => {});
  t.after(async () => {
    child.kill();
    await exited.catch(() => {});
  });
  const url = `http://127.0.0.1:${port}/assess-capture`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(url).catch(() => null);
    if (response?.status === 405) return url;
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Isolated FastAPI screening failed to start.');
}

test('production config works without issuer credentials, with signed local screening and retired legacy MySQL review routes', { timeout: 110_000 }, async t => {
  const mysql = await privateMysql(t);
  t.after(mysql.close);
  const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
  const migration = '021_citizen_enrollment_review.sql';
  assert.ok((await runMigrations(mysql.pool)).applied.includes(migration));
  assert.deepEqual((await runMigrations(mysql.pool)).applied, []);
  await mysql.adapter.execute(`INSERT INTO users (id, username, password_hash, role, barangay) VALUES
    (801, 'fictional_enrollment_reviewer', 'unused', 'admin', ''),
    (802, 'fictional_unassigned_admin', 'unused', 'admin', ''),
    (803, 'fictional_citizen', 'unused', 'citizen', 'Villamonte')`);
  const fraudSecret = randomBytes(32).toString('hex');
  process.env.REGISTRATION_FRAUD_URL = await startLocalScreening(t, fraudSecret);
  let useScreeningFixture = false;
  const fetchReal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!useScreeningFixture || String(url) !== process.env.REGISTRATION_FRAUD_URL) return fetchReal(url, options);
    const form = options.body;
    const frame = Buffer.from(await form.get('frames').arrayBuffer());
    const body = JSON.stringify({
      captureId: form.get('captureId'), framesSha256: [createHash('sha256').update(frame).digest('hex')],
      purpose: 'registration_fraud_assessment', assessment: 'clear',
      checks: { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' }
    });
    return new Response(body, { headers: {
      'X-Registration-Fraud-Signature': createHmac('sha256', fraudSecret).update(body).digest('hex')
    } });
  });
  process.env.REGISTRATION_FRAUD_SECRET = fraudSecret;
  process.env.REGISTRATION_FINGERPRINT_KEY = randomBytes(32).toString('hex');
  process.env.REGISTRATION_REVIEWER_IDS = '801';
  delete process.env.REGISTRATION_VERIFIER_URL;
  delete process.env.REGISTRATION_VERIFIER_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.UPLOAD_DIR = path.join(mysql.directory, 'test-uploads');
  const createMysqlAdapter = require('../../server/infrastructure/database/mysql/mysqlAdapter');
  require('../../server/infrastructure/database').useTestDatabase(createMysqlAdapter(mysql.pool));
  const app = require('../../server/app');
  const { authService } = require('../../server/composition');
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = token => token ? { Authorization: `Bearer ${token}` } : {};
  const get = (url, token) => fetch(origin + url, { headers: headers(token) });
  const post = (url, data, token) => fetch(origin + url, { method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const gps = () => ({ latitude: 10.671, longitude: 122.960, accuracy: 15, timestamp: Date.now() });
  const outside = () => ({ ...gps(), latitude: 14.5995, longitude: 120.9842 });
  const start = async () => {
    const response = await post('/api/auth/enrollment/start', { position: gps() });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await post('/api/auth/enrollment/start', { position: outside() })).status, 403);
  const { token: localToken, boundaryVersion } = await start();
  const manifest = await (await get('/assets/bacolod-boundary-version.json')).json();
  assert.equal(boundaryVersion, manifest.version);
  const frames = await Promise.all([48, 65].map(offset => sharp(Buffer.from(
    `<svg width="600" height="400"><rect width="600" height="400" fill="#323436"/>
    <rect x="${offset}" y="55" width="480" height="290" fill="#e2d7bc"/>
    <text x="115" y="150" font-size="26">SYNTHETIC CARD</text></svg>`
  )).jpeg().toBuffer()));
  async function capture(proof, captured = [frames[0]]) {
    const form = new FormData();
    form.set('position', JSON.stringify(gps()));
    for (const frame of captured) form.append('frames', new Blob([frame], { type: 'image/jpeg' }), 'fixture.jpg');
    return fetch(origin + '/api/auth/enrollment/capture', { method: 'POST', headers: headers(proof), body: form });
  }
  const localResponse = await capture(localToken);
  assert.equal(localResponse.status, 200);
  const inconclusive = await localResponse.json();
  assert.equal(inconclusive.decision, 'VERIFICATION_REQUIRED');
  assert.equal(inconclusive.ocrPrefillAllowed, true);
  assert.equal((await get('/api/auth/enrollment/status', localToken)).status, 403);
  assert.equal((await capture(localToken)).status, 403);
  const flat = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#838383' } }).jpeg().toBuffer();
  const unreadable = await capture((await start()).token, [flat]);
  assert.equal(unreadable.status, 400);
  const retake = await unreadable.json();
  assert.equal(retake.decision, 'RETAKE_REQUIRED');
  assert.equal(retake.screening.decision, 'RETAKE_REQUIRED');

  useScreeningFixture = true;
  const { token } = await start();
  const response = await capture(token);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.decision, 'VERIFICATION_REQUIRED');
  assert.equal(result.screening.classification, 'LOW_RISK');
  assert.equal((await get('/api/auth/enrollment/status', token)).status, 403);

  const oldToken = randomBytes(32).toString('base64url');
  const reference = randomBytes(12).toString('hex');
  const tokenKey = createHmac('sha256', process.env.REGISTRATION_FINGERPRINT_KEY)
    .update('review-token\0').update(oldToken).digest('hex');
  await mysql.adapter.execute(`INSERT INTO citizen_enrollment_reviews
    (reference, token_key, state, boundary_version, screening, frame_keys, expires_at)
    VALUES (?, ?, 'approved', ?, 'LOW_RISK', '[]', ?)`,
  [reference, tokenKey, manifest.version, Date.now() + 60_000]);
  const admin = authService.issueToken({ id: 801, role: 'admin', token_version: 0 });
  const citizen = authService.issueToken({ id: 803, role: 'citizen', token_version: 0 });
  const queue = '/api/admin/citizen-enrollment';
  assert.equal((await get(queue, admin)).status, 404);
  assert.equal((await get(queue, citizen)).status, 403);
  assert.equal((await post(queue + '/' + reference + '/decision', { decision: 'approved' }, admin)).status, 404);
  assert.equal((await get('/api/auth/enrollment/status', oldToken)).status, 403);

  for (const proof of [token, oldToken]) {
    const rejected = await post('/api/auth/register', { token: proof, position: gps(),
      username: 'fixture_must_not_activate', password: 'SyntheticPassword123!', barangay: 'Villamonte',
      identity: { documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Synthetic Test Citizen',
        birthDate: '1995-05-09', address: '42 Synthetic Street, Villamonte, Bacolod City', expiryDate: '2099-01-01' }
    });
    assert.equal(rejected.status, 403);
  }
  assert.deepEqual(await mysql.adapter.query('SELECT reference, state FROM citizen_enrollment_reviews'),
    [{ reference, state: 'approved' }]);
  assert.equal((await mysql.adapter.query('SELECT id FROM users WHERE username = ?', ['fixture_must_not_activate'])).length, 0);
  assert.deepEqual(await mysql.adapter.query("SELECT id FROM audit_logs WHERE entity_type = 'citizen_enrollment_review'"), []);
});
