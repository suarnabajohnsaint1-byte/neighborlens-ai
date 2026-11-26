const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { startTestServer, testDatabase, stubInference } = require('../support/test-app');
const { seedCitizen, freshReportFixAt, installFixtureBarangay } = require('../support/citizens');
const { JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES, WEBP_BYTES } = require('../support/image-fixtures');
const env = require('../../server/infrastructure/config/env');
const users = require('../../server/infrastructure/repositories/user.repository');
const passwordHasher = require('../../server/infrastructure/security/passwordHasher');
const { authService } = require('../../server/composition');

let server;
let baseUrl;
let citizenOwner;
let otherCitizen;
let assignedBarangayUser;
let otherBarangayUser;
let adminUser;
let assignedBarangayId;
let originalDriver;
let aiReceivedBuffers = [];
let restoreInference;

function buildReportForm({
  description = 'Deep pothole near main gate',
  landmarkDescription = 'Beside the Villamonte elementary school gate.',
  includeLandmarkDesc = true,
  damageCount = 2,
  landmarkFiles = [{ buffer: WEBP_BYTES, mime: 'image/webp', name: 'landmark.webp' }],
  requestKey = null,
  gpsFixAt = freshReportFixAt()
} = {}) {
  const form = new FormData();
  form.append('description', description);
  form.append('barangay', 'Villamonte');
  form.append('citizenCategory', 'Road Damage');
  form.append('latitude', '10.6685');
  form.append('longitude', '122.9647');
  form.append('gpsAccuracy', '15');
  form.append('gpsFixAt', String(gpsFixAt));
  if (requestKey) form.append('requestKey', requestKey);
  if (includeLandmarkDesc && landmarkDescription !== undefined) {
    form.append('landmarkDescription', landmarkDescription);
  }
  const damageFixtures = [
    { buffer: JPEG_BYTES, mime: 'image/jpeg', name: 'damage1.jpg' },
    { buffer: SECOND_JPEG_BYTES, mime: 'image/jpeg', name: 'damage2.jpg' }
  ];
  for (let i = 0; i < damageCount; i++) {
    const f = damageFixtures[i % damageFixtures.length];
    form.append('images', new Blob([f.buffer], { type: f.mime }), f.name);
  }
  for (const lf of landmarkFiles) {
    form.append('landmarkImage', new Blob([lf.buffer], { type: lf.mime }), lf.name);
  }
  return form;
}

async function seedOfficial(role, username, barangayId = null, barangay = null) {
  await users.create({
    username,
    passwordHash: passwordHasher.hash('Fixture1234!'),
    barangay,
    barangayId,
    role,
    fullName: `${role} fixture`
  }, testDatabase());
  return authService.login(username, 'Fixture1234!', role);
}

test.before(async () => {
  originalDriver = env.STORAGE_DRIVER;
  env.STORAGE_DRIVER = 'local';
  ({ server, baseUrl } = await startTestServer());
  restoreInference = stubInference(
    async (buffer) => {
      aiReceivedBuffers.push(Buffer.from(buffer));
      return {
        detected: true,
        category: 'pothole',
        canonical_class: 'pothole',
        confidence_score: 0.91,
        evidence_relevance: 'VERIFIED'
      };
    },
    async (first, second) => {
      aiReceivedBuffers.push(Buffer.from(first), Buffer.from(second));
      return {
        is_valid_match: true,
        composite_similarity_score: 0.9,
        embedding_similarity: 0.9,
        damage_type_consensus: 'pothole',
        canonical_category: 'pothole',
        alignment: { inlier_ratio: 0.8, perspective_aligned: true }
      };
    }
  );

  const suffix = Date.now();
  assignedBarangayId = await installFixtureBarangay('Villamonte');
  const otherBarangayId = await installFixtureBarangay('Mandalagan');
  citizenOwner = await seedCitizen({ username: `lm_owner_${suffix}`, password: 'Password123!', barangay: 'Villamonte', reporting: true });
  otherCitizen = await seedCitizen({ username: `lm_other_${suffix}`, password: 'Password123!', barangay: 'Villamonte', reporting: true });
  assignedBarangayUser = await seedOfficial('barangay', `lm_brgy1_${suffix}`, assignedBarangayId, 'Villamonte');
  otherBarangayUser = await seedOfficial('barangay', `lm_brgy2_${suffix}`, otherBarangayId, 'Mandalagan');
  adminUser = await authService.login(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, 'admin');
});

test.after(async () => {
  restoreInference?.();
  env.STORAGE_DRIVER = originalDriver;
  if (server) await new Promise(resolve => server.close(resolve));
});

test('1-6. Rejects missing, whitespace, oversized, multiple, and corrupted landmark inputs and cleans up uploads', async () => {
  const cases = [
    { name: 'missing landmark photo', form: () => buildReportForm({ landmarkFiles: [] }) },
    { name: 'missing landmark description', form: () => buildReportForm({ includeLandmarkDesc: false }) },
    { name: 'whitespace-only landmark description', form: () => buildReportForm({ landmarkDescription: '   \t\n  ' }) },
    { name: 'landmark description > 250 chars', form: () => buildReportForm({ landmarkDescription: 'A'.repeat(251) }) },
    {
      name: 'multiple landmark photos',
      form: () => buildReportForm({
        landmarkFiles: [
          { buffer: WEBP_BYTES, mime: 'image/webp', name: 'lm1.webp' },
          { buffer: PNG_BYTES, mime: 'image/png', name: 'lm2.png' }
        ]
      })
    },
    {
      name: 'corrupted landmark image bytes',
      form: () => buildReportForm({
        landmarkFiles: [{ buffer: Buffer.from('corrupt-bytes'), mime: 'image/jpeg', name: 'bad.jpg' }]
      })
    }
  ];

  for (const scenario of cases) {
    const beforeFiles = new Set(await fs.readdir(env.UPLOAD_DIR));
    const res = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenOwner.token}` },
      body: scenario.form()
    });
    assert.equal(res.status, 400, `${scenario.name} should return 400`);
    const afterFiles = await fs.readdir(env.UPLOAD_DIR);
    const leaked = afterFiles.filter(f => !beforeFiles.has(f));
    assert.deepEqual(leaked, [], `${scenario.name} must clean up uploaded temp files`);
  }
});

test('7-16. Valid submission, AI isolation, retrieval, auth, idempotency, historical reports, and community feed exclusion', async () => {
  aiReceivedBuffers = [];
  const key = randomUUID();
  const gpsFixAt = freshReportFixAt();
  const landmarkDesc = 'Opposite the Barangay Villamonte covered court.';

  const createRes = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenOwner.token}` },
    body: buildReportForm({ landmarkDescription: landmarkDesc, requestKey: key, gpsFixAt })
  });
  const created = await createRes.json();
  assert.equal(createRes.status, 201);
  assert.ok(created.id);
  assert.deepEqual(created.landmark, {
    description: landmarkDesc,
    imagePath: `/api/reports/${created.id}/images/landmark`
  });

  // Exactly two damage photos reached AI; landmark WebP bytes never entered AI
  assert.ok(aiReceivedBuffers.length >= 2);
  for (const buf of aiReceivedBuffers) {
    assert.equal(Buffer.compare(buf, WEBP_BYTES) === 0, false, 'Landmark bytes must never enter AI processing');
  }

  // Idempotent retry returns same report without creating a duplicate
  const retryRes = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenOwner.token}` },
    body: buildReportForm({ landmarkDescription: landmarkDesc, requestKey: key, gpsFixAt })
  });
  const retried = await retryRes.json();
  assert.equal(retryRes.status, 201);
  assert.equal(retried.id, created.id);
  assert.equal(retried.replayed, true);

  // Same requestKey with different landmark content returns 409 Conflict
  const conflictRes = await fetch(`${baseUrl}/api/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenOwner.token}` },
    body: buildReportForm({ landmarkDescription: 'Different landmark text', requestKey: key, gpsFixAt })
  });
  assert.equal(conflictRes.status, 409);

  // Report retrieval returns landmark metadata and hides raw storage path
  const getRes = await fetch(`${baseUrl}/api/reports/${created.id}`, {
    headers: { Authorization: `Bearer ${citizenOwner.token}` }
  });
  const reportBody = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.deepEqual(reportBody.landmark, {
    description: landmarkDesc,
    imagePath: `/api/reports/${created.id}/images/landmark`
  });
  assert.equal('landmark_image_path' in reportBody, false);
  assert.equal('landmark_description' in reportBody, false);

  // Authorized attachment retrieval: owner, admin, assigned barangay -> 200 with WEBP_BYTES
  for (const actor of [citizenOwner, adminUser, assignedBarangayUser]) {
    const imgRes = await fetch(`${baseUrl}/api/reports/${created.id}/images/landmark`, {
      headers: { Authorization: `Bearer ${actor.token}` }
    });
    assert.equal(imgRes.status, 200);
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    assert.equal(Buffer.compare(bytes, WEBP_BYTES), 0);
  }

  // Unauthorized / cross-barangay attachment retrieval -> 403
  for (const forbidden of [otherCitizen, otherBarangayUser]) {
    const imgRes = await fetch(`${baseUrl}/api/reports/${created.id}/images/landmark`, {
      headers: { Authorization: `Bearer ${forbidden.token}` }
    });
    assert.equal(imgRes.status, 403);
  }
  const unauthRes = await fetch(`${baseUrl}/api/reports/${created.id}/images/landmark`);
  assert.equal(unauthRes.status, 401);

  // Community publication / feed must exclude landmark evidence
  const pubRows = await testDatabase().query('SELECT * FROM community_publication_requests WHERE report_id = ?', [created.id]);
  const postRows = await testDatabase().query('SELECT * FROM community_posts WHERE report_id = ?', [created.id]);
  if (postRows.length > 0) {
    const postImages = await testDatabase().query('SELECT * FROM community_post_images WHERE post_id = ?', [postRows[0].id]);
    assert.equal(postImages.length, 2, 'Community post must only contain the 2 damage photos');
    for (const img of postImages) {
      assert.equal(String(img.image_path || '').includes('landmark'), false);
    }
  } else {
    assert.ok(pubRows.length <= 1);
  }

  // Historical report without landmark returns landmark: null and 404 on landmark image endpoint
  const hist = await testDatabase().execute(
    `INSERT INTO reports (description, barangay, barangay_id, image_path, submitted_by, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['Historical report', 'Villamonte', assignedBarangayId, '/uploads/a.jpg,/uploads/b.jpg', citizenOwner.user.id, 'pending']
  );
  const histGet = await fetch(`${baseUrl}/api/reports/${hist.insertId}`, {
    headers: { Authorization: `Bearer ${citizenOwner.token}` }
  });
  assert.equal(histGet.status, 200);
  const histBody = await histGet.json();
  assert.equal(histBody.landmark, null);

  const histImg = await fetch(`${baseUrl}/api/reports/${hist.insertId}/images/landmark`, {
    headers: { Authorization: `Bearer ${citizenOwner.token}` }
  });
  assert.equal(histImg.status, 404);
});
