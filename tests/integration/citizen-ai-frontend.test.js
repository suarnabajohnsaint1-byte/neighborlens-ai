const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { assessPair, confidenceLevel, STATES } = require('../../frontend/js/citizen/damagePairAssessment');
const { projectBox } = require('../../frontend/js/citizen/detectionOverlay');
const CitizenCorrection = require('../../frontend/js/citizen/citizenCorrection');
const { UploadState, readinessError } = require('../../frontend/js/citizen/submissionReadiness');

test('presentation bands use the unrounded score and leave absent scores unlabeled', () => {
  for (const [score, level] of [[null, null], [NaN, null], [0, 'Low'], [0.4999, 'Low'],
    [0.50, 'Moderate'], [0.7999, 'Moderate'], [0.80, 'High'], [1, 'High']]) {
    assert.equal(confidenceLevel(score), level);
  }
});

test('readiness preserves evidence-first validation and complete manual review', () => {
  const complete = {
    photoCount: 2, scanState: UploadState.READY, assessment: { state: 'LOW_CONFIDENCE', submittable: true },
    category: 'Road Damage', description: 'Damage is near the intersection.'
  };
  assert.equal(readinessError(complete), null);
  assert.match(readinessError({ ...complete, photoCount: 1 }), /exactly 2/);
  assert.match(readinessError({ ...complete, scanState: UploadState.AI_SCANNING }), /both photos must be scanned/);
  assert.match(readinessError({ ...complete, category: '' }), /select an issue category/);
  assert.match(readinessError({ ...complete, description: '   ' }), /describe the issue/);
  for (const state of ['DUPLICATE_EVIDENCE', 'INVALID_EVIDENCE']) {
    const assessment = { state, submittable: false, summary: 'Retake both photos.' };
    assert.equal(readinessError({ ...complete, category: '', scanState: UploadState.ERROR, assessment }), assessment.summary);
  }
});

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = relative => fs.readFileSync(path.join(FRONTEND, relative), 'utf8');

function sessionStore(initial) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function browserContext({ session = { username: 'citizen', role: 'citizen', apiToken: 'demo-token' }, respond }) {
  const calls = [];
  const sessionStorage = sessionStore(session ? { up_session: JSON.stringify(session) } : {});
  const listeners = {};
  const context = {
    console,
    FormData,
    File,
    CustomEvent: class { constructor(type) { this.type = type; } },
    dispatchEvent() {},
    sessionStorage,
    location: { hostname: '127.0.0.1', pathname: '/frontend/citizen.html', href: '' },
    document: { addEventListener: (name, handler) => { listeners[name] = handler; }, getElementById: () => null },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init, calls.length);
    }
  };
  context.window = context;
  vm.createContext(context);
  for (const script of ['js/shared/api.js', 'js/auth/security.js', 'js/citizen/yoloDamageDetector.js']) {
    vm.runInContext(read(script), context, { filename: script });
  }
  return { context, calls, listeners };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function photo(name) {
  return new File([Buffer.from([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' });
}

function detected(category, display, confidence, extra = {}) {
  return {
    status: 'DETECTED',
    candidate: { canonical_category: category, display_category: display, confidence, accepted: true },
    report_category: category === 'broken_streetlight' ? 'Street Light Damage' : 'Road Damage',
    triage: { classification: 'MAJOR', priority: 'High' },
    image_size: { width: 1000, height: 500 },
    model: 'NeighborLens YOLOv8m neighborlens_v3_1_interim',
    model_info: { name: 'NeighborLens YOLOv8m', version: 'neighborlens_v3_1_interim', release_label: 'v3.1 Interim Baseline', target_eligible: false },
    detections: [{ canonical_category: category, display_category: display, confidence_score: confidence, eligible: true, severity_level: 'high', bounding_box: { x: 10, y: 20, width: 30, height: 40 } }],
    ...extra
  };
}

function lowConfidence(category, display, confidence) {
  return {
    status: 'LOW_CONFIDENCE',
    candidate: { canonical_category: category, display_category: display, confidence, accepted: false },
    report_category: category === 'broken_streetlight' ? 'Street Light Damage' : 'Road Damage',
    triage: null,
    image_size: { width: 1000, height: 500 },
    detections: [{ canonical_category: category, display_category: display, confidence_score: confidence, eligible: false, bounding_box: { x: 1, y: 2, width: 3, height: 4 } }]
  };
}

const empty = { status: 'NO_DETECTION', candidate: null, detections: [] };
const unsupported = { status: 'UNSUPPORTED', candidate: null, detections: [{ canonical_category: null, display_category: null, confidence_score: 0.9 }] };
const ok = result => ({ ok: true, result });
const failed = state => ({ ok: false, error: { state, message: `${state} message` } });

test('the citizen client submits both photos together with the session bearer token', async () => {
  const primary = detected('road_crack', 'Road Crack', 0.64);
  const { context, calls } = browserContext({ respond: () => jsonResponse(200, {
    photos: [{ result: primary }, { result: primary }]
  }) });
  const entries = await context.YoloDamageDetector.detectPhotos([photo('one.jpg'), photo('two.jpg')]);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'http://127.0.0.1:3000/api/ai/damage');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer demo-token');
  assert.equal(call.init.body.get('assessment'), 'pair');
  assert.deepEqual(call.init.body.getAll('images').map(file => file.name), ['one.jpg', 'two.jpg']);
  assert.deepEqual(Array.from(entries, entry => entry.ok), [true, true]);
  assert.equal(entries[0].result.status, 'DETECTED');
});

test('a missing API token is an AUTH_ERROR and no hidden login request is made', async () => {
  const { context, calls } = browserContext({ session: { username: 'citizen', role: 'citizen', apiToken: '' }, respond: () => jsonResponse(200, {}) });
  const [entry] = await context.YoloDamageDetector.detectPhotos([photo('one.jpg'), photo('two.jpg')]);
  assert.equal(entry.ok, false);
  assert.equal(entry.error.state, 'AUTH_ERROR');
  assert.equal(calls.length, 0);
});

test('401 and 403 responses become AUTH_ERROR while 5xx and network failures become AI_SERVICE_ERROR', async () => {
  const statuses = { 1: 401, 2: 403, 3: 502, 4: 503 };
  const { context } = browserContext({ respond: (url, init, count) => jsonResponse(statuses[count], { error: 'x' }) });
  const entries = await Promise.all([1, 2, 3, 4].map(() => context.YoloDamageDetector.detectDamage(photo('p.jpg')).catch(error => error.state)));
  assert.deepEqual(entries, ['AUTH_ERROR', 'AUTH_ERROR', 'AI_SERVICE_ERROR', 'AI_SERVICE_ERROR']);

  const offline = browserContext({ respond: () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.context.YoloDamageDetector.detectDamage(photo('p.jpg')), error => error.state === 'AI_SERVICE_ERROR');
});

test('logout clears the session that carries the API token', () => {
  const { context } = browserContext({ respond: () => jsonResponse(200, {}) });
  assert.ok(context.getSession().apiToken);
  context.logout();
  assert.equal(context.getSession(), null);
  assert.equal(context.location.href, 'login.html');
});

test('two agreeing DETECTED photos produce a DETECTED pair with the mean of both real confidences', () => {
  const pair = assessPair([ok(detected('road_crack', 'Road Crack', 0.64)), ok(detected('road_crack', 'Road Crack', 0.5, { triage: { classification: 'MINOR', priority: 'Medium' } }))], { matched: true, score: 90, threshold: 82 });
  assert.equal(pair.state, STATES.DETECTED);
  assert.equal(pair.detected, true);
  assert.equal(pair.displayName, 'Road Crack');
  assert.equal(pair.category, 'Road Damage');
  assert.equal(pair.confidence, 0.57);
  assert.equal(pair.confidencePercent, 57);
  assert.equal(pair.classification, null);
  assert.equal(pair.priority, null);
  assert.equal(pair.agreement, true);
  assert.deepEqual(pair.sceneMatch, { matched: true, score: 90, threshold: 82 });
  assert.equal(pair.model.label, 'NeighborLens YOLOv8m, v3.1 Interim Baseline');
  assert.deepEqual(pair.photos[0].boxes[0].bbox, { x: 10, y: 20, width: 30, height: 40 });
});

test('same class with one sub-threshold photo is LOW_CONFIDENCE and is not auto-accepted', () => {
  const pair = assessPair([ok(detected('pothole', 'Pothole', 0.99)), ok(lowConfidence('pothole', 'Pothole', 0.29))]);
  assert.equal(pair.state, STATES.LOW_CONFIDENCE);
  assert.equal(pair.detected, false);
  assert.equal(pair.category, 'Road Damage');
  assert.equal(pair.classification, null);
  assert.equal(pair.priority, null);
  assert.equal(pair.confidence, 0.64);
  assert.deepEqual(pair.photos[1].boxes, []);
  assert.ok(pair.photos.every(photo => photo.previewBoxes.length === 1 && !photo.previewBoxes[0].eligible));
});

test('different classes, or damage in only one photo, are PAIR_MISMATCH', () => {
  const differing = assessPair([ok(detected('road_crack', 'Road Crack', 0.64)), ok(detected('pothole', 'Pothole', 0.8))]);
  const oneSided = assessPair([ok(detected('road_crack', 'Road Crack', 0.64)), ok(empty)]);
  for (const pair of [differing, oneSided]) {
    assert.equal(pair.state, STATES.PAIR_MISMATCH);
    assert.equal(pair.detected, false);
    assert.equal(pair.agreement, false);
    assert.equal(pair.confidence, null);
  }
  assert.equal(differing.photos[1].displayName, 'Pothole');
});

test('no detection in both photos is NO_DETECTION and unsupported classes are UNSUPPORTED', () => {
  assert.equal(assessPair([ok(empty), ok(empty)]).state, STATES.NO_DETECTION);
  assert.equal(assessPair([ok(unsupported), ok(empty)]).state, STATES.UNSUPPORTED);
});

test('assessment copy reflects per-photo eligibility independently of evidence verification', () => {
  const { context } = uploadHarness();
  const presentation = context.CitizenAssessmentPresentation;
  const crack = ok(detected('road_crack', 'Road Crack', 0.827));
  const pothole = ok(detected('pothole', 'Pothole', 0.926));
  const preview = (suggested_eligible) => ok({
    status: STATES.EVIDENCE_REVIEW_REQUIRED, suggested_class: 'road_crack',
    suggested_confidence: 0.926, suggested_eligible, evidence_relevance: 'UNVERIFIED'
  });
  for (const [entries, expected] of [
    [[crack, crack], 'Road Crack detected in both photos.'],
    [[pothole, pothole], 'Pothole detected in both photos.'],
    [[crack, preview(true)], 'Road Crack detected in both photos.'],
    [[preview(false), preview(undefined)], 'AI suggests Road Crack in both photos.'],
    [[crack, ok(empty)], 'AI suggests Road Crack in Photo 1.'],
    [[ok(empty), crack], 'AI suggests Road Crack in Photo 2.'],
    [[crack, pothole], 'The photos suggest different damage types.'],
    [[ok(empty), ok(empty)], 'No conclusive damage detection.'],
    [[failed('AI_SERVICE_ERROR'), crack], 'AI assessment is currently unavailable.']
  ]) {
    assert.equal(presentation.assessmentSummary(assessPair(entries)), expected);
  }

  const untrusted = '<img src=x onerror=alert(1)>';
  const assessment = assessPair([ok(detected('road_crack', undefined, 0.827)),
    ok(detected('road_crack', untrusted, 0.926))]);
  const markup = presentation.renderAssessment(assessment, { escapeHtml: context.ReportPresentation.escape, priorityBadge: context.priorityBadge });
  assert.match(markup, /Road Crack detected in both photos\./);
  assert.match(markup, /Photo 1:<\/span> Road Crack · 82\.7% · High/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<img|undefined/);
});

test('disagreeing low-confidence angles show uncertainty without guessing a class or showing boxes', async () => {
  const entries = [
    ok(lowConfidence('broken_streetlight', 'Broken Streetlight', 0.279)),
    ok(lowConfidence('clogged_drainage', 'Clogged Drainage', 0.055))
  ];
  const scene = { matched: false, score: 43, threshold: 82 };
  const result = assessPair(entries, scene);
  assert.equal(result.state, STATES.PAIR_MISMATCH);
  assert.equal(result.stateLabel, 'Damage unverified');
  assert.equal(result.submittable, true);
  assert.ok(result.photos.every(photo => photo.previewBoxes.length === 0));

  const harness = uploadHarness({ detector: { detectPhotos: async () => entries }, compareScenes: () => scene });
  await harness.change([photo('first.jpg'), photo('second.jpg')]);
  const panel = harness.element('visionDetectBox').innerHTML;
  assert.match(panel, /Damage unverified/);
  assert.match(panel, /43% \(match unverified\)/);
  assert.match(panel, /The photos suggest different damage types\./);
  assert.doesNotMatch(panel, /Broken Streetlight|Clogged Drainage|different scenes/);

  ['citizenEvidenceDialog', 'citizenEnlargedEvidence', 'citizenEvidenceSubtitle'].forEach(harness.element);
  harness.context.openCitizenPhotoZoom(0);
  assert.equal(harness.element('citizenEvidenceSubtitle').textContent, 'Low Confidence');
});

test('evidence review with conflicting suggested classes explains review without showing a common issue', async () => {
  const entries = ['broken_streetlight', 'clogged_drainage'].map(suggested_class =>
    ok({ status: STATES.EVIDENCE_REVIEW_REQUIRED, suggested_class, detected: false })
  );
  const harness = uploadHarness({ detector: { detectPhotos: async () => entries } });
  await harness.change([photo('first.jpg'), photo('second.jpg')]);
  const panel = harness.element('visionDetectBox');
  assert.match(panel.innerHTML, /The AI could not confirm the evidence/);
  assert.doesNotMatch(panel.innerHTML, /Clogged Drainage|Broken Streetlight/);
});

test('face-associated evidence gives concise retake guidance without drawing a prediction', async () => {
  const responses = [
    ok({ status: STATES.EVIDENCE_REVIEW_REQUIRED, evidence_reason: 'FACE_OVERLAP', detected: false, detections: [] }),
    ok(detected('road_crack', 'Road Crack', 0.8))
  ];
  const harness = uploadHarness({ detector: { detectPhotos: async () => responses } });
  await harness.change([photo('first.jpg'), photo('second.jpg')]);
  const panel = harness.element('visionDetectBox');
  assert.match(panel.innerHTML, /Retake the photo with the damage clearly visible/);
  assert.doesNotMatch(panel.innerHTML, /Detection details|Road Crack/);
  assert.ok(assessPair(responses).photos.every(photo => photo.previewBoxes.length === 0));
});

test('matching road crack suggestions restore preview and zoom boxes without confirming the report', async () => {
  const entries = [0.219, 0.124].map((confidence, index) => ok({
    status: STATES.EVIDENCE_REVIEW_REQUIRED,
    detected: false,
    suggested_class: 'road_crack',
    suggested_box: { confidence, bounding_box: { x: 100 + index * 30, y: 100, width: 300, height: 140 } },
    image_size: { width: 1000, height: 500 },
    candidate: null,
    detections: []
  }));
  const result = assessPair(entries);
  assert.equal(result.state, STATES.EVIDENCE_REVIEW_REQUIRED);
  assert.equal(result.detected, false);
  assert.equal(result.category, null);
  assert.equal(result.confidencePercent, 17.2);
  assert.equal(result.submittable, true);
  for (const [index, photo] of result.photos.entries()) {
    assert.deepEqual(photo.boxes, []);
    const [box] = photo.previewBoxes;
    assert.deepEqual(box.bbox, entries[index].result.suggested_box.bounding_box);
    assert.equal(box.eligible, false);
  }
  const rendered = [];
  let responses = entries;
  const harness = uploadHarness({
    detector: { detectPhotos: async () => responses },
    compareScenes: () => ({ matched: false, score: 43, threshold: 82 }),
    overlay: { clear() {}, render(img, boxes) { if (boxes.length) rendered.push(img); } }
  });
  const description = harness.element('description');
  const counter = harness.element('charCounter');
  await harness.change([photo('first.jpg'), photo('second.jpg')]);
  harness.setLandmark(photo('landmark.jpg'), 'Beside the school entrance.');
  assert.equal(description.value, 'Possible issue in both photos: Road Crack.');
  assert.equal(counter.textContent, `${description.value.length}/500`);
  assert.equal(harness.element('citizenCategory').value, 'Road Damage');
  assert.equal(harness.element('submitBtn').disabled, false);
  const panel = harness.element('visionDetectBox');
  assert.match(panel.innerHTML, /AI Damage Assessment/);
  assert.match(panel.innerHTML, /AI suggests Road Crack in both photos\./);
  assert.match(panel.innerHTML, /Evidence verification:<\/span> <strong>Pending/);
  assert.match(panel.innerHTML, /data-assessment-tone="neutral"/);
  assert.match(panel.innerHTML, /Overall: 17\.2% · Low/);
  assert.match(panel.innerHTML, /Candidate Category:<\/span> <strong>Road Damage/);
  assert.match(panel.innerHTML, /Overall AI confidence:<\/span> <strong data-confidence-level="Low"[^>]*>17\.2% · Low/);
  assert.match(panel.innerHTML, /Photo 1:<\/span> Road Crack · 21\.9% · Low/);
  assert.match(panel.innerHTML, /Photo 2:<\/span> Road Crack · 12\.4% · Low/);
  assert.match(panel.innerHTML, /Damage Agreement:<\/span> Yes \(provisional\)/);
  assert.match(panel.innerHTML, /Scene Match:<\/span> 43% \(match unverified\)/);
  assert.equal(panel.style.display, 'block');
  assert.ok(rendered.includes(harness.element('imgPreview')));
  assert.ok(rendered.includes(harness.element('imgPreview2')));
  ['citizenEvidenceDialog', 'citizenEnlargedEvidence', 'citizenEvidenceSubtitle'].forEach(harness.element);
  harness.context.openCitizenPhotoZoom(0);
  assert.equal(harness.element('citizenEvidenceSubtitle').textContent, 'Road Crack · 21.9% · Low');
  assert.ok(rendered.includes(harness.element('citizenEnlargedEvidence')));

  responses = [entries[0], ok(empty)];
  const noMatch = assessPair(responses);
  assert.ok(noMatch.photos.every(photo => photo.previewBoxes.length === 0));
  await harness.change([photo('retake-one.jpg'), photo('retake-two.jpg')]);
  assert.match(panel.innerHTML, /The AI could not confirm the evidence/);
  assert.doesNotMatch(panel.innerHTML, /Road Crack/);
  assert.equal(description.value, '');
  assert.equal(counter.textContent, '0/500');
  assert.equal(harness.element('citizenCategory').value, '');
  assert.equal(harness.element('submitBtn').disabled, true);

  description.value = 'My own description of the issue.';
  description.listeners.input.forEach(listener => listener());
  responses = entries;
  await harness.change([photo('last-one.jpg'), photo('last-two.jpg')]);
  assert.equal(description.value, 'My own description of the issue.');
});

test('auth and service failures keep their own states and are never reported as no damage or inconclusive', () => {
  const auth = assessPair([failed('AUTH_ERROR'), ok(detected('road_crack', 'Road Crack', 0.64))]);
  const service = assessPair([ok(empty), failed('AI_SERVICE_ERROR')]);
  assert.equal(auth.state, STATES.AUTH_ERROR);
  assert.equal(auth.stateLabel, 'Sign-in Required');
  assert.equal(auth.submittable, false);
  assert.equal(service.state, STATES.AI_SERVICE_ERROR);
  assert.equal(service.stateLabel, 'AI Service Unavailable');
  assert.equal(service.detected, false);
  for (const pair of [auth, service]) {
    assert.doesNotMatch(pair.stateLabel, /inconclusive|no damage/i);
    assert.equal(pair.confidence, null);
  }
});

test('boxes are projected with object-fit cover scaling relative to the API image size', () => {
  const natural = { width: 2000, height: 1000 };
  const rendered = { width: 160, height: 160 };
  const rect = projectBox({ x: 500, y: 250, width: 500, height: 250 }, { width: 1000, height: 500 }, natural, rendered, 'cover');
  assert.deepEqual(rect, { left: 80, top: 80, width: 80, height: 80 });

  const contain = projectBox({ x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 500 }, natural, rendered, 'contain');
  assert.deepEqual(contain, { left: 0, top: 40, width: 160, height: 80 });

  const clipped = projectBox({ x: 0, y: 0, width: 100, height: 500 }, { width: 1000, height: 500 }, natural, rendered, 'cover');
  assert.equal(clipped, null);
  assert.equal(projectBox(null, null, natural, rendered), null);
  assert.deepEqual(projectBox({ x: 10, y: 20, width: 20, height: 40 },
    { width: 100, height: 200 }, { width: 500, height: 1000 },
    { width: 300, height: 300 }, 'contain'), { left: 90, top: 30, width: 30, height: 60 });
});

test('clearing a detection overlay removes the previous photo load listener', () => {
  const overlay = require('../../frontend/js/citizen/detectionOverlay');
  const listeners = new Map();
  const image = {
    complete: false,
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      assert.equal(listeners.get(type), callback);
      listeners.delete(type);
    }
  };
  overlay.render(image, [{}], null);
  assert.equal(typeof listeners.get('load'), 'function');
  overlay.clear(image);
  assert.equal(listeners.has('load'), false);
});

test('pixel comparison reports measurements and unavailable vectors separately from detection', () => {
  const harness = uploadHarness();
  const compare = vm.runInContext('CitizenSceneComparison.compareSceneVectors', harness.context);
  const vector = values => ({ centered: values, norm: Math.hypot(...values) });
  const original = vector([1, -1, -1, 1]);
  const same = compare(original, original);
  assert.equal(same.score, 100);
  assert.equal(same.method, 'grayscale_correlation');
  const shift = Math.sqrt(0.99);
  const changedView = compare(original, vector([0.1 + shift, -0.1 + shift, -0.1 - shift, 0.1 - shift]));
  assert.equal(changedView.score, 10);
  assert.equal(changedView.matched, false);
  assert.equal(changedView.status, 'AVAILABLE');
  for (const second of [vector([0, 0, 0, 0]), vector([NaN, 1, 2, 3]), vector([1, -1])]) {
    const result = compare(original, second);
    assert.equal(result.score, null);
    assert.equal(result.matched, null);
    assert.equal(result.status, 'UNAVAILABLE');
  }
  const pair = assessPair([ok(detected('road_crack', 'Road Crack', 0.827)),
    ok(detected('road_crack', 'Road Crack', 0.926))], changedView);
  assert.equal(pair.confidencePercent, 87.7);
  assert.equal(pair.state, STATES.DETECTED);
  assert.equal(pair.sceneMatch.score, 10);
  assert.equal(harness.context.CitizenAssessmentPresentation.describeSceneMatch(changedView), '10% pixel similarity (advisory)');
});

const citizenReportFiles = Array.from(read('citizen.html').matchAll(/src="(js\/citizen\/[^"?]+\.js)(?:\?[^"]*)?"/g), match => match[1]);
const reportModules = citizenReportFiles.slice(citizenReportFiles.indexOf('js/citizen/photoValidation.js'));

test('Citizen Report modules stay within the scoped line limits', () => {
  // Keep the evidence dialog, fullscreen fallback, zoom and overlay lifecycle together.
  const exceptions = { 'js/citizen/evidenceViewerController.js': 300, 'js/citizen/citizen.js': 100 };
  for (const file of [...reportModules, 'js/citizen/citizenAssessmentPresentation.js', 'js/citizen/citizenSeverityPresentation.js', 'js/citizen/detectionOverlay.js']) {
    const lines = read(file).replace(/\r?\n$/, '').split(/\r?\n/).length;
    const limit = exceptions[file] || 200;
    assert.ok(lines <= limit, `${file} has ${lines} lines (limit ${limit})`);
  }
});

test('frontend files never call the FastAPI service directly or label the model as COCO', () => {
  const files = ['citizen.html', ...reportModules, 'js/citizen/yoloDamageDetector.js', 'js/citizen/damagePairAssessment.js', 'js/citizen/detectionOverlay.js', 'js/auth/security.js', 'js/shared/api.js'];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /:8000|\/predict\b|verify-pair|\/api\/v1\/damage/, file);
    assert.doesNotMatch(source, /coco/i, file);
  }
});

test('the citizen page loads the client, aggregator and overlay before citizen.js and no second login flow exists', () => {
  const html = read('citizen.html');
  const order = ['js/shared/api.js', 'js/citizen/yoloDamageDetector.js', 'js/citizen/damagePairAssessment.js', 'js/citizen/submissionReadiness.js', 'js/citizen/detectionOverlay.js', 'js/citizen/reportCameraControls.js', 'js/citizen/reportCamera.js', ...reportModules].map(src => html.indexOf(`src="${src}`));
  assert.ok(order.every(index => index > 0));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);

  for (const file of ['js/auth/security.js', 'js/citizen/yoloDamageDetector.js', ...reportModules]) {
    const source = read(file);
    assert.doesNotMatch(source, /\/api\/auth\/login/, file);
    assert.doesNotMatch(source, /password:\s*'1'/, file);
  }

  const citizen = reportModules.map(read).join('\n');
  assert.doesNotMatch(citizen, /Signals:|detectIssueFromImage|mergeVisionResults|\[OCR Detected\]/);
  assert.match(citizen, /\{ assessPair, percent \} = window\.DamagePairAssessment/);
  assert.match(citizen, /YoloDamageDetector\.detectPhotos/);
});

function uploadHarness({ detector, overlay, compareScenes, decodeError = false, schedule = setTimeout } = {}) {
  const domListeners = {};
  class FakeElement {
    constructor(id) {
      this.id = id;
      this.style = {};
      this.listeners = {};
      this.value = '';
      this.files = [];
      this.src = '';
      this.disabled = false;
      this._innerHTML = '';
      this.textContent = '';
      this.classList = { add() { }, remove() { } };
    }
    addEventListener(name, handler) {
      this.listeners[name] = this.listeners[name] || [];
      this.listeners[name].push(handler);
    }
    click() {
      this.clicked = (this.clicked || 0) + 1;
    }
    insertAdjacentElement(_position, element) {
      elements.set(element.id, element);
    }
    querySelector(selector) {
      return selector === 'p' ? this.prompt : null;
    }
    set innerHTML(value) {
      this._innerHTML = String(value);
      if (this.id === 'visionDetectBox') {
        if (this._innerHTML.includes('data-upload-state="AI_SCANNING"')) this.scanningRenders = (this.scanningRenders || 0) + 1;
        if (this._innerHTML.includes('data-assessment-state=')) this.assessmentRenders = (this.assessmentRenders || 0) + 1;
      }
    }
    get innerHTML() {
      return this._innerHTML;
    }
  }

  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const prompt = new FakeElement('uploadPrompt');
  const uploadArea = element('uploadArea');
  uploadArea.prompt = prompt;
  ['imgInput', 'imgPreview', 'imgPreview2', 'visionDetectBox', 'reportForm', 'description', 'location', 'submitBtn', 'aiResult', 'gpsStatus', 'geoCanvas', 'citizenCategory', 'citizenCategoryGroup', 'citizenCategoryExplanation'].forEach(element);

  let objectUrl = 0;
  let decodedImages = 0;
  const canvasData = new Uint8ClampedArray(100 * 100 * 4);
  for (let index = 0; index < canvasData.length; index += 4) {
    const value = index % 8 === 0 ? 20 : 220;
    canvasData[index] = value;
    canvasData[index + 1] = value;
    canvasData[index + 2] = value;
    canvasData[index + 3] = 255;
  }

  class FakeFileReader {
    readAsDataURL(file) {
      this.result = `data:${file.type || 'image/jpeg'};base64,${Buffer.from(file.name || 'photo').toString('base64')}`;
      queueMicrotask(() => this.onload?.({ target: this }));
    }
  }

  class FakeImage {
    constructor() {
      this.width = 100;
      this.height = 100;
      this.naturalWidth = 100;
      this.naturalHeight = 100;
      this.style = {};
    }
    set src(value) {
      this._src = value;
      decodedImages += 1;
      queueMicrotask(() => decodeError ? this.onerror?.() : this.onload?.());
    }
    get src() {
      return this._src;
    }
  }

  const context = {
    console,
    Buffer,
    crypto: require('node:crypto').webcrypto,
    AbortController,
    File,
    FormData,
    queueMicrotask,
    setTimeout: schedule,
    clearTimeout,
    URL: {
      createObjectURL: () => `blob:test-${++objectUrl}`,
      revokeObjectURL: url => {
        context.revokedUrls.push(url);
      }
    },
    revokedUrls: [],
    location: { href: '', hostname: '127.0.0.1' },
    window: null,
    addEventListener: (name, handler, options) => {
      domListeners[name] = options?.once ? (...args) => {
        delete domListeners[name];
        return handler(...args);
      } : handler;
    },
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: tag => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage() { },
              getImageData: () => ({ data: canvasData })
            })
          };
        }
        return new FakeElement(tag);
      },
      querySelectorAll: () => [],
      addEventListener: (name, handler) => {
        domListeners[name] = handler;
      }
    },
    Image: FakeImage,
    FileReader: FakeFileReader,
    getComputedStyle: () => ({ objectFit: 'cover' }),
    getSession: () => ({ username: 'citizen', role: 'citizen', apiToken: 'demo-token' }),
    loadMyReports: () => { },
    autoDetectBarangay: async () => null,
    getCurrentLocation: async () => ({ lat: 10.678, lng: 122.946, accuracy: 15, timestamp: Date.now() }),
    gpsFixDistance: () => 0,
    BacolodMap: { resolveReportArea: async () => ({ authoritative: true, feature: { properties: { name: 'Barangay Central' } } }) },
    getAllReports: () => [],
    ReportPresentation: require('../../frontend/js/shared/reportPresentation'),
    priorityBadge: priority => `<span>${priority || ''}</span>`,
    showFormError: message => {
      context.lastFormError = message;
    },
    addReport: report => ({ ...report, id: 'report-1' }),
    ReportVocabulary: require('../../shared/reportVocabulary'),
    CitizenCorrection,
    YoloDamageDetector: detector || { detectPhotos: async () => [ok(detected('road_crack', 'Road Crack', 0.8)), ok(detected('road_crack', 'Road Crack', 0.7))] },
    DetectionOverlay: overlay || { render() { }, clear() { } }
  };
  context.window = context;
  let landmarkPhoto = null;
  let landmarkDesc = '';
  let landmarkOnChange = () => {};
  context.createCitizenLandmarkField = ({ onChange = () => {} } = {}) => {
    landmarkOnChange = onChange;
    return {
      mount: async () => {},
      getPhoto: () => landmarkPhoto,
      getDescription: () => landmarkDesc.trim(),
      setPhoto: file => { landmarkPhoto = file; landmarkOnChange(); },
      isComplete: () => landmarkPhoto !== null && landmarkDesc.trim().length > 0 && landmarkDesc.length <= 250,
      reset: () => { landmarkPhoto = null; landmarkDesc = ''; landmarkOnChange(); }
    };
  };
  const setLandmark = (file, description) => {
    landmarkPhoto = file;
    landmarkDesc = description;
    landmarkOnChange();
  };
  vm.createContext(context);
  vm.runInContext(read('js/citizen/damagePairAssessment.js'), context, { filename: 'damagePairAssessment.js' });
  vm.runInContext(read('js/citizen/citizenSeverityPresentation.js'), context, { filename: 'citizenSeverityPresentation.js' });
  vm.runInContext(read('js/citizen/citizenAssessmentPresentation.js'), context, { filename: 'citizenAssessmentPresentation.js' });
  vm.runInContext(read('js/citizen/submissionReadiness.js'), context, { filename: 'submissionReadiness.js' });
  for (const file of reportModules) {
    if (file.endsWith('/landmarkField.js')) continue;
    vm.runInContext(read(file), context, { filename: file });
    if (file.endsWith('/sceneComparison.js') && compareScenes) {
      context.testCompareScenes = compareScenes;
      vm.runInContext('CitizenSceneComparison.comparePhotoScenes = testCompareScenes;', context);
    }
  }
  domListeners.DOMContentLoaded();

  const change = files => {
    const input = element('imgInput');
    input.files = files;
    return Promise.all((input.listeners.change || []).map(handler => handler({ preventDefault() { } })));
  };
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
  };
  return {
    context, elements, element, prompt, change, flush, setLandmark,
    decodedImages: () => decodedImages,
    fireReady: () => domListeners.DOMContentLoaded?.()
  };
}

async function waitFor(assertion, flush, attempts = 20) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

test('one two-photo selection starts one detector run, shows one scan state, and renders READY once', async () => {
  const batches = [];
  const detector = {
    detectPhotos: async files => {
      batches.push(files);
      return [ok(detected('road_crack', 'Road Crack', 0.8)), ok(detected('road_crack', 'Road Crack', 0.6))];
    }
  };
  const harness = uploadHarness({ detector });
  await harness.change([photo('one.jpg'), photo('two.jpg')]);
  const box = harness.element('visionDetectBox');

  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].name, 'one.jpg');
  assert.equal(batches[0][1].name, 'two.jpg');
  assert.equal(box.scanningRenders, 1);
  assert.equal(box.assessmentRenders, 1);
  assert.equal(harness.prompt.textContent, 'Both photos have been scanned.');
  assert.match(box.innerHTML, /data-assessment-state="DETECTED"/);
  assert.doesNotMatch(harness.prompt.textContent, /scanning both/i);
});

test('a pending scan clears stale assessment, cannot overwrite a newer replacement, and replacement starts one new scan', async () => {
  const resolvers = [];
  const detector = {
    detectPhotos: files => new Promise(resolve => {
      resolvers.push({ files, resolve });
    })
  };
  const harness = uploadHarness({ detector });
  const first = harness.change([photo('old-a.jpg'), photo('old-b.jpg')]);
  await waitFor(() => assert.equal(resolvers.length, 1), harness.flush);
  resolvers[0].resolve([ok(detected('road_crack', 'Road Crack', 0.8)), ok(detected('road_crack', 'Road Crack', 0.7))]);
  await first;
  assert.match(harness.element('visionDetectBox').innerHTML, /Road Crack/);

  const second = harness.change([photo('slow-a.jpg'), photo('slow-b.jpg')]);
  await waitFor(() => assert.equal(resolvers.length, 2), harness.flush);
  assert.equal(harness.prompt.textContent, '2 photos selected');
  assert.doesNotMatch(harness.element('visionDetectBox').innerHTML, /Road Crack/);

  const third = harness.change([photo('new-a.jpg'), photo('new-b.jpg')]);
  await waitFor(() => assert.equal(resolvers.length, 3), harness.flush);
  resolvers[2].resolve([ok(detected('pothole', 'Pothole', 0.9)), ok(detected('pothole', 'Pothole', 0.8))]);
  await third;
  resolvers[1].resolve([ok(detected('road_crack', 'Road Crack', 0.95)), ok(detected('road_crack', 'Road Crack', 0.95))]);
  await second;

  assert.equal(resolvers.length, 3);
  assert.match(harness.element('visionDetectBox').innerHTML, /Pothole/);
  assert.doesNotMatch(harness.element('visionDetectBox').innerHTML, /Road Crack/);
});

test('scene matching and overlay redraw do not start another detector run', async () => {
  let detectCalls = 0;
  let overlayRenders = 0;
  const detector = {
    detectPhotos: async () => {
      detectCalls += 1;
      return [ok(detected('road_crack', 'Road Crack', 0.8)), ok(detected('road_crack', 'Road Crack', 0.7))];
    }
  };
  const overlay = {
    render: () => {
      overlayRenders += 1;
    },
    clear() { }
  };
  const harness = uploadHarness({ detector, overlay });
  await harness.change([photo('one.jpg'), photo('two.jpg')]);
  overlay.render();

  assert.equal(detectCalls, 1);
  assert.equal(overlayRenders, 3);
});

test('auth and service failures render one ERROR assessment without duplicate scans', async () => {
  for (const state of ['AUTH_ERROR', 'AI_SERVICE_ERROR']) {
    let detectCalls = 0;
    const harness = uploadHarness({
      detector: {
        detectPhotos: async () => {
          detectCalls += 1;
          return [failed(state), failed(state)];
        }
      }
    });
    await harness.change([photo(`${state}-a.jpg`), photo(`${state}-b.jpg`)]);
    const box = harness.element('visionDetectBox');

    assert.equal(detectCalls, 1);
    assert.equal(box.scanningRenders, 1);
    assert.equal(box.assessmentRenders, 1);
    assert.match(box.innerHTML, new RegExp(`data-assessment-state="${state}"`));
  }
});

test('setup is idempotent and does not duplicate upload or submit listeners', () => {
  const harness = uploadHarness();
  harness.fireReady();

  assert.equal(harness.element('imgInput').listeners.change.length, 1);
  assert.equal(harness.element('uploadArea').listeners.click, undefined);
  assert.equal(harness.element('reportForm').listeners.submit.length, 1);
});

test('validation responses retain their own state and timeout codes survive the citizen client', async () => {
  const invalid = browserContext({ respond: () => jsonResponse(400, { error: 'Invalid image.', code: 'IMAGE_VALIDATION_ERROR' }) });
  const [entry] = await invalid.context.YoloDamageDetector.detectPhotos([photo('invalid.jpg'), photo('two.jpg')]);
  assert.equal(entry.error.state, 'VALIDATION_ERROR');
  assert.equal(entry.error.code, 'IMAGE_VALIDATION_ERROR');
  const pair = assessPair([entry, ok(empty)]);
  assert.equal(pair.state, 'VALIDATION_ERROR');
  assert.equal(pair.submittable, false);
  const timeout = browserContext({ respond: () => jsonResponse(504, { error: 'Inference timed out.', code: 'INFERENCE_TIMEOUT' }) });
  const [timedOut] = await timeout.context.YoloDamageDetector.detectPhotos([photo('timeout.jpg'), photo('two.jpg')]);
  assert.equal(timedOut.error.state, 'AI_SERVICE_ERROR');
  assert.equal(timedOut.error.code, 'INFERENCE_TIMEOUT');
});

test('malformed successful provider status is an error rather than invented no detection', async () => {
  const client = browserContext({ respond: () => jsonResponse(200, { photos: [{ result: { status: 'UNKNOWN' } }, { result: empty }] }) });
  const [entry] = await client.context.YoloDamageDetector.detectPhotos([photo('x.jpg'), photo('two.jpg')]);
  assert.equal(entry.ok, false);
  assert.equal(entry.error.state, 'AI_SERVICE_ERROR');
});

test('a corrupt image exits preview loading as validation error without invoking AI', async () => {
  let calls = 0;
  const harness = uploadHarness({ decodeError: true, detector: { detectPhotos: async () => { calls += 1; return []; } } });
  await harness.change([photo('broken.jpg'), photo('second.jpg')]);
  assert.equal(calls, 0);
  assert.match(harness.element('visionDetectBox').innerHTML, /data-assessment-state="VALIDATION_ERROR"/);
  assert.doesNotMatch(harness.element('visionDetectBox').innerHTML, /AI_SCANNING/);
});

test('failed scene comparison remains advisory without hiding detections or manual content', async () => {
  const harness = uploadHarness({ compareScenes: () => { throw new Error('Comparison failed'); } });
  harness.element('description').value = 'My manually entered description';
  await harness.change([photo('one.jpg'), photo('two.jpg')]);
  const html = harness.element('visionDetectBox').innerHTML;
  assert.match(html, /data-assessment-state="DETECTED"/);
  assert.match(html, /Scene comparison is unavailable/);
  assert.equal(harness.element('description').value, 'My manually entered description');
});

test('late scene metadata from an older scan cannot overwrite the current scene advisory', async () => {
  const scenes = [];
  const harness = uploadHarness({ compareScenes: () => new Promise(resolve => scenes.push(resolve)) });
  const old = harness.change([photo('old-one.jpg'), photo('old-two.jpg')]);
  await waitFor(() => assert.equal(scenes.length, 1), harness.flush);
  const latest = harness.change([photo('new-one.jpg'), photo('new-two.jpg')]);
  await waitFor(() => assert.equal(scenes.length, 2), harness.flush);
  scenes[1]({ matched: false, score: 15, threshold: 82 });
  await latest;
  scenes[0]({ matched: true, score: 98, threshold: 82 });
  await old;
  assert.match(harness.element('visionDetectBox').innerHTML, /15% \(match unverified\)/);
  assert.doesNotMatch(harness.element('visionDetectBox').innerHTML, /98%/);
});

test('an older submission response cannot clear newly selected assessments', async () => {
  let scan = 0;
  const harness = uploadHarness({
    detector: {
      detectPhotos: async () => {
        const canonical = scan++ ? 'pothole' : 'road_crack';
        return [ok(detected(canonical, canonical === 'pothole' ? 'Pothole' : 'Road Crack', 0.8)), ok(detected(canonical, canonical === 'pothole' ? 'Pothole' : 'Road Crack', 0.7))];
      }
    }
  });
  await harness.change([photo('first-one.jpg'), photo('first-two.jpg')]);
  harness.setLandmark(photo('landmark.jpg'), 'Beside the school entrance.');
  harness.element('description').value = 'Manual description';
  const selectCategory = () => harness.element('citizenCategory').listeners.change[0]({ target: { value: 'Road Damage' } });
  selectCategory();
  harness.context.autoDetectBarangay = async () => ({ lat: 10.678, lng: 122.946, accuracy: 15, barangay: 'Barangay Central' });
  await harness.context.runAutoGeofence();
  let finish;
  harness.context.addReport = value => ({ ...value, id: 'old-report', syncPromise: new Promise(resolve => { finish = resolve; }) });
  const submit = harness.element('reportForm').listeners.submit[0]({ currentTarget: harness.element('reportForm'), preventDefault() { } });
  await waitFor(() => assert.equal(typeof finish, 'function'), harness.flush);
  await harness.change([photo('replacement-one.jpg'), photo('replacement-two.jpg')]);
  selectCategory();
  assert.equal(harness.element('submitBtn').disabled, true);
  finish({ ok: true });
  await submit;
  assert.match(harness.element('visionDetectBox').innerHTML, /Pothole/);
  assert.equal(harness.element('description').value, 'Manual description');
  assert.equal(harness.element('submitBtn').disabled, false);
});

test('submission preserves photo order and reuses the request key after a failed attempt', async () => {
  const harness = uploadHarness({ schedule: () => 0 });
  harness.context.autoDetectBarangay = async () => ({
    lat: 10.678, lng: 122.946, accuracy: 15, timestamp: Date.now(), barangay: 'Barangay Central', address: 'Live report address'
  });
  await harness.context.runAutoGeofence();
  const files = [photo('front.jpg'), photo('side.jpg')];
  const landmarkFile = photo('landmark.jpg');
  const landmarkDescription = 'Beside the school entrance.';
  await harness.change(files);
  harness.setLandmark(landmarkFile, landmarkDescription);
  harness.element('citizenCategory').listeners.change[0]({ target: { value: 'Road Damage' } });
  const form = harness.element('reportForm');
  const event = { currentTarget: form, preventDefault() {} };
  const submit = () => form.listeners.submit[0](event);
  const payloads = [];
  let settle;
  harness.context.addReport = payload => {
    payloads.push(payload);
    return { id: '<report-id>', syncPromise: new Promise(resolve => { settle = resolve; }) };
  };

  const first = submit();
  await waitFor(() => assert.equal(payloads.length, 1), harness.flush);
  await submit();
  assert.equal(payloads.length, 1);
  settle({ ok: false, retryable: true, error: 'Report response went missing.' });
  await first;
  assert.equal(harness.element('formError').textContent, 'Report response went missing.');
  assert.equal(harness.element('submitBtn').disabled, false);

  const retry = submit();
  await waitFor(() => assert.equal(payloads.length, 2), harness.flush);
  const [original, retried] = payloads;
  assert.equal(retried.requestKey, original.requestKey);
  assert.equal(retried.location, 'Live report address');
  assert.equal(retried.citizenCategory, 'Road Damage');
  assert.equal(retried.aiPhotoDetails.length, 2);
  assert.equal(retried.image, retried.images[0]);
  assert.equal(retried.rawFiles, retried.files);
  assert.deepEqual(Array.from(retried.files), files);
  assert.equal(retried.landmarkFile, landmarkFile);
  assert.equal(retried.landmarkDescription, landmarkDescription);
  assert.equal(harness.decodedImages(), 2);
  settle({ ok: true });
  await retry;
  assert.match(harness.element('aiResult').innerHTML, /&lt;report-id&gt;/);

  // Changed landmark evidence cannot reuse an incompatible request key
  await harness.change(files);
  harness.element('citizenCategory').listeners.change[0]({ target: { value: 'Road Damage' } });
  harness.setLandmark(landmarkFile, 'Different landmark description.');
  const changed = submit();
  await waitFor(() => assert.equal(payloads.length, 3), harness.flush);
  assert.notEqual(payloads[2].requestKey, original.requestKey);
  settle({ ok: true });
  await changed;
  await submit();
  assert.equal(payloads.length, 3);
});

test('replacing evidence and clearing the report release both generations of preview URLs', async () => {
  const harness = uploadHarness();
  await harness.change([photo('first.jpg'), photo('second.jpg')]);
  await harness.change([photo('replacement.jpg'), photo('other-angle.jpg')]);
  assert.deepEqual(harness.context.revokedUrls, ['blob:test-1', 'blob:test-2']);
  harness.context.resetFormUI();
  assert.deepEqual(harness.context.revokedUrls, ['blob:test-1', 'blob:test-2', 'blob:test-3', 'blob:test-4']);
  assert.equal(harness.element('imgPreview').src, '');
  assert.equal(harness.element('imgPreview2').src, '');
});

test('citizen preview frames open zoom modal with detection bounding boxes and can be closed', async () => {
  const overlayRenders = [];
  let overlayClears = 0;
  const overlay = {
    render: (img, boxes, imageSize) => {
      overlayRenders.push({ img, boxes, imageSize });
    },
    clear: () => {
      overlayClears += 1;
    }
  };
  const harness = uploadHarness({ overlay });
  await harness.change([photo('img1.jpg'), photo('img2.jpg')]);

  ['citizenEvidenceDialog', 'citizenEnlargedEvidence', 'citizenEvidenceTitle', 'citizenEvidenceSubtitle', 'citizenZoomIn', 'citizenZoomOut', 'citizenResetZoom', 'citizenToggleFullscreen'].forEach(harness.element);
  const dialog = harness.element('citizenEvidenceDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const enlargedImg = harness.element('citizenEnlargedEvidence');

  // Trigger zoom for photo 1
  harness.context.openCitizenPhotoZoom(0);
  assert.equal(dialog.open, true);
  assert.equal(enlargedImg.src, harness.element('imgPreview').src);
  assert.equal(harness.element('citizenEvidenceTitle').textContent, 'Photo 1');
  assert.match(harness.element('citizenEvidenceSubtitle').textContent, /Road Crack/);
  assert.ok(overlayRenders.some(r => r.img === enlargedImg));

  // Trigger close
  harness.context.closeCitizenPhotoZoom();
  assert.equal(dialog.open, false);
  assert.ok(overlayClears > 0);
});

