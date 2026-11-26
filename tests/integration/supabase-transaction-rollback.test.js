const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const fs = require('node:fs/promises');
const { startTestServer, testDatabase } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const env = require('../../server/infrastructure/config/env');
const { setStorageInstance, resetStorage } = require('../../server/infrastructure/storage/storageFactory');
const reportImageRepository = require('../../server/infrastructure/repositories/reportImage.repository');

test('transaction failure after mocked Supabase uploads rolls back rows and removes objects', async () => {
  const originalDriver = env.STORAGE_DRIVER;
  const originalCreateMany = reportImageRepository.createMany;
  const objects = new Set();
  const uploaded = [];
  const removed = [];
  env.STORAGE_DRIVER = 'supabase';
  setStorageInstance(
    {
      async upload(file, key) {
        const reference = `supabase:${key}`;
        objects.add(reference);
        uploaded.push(reference);
        return { reference };
      },
      async remove(reference) {
        objects.delete(reference);
        removed.push(reference);
      },
      async getReadUrl(reference) {
        return reference;
      }
    },
    'supabase'
  );
  const { server, baseUrl } = await startTestServer();
  const description = `Isolated rollback ${Date.now()}`;
  const beforeFiles = await fs.readdir(env.UPLOAD_DIR);
  const db = testDatabase();
  try {
    const { token } = await seedCitizen({ username: `isolated_rollback_${Date.now()}`, password: 'password123', barangay: 'Barangay Central', reporting: true });
    const beforeReports = await db.query('SELECT id FROM reports');
    const beforeImages = await db.query('SELECT id FROM report_images');
    const beforeAudits = await db.query('SELECT id FROM audit_logs');
    const beforeVerifications = await db.query('SELECT id FROM damage_verifications');
    reportImageRepository.createMany = async () => {
      throw new Error('Simulated MySQL insert failure');
    };
    const form = new FormData();
    for (const [key, value] of Object.entries({
      description,
      barangay: 'Barangay Central',
      latitude: '10.6780',
      longitude: '122.9460',
      gpsAccuracy: '15',
      landmarkDescription: 'Beside the school entrance.'
    })) {
      form.append(key, value);
    }
    addReportGps(form, 'Barangay Central');
    for (let index = 0; index < 2; index++) {
      form.append('images', new File([index === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES], `proof-${index}.jpg`, { type: 'image/jpeg' }));
    }
    form.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
    const response = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.match(payload.error, /Failed to save report/);
    assert.doesNotMatch(JSON.stringify(payload), /MySQL|supabase:|uploads\//);
    assert.equal(uploaded.length, 5);
    assert.deepEqual([...removed].sort(), [...uploaded].sort());
    assert.equal(objects.size, 0);
    assert.deepEqual(await db.query('SELECT id FROM reports'), beforeReports);
    assert.deepEqual(await db.query('SELECT id FROM report_images'), beforeImages);
    assert.deepEqual(await db.query('SELECT id FROM audit_logs'), beforeAudits);
    assert.deepEqual(await db.query('SELECT id FROM damage_verifications'), beforeVerifications);
    assert.deepEqual(await fs.readdir(env.UPLOAD_DIR), beforeFiles);
  } finally {
    reportImageRepository.createMany = originalCreateMany;
    env.STORAGE_DRIVER = originalDriver;
    resetStorage();
    await new Promise((resolve) => server.close(resolve));
  }
});
