const test = require('node:test');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../../tests/support/image-fixtures');
const assert = require('node:assert/strict');

const { damageDetectionService } = require('../composition');
const { DamageDetectionError } = require('../domain/errors');

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function inference(answer) {
  return async () => ({ evidence_relevance: 'VERIFIED', ...(typeof answer === 'function' ? await answer() : answer) });
}

function detect(answer, options = {}) {
  return {
    execute: (input, extra = {}) =>
      damageDetectionService.processDamageImage(input, { ...options, ...extra, inferenceClient: inference(answer) })
  };
}

function pair(answer) {
  return {
    execute: (a, b, extra = {}) =>
      damageDetectionService.verifyDamagePair(a, b, { ...extra, inferenceClient: inference(answer) })
  };
}

test('detect returns the primary detection and summary metadata', async () => {
  const result = await detect({
    model: 'yolov8-neighborlens',
    detections: [
      { class: 'pothole', confidence: 0.92, bbox: { x: 12, y: 24, width: 160, height: 90 } },
      { class: 'road debris', confidence: 0.31 }
    ]
  }).execute(JPEG_HEADER, { model: 'yolov8-neighborlens' });

  assert.equal(result.ok, true);
  assert.equal(result.damage_type, 'pothole');
  assert.equal(result.confidence_score, 0.92);
  assert.equal(result.severity_level, null);
  assert.deepEqual(result.bounding_box, { x: 12, y: 24, width: 160, height: 90 });
  assert.equal(result.detections.length, 2);
  assert.deepEqual(result.detections.map(item => item.eligible), [true, false]);
  assert.equal(result.summary.detection_count, 2);
  assert.equal(result.summary.accepted_count, 1);
  assert.equal(result.summary.rejected_count, 1);
  assert.equal(result.summary.model, 'yolov8-neighborlens');
  assert.equal(result.summary.task, 'detect');
  assert.equal(result.raw_detection_data.model, 'yolov8-neighborlens');
});

test('detect rejects an unsupported YOLO task', async () => {
  await assert.rejects(
    detect({ detections: [] }).execute(JPEG_HEADER, { task: 'tracking' }),
    error => error instanceof DamageDetectionError && error.code === 'TASK_UNSUPPORTED'
  );
});

test('detect rejects unsupported image formats', async () => {
  await assert.rejects(
    detect({ detections: [] }).execute(Buffer.from('not-an-image')),
    error => error instanceof DamageDetectionError && error.code === 'IMAGE_FORMAT'
  );
});

test('detect reports detections below the confidence threshold as inconclusive', async () => {
  const result = await detect({ detections: [{ class: 'clogged_drainage', confidence: 0.61 }] })
    .execute(JPEG_HEADER, { minConfidence: 0.8 });

  assert.equal(result.detected, false);
  assert.equal(result.inconclusive, true);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
  assert.equal(result.canonical_category, null);
  assert.equal(result.report_category, 'Flooding / Drainage');
  assert.equal(result.triage, null);
  assert.deepEqual(result.candidate, {
    canonical_category: 'clogged_drainage',
    display_category: 'Clogged Drainage',
    confidence: 0.61,
    accepted: false
  });
  assert.equal(result.confidence, 0.61);
});

test('detect preserves provider timeout errors', async () => {
  await assert.rejects(
    detect(() => {
      throw new DamageDetectionError('Inference request timed out.', 'INFERENCE_TIMEOUT', 504);
    }).execute(JPEG_HEADER),
    error => error.code === 'INFERENCE_TIMEOUT' && error.statusCode === 504
  );
});

test('detect surfaces a provider outage without leaking the endpoint', async () => {
  await assert.rejects(
    detect(() => {
      throw new DamageDetectionError('Inference request failed: fetch failed', 'INFERENCE_NETWORK', 502);
    }).execute(JPEG_HEADER),
    error => error.code === 'INFERENCE_NETWORK' &&
      error.statusCode === 502 &&
      !/127\.0\.0\.1|https?:\/\//.test(error.message)
  );
});

test('detect rejects a malformed provider payload whose detections are not an array', async () => {
  await assert.rejects(
    detect({ detections: 'pothole' }).execute(JPEG_HEADER),
    error => error instanceof DamageDetectionError && error.code === 'INFERENCE_RESPONSE' && error.statusCode === 502
  );
});

test('detect drops detection entries that carry no damage type instead of guessing one', async () => {
  const result = await detect({
    detected: true,
    detections: [
      { confidence: 0.99 },
      { class: '', confidence: 0.97 },
      { class: 'pothole', confidence: 0.91 }
    ]
  }).execute(JPEG_HEADER);

  assert.equal(result.summary.detection_count, 1);
  assert.equal(result.damage_type, 'pothole');
});

test('detect reports NO_DETECTION as an inconclusive result when the provider finds nothing', async () => {
  const result = await detect({ detected: false, detections: [] }).execute(JPEG_HEADER);

  assert.equal(result.detected, false);
  assert.equal(result.inconclusive, true);
  assert.equal(result.reason, 'NO_DETECTION');
  assert.equal(result.confidence, null);
  assert.equal(result.canonical_category, null);
});

test('detect does not trust a provider claim of detection that has no boxes', async () => {
  const result = await detect({ detected: true, detections: [] }).execute(JPEG_HEADER);

  assert.equal(result.ok, true);
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'NO_DETECTION');
  assert.equal(result.damage_id, null);
  assert.equal(result.bounding_box, null);
  assert.equal(result.severity_level, null);
  assert.deepEqual(result.detections, []);
  assert.equal(result.summary.detection_count, 0);
});

test('detect ranks multiple accepted detections and keeps every one of them', async () => {
  const result = await detect({
    detections: [
      { class: 'road_crack', confidence: 0.71 },
      { class: 'pothole', confidence: 0.88 },
      { class: 'clogged_drainage', confidence: 0.64 }
    ]
  }).execute(JPEG_HEADER, { minConfidence: 0.6 });

  assert.equal(result.detections.length, 3);
  assert.equal(result.damage_type, 'pothole');
  assert.equal(result.summary.accepted_count, 3);
  assert.equal(result.summary.rejected_count, 0);
});

test('a provider low_confidence_match status never lowers the acceptance threshold', async () => {
  const result = await detect({
    inference_status: 'low_confidence_match',
    detected: true,
    detections: [{ class: 'pothole', confidence: 0.2 }]
  }).execute(JPEG_HEADER, { minConfidence: 0.5 });

  assert.equal(result.detected, false);
  assert.equal(result.reason, 'LOW_CONFIDENCE');
  assert.equal(result.summary.inference_status, 'low_confidence');
  assert.equal(result.summary.min_confidence, 0.5);
  assert.equal(result.summary.accepted_count, 0);
  assert.equal('accepted_confidence' in result.summary, false);
});

test('detect normalizes a percentage confidence onto the 0-1 scale', async () => {
  const result = await detect({ detections: [{ class: 'pothole', confidence: 92 }] })
    .execute(JPEG_HEADER);

  assert.equal(result.confidence_score, 0.92);
});

test('verifyDamagePair processes dual images and returns alignment and consensus details', async () => {
  const result = await pair({
    ok: true,
    request_id: 'test-req-123',
    model: 'yolov8-neighborlens',
    summary: {
      is_valid_match: true,
      composite_similarity_score: 0.875,
      embedding_similarity: 0.91,
      damage_type_consensus: 'pothole',
      highest_severity: 'critical',
      alignment: {
        perspective_aligned: true,
        good_matches_count: 36,
        inlier_ratio: 0.62,
        homography_matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
      }
    },
    image1_detections: [
      { damage_id: 'd1', class: 'pothole', confidence: 0.94, severity_level: 'critical', bounding_box: { x: 10, y: 20, width: 100, height: 80 } }
    ],
    image2_detections: [
      { damage_id: 'd2', class: 'pothole', confidence: 0.89, severity_level: 'critical', bounding_box: { x: 15, y: 25, width: 95, height: 75 } }
    ]
  }).execute(JPEG_BYTES, SECOND_JPEG_BYTES);

  assert.equal(result.ok, true);
  assert.equal(result.is_valid_match, true);
  assert.equal(result.composite_similarity_score, 0.875);
  assert.equal(result.embedding_similarity, 0.91);
  assert.equal(result.damage_type_consensus, 'pothole');
  assert.equal(result.highest_severity, null);
  assert.equal(result.severityStatus, 'NOT_ASSESSED');
  assert.equal(result.raw_payload.image1_detections[0].severity_level, 'critical');
  assert.equal(result.alignment.perspective_aligned, true);
  assert.equal(result.alignment.inlier_ratio, 0.62);
  assert.equal(result.image1_detections.length, 1);
  assert.equal(result.image2_detections.length, 1);
});

test('verifyDamagePair reports a non-match without inventing a consensus type', async () => {
  const result = await pair({
    summary: { is_valid_match: false, composite_similarity_score: 0.12, embedding_similarity: 0.2 },
    image1_detections: [],
    image2_detections: []
  }).execute(JPEG_BYTES, SECOND_JPEG_BYTES);

  assert.equal(result.is_valid_match, false);
  assert.equal(result.detected, false);
  assert.equal(result.damage_type_consensus, null);
  assert.equal(result.category, 'Inconclusive');
  assert.equal(result.agreement, false);
});

test('verifyDamagePair tolerates a payload with no summary block at all', async () => {
  const result = await pair({}).execute(JPEG_BYTES, SECOND_JPEG_BYTES);

  assert.equal(result.ok, true);
  assert.equal(result.composite_similarity_score, 0);
  assert.equal(result.alignment.perspective_aligned, false);
  assert.deepEqual(result.image1_detections, []);
});
