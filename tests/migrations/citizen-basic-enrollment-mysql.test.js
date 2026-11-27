const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const sharp = require('sharp');
const { privateMysql, waitExit } = require('../support/private-mysql');
const { installFixtureBarangay } = require('../support/citizens');

const screeningEnabled = process.env.ENROLLMENT_TEST_SCREENING_DISABLED !== '1';
const windows = process.platform === 'win32';

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function npm(t, script, env) {
  const [command, args] = windows ? ['cmd.exe', ['/d', '/s', '/c', `npm run ${script}`]] : ['npm', ['run', script]];
  const child = spawn(command, args, {
    env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (windows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  });
  return { child, output: () => output };
}

async function waitFor(check, diagnostics) {
  const deadline = Date.now() + 65_000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail(diagnostics());
}

test(
  `browser capture, ${screeningEnabled ? 'real FREUID' : 'OCR-only combined startup'}, and limited Citizen account in private MySQL`, {
  skip: screeningEnabled && (!process.env.ENROLLMENT_TEST_TESSERACT || !process.env.ENROLLMENT_TEST_FREUID_ASSETS),
  timeout: 300_000
}, async t => {
  const mysql = await privateMysql(t, { database: 'citizen_capture_test' });
  t.after(mysql.close);
  const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
  assert.ok((await runMigrations(mysql.pool)).applied.includes('022_citizen_enrollment_tier.sql'));
  assert.deepEqual((await runMigrations(mysql.pool)).applied, []);

  const port = await freePort();
  const fraudUrl = `http://127.0.0.1:${port}/assess-capture`;
  const secret = randomBytes(32).toString('hex');
  const python = process.env.ENROLLMENT_TEST_PYTHON || (process.platform === 'win32'
    ? path.resolve('.venv/Scripts/python.exe') : 'python3');
  if (screeningEnabled) {
    const fraud = spawn(python, ['-m', 'uvicorn', 'ai.identity.forensics_api:app',
      '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], {
      env: {
        ...process.env, REGISTRATION_FRAUD_SECRET: secret, IDENTITY_RESEARCH_MODEL: 'freuid-a31',
        FREUID_ASSETS: process.env.ENROLLMENT_TEST_FREUID_ASSETS, FREUID_RESEARCH_LAYOUT: 'BENIN/DL',
        REGISTRATION_CAPTURE_TESSERACT: process.env.ENROLLMENT_TEST_TESSERACT
      },
      stdio: 'ignore', windowsHide: true
    });
    const stopped = new Promise(resolve => fraud.once('close', resolve));
    fraud.on('error', error => t.diagnostic(`FastAPI process error: ${error.code}`));
    t.after(async () => {
      fraud.kill();
      await stopped;
    });
    const deadline = Date.now() + 45_000;
    let available = false;
    while (!available && Date.now() < deadline && fraud.exitCode === null) {
      available = (await fetch(fraudUrl).catch(() => null))?.status === 405;
      if (!available) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(available, 'FREUID FastAPI did not start.');
  }

  let mutation, observed = 0, ocrRequests = 0, ocrFault = false;
  const fetchReal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === `http://127.0.0.1:${port}/ocr-capture`) {
      ocrRequests++;
      if (ocrFault) return new Response(null, { status: 503 });
    }
    if (String(url) === fraudUrl) {
      observed++;
      assert.ok(screeningEnabled, 'Disabled registration must perform no fraud requests.');
    }
    const response = await fetchReal(url, options);
    if (String(url) !== fraudUrl || !response.ok) return response;
    assert.equal(options.body.getAll('frames').length, 1);
    const result = await response.clone().json();
    assert.equal(result.purpose, 'document_fraud_research');
    assert.match(result.model, /^FREUID a31 research \(BENIN\/DL /);
    assert.ok(Number.isFinite(result.documentFraudScores[0]));
    assert.ok(Number.isFinite(result.monitorRecaptureSpectralPeak));
    if (mutation === 'missing-signature') return new Response(await response.text());
    if (mutation === 'wrong-hash') {
      const body = JSON.stringify({ ...result, framesSha256: ['0'.repeat(64)] });
      return new Response(body, {
        headers: {
          'X-Registration-Fraud-Signature': createHmac('sha256', secret).update(body).digest('hex')
        }
      });
    }
    return response;
  });
  const photo = number => sharp(Buffer.from(`<svg width="900" height="580">
    <rect width="900" height="580" fill="#ece4d5"/>
    <text x="95" y="140" font-family="Arial" font-size="34">LAND TRANSPORTATION OFFICE</text>
    <text x="95" y="220" font-family="Arial" font-size="37">DRIVERS LICENSE</text>
    <text x="95" y="340" font-family="Arial" font-size="44">LICENSE NO: ${number}</text>
  </svg>`)).jpeg().toBuffer();
  const replay = await photo('N01-23-456794');
  const { normalizeFrame } = require('../../server/infrastructure/adapters/registrationVerifier');
  const replayCatalog = path.join(mysql.directory, 'test-replay-sha256.txt');
  await writeFile(replayCatalog, createHash('sha256').update(await normalizeFrame(replay)).digest('hex') + '\n');
  const appEnv = {
    ...process.env, NODE_ENV: 'development', JWT_SECRET: randomBytes(32).toString('hex'),
    HOST: '127.0.0.1', DB_HOST: '127.0.0.1', DB_DRIVER: 'mysql', DB_TARGET: 'local',
    DB_PORT: String(mysql.port), DB_NAME: mysql.database, DB_USER: 'root', DB_PASSWORD: '',
    STORAGE_DRIVER: 'local', DB_SSL_MODE: 'DISABLED', VERCEL: '',
    REGISTRATION_FRAUD_SCREENING_ENABLED: String(screeningEnabled),
    REGISTRATION_CAPTURE_TESSERACT: screeningEnabled ? process.env.ENROLLMENT_TEST_TESSERACT : '',
    REGISTRATION_BASIC_CITIZEN_ENABLED: 'true', REGISTRATION_FRAUD_URL: fraudUrl,
    REGISTRATION_FRAUD_SECRET: secret, REGISTRATION_FINGERPRINT_KEY: randomBytes(32).toString('hex'),
    REGISTRATION_ALLOW_OUTSIDE_BACOLOD_SCAN: String(!screeningEnabled), IDENTITY_API_PORT: String(port),
    REGISTRATION_VERIFIER_URL: screeningEnabled ? '' : 'http://127.0.0.1:1/verify',
    REGISTRATION_VERIFIER_SECRET: screeningEnabled ? '' : randomBytes(32).toString('hex'),
    REGISTRATION_REVIEWER_IDS: '', UPLOAD_DIR: path.join(mysql.directory, 'uploads'),
    REGISTRATION_KNOWN_REPLAY_SHA256_FILE: replayCatalog
  };
  Object.assign(process.env, appEnv);
  await installFixtureBarangay('Villamonte', mysql.adapter);
  let browserOrigin;
  if (!screeningEnabled) {
    const serverPort = await freePort();
    const damagePort = await freePort();
    const missingModelDirectory = path.join(mysql.directory, 'unavailable-identity-assets');
    const startupEnv = {
      ...appEnv, DISABLE_ORIGIN_CHECK: 'false', PORT: String(serverPort), AI_HOST: '127.0.0.1', AI_PORT: String(damagePort),
      AI_MODEL_WEIGHTS: 'models/production/best.pt', AI_PORTRAIT_MODEL: '', AI_OBJECT_MODEL: '',
      IDENTITY_RESEARCH_MODEL: 'none', FREUID_ASSETS: missingModelDirectory, TRUFOR_SOURCE: missingModelDirectory,
      PATH: (process.env.PATH || '').split(path.delimiter).filter(entry => !/tesseract/i.test(entry)).join(path.delimiter)
    };
    for (const key of Object.keys(startupEnv)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete startupEnv[key];
    }
    browserOrigin = `http://127.0.0.1:${serverPort}`;
    const api = npm(t, 'server', startupEnv);
    const ai = npm(t, 'ai', startupEnv);
    await waitFor(() => ai.output().includes('[AI] All required services ready'), ai.output);
    await waitFor(async () => (await fetchReal(browserOrigin + '/api/health').catch(() => null))?.ok, api.output);
    const identity = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${secret}` };
    const health = await (await fetchReal(identity + '/health', { headers: auth })).json();
    assert.ok(health.ocr);
    assert.equal(health.model, 'none');
    assert.equal(health.fraud, false);
    assert.equal((await fetchReal(identity + '/health')).status, 403);
    assert.equal((await fetchReal(identity + '/assess-capture', { method: 'POST', headers: auth })).status, 404);
    assert.equal((await fetchReal(identity + '/ocr-capture', { method: 'POST' })).status, 403);
    const invalidImage = new FormData();
    invalidImage.set('captureId', 'x'.repeat(32));
    invalidImage.set('frames', new Blob(['invalid JPEG'], { type: 'image/jpeg' }), 'capture.jpg');
    assert.equal((await fetchReal(identity + '/ocr-capture', {
      method: 'POST', headers: auth, body: invalidImage
    })).status, 400);
    assert.equal((await fetchReal(`http://127.0.0.1:${damagePort}/health`)).status, 200);
    const duplicate = npm(t, 'ai', startupEnv);
    assert.equal(await waitExit(duplicate.child, 20_000), 0, duplicate.output());
    assert.equal(duplicate.output().match(/existing compatible service/g)?.length, 2);
    const conflict = npm(t, 'ai', { ...startupEnv, AI_PORT: String(serverPort) });
    assert.equal(await waitExit(conflict.child, 20_000), 1);
    assert.match(conflict.output(), /Port \d+ is occupied/);
    assert.equal((await fetchReal(browserOrigin + '/api/health')).status, 200);
    assert.equal((await fetchReal(browserOrigin + '/login.html', {
      headers: { Origin: 'https://public.example' }
    })).status, 403);
    const localhost = browserOrigin.replace('127.0.0.1', 'localhost');
    const ipv6 = browserOrigin.replace('127.0.0.1', '[::1]');
    for (const local of [localhost, ipv6]) {
      assert.equal((await fetchReal(local + '/api/health')).status, 200);
    }
    t.diagnostic(ai.output().split(/\r?\n/).filter(line => /^\[AI/.test(line)).join('\n'));
  }
  require('../../server/infrastructure/database').useTestDatabase(mysql.adapter);
  const authRateLimiter = require('../../server/presentation/http/middleware/authRateLimit.middleware');
  const createAuthRateLimit = authRateLimiter.createAuthRateLimit;
  let rateLimitOffset = 0;
  t.mock.method(authRateLimiter, 'createAuthRateLimit', options =>
    createAuthRateLimit({ ...options, clock: () => Date.now() + rateLimitOffset }));
  const app = require('../../server/app');
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const origins = [browserOrigin || origin];
  if (browserOrigin) origins.push(browserOrigin.replace('127.0.0.1', 'localhost'));
  for (const [index, target] of origins.entries()) {
    const browser = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test',
      '--config=playwright.registration.config.js', '--grep=basic MySQL enrollment', '--workers=1',
      `--output=.data/registration-mysql-${port}-${index}`],
      { env: { ...process.env, REGISTRATION_TEST_URL: target, NEIGHBORLENS_BASIC_E2E: '1',
        NEIGHBORLENS_OUTSIDE_ENROLLMENT: String(!screeningEnabled), NEIGHBORLENS_BASIC_FIXTURE_OFFSET: String(index * 10) }, stdio: 'inherit', windowsHide: true });
    assert.equal(await waitExit(browser, 100_000), 0, `Browser enrollment failed at ${target}`);
    t.diagnostic(`Browser registration passed at ${target}`);
  }
  assert.equal(observed, screeningEnabled ? 2 : 0);
  const accounts = await mysql.adapter.query(`SELECT id, enrollment_tier, barangay, barangay_id, residency_confirmed_at
    FROM users WHERE username LIKE 'basic_e2e_%'`);
  assert.equal(accounts.length, origins.length * 2);
  const { isVerifiedEnrollment } = require('../../server/infrastructure/repositories/citizenEnrollment.repository');
  for (const account of accounts) {
    assert.equal(account.enrollment_tier, 'ACTIVE_LIMITED');
    assert.equal(await isVerifiedEnrollment(account.id), false);
    assert.equal(account.residency_confirmed_at, null);
    if (!screeningEnabled) {
      assert.equal(account.barangay, '');
      assert.equal(account.barangay_id, null);
    }
  }

  const gps = () => ({
    latitude: 10.66850,
    longitude: 122.96470,
    accuracy: 15,
    timestamp: Date.now()
  });
  const post = (url, data) => fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const start = position => post('/api/auth/enrollment/start', { position });
  assert.equal((await start({ ...gps(), latitude: 14.59, longitude: 120.98 })).status, screeningEnabled ? 403 : 200);
  assert.equal((await start({ ...gps(), timestamp: Date.now() - 60_000 })).status, 400);

  const flat = await sharp({ create: { width: 900, height: 580, channels: 3, background: '#838383' } }).jpeg().toBuffer();
  async function capture(frame, token) {
    token ??= (await (await start(gps())).json()).token;
    const form = new FormData();
    form.set('position', JSON.stringify(gps()));
    form.set('frames', new Blob([frame], { type: 'image/jpeg' }), 'capture.jpg');
    return fetch(origin + '/api/auth/enrollment/capture', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: form
    });
  }
  const blurry = await capture(flat);
  assert.equal(blurry.status, 400);
  assert.equal((await blurry.json()).decision, 'RETAKE_REQUIRED');

  const { token: replayToken } = await (await start(gps())).json();
  const matched = await capture(replay, replayToken);
  assert.equal(matched.status, 400);
  const matchedBody = await matched.json();
  assert.equal(matchedBody.decision, 'RETAKE_REQUIRED');
  assert.equal(matchedBody.screening.classification, 'SUSPICIOUS');
  assert.equal(matchedBody.screening.checks.includes('Research manipulation model'), screeningEnabled);
  assert.ok(matchedBody.screening.checks.includes('Exact replay fingerprint'));
  assert.equal((await capture(replay, replayToken)).status, 403);

  const duplicate = await capture(await photo('N01-23-456789'));
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'REGISTRATION_ID_ALREADY_USED');

  const image = await photo('N01-23-456791');
  for (const fault of screeningEnabled ? ['missing-signature', 'wrong-hash'] : []) {
    mutation = fault;
    const denied = await capture(image);
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, 'REGISTRATION_FRAUD_UNAVAILABLE');
  }
  mutation = null;
  const { token } = await (await start(gps())).json();
  const accepted = await (await capture(image, token)).json();
  assert.equal(accepted.decision, 'BASIC_REGISTRATION_ELIGIBLE');
  if (!screeningEnabled) assert.equal(accepted.screening, undefined);
  assert.equal((await capture(image, token)).status, 403);
  const register = (idNumber, overrides = {}) => post('/api/auth/register', {
    token, position: gps(), username: 'basic_e2e_retry', password: 'FictionalPass123!', barangay: 'Villamonte',
    identity: {
      documentType: 'DRIVERS_LICENSE', idNumber, fullName: 'Fixture Cabinet',
      address: 'SYNTHETIC STREET, VILLAMONTE, BACOLOD CITY', birthDate: '1994-01-01', expiryDate: '2099-01-01'
    }, ...overrides
  });
  if (!screeningEnabled) {
    assert.equal((await register('N01-23-456791', { token: undefined })).status, 403);
    assert.equal((await register('N01-23-456791', { identity: {} })).status, 400);
    assert.equal((await register('N01-23-456791', { username: 'basic_e2e_desktop' })).status, 409);
  }
  assert.equal((await register('N01-23-456792')).status, 400);
  assert.equal((await register('N01-23-456791')).status, 201);
  assert.equal((await register('N01-23-456791')).status, 403);
  if (!screeningEnabled) {
    const reusedCapture = await capture(image);
    assert.equal(reusedCapture.status, 409);
    assert.equal((await reusedCapture.json()).code, 'REGISTRATION_ID_ALREADY_USED');
  }

  // This separate scenario starts in the next rate-limit window of the isolated test server.
  rateLimitOffset += 60_000;
  const screen = await sharp(Buffer.from(`<svg width="900" height="580">
    <rect width="900" height="580" fill="white"/>
    <g font-family="Arial" font-size="34">
      <text x="40" y="60">GOOGLE IMAGES</text>
      <text x="40" y="130">VISIT</text>
      <text x="40" y="200">SAVE</text>
      <text x="55" y="330">LAND TRANSPORTATION OFFICE</text>
      <text x="55" y="440">LICENSE NO: N01-23-456795</text>
    </g>
  </svg>`)).jpeg().toBuffer();
  const { token: screenToken } = await (await start(gps())).json();
  const screenBlocked = await capture(screen, screenToken);
  assert.equal(screenBlocked.status, 400);
  const screenBody = await screenBlocked.json();
  assert.equal(screenBody.decision, 'RETAKE_REQUIRED');
  assert.equal(screenBody.screening.classification, 'SUSPICIOUS');
  assert.deepEqual(screenBody.screening.checks, ['Visible search interface']);
  assert.equal((await capture(screen, screenToken)).status, 403);
  if (!screeningEnabled) {
    ocrFault = true;
    const unavailable = await capture(await photo('N01-23-456793'));
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'REGISTRATION_CAPTURE_OCR_UNAVAILABLE');
    assert.ok(ocrRequests > 0);
    assert.equal(observed, 0);
  }
});
