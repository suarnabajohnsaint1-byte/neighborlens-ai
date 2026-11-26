const test = require('node:test');
const assert = require('node:assert/strict');
const { addReportGps, setFixtureResidency } = require('../support/citizens');
const jwt = require('jsonwebtoken');

const { createTestApp, testDatabase } = require('../support/test-app');
const { DamageDetectionError } = require('../../server/domain/errors');
const env = require('../../server/infrastructure/config/env');
const { seedDemoCitizen } = require('../../server/infrastructure/database/demoCitizenSeed');
const { assessPair } = require('../../frontend/js/citizen/damagePairAssessment');

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const LEGACY_CLASSES = ['damaged_road', 'damaged_street_light', 'damaged_traffic_light'];
const MODEL_INFO = {
  name: 'NeighborLens YOLOv8m',
  architecture: 'YOLOv8m',
  version: 'neighborlens_v3_1_interim',
  release_label: 'v3.1 Interim Baseline',
  checkpoint: 'neighborlens_v3_1_interim/weights/best.pt',
  target_eligible: false,
  classes: { 0: 'broken_streetlight', 1: 'clogged_drainage', 2: 'pothole', 3: 'road_crack' }
};

const scripted = { queue: [], seen: 0 };
const app = createTestApp({
  inference: async () => {
    scripted.seen += 1;
    const answer = scripted.queue.length > 1 ? scripted.queue.shift() : scripted.queue[0];
    return typeof answer === 'function' ? answer() : answer;
  }
});

let server;
let baseUrl;
let demoToken;

function providerPayload(detections, extra = {}) {
  return {
    model: 'NeighborLens YOLOv8m neighborlens_v3_1_interim',
    model_info: MODEL_INFO,
    min_confidence: 0.3,
    image_size: { width: 1280, height: 960 },
    detections,
    ...extra
  };
}

function script(...answers) {
  scripted.queue = answers;
  scripted.seen = 0;
}

function login(username, password, portal = 'citizen') {
  return fetch(`${baseUrl}/api/auth/${portal}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
}

function damageRequest(token, name = 'photo.jpg') {
  const form = new FormData();
  form.append('images', new File([JPEG_BYTES], name, { type: 'image/jpeg' }));
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers, body: form });
}

async function damage(token, name) {
  const response = await damageRequest(token, name);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  await setFixtureResidency('citizen', 'Barangay 1');
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

test('the demo citizen/1 credential authenticates against the API as a citizen', async () => {
  assert.equal(env.DEMO_CITIZEN_USERNAME, 'citizen');
  assert.equal(env.DEMO_CITIZEN_PASSWORD, '1');
  const response = await login('citizen', '1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.username, 'citizen');
  assert.equal(body.user.role, 'citizen');
  assert.equal(body.user.password_hash, undefined);
  assert.ok(body.token);
  demoToken = body.token;
});

test('invalid demo credentials stay unauthorized', async () => {
  assert.equal((await login('citizen', '2')).status, 401);
  assert.equal((await login('citizen', '')).status, 401);
  assert.equal((await login('not-a-user', '1')).status, 401);
});

test('the demo citizen seed is idempotent and never resets the stored credential', async () => {
  const database = testDatabase();
  const before = await database.query('SELECT id, password_hash FROM users WHERE username = ?', ['citizen']);
  const result = await seedDemoCitizen(database);
  const after = await database.query('SELECT id, password_hash FROM users WHERE username = ?', ['citizen']);
  assert.equal(result.seeded, false);
  assert.equal(before.length, 1);
  assert.deepEqual(after, before);
});

test('an authenticated demo citizen gets a DETECTED assessment with boxes, image size and model identity', async () => {
  script(providerPayload([
    { class: 'road_crack', confidence: 0.64, severity_level: 'high', eligible: true, bbox: { x: 100, y: 120, width: 300, height: 200 } },
    { class: 'pothole', confidence: 0.12, eligible: false, bbox: { x: 10, y: 10, width: 20, height: 20 } }
  ]));
  const { status, body } = await damage(demoToken);
  assert.equal(status, 200);
  const result = body.primary;
  assert.equal(result.status, 'DETECTED');
  assert.equal(result.detected, true);
  assert.equal(result.canonical_category, 'road_crack');
  assert.equal(result.display_category, 'Road Crack');
  assert.equal(result.report_category, 'Road Damage');
  assert.deepEqual(result.candidate, { canonical_category: 'road_crack', display_category: 'Road Crack', confidence: 0.64, accepted: true });
  assert.equal(result.triage, null);
  assert.equal(result.severityStatus, 'NOT_ASSESSED');
  assert.deepEqual(result.image_size, { width: 1280, height: 960 });
  assert.deepEqual(result.bounding_box, { x: 100, y: 120, width: 300, height: 200 });
  assert.deepEqual(result.detections.map(item => [item.damage_type, item.eligible]), [['road_crack', true], ['pothole', false]]);
  assert.deepEqual(result.detections[0].bounding_box, { x: 100, y: 120, width: 300, height: 200 });
  assert.equal(result.model_info.name, 'NeighborLens YOLOv8m');
  assert.equal(result.model_info.release_label, 'v3.1 Interim Baseline');
  assert.equal(result.model_info.target_eligible, false);
});

test('a sub-threshold canonical detection is LOW_CONFIDENCE with its real confidence', async () => {
  script(providerPayload([{ class: 'road_crack', confidence: 0.22, eligible: false, bbox: { x: 1, y: 1, width: 5, height: 5 } }]));
  const { status, body } = await damage(demoToken);
  assert.equal(status, 200);
  assert.equal(body.primary.status, 'LOW_CONFIDENCE');
  assert.equal(body.primary.detected, false);
  assert.equal(body.primary.canonical_category, null);
  assert.equal(body.primary.report_category, 'Road Damage');
  assert.equal(body.primary.triage, null);
  assert.deepEqual(body.primary.candidate, { canonical_category: 'road_crack', display_category: 'Road Crack', confidence: 0.22, accepted: false });
});

test('an empty provider response is NO_DETECTION', async () => {
  script(providerPayload([]));
  const { status, body } = await damage(demoToken);
  assert.equal(status, 200);
  assert.equal(body.primary.status, 'NO_DETECTION');
  assert.equal(body.primary.candidate, null);
  assert.equal(body.primary.confidence, null);
});

test('legacy class names never surface as a canonical class', async () => {
  for (const legacy of LEGACY_CLASSES) {
    script(providerPayload([{ class: legacy, confidence: 0.95, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }]));
    const { status, body } = await damage(demoToken);
    assert.equal(status, 200);
    assert.equal(body.primary.status, 'UNSUPPORTED');
    assert.equal(body.primary.detected, false);
    assert.equal(body.primary.canonical_category, null);
    assert.equal(body.primary.report_category, null);
    assert.equal(body.primary.candidate, null);
    assert.equal(body.summary.damage_type, null);
  }
});

test('the four canonical classes map to their display names and report categories', async () => {
  const expected = {
    broken_streetlight: ['Broken Streetlight', 'Street Light Damage'],
    clogged_drainage: ['Clogged Drainage', 'Flooding / Drainage'],
    pothole: ['Pothole', 'Road Damage'],
    road_crack: ['Road Crack', 'Road Damage']
  };
  for (const [category, [display, reportCategory]] of Object.entries(expected)) {
    script(providerPayload([{ class: category, confidence: 0.8, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }]));
    const { body } = await damage(demoToken);
    assert.equal(body.primary.canonical_category, category);
    assert.equal(body.primary.display_category, display);
    assert.equal(body.primary.report_category, reportCategory);
  }
});

test('a model response never advertises a COCO baseline', async () => {
  script(providerPayload([{ class: 'pothole', confidence: 0.7, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }]));
  const { body } = await damage(demoToken);
  assert.equal(/coco/i.test(JSON.stringify(body)), false);
  assert.notEqual(env.DAMAGE_MODEL, 'yolov8m-coco-baseline');
});

test('an AI provider outage is an error status, never a no-damage result', async () => {
  script(() => {
    throw new DamageDetectionError('Inference request failed: fetch failed', 'INFERENCE_NETWORK', 502);
  });
  const { status, body } = await damage(demoToken);
  assert.equal(status, 502);
  assert.equal(body.code, 'INFERENCE_NETWORK');
  assert.equal(body.primary, undefined);
});

test('the damage endpoint refuses missing, expired, tampered and non-citizen tokens', async () => {
  script(providerPayload([]));
  const decoded = jwt.decode(demoToken);
  const expired = jwt.sign({ id: decoded.id, username: decoded.username, role: decoded.role, barangay: decoded.barangay }, env.JWT_SECRET, { expiresIn: -10 });
  const tampered = `${demoToken.slice(0, -4)}AAAA`;
  const admin = (await (await login('admin', process.env.ADMIN_PASSWORD || 'admin123', 'admin')).json()).token;

  assert.equal((await damageRequest(null)).status, 401);
  assert.equal((await damageRequest(expired)).status, 401);
  assert.equal((await damageRequest(tampered)).status, 401);
  assert.equal((await damageRequest(admin)).status, 403);
  assert.equal(scripted.seen, 0);
});

test('both photos go through /api/ai/damage and the pair assessment uses both real results', async () => {
  script(
    providerPayload([{ class: 'road_crack', confidence: 0.64, eligible: true, bbox: { x: 100, y: 120, width: 300, height: 200 } }]),
    providerPayload([{ class: 'road_crack', confidence: 0.52, eligible: true, bbox: { x: 50, y: 60, width: 100, height: 80 } }], { image_size: { width: 800, height: 600 } })
  );
  const first = await damage(demoToken, 'photo-1.jpg');
  const second = await damage(demoToken, 'photo-2.jpg');
  assert.equal(scripted.seen, 2);

  const pair = assessPair([{ ok: true, result: first.body.primary }, { ok: true, result: second.body.primary }], { matched: true, score: 88, threshold: 82 });
  assert.equal(pair.state, 'DETECTED');
  assert.equal(pair.canonicalClass, 'road_crack');
  assert.equal(pair.category, 'Road Damage');
  assert.equal(pair.confidence, 0.58);
  assert.equal(pair.agreement, true);
  assert.deepEqual(pair.photos.map(photo => photo.confidence), [0.64, 0.52]);
  assert.deepEqual(pair.photos[0].boxes[0].bbox, { x: 100, y: 120, width: 300, height: 200 });
  assert.deepEqual(pair.photos[1].imageSize, { width: 800, height: 600 });
  assert.equal(pair.model.label, 'NeighborLens YOLOv8m, v3.1 Interim Baseline');
  assert.equal(pair.model.targetEligible, false);
});

test('photos that disagree on class are a PAIR_MISMATCH, not a forced agreement', async () => {
  script(
    providerPayload([{ class: 'road_crack', confidence: 0.64, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }]),
    providerPayload([{ class: 'pothole', confidence: 0.71, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }])
  );
  const first = await damage(demoToken);
  const second = await damage(demoToken);
  const pair = assessPair([{ ok: true, result: first.body.primary }, { ok: true, result: second.body.primary }]);
  assert.equal(pair.state, 'PAIR_MISMATCH');
  assert.equal(pair.detected, false);
  assert.equal(pair.agreement, false);
  assert.equal(pair.confidence, null);
  assert.equal(pair.canonicalClass, null);
});

test('the demo citizen token can still submit a two-photo report', async () => {
  script(providerPayload([{ class: 'pothole', confidence: 0.81, eligible: true, bbox: { x: 1, y: 1, width: 5, height: 5 } }]));
  const form = new FormData();
  const fields = {
    description: 'Pothole near the chapel reported by the demo citizen',
    location: 'Chapel Road',
    barangay: 'Barangay 1',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15',
    landmarkDescription: 'Beside the school entrance.'
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  addReportGps(form);
  form.append('images', new File([JPEG_BYTES], 'r1.jpg', { type: 'image/jpeg' }));
  form.append('images', new File([SECOND_JPEG_BYTES], 'r2.jpg', { type: 'image/jpeg' }));
  form.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  const response = await fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${demoToken}` }, body: form });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(body.id);
  assert.equal(body.ai_category ?? body.aiCategory, 'pothole');
});
