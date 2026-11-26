const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const { startTestServer, testDatabase, DamageDetectionError } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const verificationRepository = require('../../server/infrastructure/repositories/damageVerification.repository');

let server;
let baseUrl;
let token;
let providerFailure = null;
let first = [{ damage_type: 'road_crack', confidence_score: 0.8, eligible: true }];
let second = first;
let scene = {
  is_valid_match: false,
  composite_similarity_score: 0.15,
  embedding_similarity: 0.15,
  scene_status: 'MISMATCH'
};

test.before(async () => {
  ({ server, baseUrl } = await startTestServer({
    inference: async () => ({ detections: first, min_confidence: 0.3 }),
    pairInference: async () => {
      if (providerFailure) throw providerFailure;
      return {
        image1_detections: first,
        image2_detections: second,
        min_confidence: 0.3,
        summary: { ...scene, highest_severity: 'critical', damage_type_consensus: 'road_crack' }
      };
    }
  }));
  ({ token } = await seedCitizen({ username: `pair_phase1b_${Date.now()}`, password: 'password123', barangay: 'Barangay Central', reporting: true }));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function form() {
  const body = new FormData();
  body.append('images', new File([JPEG_BYTES], 'first.jpg', { type: 'image/jpeg' }));
  body.append('images', new File([SECOND_JPEG_BYTES], 'second.jpg', { type: 'image/jpeg' }));
  return body;
}

async function requestPair() {
  const response = await fetch(`${baseUrl}/api/ai/damage-pair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form()
  });
  return { status: response.status, body: await response.json() };
}

test('pair HTTP response separates class agreement from scene match and keeps raw scene evidence', async () => {
  const response = await requestPair();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'DETECTED');
  assert.equal(response.body.agreement, true);
  assert.equal(response.body.is_valid_match, false);
  assert.equal(response.body.scene_status, 'MISMATCH');
  assert.equal(response.body.report_category, 'Road Damage');
  assert.equal(response.body.highest_severity, null);
  assert.equal(response.body.triage, null);
  assert.deepEqual(response.body.raw_payload.summary.composite_similarity_score, 0.15);
});

test('conflicting road classes are different detections despite sharing the category', async () => {
  second = [{ damage_type: 'pothole', confidence_score: 0.9, eligible: true }];
  try {
    const response = await requestPair();
    assert.equal(response.body.status, 'PAIR_MISMATCH');
    assert.equal(response.body.same_report_category, true);
    assert.equal(response.body.agreement, false);
    assert.equal(response.body.candidate, null);
    assert.equal(response.body.shared_report_category, 'Road Damage');
  } finally {
    second = first;
  }
});

test('low-confidence pair returns a supported candidate without confirmed triage', async () => {
  const saved = first;
  first = [{ damage_type: 'road_crack', confidence_score: 0.2, eligible: false }];
  second = first;
  try {
    const response = await requestPair();
    assert.equal(response.body.status, 'LOW_CONFIDENCE');
    assert.equal(response.body.candidate.canonical_category, 'road_crack');
    assert.equal(response.body.candidate.accepted, false);
    assert.equal(response.body.canonical_category, null);
    assert.equal(response.body.triage, null);
  } finally {
    first = saved;
    second = first;
  }
});

for (const [name, code, status] of [
  ['timeout', 'INFERENCE_TIMEOUT', 504],
  ['unavailable provider', 'INFERENCE_UNAVAILABLE', 503],
  ['validation failure', 'IMAGE_VALIDATION_ERROR', 400]
]) {
  test(`pair endpoint keeps ${name} distinct`, async () => {
    providerFailure = new DamageDetectionError(name, code, status);
    try {
      const response = await requestPair();
      assert.equal(response.status, status);
      assert.equal(response.body.code, code);
      assert.equal(response.body.detected, undefined);
    } finally {
      providerFailure = null;
    }
  });
}

test('valid report submission with low scene similarity persists authoritative review metadata', async () => {
  const body = form();
  body.append('description', 'Real issue with different camera angles');
  body.append('barangay', 'Barangay Central');
  body.append('latitude', '10.678');
  body.append('longitude', '122.946');
  body.append('gpsAccuracy', '15');
  body.append('gpsFixAt', String(freshReportFixAt()));
  body.append('landmarkDescription', 'Beside the school entrance.');
  body.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  });
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal(report.ai_classification, null);
  assert.equal(report.ai_priority, null);
  const [stored] = await verificationRepository.findByReportId(report.id);
  assert.equal(stored.is_valid_match, 0);
  const raw = JSON.parse(stored.raw_payload);
  assert.equal(raw.detected, true);
  assert.equal(raw.scene_status, 'MISMATCH');
  assert.equal(raw.highest_severity, null);
  assert.equal(raw.raw_payload.summary.composite_similarity_score, 0.15);
  assert.equal(raw.raw_payload.summary.highest_severity, 'critical');
  const rows = await testDatabase().query('SELECT * FROM report_images WHERE report_id = ?', [report.id]);
  assert.equal(rows.length, 2);
});
