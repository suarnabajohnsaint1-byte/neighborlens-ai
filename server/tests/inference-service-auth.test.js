const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../infrastructure/config/env');
const { requestLocalYoloInference, requestLocalDualInference } = require('../infrastructure/ai/localYolo/localYoloClient');

test('single and pair inference send the server-only service secret', async () => {
  const original = env.INFERENCE_SHARED_SECRET;
  const fetch = global.fetch;
  const seen = [];
  env.INFERENCE_SHARED_SECRET = 'test-secret-that-never-enters-browser-javascript';
  global.fetch = async (_url, options) => {
    seen.push(options.headers['X-Inference-Key']);
    return { ok: true, json: async () => ({ detections: [] }) };
  };
  try {
    await requestLocalYoloInference(Buffer.from('image'), 'image/jpeg', { endpoint: 'https://inference.example/predict' });
    await requestLocalDualInference(Buffer.from('first'), 'image/jpeg', Buffer.from('second'), 'image/jpeg', { endpoint: 'https://inference.example/verify-pair' });
    assert.deepEqual(seen, [env.INFERENCE_SHARED_SECRET, env.INFERENCE_SHARED_SECRET]);
  } finally {
    env.INFERENCE_SHARED_SECRET = original;
    global.fetch = fetch;
  }
});

test('Vercel inference rejects insecure or unauthenticated service configuration', async () => {
  const originalVercel = process.env.VERCEL;
  const originalSecret = env.INFERENCE_SHARED_SECRET;
  process.env.VERCEL = '1';
  env.INFERENCE_SHARED_SECRET = '';
  try {
    await assert.rejects(requestLocalYoloInference(Buffer.from('image'), 'image/jpeg', { endpoint: 'https://inference.example/predict' }), { code: 'INFERENCE_NOT_CONFIGURED' });
    env.INFERENCE_SHARED_SECRET = 'test-secret-that-never-enters-browser-javascript';
    await assert.rejects(requestLocalDualInference(Buffer.from('first'), 'image/jpeg', Buffer.from('second'), 'image/jpeg', { endpoint: 'http://inference.example/verify-pair' }), { code: 'INFERENCE_NOT_CONFIGURED' });
  } finally {
    env.INFERENCE_SHARED_SECRET = originalSecret;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});

test('both inference paths preserve known evidence errors and sanitize the upstream message', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 422,
    json: async () => ({ detail: { code: 'INVALID_EVIDENCE', message: 'private upstream payload' } })
  });
  try {
    const options = { endpoint: 'https://inference.example' };
    const bytes = Buffer.from('evidence');
    for (const request of [
      () => requestLocalYoloInference(bytes, 'image/jpeg', options),
      () => requestLocalDualInference(bytes, 'image/jpeg', bytes, 'image/jpeg', options)
    ]) {
      await assert.rejects(request, {
        code: 'INVALID_EVIDENCE', statusCode: 422,
        message: 'No supported issue was detected. Retake the photo with the infrastructure issue clearly visible.'
      });
    }
  } finally {
    global.fetch = original;
  }
});
