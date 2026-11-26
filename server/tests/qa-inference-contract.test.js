const test = require('node:test');
const assert = require('node:assert/strict');
const { createDamageDetectionService } = require('../application/use-cases/damageDetection.service');
const { JPEG_BYTES } = require('../../tests/support/image-fixtures');
const { requestLocalYoloInference, requestLocalDualInference } = require('../infrastructure/ai/localYolo/localYoloClient');

function detector(payload) {
  return createDamageDetectionService({
    aiProvider: { detectionDefaults: () => ({ minConfidence: 0.3 }), requestInference: async () => payload },
    imageInput: { read: async () => ({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }) }
  });
}

for (const [name, box] of [
  ['negative width', { x: 0, y: 0, width: -1, height: 10 }],
  ['negative origin', { x: -1, y: 0, width: 10, height: 10 }],
  ['infinite coordinate', { x: Infinity, y: 0, width: 10, height: 10 }],
  ['out of bounds', { x: 90, y: 0, width: 20, height: 10 }],
  ['missing dimension', { x: 0, y: 0, width: 10 }],
  ['invalid dimension', { x: 0, y: 0, width: 'invalid', height: 10 }]
]) {
  test(`provider ${name} is rejected as a contract failure`, async () => {
    const service = detector({ image_size: { width: 100, height: 80 }, detections: [{ class: 'pothole', confidence: 0.9, bounding_box: box }] });
    await assert.rejects(service.processDamageImage({}), error => error.code === 'INFERENCE_RESPONSE');
  });
}

test('missing predictions are a provider failure, while an explicit empty array is honest no detection', async () => {
  await assert.rejects(detector({ ok: true }).processDamageImage({}), error => error.code === 'INFERENCE_RESPONSE');
  assert.equal((await detector({ detections: [] }).processDamageImage({})).status, 'NO_DETECTION');
});

test('valid edge-aligned coordinates retain their actual values', async () => {
  const box = { x: 90, y: 70, width: 10, height: 10 };
  const result = await detector({
    evidence_relevance: 'VERIFIED',
    image_size: { width: 100, height: 80 },
    detections: [{ class: 'pothole', confidence: 0.9, bounding_box: box }]
  }).processDamageImage({});
  assert.deepEqual(result.bounding_box, box);
});

test('provider HTTP failures do not expose upstream error text in single or pair adapters', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Private /srv/model credential=fixture-sensitive', detail: 'Private /srv/model credential=fixture-sensitive' }) });
  try {
    for (const operation of [
      () => requestLocalYoloInference(JPEG_BYTES, 'image/jpeg', { endpoint: 'http://127.0.0.1/predict' }),
      () => requestLocalDualInference(JPEG_BYTES, 'image/jpeg', JPEG_BYTES, 'image/jpeg', { endpoint: 'http://127.0.0.1/pair' })
    ]) await assert.rejects(operation(), error => error.code === 'INFERENCE_HTTP' && !/Private|credential|srv/.test(error.message));
  } finally { global.fetch = original; }
});
