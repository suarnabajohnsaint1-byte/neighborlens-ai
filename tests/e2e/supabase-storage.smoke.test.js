const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const env = require('../../server/infrastructure/config/env');
const SupabaseStorageAdapter = require('../../server/infrastructure/storage/supabaseStorage.adapter');

const REQUESTED =
  process.env.STORAGE_SMOKE_TEST === 'true' ||
  process.env.STORAGE_SMOKE_TEST === '1' ||
  process.env.SUPABASE_SMOKE_TEST === 'true' ||
  process.env.SUPABASE_SMOKE_TEST === '1' ||
  (process.env.STORAGE_DRIVER || '').toLowerCase() === 'supabase';

function validateCredentials() {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'SUPABASE_URL is missing or empty' };
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'SUPABASE_URL has invalid protocol' };
    }
  } catch {
    return { ok: false, reason: 'SUPABASE_URL is not a valid URL' };
  }

  if (!secretKey || typeof secretKey !== 'string' || !secretKey.trim()) {
    return { ok: false, reason: 'SUPABASE_SECRET_KEY is missing or empty' };
  }

  if (!bucket || typeof bucket !== 'string' || !bucket.trim()) {
    return { ok: false, reason: 'SUPABASE_STORAGE_BUCKET is missing or empty' };
  }

  return { ok: true };
}

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9
]);

test('Supabase Storage live integration smoke test', async (t) => {
  if (!REQUESTED) {
    t.skip('Opt-in smoke test skipped: STORAGE_SMOKE_TEST=true or STORAGE_DRIVER=supabase required.');
    return;
  }

  const credValidation = validateCredentials();
  if (!credValidation.ok) {
    t.skip(`Opt-in smoke test skipped: ${credValidation.reason}.`);
    return;
  }

  const adapter = new SupabaseStorageAdapter(env);

  await t.test('1. Verify bucket exists and is private without exposing secrets', async () => {
    assert.equal(env.SUPABASE_STORAGE_BUCKET, 'neighborlens-reports');
    const { data: bucket, error } = await adapter.client.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);
    assert.equal(error, null, `Bucket retrieval failed: ${error?.message}`);
    assert.ok(bucket, 'Bucket metadata must exist');
    assert.equal(bucket.name, 'neighborlens-reports');
    assert.equal(bucket.public, false, 'Configured bucket must be private');
  });

  await t.test('2. Upload disposable JPEG, sign URL, fetch, delete, and verify inaccessibility', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-smoke-'));
    const tempFilePath = path.join(tempDir, 'disposable-smoke-test.jpg');
    await fs.writeFile(tempFilePath, MINIMAL_JPEG);

    const uuid = crypto.randomUUID();
    const objectKey = `reports/smoke-test/${uuid}.jpg`;
    let uploadedReference = null;

    try {
      const uploadResult = await adapter.upload(
        {
          path: tempFilePath,
          mimetype: 'image/jpeg'
        },
        objectKey
      );

      assert.equal(uploadResult.provider, 'supabase');
      assert.equal(uploadResult.key, objectKey);
      uploadedReference = uploadResult.reference;
      assert.equal(uploadedReference, `supabase:${objectKey}`);

      const parsedKey = adapter.parseReference(uploadedReference);
      assert.equal(parsedKey, objectKey);

      const signedUrl = await adapter.getReadUrl(uploadedReference);
      assert.ok(typeof signedUrl === 'string' && signedUrl.length > 0);
      assert.ok(signedUrl.startsWith('https://') || signedUrl.startsWith('http://'));

      const response = await fetch(signedUrl);
      assert.equal(response.status, 200, 'Signed URL retrieval must return 200 OK');
      const contentType = response.headers.get('content-type') || '';
      assert.ok(
        contentType.includes('image/jpeg') || contentType.includes('image/jpg'),
        `Unexpected content-type: ${contentType}`
      );

      const downloadedBytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        Buffer.compare(downloadedBytes, MINIMAL_JPEG),
        0,
        'Downloaded bytes must match uploaded JPEG fixture'
      );
    } finally {
      if (uploadedReference) {
        try {
          await adapter.remove(uploadedReference);
        } catch (cleanupError) {
          console.error('Failed to cleanup smoke test object:', cleanupError?.message || cleanupError);
        }
      }

      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    const { error: downloadError } = await adapter.bucket.download(objectKey);
    assert.ok(downloadError, 'Deleted object must produce an error on download');
    assert.equal(
      downloadError.statusCode,
      '404',
      'Download of deleted object must return 404 status code'
    );

    await assert.rejects(
      () => adapter.getReadUrl(`supabase:${objectKey}`),
      (err) => err?.statusCode === '404' || /Object not found/i.test(err?.message || ''),
      'Creating signed URL for deleted object must be rejected with 404'
    );

    const { data: listData, error: listError } = await adapter.bucket.list('reports/smoke-test', {
      search: uuid
    });
    assert.equal(listError, null);
    assert.equal(
      Array.isArray(listData) ? listData.filter(item => item.name === `${uuid}.jpg`).length : 0,
      0,
      'Deleted object must not appear in bucket listing'
    );
  });
});
