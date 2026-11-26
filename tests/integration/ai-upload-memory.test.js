const test = require('node:test');
const assert = require('node:assert/strict');
const { addReportGps, setFixtureResidency } = require('../support/citizens');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const { createTestApp } = require('../support/test-app');
const { damageDetectionService } = require('../../server/composition');
const aiController = require('../../server/presentation/http/controllers/ai.controller');
const aiUpload = require('../../server/presentation/http/middleware/aiUpload.middleware');
const reportUpload = require('../../server/presentation/http/middleware/upload.middleware');
const { PROJECT_ROOT, UPLOAD_ROOT } = require('../../server/infrastructure/storage/uploadDirectory');

const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const WATCHED_UPLOAD_DIRS = [...new Set([path.join(PROJECT_ROOT, 'uploads'), path.join(PROJECT_ROOT, 'storage', 'uploads'), UPLOAD_ROOT])];

const app = createTestApp({
  inference: async () => ({
    model: 'NeighborLens YOLOv8m neighborlens_v3_1_interim',
    min_confidence: 0.3,
    image_size: { width: 640, height: 480 },
    detections: [{ class: 'pothole', confidence: 0.81, eligible: true, bbox: { x: 10, y: 20, width: 30, height: 40 } }]
  }),
  pairInference: async () => ({
    is_valid_match: true,
    summary: { is_valid_match: true, damage_type_consensus: 'pothole', composite_similarity_score: 0.9 },
    image1_detections: [{ class: 'pothole', confidence: 0.81 }],
    image2_detections: [{ class: 'pothole', confidence: 0.77 }]
  })
});

const seenInputs = [];
const wrappedProcess = damageDetectionService.processDamageImage;
const wrappedPair = damageDetectionService.verifyDamagePair;
damageDetectionService.processDamageImage = (input, options) => {
  seenInputs.push(input);
  return wrappedProcess(input, options);
};
damageDetectionService.verifyDamagePair = (first, second, options) => {
  seenInputs.push(first, second);
  return wrappedPair(first, second, options);
};

let server;
let baseUrl;
let token;

function imageForm(count) {
  const form = new FormData();
  for (let index = 0; index < count; index++) {
    form.append('images', new File([index === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES], `photo-${index + 1}.jpg`, { type: 'image/jpeg' }));
  }
  return form;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

async function observeUploadDirs(action) {
  const before = WATCHED_UPLOAD_DIRS.map(listDir);
  const events = [];
  const watchers = WATCHED_UPLOAD_DIRS.filter(dir => fs.existsSync(dir))
    .map(dir => fs.watch(dir, (type, name) => events.push(`${type} ${path.join(dir, String(name))}`)));
  const unlinkCalls = [];
  const originalUnlink = fsPromises.unlink;
  const originalUnlinkSync = fs.unlinkSync;
  fsPromises.unlink = (...args) => {
    unlinkCalls.push(String(args[0]));
    return originalUnlink(...args);
  };
  fs.unlinkSync = (...args) => {
    unlinkCalls.push(String(args[0]));
    return originalUnlinkSync(...args);
  };
  try {
    const result = await action();
    await new Promise(resolve => setTimeout(resolve, 150));
    return { result, events, unlinkCalls, before, after: WATCHED_UPLOAD_DIRS.map(listDir) };
  } finally {
    fsPromises.unlink = originalUnlink;
    fs.unlinkSync = originalUnlinkSync;
    watchers.forEach(watcher => watcher.close());
  }
}

test.before(async () => {
  await setFixtureResidency('citizen', 'Barangay 1');
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'citizen', password: '1' })
  });
  token = (await response.json()).token;
});

test.after(() => server.close());

test('AI preview uploads use memory storage while report uploads keep disk storage', () => {
  assert.equal(aiUpload.storage.constructor.name, 'MemoryStorage');
  assert.equal(reportUpload.storage.constructor.name, 'DiskStorage');
  assert.deepEqual(aiUpload.limits, reportUpload.limits);
  assert.equal(aiUpload.fileFilter, reportUpload.fileFilter);

  const aiRoutes = fs.readFileSync(path.join(PROJECT_ROOT, 'server/presentation/http/routes/ai.routes.js'), 'utf8');
  const reportRoutes = fs.readFileSync(path.join(PROJECT_ROOT, 'server/presentation/http/routes/reports.routes.js'), 'utf8');
  assert.match(aiRoutes, /aiUpload\.middleware/);
  assert.doesNotMatch(aiRoutes, /require\('\.\.\/middleware\/upload\.middleware'\)/);
  assert.match(reportRoutes, /require\('\.\.\/middleware\/upload\.middleware'\)/);
});

test('POST /api/ai/damage infers from memory buffers and writes nothing to the upload folders', async () => {
  seenInputs.length = 0;
  const observed = await observeUploadDirs(async () => {
    const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: imageForm(1) });
    return { status: response.status, body: await response.json() };
  });

  assert.equal(observed.result.status, 200);
  const primary = observed.result.body.primary;
  assert.equal(primary.status, 'DETECTED');
  assert.equal(primary.canonical_category, 'pothole');
  assert.equal(primary.report_category, 'Road Damage');
  assert.deepEqual(primary.bounding_box, { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(primary.image_size, { width: 640, height: 480 });
  assert.equal(primary.metadata.source, 'file-object');

  assert.equal(seenInputs.length, 1);
  assert.ok(Buffer.isBuffer(seenInputs[0].buffer));
  assert.deepEqual(seenInputs[0].buffer, JPEG_BYTES);
  assert.equal(seenInputs[0].path, undefined);

  assert.deepEqual(observed.events, []);
  assert.deepEqual(observed.unlinkCalls, []);
  assert.deepEqual(observed.after, observed.before);
});

test('a single request for a two-photo scan writes no temporary files', async () => {
  seenInputs.length = 0;
  const form = imageForm(2);
  form.append('assessment', 'pair');
  const observed = await observeUploadDirs(async () => {
    const response = await fetch(`${baseUrl}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(observed.result.status, 200);
  assert.equal(observed.result.body.photos.length, 2);
  assert.equal(seenInputs.length, 2);
  assert.ok(seenInputs.every(input => Buffer.isBuffer(input.buffer) && input.path === undefined));
  assert.deepEqual(observed.events, []);
  assert.deepEqual(observed.unlinkCalls, []);
  assert.deepEqual(observed.after, observed.before);
});

test('POST /api/ai/damage-pair verifies memory-backed files without touching the filesystem', async () => {
  seenInputs.length = 0;
  const observed = await observeUploadDirs(async () => {
    const response = await fetch(`${baseUrl}/api/ai/damage-pair`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: imageForm(2) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(observed.result.status, 200);
  assert.equal(observed.result.body.detected, true);
  assert.equal(observed.result.body.canonical_category, 'pothole');
  assert.equal(seenInputs.length, 2);
  assert.ok(seenInputs.every(input => Buffer.isBuffer(input.buffer) && input.path === undefined));
  assert.deepEqual(observed.events, []);
  assert.deepEqual(observed.unlinkCalls, []);
  assert.deepEqual(observed.after, observed.before);
});

test('the AI controller refuses a disk-backed file instead of reading or deleting its path', async () => {
  const calls = [];
  const original = damageDetectionService.processDamageImage;
  damageDetectionService.processDamageImage = (...args) => {
    calls.push(args);
    return original(...args);
  };
  let forwarded;
  try {
    await aiController.detectDamage({ files: [{ path: '/tmp/never-read.jpg', mimetype: 'image/jpeg' }] }, { json: () => assert.fail('must not respond') }, error => { forwarded = error; });
  } finally {
    damageDetectionService.processDamageImage = original;
  }
  assert.equal(calls.length, 0);
  assert.equal(forwarded?.name, 'ValidationError');
});

test('auth on the AI preview routes is unchanged', async () => {
  for (const route of ['/api/ai/damage', '/api/ai/damage-pair']) {
    const anonymous = await fetch(`${baseUrl}${route}`, { method: 'POST', body: imageForm(2) });
    assert.equal(anonymous.status, 401);
  }
});

test('report submission still persists its images to the upload folder', async () => {
  const before = new Set(listDir(UPLOAD_ROOT));
  const form = imageForm(2);
  const fields = { description: 'Pothole near the chapel, persistence probe', location: 'Chapel Road', barangay: 'Barangay 1', latitude: '10.6780', longitude: '122.9460', gpsAccuracy: '15', landmarkDescription: 'Beside the school entrance.' };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('landmarkImage', new File([JPEG_BYTES], 'landmark.jpg', { type: 'image/jpeg' }));
  addReportGps(form);
  const response = await fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.images.length, 2);

  const added = listDir(UPLOAD_ROOT).filter(name => !before.has(name));
  assert.equal(added.length, 5, 'Two original evidence files, one landmark evidence file, and two private publication previews are persisted.');
  for (const image of body.images) {
    const [row] = await require('../support/test-app').testDatabase().query('SELECT image_path FROM report_images WHERE id = ?', [image.id]);
    const stored = path.basename(row.image_path);
    assert.ok(added.includes(stored));
    assert.equal((await fetch(`${baseUrl}/uploads/${stored}`)).status, 404);
    const served = await fetch(`${baseUrl}${image.imagePath}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), image.imageOrder === 2 ? SECOND_JPEG_BYTES : JPEG_BYTES);
  }
});
