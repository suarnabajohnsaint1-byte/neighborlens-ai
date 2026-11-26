const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-phase2-'));
process.env.TEST_DB_FILE = path.join(directory, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.STORAGE_DRIVER = 'local';
const { startTestServer, testDatabase, DamageDetectionError } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES } = require('../support/image-fixtures');
const { adminSession, createOfficial } = require('../support/accounts');
const proofProvider = require('../../server/infrastructure/security/tokenProvider');
const reportRepository = require('../../server/infrastructure/repositories/report.repository');
const auditService = require('../../server/application/use-cases/audit.service');
const { getImageStorage } = require('../../server/infrastructure/storage/storageFactory');

let server;
let baseUrl;
let citizen;
let other;
let admin;
let officialOne;
let officialTwo;
let mode = 'pothole';
let confidence = 0.9;
let inferenceCalls = 0;

async function register(username) {
  return seedCitizen({ username: `${username}_${Date.now()}`, password: 'password123', reporting: true });
}

test.before(async () => {
  ({ server, baseUrl } = await startTestServer({ inference: async () => {
    inferenceCalls++;
    if (mode === 'unavailable') throw new DamageDetectionError('Unavailable', 'INFERENCE_NETWORK', 502);
    if (mode === 'malformed') return {};
    if (mode === 'missing-confidence') return { detections: [{ damage_type: 'pothole' }] };
    if (mode === 'classless') return { detections: [{ confidence_score: 0.95 }] };
    if (mode === 'conflicting-class') return { detections: [{ damage_type: 'pothole', class: 'road_crack', confidence_score: 0.95 }] };
    if (mode === 'unsupported-evidence') return { detections: [{ damage_type: 'car', confidence_score: 0.95 }] };
    if (mode === 'invalid-eligibility') return { detections: [{ damage_type: 'pothole', confidence_score: 0.95, eligible: 'false' }] };
    return { min_confidence: 0.3, detections: mode === 'none' ? [] : [{ damage_type: mode, confidence_score: confidence }] };
  } }));
  citizen = await register('phase2_citizen');
  other = await register('phase2_other');
  admin = await adminSession(baseUrl);
  officialOne = await createOfficial(baseUrl, admin.token, 'Barangay 1', 'phase2_b1');
  officialTwo = await createOfficial(baseUrl, admin.token, 'Barangay 2', 'phase2_b2');
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  testDatabase().close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: false });
});

async function previews(token = citizen.token) {
  const proofs = [];
  for (const order of [1, 2]) {
    const body = new FormData();
    body.append('photoOrder', String(order));
    body.append('images', new File([order === 2 ? SECOND_JPEG_BYTES : JPEG_BYTES], `angle-${order}.jpg`, { type: 'image/jpeg' }));
    const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    assert.equal(response.status, mode === 'unavailable' ? 502 : 200);
    const data = await response.json();
    assert.ok(data.assessmentProof);
    proofs.push(data.assessmentProof);
  }
  return proofs;
}

async function submit(proofs, category = 'Road Damage', options = {}) {
  const body = new FormData();
  body.append('description', options.description || 'Citizen clarification stays intact.');
  body.append('barangay', 'Barangay 1');
  body.append('landmarkDescription', 'Beside the school entrance.');
  addReportGps(body);
  if (category !== undefined && category !== null) body.append('citizenCategory', category);
  if (proofs !== undefined) body.append('assessmentProofs', typeof proofs === 'string' ? proofs : JSON.stringify(proofs));
  body.append('original_ai', JSON.stringify({ status: 'DETECTED', canonical_class: 'invented' }));
  body.append('images', new File([options.firstBytes || JPEG_BYTES], 'first.jpg', { type: options.firstBytes ? 'image/png' : 'image/jpeg' }));
  body.append('images', new File([SECOND_JPEG_BYTES], 'second.jpg', { type: 'image/jpeg' }));
  body.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  const response = await fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${options.token || citizen.token}` }, body });
  return { status: response.status, data: await response.json() };
}

test('Phase 2 accepts a correct suggestion and persists a versioned independent snapshot', async () => {
  mode = 'pothole'; confidence = 0.9;
  const result = await submit(await previews());
  assert.equal(result.status, 201);
  assert.equal(result.data.citizenCategory, 'Road Damage');
  assert.equal(result.data.originalAi.canonical_class, 'pothole');
  assert.equal(result.data.originalAi.suggested_category, 'Road Damage');
  assert.equal(result.data.status, 'pending');
  const row = await reportRepository.findById(result.data.id);
  assert.equal(row.submission_assessment.schema_version, 1);
  assert.equal(row.submission_assessment.citizen_category, 'Road Damage');
  assert.equal(row.submission_assessment.evidence.photos[1].order, 2);
  assert.equal('submission_assessment' in result.data, false);
  assert.doesNotMatch(JSON.stringify(result.data), /proof_id|assessmentProof|evidence_sha256/);
});

test('Phase 2 correction preserves the displayed original despite changed submission-time inference', async () => {
  mode = 'broken_streetlight';
  const proofs = await previews();
  mode = 'pothole';
  const result = await submit(proofs);
  assert.equal(result.status, 201);
  assert.equal(result.data.originalAi.canonical_class, 'broken_streetlight');
  assert.equal(result.data.originalAi.suggested_category, 'Street Light Damage');
  assert.equal(result.data.citizenCategory, 'Road Damage');
  assert.equal(result.data.ai_category, 'pothole');
  assert.equal(result.data.description, 'Citizen clarification stays intact.');
  const rows = await fetch(`${baseUrl}/api/reports`, { headers: { Authorization: `Bearer ${citizen.token}` } }).then(response => response.json());
  const saved = rows.reports.find(row => row.id === result.data.id);
  assert.deepEqual(saved.originalAi, result.data.originalAi);
  assert.equal(saved.citizenCategory, 'Road Damage');
});

for (const scenario of [
  { name: 'LOW_CONFIDENCE', mode: 'pothole', confidence: 0.2 },
  { name: 'NO_DETECTION', mode: 'none', confidence: 0.9 },
  { name: 'AI_UNAVAILABLE', mode: 'unavailable', confidence: 0.9 }
]) {
  test(`Phase 2 ${scenario.name} supports manual selection without invented acceptance`, async () => {
    mode = scenario.mode; confidence = scenario.confidence;
    const result = await submit(await previews(), 'Flooding / Drainage');
    assert.equal(result.status, 201);
    assert.equal(result.data.originalAi.status, scenario.name);
    assert.equal(result.data.originalAi.detected, false);
    assert.equal(result.data.originalAi.canonical_class, null);
    assert.equal(result.data.citizenCategory, 'Flooding / Drainage');
    if (scenario.name !== 'LOW_CONFIDENCE') assert.equal(result.data.originalAi.confidence, null);
    else assert.equal(result.data.originalAi.candidate.accepted, false);
    mode = 'pothole'; confidence = 0.9;
  });
}

test('Phase 2 unauthorized users cannot modify categories and barangay reads remain isolated', async () => {
  const result = await submit(await previews());
  for (const actor of [other.token, officialOne.token, officialTwo.token]) {
    const response = await fetch(`${baseUrl}/api/reports/${result.data.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${actor}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ citizenCategory: 'Flooding / Drainage' }) });
    assert.notEqual(response.status, 200);
  }
  for (const [token, visible] of [[admin.token, true], [officialOne.token, true], [officialTwo.token, false], [other.token, false]]) {
    const response = await fetch(`${baseUrl}/api/reports`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const row = (await response.json()).reports.find(row => row.id === result.data.id);
    assert.equal(Boolean(row), visible);
    if (row) assert.equal(row.citizenCategory, 'Road Damage');
  }
  assert.equal((await reportRepository.findById(result.data.id)).submission_assessment.citizen_category, 'Road Damage');
});

for (const category of ['pothole', 'Electrical', 'Unsupported']) {
  test(`Phase 2 invalid correction ${category} is rejected before inference`, async () => {
    const calls = inferenceCalls;
    assert.equal((await submit([], category)).status, 400);
    assert.equal(inferenceCalls, calls);
  });
}

test('Phase 2 legacy generic reporting remains accepted with a NULL snapshot', async () => {
  const result = await submit(undefined, null, { description: 'Fallen tree obstructing a street.' });
  assert.equal(result.status, 201);
  assert.equal(result.data.citizenCategory, null);
  assert.equal(result.data.originalAi, null);
  assert.equal((await reportRepository.findById(result.data.id)).submission_assessment, null);
});

for (const scenario of ['tampered', 'expired', 'wrong citizen', 'wrong order', 'different bytes', 'duplicate', 'malformed']) {
  test(`Phase 2 rejects ${scenario} assessment proofs`, async () => {
    let proofs = await previews();
    const options = {};
    if (scenario === 'tampered') {
      const parts = proofs[0].split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
      payload.assessment.canonical_class = 'road_crack';
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url'); proofs[0] = parts.join('.');
    }
    if (scenario === 'expired') {
      const { iat, exp, aud, iss, jti, ...payload } = proofProvider.verifyAssessment(proofs[0]);
      proofs[0] = proofProvider.issueAssessment(payload, -1);
    }
    if (scenario === 'wrong citizen') options.token = other.token;
    if (scenario === 'wrong order') proofs.reverse();
    if (scenario === 'different bytes') options.firstBytes = PNG_BYTES;
    if (scenario === 'duplicate') proofs[1] = proofs[0];
    if (scenario === 'malformed') proofs = '{broken';
    const calls = inferenceCalls;
    const result = await submit(proofs, 'Road Damage', options);
    assert.equal(result.status, 400);
    const expectedCode = ['tampered', 'expired'].includes(scenario) ? 'ASSESSMENT_INVALID' : scenario === 'malformed' ? 'ASSESSMENT_REQUIRED' : 'ASSESSMENT_MISMATCH';
    assert.equal(result.data.code, expectedCode);
    assert.equal(inferenceCalls, calls);
  });
}

test('Phase 2 prevents full and partial proof replay after committed submission', async () => {
  const proofs = await previews();
  assert.equal((await submit(proofs)).status, 201);
  assert.equal((await submit(proofs)).status, 409);
  const fresh = await previews();
  assert.equal((await submit([proofs[0], fresh[1]])).status, 409);
});

test('Phase 2 proof cannot be used as an authentication bearer token', async () => {
  const proofs = await previews();
  assert.equal((await fetch(`${baseUrl}/api/reports`, { headers: { Authorization: `Bearer ${proofs[0]}` } })).status, 401);
});

test('Phase 2 failed transaction removes mocked storage objects and does not consume proofs', async () => {
  const proofs = await previews();
  const storage = getImageStorage();
  const originalUpload = storage.upload;
  const originalRemove = storage.remove;
  const originalAudit = auditService.writeAudit;
  const uploaded = [];
  const removed = [];
  const before = (await testDatabase().query('SELECT COUNT(*) AS count FROM reports'))[0].count;
  storage.upload = async () => { const reference = `supabase:phase2-test/${uploaded.length}.jpg`; uploaded.push(reference); return { reference }; };
  storage.remove = async reference => { removed.push(reference); };
  auditService.writeAudit = async () => { throw new Error('Isolated audit failure'); };
  try {
    assert.equal((await submit(proofs)).status, 500);
    assert.deepEqual([...removed].sort(), [...uploaded].sort());
    assert.equal(uploaded.length, 5, 'Original evidence, landmark evidence, and private publication previews are all cleaned on rollback.');
    assert.equal((await testDatabase().query('SELECT COUNT(*) AS count FROM reports'))[0].count, before);
  } finally {
    storage.upload = originalUpload; storage.remove = originalRemove; auditService.writeAudit = originalAudit;
  }
  assert.equal((await submit(proofs)).status, 201);
});

test('Phase 2 rejects malformed repository snapshots before database writes', async () => {
  await assert.rejects(() => reportRepository.create({ submissionAssessment: { schema_version: 1, citizen_category: 'Road Damage', original_ai: null } }), /Malformed/);
});

test('Phase 2 status updates do not provide an alternate category modification route', async () => {
  const result = await submit(await previews());
  const response = await fetch(`${baseUrl}/api/reports/${result.data.id}/status`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ongoing', citizenCategory: 'Street Light Damage' })
  });
  assert.equal(response.status, 403);
  const row = await reportRepository.findById(result.data.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.submission_assessment.citizen_category, 'Road Damage');
});

test('Phase 2 assigned Barangay status change keeps the original and correction immutable and omits proof metadata', async () => {
  mode = 'broken_streetlight';
  const result = await submit(await previews());
  mode = 'pothole';
  const token = officialOne.token;
  const response = await fetch(`${baseUrl}/api/reports/${result.data.id}/status`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ongoing', citizenCategory: 'Flooding / Drainage', originalAi: { status: 'VERIFIED' } })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ongoing');
  assert.equal(body.citizenCategory, 'Road Damage');
  assert.equal(body.originalAi.canonical_class, 'broken_streetlight');
  assert.doesNotMatch(JSON.stringify(body), /proof_id|assessmentProof|evidence_sha256/);
});

test('Phase 2 explicit read mapping strips internal fields even inside stored original photos', async () => {
  const result = await submit(await previews());
  const row = await reportRepository.findById(result.data.id);
  row.submission_assessment.original_ai.internal_secret = 'hidden-pair-field';
  row.submission_assessment.original_ai.confidence = 0.8765;
  row.submission_assessment.original_ai.photos[0].internal_secret = 'hidden-photo-field';
  row.submission_assessment.original_ai.photos[0].candidate.internal_secret = 'hidden-candidate-field';
  await testDatabase().execute('UPDATE reports SET submission_assessment = ? WHERE id = ?', [JSON.stringify(row.submission_assessment), row.id]);
  const response = await fetch(`${baseUrl}/api/reports`, { headers: { Authorization: `Bearer ${citizen.token}` } });
  assert.equal(response.status, 200);
  const saved = (await response.json()).reports.find(report => report.id === row.id);
  assert.doesNotMatch(JSON.stringify(saved), /hidden-|internal_secret|proof_id/);
  assert.equal(saved.originalAi.canonical_class, 'pothole');
  assert.equal(saved.originalAi.confidence, 0.8765);
});

test('Phase 2 ordered preview rejects corrupt evidence before inference or proof issuance', async () => {
  const calls = inferenceCalls;
  const body = new FormData();
  body.append('photoOrder', '1');
  body.append('images', new File([JPEG_BYTES.subarray(0, 30)], 'truncated.jpg', { type: 'image/jpeg' }));
  const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'IMAGE_VALIDATION_ERROR');
  assert.equal(data.assessmentProof, undefined);
  assert.equal(inferenceCalls, calls);
});

test('Phase 2 proof issuance remains citizen-only and validates the declared photo order', async () => {
  for (const [token, order, status] of [[citizen.token, 3, 400], [officialOne.token, 1, 403]]) {
    const body = new FormData();
    body.append('photoOrder', String(order));
    body.append('images', new File([JPEG_BYTES], 'photo.jpg', { type: 'image/jpeg' }));
    const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    assert.equal(response.status, status);
    assert.equal((await response.json()).assessmentProof, undefined);
  }
});

for (const selectedMode of ['malformed', 'missing-confidence', 'classless', 'conflicting-class', 'unsupported-evidence', 'invalid-eligibility']) {
test(`Phase 2 ${selectedMode} provider success is unavailable, never fabricated no detection`, async () => {
  mode = selectedMode;
  const proofs = [];
  for (const order of [1, 2]) {
    const body = new FormData();
    body.append('photoOrder', String(order));
    body.append('images', new File([order === 2 ? SECOND_JPEG_BYTES : JPEG_BYTES], 'photo.jpg', { type: 'image/jpeg' }));
    const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body });
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.code, 'INFERENCE_RESPONSE');
    proofs.push(data.assessmentProof);
  }
  const result = await submit(proofs, 'Road Damage');
  assert.equal(result.status, 201);
  assert.equal(result.data.originalAi.status, 'AI_UNAVAILABLE');
  assert.equal(result.data.originalAi.confidence, null);
  mode = 'pothole';
});
}

for (const [scenario, selectedMode, selectedConfidence] of [['LOW_CONFIDENCE', 'pothole', 0.2], ['NO_DETECTION', 'none', 0.9], ['AI_UNAVAILABLE', 'unavailable', 0.9]]) {
  test(`Phase 2 ${scenario} still submits without an optional category selection`, async () => {
    mode = selectedMode; confidence = selectedConfidence;
    const actor = await register(`phase2_optional_${scenario.toLowerCase()}`);
    const result = await submit(await previews(actor.token), null, { token: actor.token });
    assert.equal(result.status, 201);
    assert.equal(result.data.citizenCategory, null);
    assert.equal(result.data.originalAi.status, scenario);
    assert.equal(result.data.originalAi.detected, false);
    assert.equal((await reportRepository.findById(result.data.id)).submission_assessment.citizen_category, null);
    mode = 'pothole'; confidence = 0.9;
  });
}
