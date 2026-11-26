const test = require('node:test');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../../tests/support/image-fixtures');
const assert = require('node:assert/strict');

const { damageDetectionService } = require('../composition');
const {
  CANONICAL_DAMAGE_CATEGORIES,
  DISPLAY_LABELS,
  isCanonicalDamageCategory
} = require('../domain/reports/damageCategories');

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const LEGACY = ['damaged_road', 'damaged_street_light', 'damaged_traffic_light'];

function fastApiPayload(className, confidence, extra = {}) {
  return {
    ok: true,
    model: 'neighborlens-paper-aligned-v2-baseline',
    min_confidence: 0.3,
    detections: [{ class: className, confidence, eligible: confidence >= 0.3, bounding_box: { x: 1, y: 2, width: 3, height: 4 } }],
    ...extra
  };
}

function run(payload, options = { minConfidence: 0.3 }) {
  return damageDetectionService.processDamageImage(JPEG_HEADER, {
    ...options, inferenceClient: async () => ({ evidence_relevance: 'VERIFIED', ...payload })
  });
}

test('the canonical contract is exactly the four paper-aligned research classes', () => {
  assert.deepEqual([...CANONICAL_DAMAGE_CATEGORIES], ['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']);
  assert.deepEqual({ ...DISPLAY_LABELS }, {
    broken_streetlight: 'Broken Streetlight',
    clogged_drainage: 'Clogged Drainage',
    pothole: 'Pothole',
    road_crack: 'Road Crack'
  });
  for (const legacy of LEGACY) assert.equal(isCanonicalDamageCategory(legacy), false);
});

for (const category of ['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']) {
  test(`${category} survives FastAPI payload -> service -> response unchanged`, async () => {
    const result = await run(fastApiPayload(category, 0.82));

    assert.equal(result.detected, true);
    assert.equal(result.inconclusive, false);
    assert.equal(result.canonical_category, category);
    assert.equal(result.damage_type, category);
    assert.equal(result.category, category);
    assert.equal(result.display_category, DISPLAY_LABELS[category]);
    assert.equal(result.detections[0].damage_type, category);
    assert.equal(result.detections[0].canonical_category, category);
    assert.equal(result.source, 'yolo_backend');
    assert.equal(result.reason, null);
    assert.equal(result.confidence, 0.82);

    const serialized = JSON.stringify({ ...result, raw_detection_data: undefined });
    for (const legacy of LEGACY) assert.equal(serialized.includes(legacy), false, `${legacy} leaked for ${category}`);
  });
}

test('pothole and road_crack are never merged into damaged_road', async () => {
  for (const category of ['pothole', 'road_crack']) {
    const result = await run(fastApiPayload(category, 0.9));
    assert.notEqual(result.canonical_category, 'damaged_road');
    assert.notEqual(result.display_category, 'Road Damage');
  }
});

test('broken_streetlight is never translated into damaged_street_light', async () => {
  const result = await run(fastApiPayload('broken_streetlight', 0.9));
  assert.notEqual(result.canonical_category, 'damaged_street_light');
  assert.notEqual(result.display_category, 'Street Light Damage');
});

test('road_crack is supported and never reported as yolo_backend_unsupported', async () => {
  const result = await run(fastApiPayload('road_crack', 0.55));
  assert.equal(result.detected, true);
  assert.notEqual(result.source, 'yolo_backend_unsupported');
});

for (const [confidence, eligible] of [[0.31, true], [0.3, true], [0.2999, false], [0.22, false], [0.15, false]]) {
  test(`confidence ${confidence} at threshold 0.30 is ${eligible ? 'eligible' : 'inconclusive'}`, async () => {
    const result = await run(fastApiPayload('pothole', confidence, { inference_status: 'low_confidence_match' }));

    assert.equal(result.detected, eligible);
    assert.equal(result.inconclusive, !eligible);
    assert.equal(result.confidence, confidence);
    assert.equal(result.summary.min_confidence, 0.3);
    if (eligible) {
      assert.equal(result.canonical_category, 'pothole');
      assert.equal(result.reason, null);
    } else {
      assert.equal(result.canonical_category, null);
      assert.equal(result.damage_type, null);
      assert.equal(result.reason, 'LOW_CONFIDENCE');
      assert.equal(result.source, 'yolo_backend');
      assert.equal(result.bounding_box, null);
    }
  });
}

test('a provider that claims detected:true for a sub-threshold box cannot promote it', async () => {
  const result = await run(fastApiPayload('pothole', 0.15, { detected: true, category: 'pothole', canonical_category: 'pothole' }));
  assert.equal(result.detected, false);
  assert.equal(result.canonical_category, null);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
});

test('the stricter of the Node and FastAPI thresholds applies', async () => {
  const result = await run(fastApiPayload('pothole', 0.35, { min_confidence: 0.4 }), { minConfidence: 0.3 });
  assert.equal(result.detected, false);
  assert.equal(result.summary.min_confidence, 0.4);
});

test('a provider-side ineligible flag is respected even when rounding lands on the threshold', async () => {
  const payload = fastApiPayload('pothole', 0.3);
  payload.detections[0].eligible = false;
  const result = await run(payload);
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
});

test('an unknown model class is unsupported and never mapped to another damage type', async () => {
  for (const unknown of ['damaged_road', 'traffic_light', 'car']) {
    const result = await run(fastApiPayload(unknown, 0.97));
    assert.equal(result.detected, false);
    assert.equal(result.inconclusive, true);
    assert.equal(result.canonical_category, null);
    assert.equal(result.damage_type, null);
    assert.equal(result.reason, 'UNSUPPORTED_CLASS');
    assert.equal(result.source, 'yolo_backend_unsupported');
    assert.equal(result.detections[0].damage_type, unknown);
    assert.equal(result.detections[0].canonical_category, null);
  }
});

test('a canonical detection wins over a higher-confidence unknown class', async () => {
  const result = await run({
    detections: [
      { class: 'car', confidence: 0.99 },
      { class: 'road_crack', confidence: 0.6 }
    ]
  });
  assert.equal(result.canonical_category, 'road_crack');
  assert.equal(result.summary.accepted_count, 1);
});

test('primary selection across images prefers a detected result over an inconclusive one', async () => {
  const accepted = await run(fastApiPayload('road_crack', 0.4));
  const lowConfidence = await run(fastApiPayload('pothole', 0.29));
  assert.equal(damageDetectionService.selectPrimaryResult([lowConfidence, accepted]), accepted);
});

test('pair verification keeps the canonical consensus and rejects a legacy one', async () => {
  const verify = consensus => damageDetectionService.verifyDamagePair(JPEG_BYTES, SECOND_JPEG_BYTES, {
    inferenceClient: async () => ({ evidence_relevance: 'VERIFIED', summary: { is_valid_match: true, damage_type_consensus: consensus } })
  });

  const canonical = await verify('road_crack');
  assert.equal(canonical.detected, true);
  assert.equal(canonical.canonical_category, 'road_crack');
  assert.equal(canonical.display_category, 'Road Crack');

  const legacy = await verify('damaged_road');
  assert.equal(legacy.detected, false);
  assert.equal(legacy.canonical_category, null);
  assert.equal(legacy.reason, 'UNSUPPORTED_CLASS');
});
