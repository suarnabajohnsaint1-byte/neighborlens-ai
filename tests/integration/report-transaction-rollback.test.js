const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTestApp } = require('../support/test-app');
const env = require('../../server/infrastructure/config/env');
const reportImageRepository = require('../../server/infrastructure/repositories/reportImage.repository');
const reportRepository = require('../../server/infrastructure/repositories/report.repository');

const app = createTestApp();

let server;
let baseUrl;
let citizenToken;

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

function jpegFile(name, bytes = JPEG_BYTES) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const username = `rollback_${Date.now()}`;
  ({ token: citizenToken } = await seedCitizen({ username, password: 'password123', barangay: 'Barangay Central', reporting: true }));
});

test.after(() => server.close());

test('a DB failure during report creation rolls back all rows and deletes the uploaded files', async () => {
  const uniqueDescription = `Rollback probe report ${Date.now()}`;
  const originalCreateMany = reportImageRepository.createMany;
  const filesBefore = new Set(await fs.readdir(env.UPLOAD_DIR));

  reportImageRepository.createMany = async () => {
    throw new Error('Simulated report_images insert failure for rollback test');
  };

  try {
    const form = new FormData();
    form.append('description', uniqueDescription);
    form.append('barangay', 'Barangay Central');
    form.append('latitude', '10.6780');
    form.append('longitude', '122.9460');
    addReportGps(form, 'Barangay Central');
    form.append('landmarkDescription', 'Beside the school entrance.');
    form.append('images', jpegFile('a.jpg'));
    form.append('images', jpegFile('b.jpg', SECOND_JPEG_BYTES));
    form.append('landmarkImage', jpegFile('landmark.jpg'));

    const response = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: form
    });
    assert.equal(response.status, 500);
  } finally {
    reportImageRepository.createMany = originalCreateMany;
  }

  const allReports = await reportRepository.findAll({ role: 'admin' });
  const leaked = allReports.find(r => r.description === uniqueDescription);
  assert.equal(leaked, undefined, 'report row must not exist after rollback');

  const filesAfter = new Set(await fs.readdir(env.UPLOAD_DIR));
  assert.deepEqual(filesAfter, filesBefore, 'uploaded files must be deleted when the transaction fails');
});
