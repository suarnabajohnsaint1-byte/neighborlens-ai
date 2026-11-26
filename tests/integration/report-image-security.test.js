const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, freshReportFixAt } = require('../support/citizens');
const fs = require('node:fs/promises');
const { startTestServer, testDatabase, stubInference, DamageDetectionError } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES, WEBP_BYTES } = require('../support/image-fixtures');
const env = require('../../server/infrastructure/config/env');
const { setStorageInstance, resetStorage } = require('../../server/infrastructure/storage/storageFactory');

let server;
let baseUrl;
let token;
let originalDriver;
let aiCalls = 0;
let uploadCalls = 0;
const objects = new Set();

test.before(async () => {
  originalDriver = env.STORAGE_DRIVER;
  env.STORAGE_DRIVER = 'supabase';
  setStorageInstance(
    {
      async upload(file, key) {
        uploadCalls += 1;
        const reference = `supabase:${key}`;
        objects.add(reference);
        return { reference };
      },
      async remove(reference) {
        objects.delete(reference);
      },
      async getReadUrl(reference) {
        return `https://storage.mock.test/${reference.slice(9)}`;
      }
    },
    'supabase'
  );
  ({ server, baseUrl } = await startTestServer());
  ({ token } = await seedCitizen({ username: `image_security_${Date.now()}`, password: 'password123', barangay: 'Barangay Central', reporting: true }));
});

test.after(async () => {
  env.STORAGE_DRIVER = originalDriver;
  resetStorage();
  await new Promise((resolve) => server.close(resolve));
});

async function tableCounts() {
  const db = testDatabase();
  const counts = {};
  for (const table of ['reports', 'report_images', 'damage_verifications', 'audit_logs']) {
    counts[table] = (await db.query(`SELECT COUNT(*) AS count FROM ${table}`))[0].count;
  }
  return counts;
}

const corruptPng = Buffer.from(PNG_BYTES);
corruptPng[80] ^= 0xff;
const cases = [
  { name: 'valid JPEG with AI unavailable', buffer: JPEG_BYTES, mime: 'image/jpeg', valid: true },
  { name: 'valid PNG with AI unavailable', buffer: PNG_BYTES, mime: 'image/png', valid: true },
  { name: 'valid WebP with AI unavailable', buffer: WEBP_BYTES, mime: 'image/webp', valid: true },
  { name: 'valid image with AI timeout', buffer: JPEG_BYTES, mime: 'image/jpeg', valid: true, timeout: true },
  {
    name: 'invalid report image bytes while AI is unavailable',
    buffer: Buffer.from('not an image'),
    mime: 'image/jpeg'
  },
  { name: 'PNG bytes declared as JPEG', buffer: PNG_BYTES, mime: 'image/jpeg' },
  { name: 'unsupported bytes declared as JPEG', buffer: Buffer.from('GIF89a'), mime: 'image/jpeg' },
  { name: 'unsupported declared format', buffer: Buffer.from('GIF89a'), mime: 'image/gif', middleware: true },
  {
    name: 'oversized image',
    buffer: Buffer.concat([JPEG_BYTES, Buffer.alloc(10 * 1024 * 1024)]),
    mime: 'image/jpeg',
    middleware: true
  },
  { name: 'truncated JPEG', buffer: JPEG_BYTES.subarray(0, 100), mime: 'image/jpeg' },
  { name: 'truncated PNG', buffer: PNG_BYTES.subarray(0, 60), mime: 'image/png' },
  { name: 'truncated WebP', buffer: WEBP_BYTES.subarray(0, 30), mime: 'image/webp' },
  { name: 'corrupt PNG pixel data', buffer: corruptPng, mime: 'image/png' }
];

for (const scenario of cases) {
  test(`report upload: ${scenario.name}`, async () => {
    const beforeFiles = await fs.readdir(env.UPLOAD_DIR);
    const beforeCounts = await tableCounts();
    const beforeObjects = [...objects];
    uploadCalls = 0;
    aiCalls = 0;
    const failInference = async () => {
      aiCalls += 1;
      throw new DamageDetectionError(
        'Private provider endpoint failure',
        scenario.timeout ? 'INFERENCE_TIMEOUT' : 'INFERENCE_UNAVAILABLE',
        scenario.timeout ? 504 : 503
      );
    };
    const restoreInference = stubInference(failInference, failInference);
    try {
      const description = `${scenario.name} ${Date.now()}`;
      const form = new FormData();
      for (const [key, value] of Object.entries({
        description,
        barangay: 'Barangay Central',
        latitude: '10.6780',
        longitude: '122.9460',
        gpsAccuracy: '15',
        gpsFixAt: freshReportFixAt(),
        aiCategory: 'Forged category',
        landmarkDescription: 'Beside the school entrance.'
      })) {
        form.append(key, value);
      }
      form.append('images', new File([SECOND_JPEG_BYTES], 'first.jpg', { type: 'image/jpeg' }));
      form.append('images', new File([scenario.buffer], 'second-image', { type: scenario.mime }));
      form.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
      const response = await fetch(`${baseUrl}/api/reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      assert.equal(response.status, scenario.valid ? 201 : 400);
      const payload = await response.json();
      assert.doesNotMatch(JSON.stringify(payload), /Private provider|libvips|ENOENT|SQL|supabase:/);
      const rows = await testDatabase().query('SELECT * FROM reports WHERE description = ?', [description]);
      if (scenario.valid) {
        assert.equal(uploadCalls, 5);
        assert.equal(aiCalls, 3);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].ai_category, null);
        assert.equal(rows[0].ai_confidence, null);
        assert.equal(rows[0].barangay, 'Barangay Central');
        assert.equal(rows[0].boundary_check_status, 'inside_service_area');
        assert.equal(payload.images.length, 2);
        const afterCounts = await tableCounts();
        assert.equal(afterCounts.reports, beforeCounts.reports + 1);
        assert.equal(afterCounts.report_images, beforeCounts.report_images + 2);
        assert.equal(afterCounts.damage_verifications, beforeCounts.damage_verifications);
        assert.equal(afterCounts.audit_logs, beforeCounts.audit_logs + 2);
        const review = (await testDatabase().query('SELECT id, state FROM community_publication_requests WHERE report_id = ?', [rows[0].id]))[0];
        assert.equal(review.state, 'pending_approval');
        const audit = await testDatabase().query('SELECT action FROM audit_logs WHERE entity_type = ? AND entity_id = ?', ['community_publication', review.id]);
        assert.match(audit[0].action, /^community_publication_requested_/);
      } else {
        if (!scenario.middleware) assert.equal(payload.code, 'IMAGE_VALIDATION_ERROR');
        assert.equal(uploadCalls, 0);
        assert.equal(aiCalls, 0);
        assert.equal(rows.length, 0);
        assert.deepEqual(await tableCounts(), beforeCounts);
        assert.deepEqual([...objects], beforeObjects);
      }
      assert.deepEqual(await fs.readdir(env.UPLOAD_DIR), beforeFiles);
    } finally {
      restoreInference();
    }
  });
}
