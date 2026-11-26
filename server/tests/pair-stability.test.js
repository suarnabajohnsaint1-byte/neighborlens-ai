const test = require('node:test');
const assert = require('node:assert/strict');
const { damageDetectionService } = require('../composition');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../../tests/support/image-fixtures');
const { assessPair, percent } = require('../../frontend/js/citizen/damagePairAssessment');

function detection(className, confidence = 0.8, eligible = true) {
  return { damage_type: className, confidence_score: confidence, eligible, severity_level: null };
}

function verify(first, second, extra = {}) {
  return damageDetectionService.verifyDamagePair(JPEG_BYTES, SECOND_JPEG_BYTES, {
    inferenceClient: async () => ({
      model: 'NeighborLens YOLOv8',
      evidence_relevance: 'VERIFIED',
      min_confidence: 0.3,
      detected: false,
      image1_detections: first,
      image2_detections: second,
      summary: {
        is_valid_match: false,
        damage_type_consensus: 'road_crack',
        composite_similarity_score: 0.15,
        embedding_similarity: 0.15
      },
      ...extra
    })
  });
}

test('same accepted class remains detected despite low scene similarity', async () => {
  const result = await verify([detection('road_crack')], [detection('road_crack', 0.7)]);
  assert.equal(result.detected, true);
  assert.equal(result.is_valid_match, false);
  assert.equal(result.agreement, true);
  assert.equal(result.report_category, 'Road Damage');
  assert.equal(result.confidence, 0.75);
});

test('missing confidence is not displayed as zero percent', () => {
  assert.equal(percent(null), null);
  assert.equal(percent(undefined), null);
});

test('scene mismatch supplies an advisory without blocking a provisional pair', () => {
  const entry = (confidence) => ({
    ok: true,
    result: {
      status: 'LOW_CONFIDENCE',
      candidate: {
        canonical_category: 'road_crack',
        display_category: 'Road Crack',
        confidence,
        accepted: false
      },
      report_category: 'Road Damage',
      detections: []
    }
  });
  const pair = assessPair([entry(0.25), entry(0.2)], { matched: false, score: 15, threshold: 82 });
  assert.equal(pair.state, 'LOW_CONFIDENCE');
  assert.equal(pair.submittable, true);
  assert.match(pair.sceneAdvisory, /could not verify a scene match/i);
  assert.equal(pair.priority, null);
});

const scenarios = [
  ['same class', [detection('pothole')], [detection('pothole', 0.6)], 'DETECTED', true],
  [
    'different classes with same report category',
    [detection('pothole')],
    [detection('road_crack')],
    'PAIR_MISMATCH',
    false
  ],
  [
    'different report categories',
    [detection('road_crack')],
    [detection('clogged_drainage')],
    'PAIR_MISMATCH',
    false
  ],
  [
    'accepted and provisional class',
    [detection('pothole')],
    [detection('pothole', 0.2, false)],
    'LOW_CONFIDENCE',
    true
  ],
  [
    'both provisional',
    [detection('road_crack', 0.2, false)],
    [detection('road_crack', 0.25, false)],
    'LOW_CONFIDENCE',
    true
  ],
  [
    'conflicting provisional classes',
    [detection('pothole', 0.2, false)],
    [detection('road_crack', 0.25, false)],
    'PAIR_MISMATCH',
    false
  ],
  ['one empty photo', [detection('pothole')], [], 'PAIR_MISMATCH', false],
  ['both empty photos', [], [], 'NO_DETECTION', false],
  ['unsupported class', [detection('car')], [detection('car')], 'UNSUPPORTED', false],
  [
    'provider-ineligible prediction',
    [detection('pothole', 0.9, false)],
    [detection('pothole')],
    'LOW_CONFIDENCE',
    true
  ],
  [
    'different primary classes with a shared secondary class',
    [detection('pothole', 0.9), detection('road_crack', 0.6)],
    [detection('road_crack', 0.9), detection('pothole', 0.6)],
    'PAIR_MISMATCH',
    false
  ]
];

for (const [name, first, second, status, agreement] of scenarios) {
  test(`Node and citizen pair contract: ${name}`, async () => {
    const result = await verify(first, second, {
      summary: {
        is_valid_match: true,
        damage_type_consensus: 'pothole',
        highest_severity: 'critical',
        composite_similarity_score: 0.95
      }
    });
    const frontend = assessPair(
      [
        { ok: true, result: result.image1_assessment },
        { ok: true, result: result.image2_assessment }
      ],
      { matched: true, score: 95, threshold: 82 }
    );
    assert.equal(result.status, status);
    assert.equal(frontend.state, status);
    assert.equal(result.class_agreement, agreement);
    assert.equal(frontend.agreement, agreement);
    assert.equal(result.detected, status === 'DETECTED');
    assert.equal(frontend.detected, result.detected);
    assert.equal(frontend.category, result.report_category);
    assert.equal(frontend.confidence, result.confidence);
    assert.equal(result.highest_severity, null);
    assert.equal(result.triage, null);
    assert.equal(frontend.classification, null);
    assert.equal(frontend.priority, null);
    assert.deepEqual(result.raw_payload.image1_detections, first);
    assert.deepEqual(frontend.photos[0].rawResult.raw_detection_data.detections, first);
    if (name === 'different classes with same report category') {
      assert.equal(result.same_report_category, true);
      assert.equal(frontend.sharedReportCategory, 'Road Damage');
      assert.equal(result.damage_type_consensus, null);
    }
  });
}

for (const [canonical, category] of [
  ['road_crack', 'Road Damage'],
  ['pothole', 'Road Damage'],
  ['clogged_drainage', 'Flooding / Drainage'],
  ['broken_streetlight', 'Street Light Damage']
]) {
  test(`authoritative mapping is preserved in backend and citizen presentation for ${canonical}`, async () => {
    const result = await verify([detection(canonical)], [detection(canonical)]);
    const frontend = assessPair([
      { ok: true, result: result.image1_assessment },
      { ok: true, result: result.image2_assessment }
    ]);
    assert.equal(result.report_category, category);
    assert.equal(frontend.category, category);
    assert.equal(frontend.canonicalClass, canonical);
  });
}

test('scene comparison cannot supply AI confidence or severity when detections are absent', async () => {
  const result = await verify([], [], {
    confidence: 0.99,
    summary: {
      is_valid_match: true,
      damage_type_consensus: 'pothole',
      highest_severity: 'critical',
      composite_similarity_score: 0.99
    }
  });
  assert.equal(result.detected, false);
  assert.equal(result.confidence, null);
  assert.equal(result.candidate, null);
  assert.equal(result.highest_severity, null);
});

test('a missing scene result remains separate from agreeing accepted detections', async () => {
  const result = await verify([detection('pothole')], [detection('pothole')], { summary: {} });
  assert.equal(result.detected, true);
  assert.equal(result.scene_status, 'UNAVAILABLE');
  const frontend = assessPair([
    { ok: true, result: result.image1_assessment },
    { ok: true, result: result.image2_assessment }
  ]);
  assert.match(frontend.sceneAdvisory, /unavailable/i);
  assert.equal(frontend.submittable, true);
});

test('rounding cannot promote a provider prediction just below the unchanged threshold', async () => {
  const low = { damage_type: 'pothole', confidence_score: 0.29996 };
  const result = await verify([low], [detection('pothole')]);
  assert.equal(result.status, 'LOW_CONFIDENCE');
  assert.equal(result.detected, false);
  assert.equal(result.image1_detections[0].raw_confidence_score, 0.29996);
});

test('low-confidence results without a supported candidate retain null category and confidence', () => {
  const entry = {
    ok: true,
    result: { status: 'LOW_CONFIDENCE', candidate: null, report_category: null, detections: [] }
  };
  const result = assessPair([entry, entry]);
  assert.equal(result.state, 'LOW_CONFIDENCE');
  assert.equal(result.category, null);
  assert.equal(result.confidence, null);
  assert.equal(result.confidencePercent, null);
  assert.equal(result.agreement, false);
  assert.equal(result.priority, null);
});

test('a claimed detected status does not confirm a provisional candidate', () => {
  const entry = {
    ok: true,
    result: {
      status: 'DETECTED',
      candidate: {
        canonical_category: 'pothole',
        display_category: 'Pothole',
        confidence: 0.2,
        accepted: false
      },
      report_category: 'Road Damage',
      triage: { classification: 'MAJOR', priority: 'Critical' }
    }
  };
  const result = assessPair([entry, entry]);
  assert.equal(result.state, 'LOW_CONFIDENCE');
  assert.equal(result.detected, false);
  assert.equal(result.classification, null);
  assert.equal(result.priority, null);
});

test('provider summary cannot overwrite actual supported photo evidence with a legacy class', async () => {
  const result = await verify([detection('pothole')], [detection('pothole')], { summary: { is_valid_match: false, damage_type_consensus: 'damaged_road' } });
  assert.equal(result.detected, true);
  assert.equal(result.canonical_category, 'pothole');
  assert.equal(result.source, 'yolo_backend');
  assert.equal(result.raw_payload.summary.damage_type_consensus, 'damaged_road');
});

test('a provider response missing one photo assessment is a provider error', async () => {
  await assert.rejects(verify([detection('pothole')], null), { code: 'INFERENCE_RESPONSE', kind: 'PROVIDER_FAILURE' });
});
