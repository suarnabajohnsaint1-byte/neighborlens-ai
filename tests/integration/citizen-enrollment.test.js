const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { copyFile, readFile, readdir, mkdtemp, unlink, writeFile, rmdir } = require('node:fs/promises');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const identity = {
  documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789',
  fullName: 'Ana Halimbawa', birthDate: '1995-05-09',
  address: '42 TEST STREET, VILLAMONTE, BACOLOD CITY', expiryDate: '2099-01-01'
};
const clearScreening = { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' };
const bacolod = () => ({ latitude: 10.671, longitude: 122.960, accuracy: 15, timestamp: Date.now() });

async function fixtureFrame(offset) {
  return sharp(Buffer.from(`<svg width="600" height="400"><rect width="600" height="400" fill="navy"/>
    <rect x="${offset}" y="40" width="480" height="320" fill="white"/>
    <text x="130" y="180" fill="black" font-size="26">SYNTHETIC TEST FRAME</text></svg>`)).jpeg().toBuffer();
}

test('registration gates account creation on location, live capture and trusted identity approval', async t => {
  const realNow = Date.now;
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => realNow() + clockOffset);
  let verdict = {};
  let verifierRequests = 0;
  let fraudFlagged = false;
  let fraudAdvisory;
  const fraudSecret = 'f'.repeat(32);
  const provider = createServer(async (req, res) => {
    try {
      const fraudRequest = req.url === '/fraud';
      assert.equal(req.headers.authorization, `Bearer ${fraudRequest ? fraudSecret : 'v'.repeat(32)}`);
      const parts = await new Response(req, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const captureId = parts.get('captureId');
      const images = parts.getAll('frames');
      assert.equal(images.length, 1);
      assert.match(captureId, /^[A-Za-z0-9_-]{32}$/);
      res.setHeader('Content-Type', 'application/json');
      const framesSha256 = [createHash('sha256').update(Buffer.from(await images[0].arrayBuffer())).digest('hex')];
      if (fraudRequest) {
        const body = JSON.stringify({
          purpose: 'registration_fraud_assessment', captureId, framesSha256,
          assessment: fraudFlagged ? 'flagged' : 'clear',
          checks: fraudFlagged ? { ...clearScreening, monitorRecapture: 'flagged' } : clearScreening,
          advisory: fraudAdvisory
        });
        res.setHeader('X-Registration-Fraud-Signature', createHmac('sha256', fraudSecret).update(body).digest('hex'));
        return res.end(body);
      }
      verifierRequests++;
      assert.equal(parts.get('challenge'), null);
      const body = JSON.stringify({ captureId, framesSha256, ...verdict });
      res.setHeader('X-Registration-Verifier-Signature', createHmac('sha256', 'v'.repeat(32)).update(body).digest('hex'));
      res.end(body);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => provider.close());
  process.env.REGISTRATION_VERIFIER_URL = `http://127.0.0.1:${provider.address().port}/verify`;
  process.env.REGISTRATION_VERIFIER_SECRET = 'v'.repeat(32);
  process.env.REGISTRATION_FRAUD_URL = `http://127.0.0.1:${provider.address().port}/fraud`;
  process.env.REGISTRATION_FRAUD_SECRET = fraudSecret;
  process.env.REGISTRATION_FINGERPRINT_KEY = 'k'.repeat(32);
  delete process.env.REGISTRATION_REVIEWER_IDS;
  const { startTestServer, testDatabase } = require('../support/test-app');
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const barangays = require('../../server/infrastructure/repositories/barangay.repository');
  for (const [name, lat, lng] of [
    ['Villamonte', 10.671, 122.960], ['Estefania', 10.685, 122.982], ['Montevista', 10.667, 122.976]
  ]) {
    const boundary = { type: 'Polygon', coordinates: [[
      [lng - 0.002, lat - 0.002], [lng + 0.002, lat - 0.002], [lng + 0.002, lat + 0.002],
      [lng - 0.002, lat + 0.002], [lng - 0.002, lat - 0.002]
    ]] };
    await testDatabase().execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE name = ?',
      [JSON.stringify(boundary), 'isolated test fixture', 'test-v1', name]);
    assert.ok(await barangays.findByName(name));
  }

  const credentials = { username: 'synthetic-enrollment', password: 'synthetic-example', barangay: 'Villamonte' };
  const json = (endpoint, data, token) => fetch(`${baseUrl}/api/auth/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data)
  });
  const start = async () => {
    const response = await json('enrollment/start', { position: bacolod() });
    assert.equal(response.status, 200);
    return response;
  };
  const frames = await Promise.all([fixtureFrame(30), fixtureFrame(75)]);
  const capture = (token, selectedFrames = [frames[0]]) => {
    const form = new FormData();
    form.set('position', JSON.stringify(bacolod()));
    for (const frame of selectedFrames) form.append('frames', new Blob([frame], { type: 'image/jpeg' }), 'capture.jpg');
    return fetch(`${baseUrl}/api/auth/enrollment/capture`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
  };
  const register = (token, extra = {}) => json('register', { ...credentials, token, position: bacolod(), identity, ...extra });
  const assertNoUser = async () => {
    const rows = await testDatabase().query('SELECT id FROM users WHERE username = ?', [credentials.username]);
    assert.equal(rows.length, 0);
  };

  assert.equal((await json('enrollment/start', { position: {
    ...bacolod(), latitude: 14.5995, longitude: 120.9842
  } })).status, 403);
  assert.equal((await json('enrollment/start', { position: { ...bacolod(), timestamp: Date.now() - 60_000 } })).status, 400);
  assert.equal((await json('enrollment/start', { position: { ...bacolod(), accuracy: 150 } })).status, 400);
  assert.equal((await register(undefined)).status, 403);
  await assertNoUser();

  const first = await (await start()).json();
  assert.equal((await register(first.token)).status, 403);
  assert.equal((await capture(first.token, [frames[0], frames[0]])).status, 400);
  assert.equal(verifierRequests, 0);
  const flagged = await (await start()).json();
  fraudFlagged = true;
  const rejected = await capture(flagged.token);
  assert.equal(rejected.status, 200);
  const reviewForScreening = await rejected.json();
  assert.equal(reviewForScreening.decision, 'VERIFICATION_REQUIRED');
  assert.equal(reviewForScreening.reference, undefined);
  assert.equal(reviewForScreening.screening.classification, 'SUSPICIOUS');
  assert.equal(reviewForScreening.ocrPrefillAllowed, false);
  assert.equal(verifierRequests, 1);
  assert.equal((await register(flagged.token)).status, 403);
  await assertNoUser();

  for (const reason of ['invalid_qr_signature', 'issuer_data_mismatch', 'confirmed_counterfeit']) {
    const session = await (await start()).json();
    verdict = { status: 'rejected', documentType: reason === 'invalid_qr_signature' ? 'PHILSYS' : 'DRIVERS_LICENSE', reason };
    const invalid = await capture(session.token);
    assert.equal(invalid.status, 422);
    const rejection = await invalid.json();
    assert.equal(rejection.decision, 'BLOCK_INVALID');
    assert.equal(rejection.code, reason === 'confirmed_counterfeit'
      ? 'REGISTRATION_ID_COUNTERFEIT' : 'REGISTRATION_ID_INVALID');
    assert.equal((await register(session.token, { decision: 'VERIFIED' })).status, 403);
  }
  const unreadable = await (await start()).json();
  const retake = await capture(unreadable.token, [Buffer.from('unreadable')]);
  assert.equal(retake.status, 400);
  assert.equal((await retake.json()).code, 'REGISTRATION_ID_RETAKE_REQUIRED');
  assert.equal((await capture(unreadable.token)).status, 403);
  assert.equal((await register(unreadable.token)).status, 403);
  await assertNoUser();

  // Keep the successful attempts in a separate auth rate-limit window.
  clockOffset = 60_001;
  fraudFlagged = false;
  const needsReview = await (await start()).json();
  verdict = { status: 'pending_review' };
  const review = await capture(needsReview.token);
  assert.equal(review.status, 200);
  const pending = await review.json();
  assert.equal(pending.decision, 'VERIFICATION_REQUIRED');
  assert.equal(pending.verificationReason, 'VERIFIER_NOT_APPROVED');
  assert.equal(pending.screening.classification, 'LOW_RISK');
  assert.equal(pending.ocrPrefillAllowed, true);
  assert.equal((await register(needsReview.token, { ocrPrefillAllowed: true })).status, 403);
  await assertNoUser();
  const stale = await (await start()).json();
  verdict = { status: 'approved', captureId: 'previous-capture' };
  const staleResponse = await capture(stale.token);
  assert.equal((await staleResponse.json()).decision, 'VERIFICATION_REQUIRED');
  assert.equal((await register(stale.token)).status, 403);
  const unverified = await (await start()).json();
  verdict = { status: 'approved', issuerVerified: true, holderVerified: false, liveCapturePassed: true,
    fraudScreening: clearScreening, subject: 'synthetic-subject-a', facts: identity };
  assert.equal((await (await capture(unverified.token)).json()).decision, 'VERIFICATION_REQUIRED');
  assert.equal((await register(unverified.token)).status, 403);
  const inconclusive = await (await start()).json();
  verdict = { ...verdict, holderVerified: true,
    fraudScreening: { monitorRecapture: 'clear', imageReuse: 'clear' } };
  assert.equal((await (await capture(inconclusive.token)).json()).decision, 'VERIFICATION_REQUIRED');
  assert.equal((await register(inconclusive.token)).status, 403);

  const approved = await (await start()).json();
  const reuse = await (await start()).json();
  verdict = { status: 'approved', issuerVerified: true, holderVerified: true, liveCapturePassed: true,
    fraudScreening: clearScreening, subject: 'synthetic-subject-a', facts: identity };
  fraudAdvisory = { classification: 'POTENTIALLY_FAKE', indicators: ['digitalManipulation'] };
  const advisory = await (await start()).json();
  assert.equal((await (await capture(advisory.token)).json()).decision, 'VERIFICATION_REQUIRED');
  assert.equal((await register(advisory.token)).status, 403);
  fraudAdvisory = undefined;
  const verified = await capture(approved.token);
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.decision, 'VERIFIED');
  assert.equal(verifiedBody.screening.classification, 'LOW_RISK');
  assert.equal((await capture(reuse.token, [frames[1]])).status, 200);
  assert.equal((await register(approved.token, { identity: { ...identity, fullName: 'Different Person' } })).status, 400);
  assert.equal((await register(approved.token, { position: { ...bacolod(), latitude: 14.5995, longitude: 120.9842 } })).status, 403);
  clockOffset += 60_001;
  const mismatch = await register(approved.token, { position: { ...bacolod(), latitude: 10.685, longitude: 122.982 } });
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).code, 'REGISTRATION_BARANGAY_MISMATCH');
  await assertNoUser();
  const competingUsername = 'synthetic-duplicate';
  const [primaryAttempt, competingAttempt] = await Promise.all([
    register(approved.token),
    register(reuse.token, { username: competingUsername })
  ]);
  assert.deepEqual([primaryAttempt.status, competingAttempt.status].sort(), [201, 409]);
  const firstWon = primaryAttempt.status === 201;
  const created = firstWon ? primaryAttempt : competingAttempt;
  const duplicate = firstWon ? competingAttempt : primaryAttempt;
  assert.equal((await duplicate.json()).code, 'REGISTRATION_ID_ALREADY_USED');
  const createdUsername = firstWon ? credentials.username : competingUsername;
  const account = await created.json();
  assert.ok(account.token);
  const login = await json('login', { username: createdUsername, password: credentials.password });
  assert.equal(login.status, 200);
  const loggedIn = await login.json();
  assert.ok(loggedIn.token);
  assert.equal(loggedIn.user.id, account.user.id);
  assert.equal(loggedIn.user.barangay, 'Villamonte');
  assert.equal(Number(loggedIn.user.barangay_id), Number((await barangays.findByName('Villamonte')).id));
  for (const [label, response, body] of [['registration', created, account], ['login', login, loggedIn]]) {
    t.diagnostic(JSON.stringify({ label, status: response.status, ...body, token: '[redacted]' }));
  }
  const expiredSession = await fetch(`${baseUrl}/api/identity/me`, { headers: { Authorization: `Bearer ${account.token}` } });
  assert.equal(expiredSession.status, 401);
  const stored = await fetch(`${baseUrl}/api/identity/me`, { headers: { Authorization: `Bearer ${loggedIn.token}` } });
  assert.equal((await stored.json()).identity.address, identity.address);
  assert.equal(loggedIn.user.residencyVerified, true);

  // Duplicate username returns 409 without overwriting existing account or identity; retry with new username succeeds atomically.
  const { seedCitizen } = require('../support/citizens');
  const existingOwnerUsername = `existing_owner_${Date.now()}`;
  const existingOwner = await seedCitizen({
    username: existingOwnerUsername, password: 'OwnerPassword123!', barangay: 'Villamonte', reporting: false
  }, testDatabase());
  const secondIdentity = { ...identity, idNumber: 'N01-23-999888', fullName: 'Second Synthetic Citizen' };
  verdict = { status: 'approved', issuerVerified: true, holderVerified: true, liveCapturePassed: true,
    fraudScreening: clearScreening, subject: 'synthetic-subject-b', facts: secondIdentity };
  const dupStart = await (await start()).json();
  assert.equal((await capture(dupStart.token, [await fixtureFrame(140)])).status, 200);
  const dupAttempt = await register(dupStart.token, { username: existingOwnerUsername, identity: secondIdentity });
  assert.equal(dupAttempt.status, 409);
  const ownerIdentityAfter409 = await fetch(`${baseUrl}/api/identity/me`, { headers: { Authorization: `Bearer ${existingOwner.token}` } });
  assert.equal(ownerIdentityAfter409.status, 200);
  assert.equal((await ownerIdentityAfter409.json()).identity, null);
  const retryStart = await (await start()).json();
  assert.equal((await capture(retryStart.token, [await fixtureFrame(180)])).status, 200);
  const retryAttempt = await register(retryStart.token, { username: `${existingOwnerUsername}_retry`, identity: secondIdentity });
  assert.equal(retryAttempt.status, 201);
  const retryBody = await retryAttempt.json();
  assert.equal(retryBody.user.username, `${existingOwnerUsername}_retry`);
  assert.equal(retryBody.user.residencyVerified, true);
  assert.equal(retryBody.identity.documentValidationStatus, 'pass');
  const ownerIdentityAfterRetry = await fetch(`${baseUrl}/api/identity/me`, { headers: { Authorization: `Bearer ${existingOwner.token}` } });
  assert.equal((await ownerIdentityAfterRetry.json()).identity, null);
  const submitReport = (position, { gpsFixAt = Date.now(), gpsAccuracy = 15, barangay = 'Villamonte', requestKey } = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ description: 'Test pothole', barangay, gpsAccuracy,
      latitude: position.latitude, longitude: position.longitude, gpsFixAt, landmarkDescription: 'Beside the school entrance.' })) form.set(key, String(value));
    if (requestKey) form.set('requestKey', requestKey);
    for (const frame of frames) form.append('images', new Blob([frame], { type: 'image/jpeg' }), 'fixture.jpg');
    form.append('landmarkImage', new Blob([frames[0]], { type: 'image/jpeg' }), 'landmark.jpg');
    return fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${loggedIn.token}` }, body: form });
  };
  const sideEffects = async () => ({
    rows: (await testDatabase().query(`SELECT
      (SELECT COUNT(*) FROM reports) AS reports,
      (SELECT COUNT(*) FROM notifications) AS notifications,
      (SELECT COUNT(*) FROM community_posts) AS posts,
      (SELECT COUNT(*) FROM community_publication_requests) AS publications`))[0],
    uploads: (await readdir(process.env.UPLOAD_DIR, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort()
  });
  const beforeDenials = await sideEffects();
  const crossBarangay = await submitReport({ latitude: 10.667, longitude: 122.976 });
  assert.equal(crossBarangay.status, 403);
  assert.equal((await crossBarangay.json()).code, 'REPORT_BARANGAY_MISMATCH');
  const offshoreReport = await submitReport({ latitude: 10.675, longitude: 122.890 });
  assert.equal(offshoreReport.status, 400);
  assert.match((await offshoreReport.json()).error, /outside the Bacolod City service area/i);
  const staleReport = await submitReport(bacolod(), { gpsFixAt: Date.now() - 31_000 });
  assert.equal(staleReport.status, 400);
  assert.equal((await staleReport.json()).code, 'REPORT_LOCATION_RETRY');
  assert.equal((await submitReport(bacolod(), { gpsAccuracy: 101 })).status, 400);
  const ambiguousReport = await submitReport({ latitude: 10.673, longitude: 122.960 });
  assert.equal(ambiguousReport.status, 400);
  assert.equal((await ambiguousReport.json()).code, 'REPORT_LOCATION_RETRY');
  assert.deepEqual(await sideEffects(), beforeDenials);
  assert.equal((await testDatabase().query('SELECT id FROM reports WHERE submitted_by = ?', [account.user.id])).length, 0);
  const persistedFix = { gpsFixAt: Date.now(), requestKey: 'fixture-report-request-key', barangay: 'Estefania' };
  const [localReport, competingReport] = await Promise.all([
    submitReport(bacolod(), persistedFix),
    submitReport(bacolod(), { ...persistedFix, requestKey: 'competing-fixture-report-key' })
  ]);
  assert.deepEqual([localReport.status, competingReport.status].sort(), [201, 409]);
  const winningFix = localReport.ok ? persistedFix : { ...persistedFix, requestKey: 'competing-fixture-report-key' };
  const deniedReport = localReport.ok ? competingReport : localReport;
  assert.equal((await deniedReport.json()).code, 'REPORT_LOCATION_REUSED');
  const accepted = await testDatabase().query('SELECT id, barangay, gps_fix_at FROM reports WHERE submitted_by = ?', [account.user.id]);
  assert.deepEqual(accepted.map(row => [row.barangay, row.gps_fix_at]), [['Villamonte', persistedFix.gpsFixAt]]);
  const replay = await submitReport(bacolod(), { ...persistedFix, requestKey: 'different-fixture-report-key' });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, 'REPORT_LOCATION_REUSED');
  const sameRequest = await submitReport(bacolod(), winningFix);
  assert.ok(sameRequest.ok);
  assert.equal((await sameRequest.json()).reportId, accepted[0].id);
  const profile = await fetch(`${baseUrl}/api/auth/me/account`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loggedIn.token}` },
    body: JSON.stringify({ barangay: 'Montevista' })
  });
  assert.equal(profile.status, 403);
  const unchanged = await fetch(`${baseUrl}/api/identity/me`, { headers: { Authorization: `Bearer ${loggedIn.token}` } });
  assert.equal((await unchanged.json()).identity.address, identity.address);
  const owner = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${loggedIn.token}` } });
  assert.equal((await owner.json()).user.barangay, 'Villamonte');
  const modification = await fetch(`${baseUrl}/api/identity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loggedIn.token}` },
    body: JSON.stringify({ ...identity, idNumber: '1234-5678-1234-5678' })
  });
  assert.equal(modification.status, 403);
  assert.equal((await register(firstWon ? approved.token : reuse.token, { username: 'synthetic-replay' })).status, 403);
  const duplicateImage = await (await start()).json();
  assert.equal((await capture(duplicateImage.token)).status, 409);
  const candidates = await testDatabase().query('SELECT username FROM users WHERE username IN (?, ?)',
    [credentials.username, competingUsername]);
  assert.deepEqual(candidates.map(row => row.username), [createdUsername]);
});

test('verified LTO facts require the license number format and current expiration', () => {
  const { verifiedFacts, comparableFacts } = require('../../server/application/use-cases/enrollmentFacts');
  const now = Date.parse('2026-11-24T00:00:00Z');
  assert.equal(verifiedFacts(identity, now).documentType, 'DRIVERS_LICENSE');
  assert.equal(verifiedFacts({ ...identity, documentType: "LTO Driver's License" }, now).documentType, 'DRIVERS_LICENSE');
  assert.equal(verifiedFacts({ ...identity, documentType: "Driver’s License", expiryDate: null }, now), null);
  assert.deepEqual(comparableFacts(verifiedFacts({ ...identity, idNumber: 'n0123456789' }, now)),
    comparableFacts(verifiedFacts(identity, now)));
  assert.equal(verifiedFacts({ ...identity, expiryDate: null }, now), null);
  assert.equal(verifiedFacts({ ...identity, expiryDate: '2026-11-23' }, now), null);
  assert.equal(verifiedFacts({ ...identity, idNumber: '9876-5432-1098-7654' }, now), null);
  assert.equal(verifiedFacts({ ...identity, documentType: 'NATIONAL_ID', idNumber: '9876-5432-1098-7654', expiryDate: null }, now).documentType, 'PHILSYS');
});

test('Vista Alegre and Estefania require matching, confirmed residency to report', async t => {
  const { startTestServer, testDatabase } = require('../support/test-app');
  const { authService } = require('../../server/composition');
  const users = require('../../server/infrastructure/repositories/user.repository');
  const { hash } = require('../../server/infrastructure/security/passwordHasher');
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const areas = [
    { name: 'Vista Alegre', lat: 10.638, lng: 122.990, username: 'panel-vista' },
    { name: 'Estefania', lat: 10.685, lng: 122.982, username: 'panel-estefania' }
  ];
  const frames = await Promise.all([fixtureFrame(30), fixtureFrame(75)]);
  for (const { name, lat, lng, username } of areas) {
    const boundary = { type: 'Polygon', coordinates: [[
      [lng - .002, lat - .002], [lng + .002, lat - .002], [lng + .002, lat + .002],
      [lng - .002, lat + .002], [lng - .002, lat - .002]
    ]] };
    await testDatabase().execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE name = ?',
      [JSON.stringify(boundary), 'panel test fixture', 'test-v2', name]);
    const { insertId } = await users.create({ username, passwordHash: hash('panel-fixture-password'), role: 'citizen',
      barangay: name, fullName: 'Panel Test Citizen', enrollmentTier: 'FULLY_VERIFIED' }, testDatabase());
    if (name === 'Vista Alegre') {
      const { token, user } = await authService.login(username, 'panel-fixture-password', 'citizen');
      assert.equal(user.residencyVerified, false);
      const form = new FormData();
      for (const [key, value] of Object.entries({ description: 'Synthetic pothole', barangay: name,
        latitude: lat, longitude: lng, gpsAccuracy: 15, gpsFixAt: Date.now(), landmarkDescription: 'Beside the school entrance.' })) form.set(key, String(value));
      for (const frame of frames) form.append('images', new Blob([frame], { type: 'image/jpeg' }), 'fixture.jpg');
      form.append('landmarkImage', new Blob([frames[0]], { type: 'image/jpeg' }), 'landmark.jpg');
      const rejected = await fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).code, 'REPORT_RESIDENCY_REQUIRED');
    }
    await users.confirmCitizenResidence(insertId, { cityVersion: 'fixture', barangayVersion: 'test-v2' }, testDatabase());
  }
  for (const [home, away] of [[areas[0], areas[1]], [areas[1], areas[0]]]) {
    const { token, user } = await authService.login(home.username, 'panel-fixture-password', 'citizen');
    async function submit({ lat, lng }) {
      const form = new FormData();
      for (const [key, value] of Object.entries({ description: 'Synthetic pothole', barangay: home.name,
        latitude: lat, longitude: lng, gpsAccuracy: 15, gpsFixAt: Date.now(), landmarkDescription: 'Beside the school entrance.' })) form.set(key, String(value));
      for (const frame of frames) form.append('images', new Blob([frame], { type: 'image/jpeg' }), 'fixture.jpg');
      form.append('landmarkImage', new Blob([frames[0]], { type: 'image/jpeg' }), 'landmark.jpg');
      return fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    }
    const rejected = await submit(away);
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'REPORT_BARANGAY_MISMATCH');
    assert.equal((await testDatabase().query('SELECT id FROM reports WHERE submitted_by = ?', [user.id])).length, 0);
    const accepted = await submit(home);
    assert.equal(accepted.status, 201, await accepted.text());
  }
});

test('enrollment aliases share the same eligibility and expiry policy', () => {
  const { enrollmentDocumentType, expiryRequirement } = require('../../shared/identityDocumentPolicy');
  for (const label of ["LTO Driver's License", "Driver’s License", 'DRIVERS_LICENSE']) {
    assert.equal(enrollmentDocumentType(label), 'DRIVERS_LICENSE');
    assert.equal(expiryRequirement(label), 'required');
  }
  for (const label of ['PHILSYS', 'National ID', 'Philippine National ID']) {
    assert.equal(enrollmentDocumentType(label), 'PHILSYS');
    assert.equal(expiryRequirement(label), 'not_applicable');
  }
  for (const label of ['Philippine Passport', 'SSS ID', 'PRC', 'UNKNOWN_ID']) {
    assert.equal(enrollmentDocumentType(label), null);
  }
});

test('enrollment retries at the boundary and rejects expired capture sessions', async () => {
  const { createCitizenEnrollment } = require('../../server/application/use-cases/citizenEnrollment.service');
  const geometry = require('../../frontend/assets/bacolod-city-boundary.json');
  let now = Date.now();
  const service = createCitizenEnrollment({
    loadBoundary: () => geometry, verifier: { available: true },
    fingerprintKey: 'k'.repeat(32), clock: () => now
  });
  const boundaryRing = geometry.geometry.type === 'Polygon'
    ? geometry.geometry.coordinates[0] : geometry.geometry.coordinates[0][0];
  const [longitude, latitude] = boundaryRing[0];
  await assert.rejects(service.start({ ...bacolod(), longitude, latitude, timestamp: now }),
    { code: 'REGISTRATION_LOCATION_RETRY' });
  const { token, expiresAt } = await service.start({ ...bacolod(), timestamp: now });
  now = expiresAt;
  assert.throws(() => service.assertCaptureSession(token), { code: 'REGISTRATION_PROOF_REQUIRED' });
});

test('the shared boundary loader validates the complete versioned geometry and rejects tampered data', async t => {
  const { loadBacolodBoundary } = require('../../server/infrastructure/adapters/bacolodBoundary');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'neighborlens-boundary-'));
  const files = ['bacolod-boundary-version.json', 'bacolod-city-boundary.json', 'bacolod-barangay-boundaries.json'];
  t.after(async () => {
    for (const file of files) await unlink(path.join(directory, file)).catch(() => {});
    await rmdir(directory);
  });
  for (const file of files) await copyFile(path.join('frontend/assets', file), path.join(directory, file));
  const dataset = await loadBacolodBoundary(directory);
  assert.equal(dataset.city.properties.name, 'Bacolod City');
  assert.equal(dataset.barangays.features.length, 61);
  const { inspect } = require('../../shared/geoContainment');
  assert.equal(inspect(10.675, 122.890, dataset.city).inside, false, 'Guimaras Strait');
  assert.equal(inspect(10.673, 122.952, dataset.city).inside, true, 'coastal land');
  assert.equal(inspect(10.6597, 123.1345, dataset.city).inside, true, 'eastern uplands');
  const city = path.join(directory, files[1]);
  await writeFile(city, (await readFile(city, 'utf8')) + ' ');
  await assert.rejects(loadBacolodBoundary(directory), /integrity/);
  await unlink(path.join(directory, files[0]));
  await assert.rejects(loadBacolodBoundary(directory), { code: 'ENOENT' });
});

test('outside-city result stays distinct from a verifier outage', async () => {
  const { createCitizenEnrollment } = require('../../server/application/use-cases/citizenEnrollment.service');
  const { verificationUnavailable } = require('../../server/infrastructure/adapters/registrationVerifier');
  const geometry = require('../../frontend/assets/bacolod-city-boundary.json');
  const service = createCitizenEnrollment({ loadBoundary: () => geometry, verifier: { available: false }, verificationUnavailable });
  await assert.rejects(service.start({ ...bacolod(), latitude: 10.675, longitude: 122.890 }),
    { code: 'REGISTRATION_OUTSIDE_BACOLOD' });
  await assert.rejects(service.start({ ...bacolod(), latitude: 14.5995, longitude: 120.9842 }),
    { code: 'REGISTRATION_OUTSIDE_BACOLOD' });
  await assert.rejects(service.start(bacolod()), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  const missingBoundary = createCitizenEnrollment({ loadBoundary: () => null, verifier: { available: true } });
  await assert.rejects(missingBoundary.start(bacolod()), { code: 'REGISTRATION_LOCATION_UNAVAILABLE' });
});

test('fraud screening stays available during an issuer outage and never authorizes enrollment', async () => {
  const { createCitizenEnrollment } = require('../../server/application/use-cases/citizenEnrollment.service');
  const { verificationUnavailable } = require('../../server/infrastructure/adapters/registrationVerifier');
  const geometry = require('../../frontend/assets/bacolod-city-boundary.json');
  let assessment;
  const fraudAssessor = { available: true, assess: async () => assessment() };
  const service = createCitizenEnrollment({
    loadBoundary: () => geometry, verifier: { available: false }, fraudAssessor,
    verificationUnavailable, fingerprintKey: 'k'.repeat(32),
    normalizeFrame: async bytes => bytes, keyUsed: async () => false
  });
  async function assertCaptureFailure(code) {
    const { token } = await service.start(bacolod());
    if (code) await assert.rejects(service.capture({ token, position: bacolod(), frames: [Buffer.from('first')] }), { code });
    else assert.equal((await service.capture({ token, position: bacolod(), frames: [Buffer.from('first')] })).decision, 'VERIFICATION_REQUIRED');
    await assert.rejects(service.enroll({ token, position: bacolod(), identity }, () => assert.fail('Unexpected enrollment')),
      { code: 'REGISTRATION_PROOF_REQUIRED' });
  }
  assessment = () => ({ cleared: false, screening: { classification: 'SUSPICIOUS' } });
  await assertCaptureFailure();
  assessment = () => { throw verificationUnavailable(); };
  await assertCaptureFailure('REGISTRATION_FRAUD_UNAVAILABLE');
  assessment = () => ({ cleared: true });
  await assertCaptureFailure();
  fraudAssessor.available = false;
  await assert.rejects(service.start(bacolod()), { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });
});

test('missing enrollment tables produce a safe dependency error and consume the capture', async () => {
  const { createCitizenEnrollment } = require('../../server/application/use-cases/citizenEnrollment.service');
  const city = require('../../frontend/assets/bacolod-city-boundary.json');
  const service = createCitizenEnrollment({
    loadBoundary: () => ({ ...city, boundaryVersion: 'fixture' }),
    verifier: { available: false }, fraudAssessor: { available: true, assess: async () => ({ cleared: false }) },
    fingerprintKey: 'k'.repeat(32), normalizeFrame: async bytes => bytes, keyUsed: async () => false,
    manualReview: { submit: async () => { throw Object.assign(new Error('private SQL'), { code: 'ER_NO_SUCH_TABLE' }); } }
  });
  const { token } = await service.start(bacolod());
  await assert.rejects(service.capture({ token, position: bacolod(), frames: [Buffer.from('a')] }),
    { code: 'REGISTRATION_STORAGE_UNAVAILABLE', message: 'Enrollment storage is unavailable.' });
  assert.throws(() => service.assertCaptureSession(token), { code: 'REGISTRATION_PROOF_REQUIRED' });
});
