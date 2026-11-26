const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestLocalYoloInference,
  requestLocalDualInference
} = require('../infrastructure/ai/localYolo/localYoloClient');
const { JPEG_BYTES } = require('../../tests/support/image-fixtures');

for (const status of [400, 415, 422]) {
  test(`FastAPI HTTP ${status} image errors are sanitized validation failures for single and pair calls`, async () => {
    const fetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status,
      json: async () => ({ detail: 'Private C:/server/model/image-decoder details' })
    });
    try {
      for (const call of [
        () =>
          requestLocalYoloInference(JPEG_BYTES, 'image/jpeg', { endpoint: 'http://isolated.test/predict' }),
        () =>
          requestLocalDualInference(JPEG_BYTES, 'image/jpeg', JPEG_BYTES, 'image/jpeg', {
            endpoint: 'http://isolated.test/pair'
          })
      ]) {
        await assert.rejects(call(), (error) => {
          assert.equal(error.code, 'IMAGE_VALIDATION_ERROR');
          assert.equal(error.kind, 'VALIDATION');
          assert.doesNotMatch(error.message, /C:\/|Private|model|decoder details/);
          return true;
        });
      }
    } finally {
      global.fetch = fetch;
    }
  });
}
