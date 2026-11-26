const test = require('node:test');
const assert = require('node:assert/strict');
const { createDamageDetectionService } = require('../application/use-cases/damageDetection.service');
const { DamageDetectionError } = require('../domain/errors');
const { originalAssessment } = require('../domain/reports/submissionAssessment.rules');
const proof = require('../infrastructure/security/tokenProvider');
const { JPEG_BYTES } = require('../../tests/support/image-fixtures');

function service(payload) {
  return createDamageDetectionService({
    aiProvider: { detectionDefaults: () => ({ minConfidence: 0.3 }), requestInference: async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    } },
    imageInput: require('../infrastructure/storage/imageInput.adapter'),
    assessmentProof: proof
  });
}

for (const [name, entry] of [
  ['missing class', { confidence_score: 0.95 }],
  ['empty class', { damage_type: '', confidence_score: 0.95 }],
  ['whitespace class', { damage_type: ' ', confidence_score: 0.95 }],
  ['numeric class', { damage_type: 2, confidence_score: 0.95 }],
  ['object class', { damage_type: {}, confidence_score: 0.95 }],
  ['unsupported class', { damage_type: 'car', confidence_score: 0.95 }],
  ['conflicting classes', { damage_type: 'pothole', class: 'road_crack', confidence_score: 0.95 }],
  ['conflicting canonical class', { damage_type: 'pothole', canonical_category: 'road_crack', confidence_score: 0.95 }],
  ['canonical field without model class', { canonical_category: 'pothole', confidence_score: 0.95 }],
  ['null entry', null],
  ['missing confidence', { damage_type: 'pothole' }],
  ['null confidence', { damage_type: 'pothole', confidence_score: null }],
  ['empty confidence', { damage_type: 'pothole', confidence_score: '' }],
  ['boolean confidence', { damage_type: 'pothole', confidence_score: true }],
  ['negative confidence', { damage_type: 'pothole', confidence_score: -1 }],
  ['oversized confidence', { damage_type: 'pothole', confidence_score: 101 }],
  ['NaN confidence', { damage_type: 'pothole', confidence_score: NaN }],
  ['infinite confidence', { damage_type: 'pothole', confidence_score: Infinity }],
  ['invalid eligibility', { damage_type: 'pothole', confidence_score: 0.95, eligible: 'false' }],
  ['conflicting confidences', { damage_type: 'pothole', confidence_score: 0.95, confidence: 0.1 }],
  ['invalid alternate confidence', { damage_type: 'pothole', confidence_score: 0.95, confidence: null }]
]) {
  test(`Phase 2 evidence: ${name} becomes signed unavailable, never signed no detection`, async () => {
    const detector = service({ detections: [entry] });
    const photos = await Promise.all([1, 2].map(order => detector.assessCitizenPhoto(JPEG_BYTES, { id: 1, role: 'citizen' }, order)));
    const assessments = photos.map(photo => {
      assert.equal(photo.failure.code, 'INFERENCE_RESPONSE');
      assert.equal(photo.failure.status, 502);
      const assessment = proof.verifyAssessment(photo.assessmentProof).assessment;
      assert.equal(assessment.status, 'AI_UNAVAILABLE');
      assert.equal(assessment.detected, false);
      assert.equal(assessment.confidence, null);
      assert.deepEqual(assessment.detections, []);
      return assessment;
    });
    assert.equal(originalAssessment(assessments).status, 'AI_UNAVAILABLE');
  });
}

for (const damageType of ['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']) {
  test(`Phase 2 evidence: independently verified ${damageType} remains accepted`, async () => {
    const result = await service({
      evidence_relevance: 'VERIFIED',
      detections: [{ damage_type: damageType, confidence_score: 0.9 }]
    }).assessCitizenPhoto(JPEG_BYTES, { id: 1, role: 'citizen' }, 1);
    assert.equal(result.failure, null);
    const assessment = proof.verifyAssessment(result.assessmentProof).assessment;
    assert.equal(assessment.status, 'DETECTED');
    assert.equal(assessment.canonical_class, damageType);
    assert.equal(assessment.confidence, 0.9);
  });
}

for (const [name, detections, status, confidence] of [
  ['empty detections', [], 'NO_DETECTION', null],
  ['low confidence', [{ damage_type: 'pothole', confidence_score: 0.2 }], 'LOW_CONFIDENCE', 0.2],
  ['ineligible candidate', [{ damage_type: 'pothole', confidence_score: 0.9, eligible: false }], 'LOW_CONFIDENCE', 0.9],
  ['percentage confidence', [{ damage_type: 'pothole', confidence_score: 90 }], 'DETECTED', 0.9],
  ['equivalent confidence aliases', [{ damage_type: 'pothole', confidence_score: 90, confidence: 0.9 }], 'DETECTED', 0.9],
  ['score alias', [{ class: 'pothole', score: 0.9 }], 'DETECTED', 0.9]
]) {
  test(`Phase 2 evidence: ${name} retains its genuine outcome`, async () => {
    const result = await service({ evidence_relevance: 'VERIFIED', detections }).assessCitizenPhoto(JPEG_BYTES, { id: 1, role: 'citizen' }, 1);
    assert.equal(result.failure, null);
    const assessment = proof.verifyAssessment(result.assessmentProof).assessment;
    assert.equal(assessment.status, status);
    assert.equal(assessment.confidence, confidence);
    assert.equal(assessment.detected, status === 'DETECTED');
  });
}

test('Phase 2 evidence: mixed valid and malformed entries cannot manufacture acceptance', async () => {
  const result = await service({ detections: [{ damage_type: 'pothole', confidence_score: 0.9 }, { confidence_score: 0.95 }] }).assessCitizenPhoto(JPEG_BYTES, { id: 1, role: 'citizen' }, 1);
  assert.equal(proof.verifyAssessment(result.assessmentProof).assessment.status, 'AI_UNAVAILABLE');
});

test('Phase 2 evidence: provider failure retains signed unavailable status', async () => {
  const result = await service(new DamageDetectionError('Isolated failure', 'INFERENCE_NETWORK', 502)).assessCitizenPhoto(JPEG_BYTES, { id: 1, role: 'citizen' }, 1);
  assert.equal(result.failure.code, 'INFERENCE_NETWORK');
  assert.equal(proof.verifyAssessment(result.assessmentProof).assessment.status, 'AI_UNAVAILABLE');
});

test('Phase 2 evidence: legacy unsupported responses retain the existing contract', async () => {
  const result = await service({ detections: [{ damage_type: 'car', confidence_score: 0.95 }] }).processDamageImage(JPEG_BYTES);
  assert.equal(result.status, 'UNSUPPORTED');
  assert.equal(result.detected, false);
});
