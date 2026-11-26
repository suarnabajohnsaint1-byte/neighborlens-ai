const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { startTestServer, testDatabase } = require('../support/test-app');
const { evidenceFile, JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const { DamageDetectionError } = require('../../server/domain/errors');

let server, baseUrl, token;
let predictions = 0;
let pairPredictions = 0;
let lowConfidence = false;
let portraitRejected = false;
let faceReview = false;
let alternatePredictions;
let inferenceRelevance = 'VERIFIED';
let scriptedDetection;
let scriptedDetectionHints;
let previewScreening = 'region-v2';
const jpg = bytes => new File([bytes], 'angle.jpg', { type: 'image/jpeg' });
const png = bytes => new File([bytes], 'angle.png', { type: 'image/png' });
const vision = confidence => ({ damage_type: lowConfidence ? 'pothole' : 'broken_streetlight', confidence_score: confidence });

test.before(async () => {
  ({ server, baseUrl } = await startTestServer({
    inference: async buffer => {
      predictions++;
      if (portraitRejected && buffer.equals(JPEG_BYTES)) {
        throw new DamageDetectionError('No supported issue was detected. Retake the photo.', 'INVALID_EVIDENCE', 422);
      }
      if (faceReview && buffer.equals(JPEG_BYTES)) {
        return { inference_status: 'evidence_review_required', reason: 'face_overlap', detections: [] };
      }
      if (alternatePredictions && buffer.equals(SECOND_JPEG_BYTES)) {
        return { min_confidence: 0.3, detections: alternatePredictions };
      }
      if (scriptedDetectionHints) {
        const hint = scriptedDetectionHints[Number(buffer.equals(SECOND_JPEG_BYTES))];
        return {
          evidence_relevance: 'UNAVAILABLE',
          evidence_screening: previewScreening,
          image_size: { width: 320, height: 320 },
          min_confidence: 0.3,
          detection_preview: hint,
          detections: hint?.source === 'original' ? [hint] : []
        };
      }
      return {
        evidence_relevance: inferenceRelevance,
        min_confidence: 0.3,
        detections: [scriptedDetection || vision(lowConfidence && buffer.equals(SECOND_JPEG_BYTES) ? 0.18 : 0.789)]
      };
    },
    pairInference: async () => {
      pairPredictions++;
      if (faceReview) return {
        status: 'EVIDENCE_REVIEW_REQUIRED',
        image1_assessment: { inference_status: 'evidence_review_required', reason: 'face_overlap' },
        image1_detections: [], image2_detections: [vision(0.8)]
      };
      const prediction = scriptedDetection || vision(0.789);
      return {
        evidence_relevance: inferenceRelevance,
        image1_detections: [prediction], image2_detections: [prediction],
        summary: { scene_status: 'MATCH', composite_score: 1 }
      };
    }
  }));
  ({ token } = await seedCitizen({ username: 'evidence_citizen', password: 'password123', barangay: 'Villamonte', reporting: true }));
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await testDatabase().close();
});

async function post(path, photos, fields = {}, accessToken = token) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  for (const photo of photos) body.append('images', photo);
  const headers = accessToken ? { Authorization: 'Bearer ' + accessToken } : {};
  if (path === '/api/reports') {
    addReportGps(body, 'Villamonte');
    if (!body.has('landmarkDescription')) body.append('landmarkDescription', 'Beside the school entrance.');
    if (!body.has('landmarkImage')) body.append('landmarkImage', jpg(JPEG_BYTES));
  }
  const response = await fetch(baseUrl + path, { method: 'POST', body, headers });
  return { status: response.status, data: await response.json() };
}

const preview = photos => post('/api/ai/damage', photos, { assessment: 'pair' });
const submit = (photos, fields = {}) => post('/api/reports', photos, {
  description: 'Possible infrastructure issue near the crossing.',
  citizenCategory: 'Road Damage', barangay: 'Villamonte',
  latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15',
  aiCategory: 'broken_streetlight', aiConfidence: '0.99', ...fields
});

for (const [name, makePhotos, code] of [
  ['same bytes under different names', () => [jpg(JPEG_BYTES), new File([JPEG_BYTES], 'renamed.jpg', { type: 'image/jpeg' })], 'DUPLICATE_EVIDENCE'],
  ['a resized and recompressed copy', async () => [jpg(JPEG_BYTES), jpg(await sharp(JPEG_BYTES).resize(190).jpeg({ quality: 76 }).toBuffer())], 'DUPLICATE_EVIDENCE'],
  ['a Camo Studio screen beside real evidence', () => [jpg(JPEG_BYTES), png(evidenceFile('camo-studio.png'))], 'INVALID_EVIDENCE'],
  ['both non-identical Camo Studio crops', () => ['camo-studio.png', 'camo-studio-second.png'].map(name => png(evidenceFile(name))), 'INVALID_EVIDENCE'],
  ['a JPEG re-encoding of the Camo Studio screen', async () => [jpg(JPEG_BYTES), jpg(await sharp(evidenceFile('camo-studio.png')).jpeg({ quality: 80 }).toBuffer())], 'INVALID_EVIDENCE'],
  ['a flat-color icon', async () => {
    const dimensions = { width: 300, height: 200, channels: 3 };
    const mark = await sharp({ create: { ...dimensions, width: 90, height: 90, background: '#ffffff' } }).png().toBuffer();
    const icon = await sharp({ create: { ...dimensions, background: '#315dbf' } })
      .composite([{ input: mark, top: 55, left: 105 }]).png().toBuffer();
    return [jpg(JPEG_BYTES), png(icon)];
  }, 'INVALID_EVIDENCE']
]) {
  test(`preview and direct submission reject ${name} before YOLO or persistence`, async () => {
    const photos = await makePhotos();
    const before = [predictions, pairPredictions];
    const db = testDatabase();
    const counts = async () => Promise.all([
      db.query('SELECT COUNT(*) AS n FROM reports'),
      db.query('SELECT COUNT(*) AS n FROM report_images'),
      db.query('SELECT COUNT(*) AS n FROM community_publication_requests'),
      fs.readdir(process.env.UPLOAD_DIR).then(files => files.sort())
    ]);
    const previous = await counts();
    for (const response of [await preview(photos), await post('/api/ai/damage-pair', photos), await submit(photos)]) {
      assert.equal(response.status, 422);
      assert.equal(response.data.code, code);
      if (name === 'a Camo Studio screen beside real evidence') assert.match(response.data.error, /^Photo 2:/);
      assert.equal(response.data.assessmentProof, undefined);
    }
    assert.deepEqual([predictions, pairPredictions], before);
    assert.deepEqual(await counts(), previous);
  });
}

test('ambiguous copies use manual review even with two valid legacy proofs', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(await sharp(JPEG_BYTES).linear(1, 8).jpeg({ quality: 85 }).toBuffer())];
  const before = [predictions, pairPredictions];
  const box = { x: 12, y: 20, width: 60, height: 80 };
  let response;
  scriptedDetection = { damage_type: 'road_crack', confidence_score: 0.83, bounding_box: box };
  try {
    response = await preview(photos);
  } finally {
    scriptedDetection = undefined;
  }
  assert.equal(response.status, 200);
  assert.equal(response.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
  assert.ok(response.data.photos.every(photo => !photo.result.detected && photo.result.detections.length === 0 && photo.assessmentProof));
  assert.ok(response.data.photos.every(photo => photo.result.suggested_class === 'road_crack'));
  assert.equal(response.data.pairReviewReason, 'SIMILAR_VIEWS');
  assert.ok(response.data.photos.every(photo => photo.result.evidence_reason === null &&
    photo.result.suggested_confidence === 0.83));
  assert.deepEqual(response.data.photos.map(photo => photo.result.suggested_box?.bounding_box), [box, box]);
  assert.deepEqual([predictions, pairPredictions], [before[0] + 2, before[1]]);

  const legacy = [];
  for (const [index, file] of photos.entries()) {
    const old = await post('/api/ai/damage', [file], { photoOrder: String(index + 1) });
    assert.equal(old.data.primary.status, 'DETECTED');
    legacy.push(old.data.assessmentProof);
  }
  const beforeSubmit = [predictions, pairPredictions];
  const submitted = await submit(photos, { assessmentProofs: JSON.stringify(legacy) });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.status, 'pending');
  assert.equal(submitted.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
  assert.equal(submitted.data.originalAi.status, 'EVIDENCE_REVIEW_REQUIRED');
  const [stored] = await testDatabase().query('SELECT vision_detected, ai_category FROM reports WHERE id = ?', [submitted.data.id]);
  assert.equal(stored.vision_detected, 0);
  assert.equal(stored.ai_category, null);
  assert.deepEqual([predictions, pairPredictions], beforeSubmit);
});

test('normal alternate views keep ordered signed assessments and low confidence stays manual', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  lowConfidence = true;
  const response = await preview(photos);
  assert.equal(response.status, 200);
  assert.equal(response.data.evidenceStatus, 'PASSED');
  assert.deepEqual(response.data.photos.map(photo => photo.result.status), ['DETECTED', 'LOW_CONFIDENCE']);
  const proofs = JSON.stringify(response.data.photos.map(photo => photo.assessmentProof));
  const swapped = await submit(photos.slice().reverse(), { assessmentProofs: proofs });
  assert.equal(swapped.status, 400);
  assert.equal(swapped.data.code, 'ASSESSMENT_MISMATCH');
  const saved = await submit(photos, { assessmentProofs: proofs });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.originalAi.status, 'LOW_CONFIDENCE');
  assert.equal(Boolean(saved.data.vision_detected), false);
});

test('an authoritative inference rejection blocks preview and direct submission even when another photo scores highly', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const db = testDatabase();
  const before = await db.query('SELECT COUNT(*) AS n FROM reports');
  const stored = await fs.readdir(process.env.UPLOAD_DIR);
  lowConfidence = false;
  portraitRejected = true;
  try {
    for (const response of [await preview(photos), await submit(photos)]) {
      assert.equal(response.status, 422);
      assert.equal(response.data.code, 'INVALID_EVIDENCE');
      assert.equal(response.data.assessmentProof, undefined);
      assert.match(response.data.error, /No supported issue/);
    }
    assert.deepEqual(await db.query('SELECT COUNT(*) AS n FROM reports'), before);
    assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), stored);
  } finally {
    portraitRejected = false;
  }
});

test('direct submissions cannot confirm a defect from a single positive or a conflicting class', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  try {
    for (const predictions of [[], [{ damage_type: 'pothole', confidence_score: 0.95 }]]) {
      alternatePredictions = predictions;
      const response = await submit(photos);
      assert.equal(response.status, 201);
      assert.equal(response.data.status, 'pending');
      assert.equal(Boolean(response.data.vision_detected), false);
      const [stored] = await testDatabase().query('SELECT ai_category FROM reports WHERE id = ?', [response.data.id]);
      assert.equal(stored.ai_category, null);
    }
  } finally {
    alternatePredictions = undefined;
  }
});

test('unverified cup, cat and portrait predictions cannot issue a detected proof or confirm a pair', async () => {
  inferenceRelevance = 'UNVERIFIED';
  try {
    for (const fixture of [
      { photo: png(evidenceFile('coffee.png')), name: 'broken_streetlight', score: 0.7434 },
      { photo: png(evidenceFile('chelsea.png')), name: 'clogged_drainage', score: 0.6958 },
      { photo: jpg(evidenceFile('public-portrait.jpg')), name: 'broken_streetlight', score: 0.864 }
    ]) {
      scriptedDetection = { damage_type: fixture.name, confidence_score: fixture.score };
      const single = await post('/api/ai/damage', [fixture.photo], { photoOrder: '1' });
      assert.equal(single.status, 200);
      assert.equal(single.data.primary.status, 'EVIDENCE_REVIEW_REQUIRED');
      assert.equal(single.data.primary.evidence_relevance, 'UNVERIFIED');
      assert.equal(single.data.primary.evidence_reason, 'EVIDENCE_RELEVANCE_UNVERIFIED');
      assert.equal(single.data.primary.detected, false);
      assert.deepEqual(single.data.primary.detections, []);
      assert.ok(single.data.assessmentProof);
    }

    // Distinct crops exercise pair plumbing. The offline model audit uses real changes of viewpoint.
    const cup = evidenceFile('coffee.png');
    scriptedDetection = { damage_type: 'broken_streetlight', confidence_score: 0.7434 };
    const photos = [jpg(await sharp(cup).extract({ left: 0, top: 0, width: 520, height: 400 }).jpeg().toBuffer()),
      jpg(await sharp(cup).extract({ left: 180, top: 50, width: 400, height: 310 }).jpeg().toBuffer())];
    const checks = [await preview(photos), await post('/api/ai/damage-pair', photos)];
    assert.equal(checks[0].status, 200);
    assert.equal(checks[0].data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
    assert.ok(checks[0].data.photos.every(photo => !photo.result.detected && photo.result.status === 'EVIDENCE_REVIEW_REQUIRED'));
    assert.equal(checks[1].status, 200);
    assert.equal(checks[1].data.status, 'EVIDENCE_REVIEW_REQUIRED');
    assert.equal(checks[1].data.detected, false);
    assert.equal(checks[1].data.candidate, null);

    const before = await testDatabase().query('SELECT COUNT(*) AS n FROM reports');
    assert.equal((await post('/api/reports', photos, {}, null)).status, 401);
    assert.deepEqual(await testDatabase().query('SELECT COUNT(*) AS n FROM reports'), before);
    const proofs = checks[0].data.photos.map(photo => photo.assessmentProof);
    for (const fields of [{}, { assessmentProofs: JSON.stringify(proofs) }]) {
      const result = await submit(photos, fields);
      assert.equal(result.status, 201);
      assert.equal(result.data.status, 'pending');
      assert.equal(result.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
      const [stored] = await testDatabase().query('SELECT vision_detected, ai_category FROM reports WHERE id = ?', [result.data.id]);
      assert.equal(stored.vision_detected, 0);
      assert.equal(stored.ai_category, null);
    }
  } finally {
    inferenceRelevance = 'VERIFIED';
    scriptedDetection = undefined;
  }
});

test('only the uncertain photo receives a suitability reason and loses confirmation', async () => {
  const patch = await sharp(SECOND_JPEG_BYTES).resize(96, 36, { fit: 'cover' }).png().toBuffer();
  const partial = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#999999' } })
    .composite([{ input: patch, left: 0, top: 60 }]).png().toBuffer();
  const photos = [jpg(JPEG_BYTES), png(partial)];
  const response = await preview(photos);
  assert.equal(response.status, 200);
  const [first, second] = response.data.photos;
  assert.equal(first.result.status, 'DETECTED');
  assert.equal(first.result.evidence_relevance, 'VERIFIED');
  assert.equal(first.result.evidence_reason, undefined);
  assert.equal(second.result.evidence_reason, 'PHOTO_SUITABILITY_UNCERTAIN');
  assert.equal(response.data.pairReviewReason, null);
  const saved = await submit(photos, { assessmentProofs: JSON.stringify([first.assessmentProof, second.assessmentProof]) });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.originalAi.detected, false);
  assert.deepEqual(saved.data.originalAi.photos.map(photo => photo.status), ['DETECTED', 'EVIDENCE_REVIEW_REQUIRED']);
});

test('an explicit relevance rejection blocks both preview and direct submission', async () => {
  inferenceRelevance = 'REJECTED';
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  try {
    for (const request of [preview, submit]) {
      const response = await request(photos);
      assert.equal(response.status, 422);
      assert.equal(response.data.code, 'INVALID_EVIDENCE');
    }
  } finally {
    inferenceRelevance = 'VERIFIED';
  }
});

test('unverified high-confidence crack candidates stay out of the preview and signed assessment', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const box = { x: 12, y: 20, width: 60, height: 80 };
  inferenceRelevance = undefined;
  scriptedDetection = { damage_type: 'road_crack', confidence_score: 0.83, bounding_box: box };
  try {
    const response = await preview(photos);
    assert.equal(response.status, 200);
    assert.equal(response.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
    for (const { result } of response.data.photos) {
      assert.equal(result.detected, false);
      assert.equal(result.suggested_class, undefined);
      assert.equal(result.evidence_reason, 'EVIDENCE_VERIFIER_UNAVAILABLE');
      assert.equal(result.evidence_relevance, 'UNAVAILABLE');
      assert.equal(result.suggested_confidence, undefined);
      assert.equal(result.suggested_box, undefined);
      assert.equal(result.suggested_eligible, undefined);
      assert.equal(result.candidate, null);
      assert.deepEqual(result.detections, []);
    }
    const single = await post('/api/ai/damage', [photos[0]], { photoOrder: '1' });
    assert.equal(single.status, 200);
    assert.equal(single.data.primary.suggested_box, undefined);
    const proofs = response.data.photos.map(photo => photo.assessmentProof);
    const submitted = await submit(photos, { assessmentProofs: JSON.stringify(proofs) });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.data.status, 'pending');
    assert.equal(submitted.data.originalAi.detected, false);
    assert.ok(submitted.data.originalAi.photos.every(photo =>
      photo.suggested_box === undefined && photo.suggested_confidence === undefined && photo.suggested_eligible === undefined &&
      photo.evidence_reason === undefined && photo.candidate === null && photo.detections.length === 0));
  } finally {
    inferenceRelevance = 'VERIFIED';
    scriptedDetection = undefined;
  }
});

test('a screened original and contrast pavement match supplies display-only boxes', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const hint = {
    class: 'road_crack', source: 'original', confidence: 0.62,
    bounding_box: { x: 12, y: 20, width: 60, height: 80 }
  };
  const retry = { ...hint, source: 'contrast', confidence: 0.42 };
  scriptedDetectionHints = [hint, retry];
  try {
    const response = await preview(photos);
    assert.equal(response.status, 200);
    assert.equal(response.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
    assert.equal(response.data.severitySuggestion, null);
    for (const [index, { result }] of response.data.photos.entries()) {
      assert.equal(result.suggested_class, 'road_crack');
      assert.equal(result.suggested_box.confidence, scriptedDetectionHints[index].confidence);
      assert.deepEqual(result.suggested_box.bounding_box, hint.bounding_box);
      assert.equal(result.suggested_eligible, false);
      assert.equal(result.detected, false);
      assert.equal(result.candidate, null);
      assert.deepEqual(result.detections, []);
    }
    const proofs = response.data.photos.map(photo => photo.assessmentProof);
    const saved = await submit(photos, { assessmentProofs: JSON.stringify(proofs) });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.originalAi.detected, false);
    assert.equal(saved.data.ai_classification, null);
    assert.ok(saved.data.originalAi.photos.every(photo => !photo.suggested_box && !photo.candidate));

    for (const hints of [
      [retry, retry],
      [{ ...retry, scale_agreement: true }, retry],
      [hint, { ...retry, class: 'pothole' }],
      [hint, { ...retry, bounding_box: { ...hint.bounding_box, x: 300 } }],
      [hint, null],
      [{ ...hint, confidence: 0.45 }, retry]
    ]) {
      scriptedDetectionHints = hints;
      const unshown = await preview(photos);
      assert.equal(unshown.status, 200);
      assert.ok(unshown.data.photos.every(({ result }) => result.suggested_box === undefined));
    }
    scriptedDetectionHints = [0.354, 0.312].map(confidence => ({ ...retry, confidence, scale_agreement: true }));
    const corroborated = await preview(photos);
    assert.deepEqual(corroborated.data.photos.map(({ result }) => result.suggested_box.confidence), [0.354, 0.312]);
    assert.ok(corroborated.data.photos.every(({ result }) => !result.detected));
  } finally {
    scriptedDetectionHints = undefined;
  }
});

test('a screened pair supports provisional boxes for all four damage classes', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const bounding_box = { x: 12, y: 20, width: 60, height: 80 };
  try {
    for (const damageClass of ['pothole', 'road_crack', 'clogged_drainage', 'broken_streetlight']) {
      scriptedDetectionHints = [0.21, 0.91].map(confidence => ({
        class: damageClass, source: 'original', confidence, bounding_box
      }));
      const response = await preview(photos);
      assert.equal(response.status, 200);
      assert.equal(response.data.severitySuggestion, null);
      assert.deepEqual(response.data.photos.map(({ result }) => result.suggested_class), [damageClass, damageClass]);
      assert.deepEqual(response.data.photos.map(({ result }) => result.suggested_box.confidence), [0.21, 0.91]);
      assert.ok(response.data.photos.every(({ result }) => !result.detected && result.candidate === null));
    }
    scriptedDetectionHints = [0.3869, 0.3976].map(confidence => ({
      class: 'road_crack', source: 'original', confidence, bounding_box
    }));
    const crack = await preview(photos);
    assert.deepEqual(crack.data.photos.map(({ result }) => result.suggested_box.confidence), [0.3869, 0.3976]);
    for (const [damageClass, scores] of [
      ['clogged_drainage', [0.65, 0.72]],
      ['pothole', [0.41, 0.49]],
      ['broken_streetlight', [0.71, 0.76]],
      ['broken_streetlight', [0.81, 0.66]]
    ]) {
      scriptedDetectionHints = scores.map(confidence => ({ class: damageClass, source: 'original', confidence, bounding_box }));
      const restored = await preview(photos);
      assert.deepEqual(restored.data.photos.map(({ result }) => result.suggested_box.confidence), scores);
    }
    previewScreening = 'region-v1';
    scriptedDetectionHints = [0.8747, 0.8398].map(confidence => ({
      class: 'broken_streetlight', source: 'original', confidence, bounding_box
    }));
    const unrelated = await preview(photos);
    assert.ok(unrelated.data.photos.every(({ result }) => result.suggested_box === undefined));
  } finally {
    scriptedDetectionHints = undefined;
    previewScreening = 'region-v2';
  }
});

test('keeps a strong screened detection visible when the other view has no candidate', async () => {
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const bounding_box = { x: 12, y: 20, width: 60, height: 80 };
  scriptedDetectionHints = [{ class: 'clogged_drainage', source: 'original', confidence: 0.91, bounding_box }, null];
  try {
    const response = await preview(photos);
    assert.equal(response.status, 200);
    const [first, second] = response.data.photos;
    assert.equal(first.result.single_photo_preview, true);
    assert.deepEqual(first.result.suggested_box.bounding_box, bounding_box);
    assert.equal(second.result.suggested_box, undefined);
    assert.equal(response.data.severitySuggestion, null);
    const saved = await submit(photos, { assessmentProofs: JSON.stringify([first.assessmentProof, second.assessmentProof]) });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.originalAi.detected, false);
    assert.ok(saved.data.originalAi.photos.every(photo => !photo.suggested_box && !photo.single_photo_preview));
  } finally {
    scriptedDetectionHints = undefined;
  }
});

test('face-associated predictions request review and can be submitted as pending', async () => {
  faceReview = true;
  try {
    const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
    const response = await preview(photos);
    assert.equal(response.status, 200);
    assert.equal(response.data.photos[0].result.evidence_reason, 'FACE_OVERLAP');
    assert.equal(response.data.photos[0].result.detected, false);
    assert.equal(response.data.photos[0].result.suggested_box, undefined);
    const pair = await post('/api/ai/damage-pair', photos);
    assert.equal(pair.status, 200);
    assert.equal(pair.data.status, 'EVIDENCE_REVIEW_REQUIRED');
    const proofs = response.data.photos.map(photo => photo.assessmentProof);
    const saved = await submit(photos, { assessmentProofs: JSON.stringify(proofs) });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.status, 'pending');
    assert.equal(saved.data.originalAi.detected, false);
  } finally {
    faceReview = false;
  }
});

test('older detected proofs are rechecked and saved as manual review when relevance is unverified', async () => {
  lowConfidence = false;
  const photos = [jpg(JPEG_BYTES), jpg(SECOND_JPEG_BYTES)];
  const before = await preview(photos);
  assert.ok(before.data.photos.every(photo => photo.result.detected));

  inferenceRelevance = 'UNVERIFIED';
  try {
    const proofs = before.data.photos.map(photo => photo.assessmentProof);
    const result = await submit(photos, { assessmentProofs: JSON.stringify(proofs) });
    assert.equal(result.status, 201);
    assert.equal(result.data.evidenceStatus, 'EVIDENCE_REVIEW_REQUIRED');
    assert.equal(result.data.originalAi.status, 'EVIDENCE_REVIEW_REQUIRED');
    assert.equal(result.data.originalAi.detected, false);
  } finally {
    inferenceRelevance = 'VERIFIED';
  }
});
