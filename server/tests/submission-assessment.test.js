const test = require('node:test');
const assert = require('node:assert/strict');
const { AI_REPORT_CATEGORIES, reportCategoryFor } = require('../domain/reports/damageCategories');
const { photoSnapshot, originalAssessment, validateSubmissionAssessment } = require('../domain/reports/submissionAssessment.rules');
const { validateReport } = require('../application/use-cases/report.validation');
const proof = require('../infrastructure/security/tokenProvider');
const correction = require('../../frontend/js/citizen/citizenCorrection');

function photo(status = 'DETECTED', category = 'pothole', confidence = 0.9) {
  return photoSnapshot({ status, detected: status === 'DETECTED', canonical_category: status === 'DETECTED' ? category : null,
    candidate: category ? { canonical_category: category, confidence, accepted: status === 'DETECTED' } : null,
    confidence, detections: [] });
}

function snapshot() {
  return { schema_version: 1, citizen_category: 'Road Damage', original_ai: originalAssessment([photo(), photo()]),
    evidence: { citizen_id: '1', photos: [1, 2].map(order => ({ order, sha256: 'a'.repeat(64), proof_id: `proof-${order}`, issued_at: 100 })) } };
}

for (const [canonical, category] of Object.entries({ pothole: 'Road Damage', road_crack: 'Road Damage', clogged_drainage: 'Flooding / Drainage', broken_streetlight: 'Street Light Damage' })) {
  test(`Phase 2 retains ${canonical} mapping`, () => assert.equal(reportCategoryFor(canonical), category));
}

test('Phase 2 exposes exactly three AI correction categories', () => assert.deepEqual(new Set(AI_REPORT_CATEGORIES), new Set(['Road Damage', 'Flooding / Drainage', 'Street Light Damage'])));

for (const category of AI_REPORT_CATEGORIES) {
  test(`Phase 2 accepts report category ${category}`, () => assert.equal(validateReport({ description: 'Damage', barangay: 'Barangay 1', citizenCategory: category }).error, undefined));
}

for (const category of ['pothole', 'Electrical', 'Fallen Tree', 'Invalid', '', null, ['Road Damage']]) {
  test(`Phase 2 rejects AI correction input ${JSON.stringify(category)}`, () => assert.ok(validateReport({ description: 'Damage', barangay: 'Barangay 1', citizenCategory: category }).error));
}

test('legacy generic submissions remain valid without an AI correction input', () => assert.equal(validateReport({ description: 'Fallen tree', barangay: 'Barangay 1', aiCategory: 'Fallen Tree' }).error, undefined));

test('original low-confidence candidate remains provisional and unchanged', () => {
  const photos = [photo('LOW_CONFIDENCE', 'pothole', 0.2), photo()];
  const before = structuredClone(photos);
  const ai = originalAssessment(photos);
  assert.equal(ai.status, 'LOW_CONFIDENCE');
  assert.equal(ai.canonical_class, null);
  assert.equal(ai.candidate.accepted, false);
  assert.equal(ai.confidence, 0.55);
  assert.deepEqual(photos, before);
});

for (const status of ['NO_DETECTION', 'AI_UNAVAILABLE']) {
  test(`original ${status} never gains a canonical class or confidence`, () => {
    const ai = originalAssessment([photo(status, null, null), photo(status, null, null)]);
    assert.equal(ai.status, status);
    assert.equal(ai.canonical_class, null);
    assert.equal(ai.confidence, null);
    assert.equal(ai.suggested_category, null);
  });
}

test('different road subtypes are not collapsed into an accepted canonical class', () => {
  const ai = originalAssessment([photo(), photo('DETECTED', 'road_crack')]);
  assert.equal(ai.status, 'PAIR_MISMATCH');
  assert.equal(ai.class_agreement, false);
});

test('valid snapshot and legacy null pass without changing source fields', () => {
  const value = snapshot();
  const before = structuredClone(value);
  validateSubmissionAssessment(value);
  validateSubmissionAssessment(null);
  assert.deepEqual(value, before);
});

for (const [name, mutate] of [
  ['version', value => { value.schema_version = 2; }],
  ['category', value => { value.citizen_category = 'Electrical'; }],
  ['evidence order', value => { value.evidence.photos.reverse(); }],
  ['digest', value => { value.evidence.photos[0].sha256 = 'bad'; }],
  ['duplicate proof', value => { value.evidence.photos[1].proof_id = 'proof-1'; }],
  ['invented confidence', value => { value.original_ai.confidence = 1; }],
  ['invented status', value => { value.original_ai.photos[0].status = 'VERIFIED'; }]
]) {
  test(`malformed snapshot rejects ${name}`, () => {
    const value = snapshot(); mutate(value);
    assert.throws(() => validateSubmissionAssessment(value));
  });
}

test('proof has fifteen-minute expiry and cannot authenticate as a user token', () => {
  const token = proof.issueAssessment({ sub: '42', photo_order: 1, evidence_sha256: 'a'.repeat(64), assessment: photo() });
  const claim = proof.verifyAssessment(token);
  assert.equal(claim.exp - claim.iat, 900);
  assert.equal(claim.sub, '42');
  assert.ok(claim.jti);
  assert.throws(() => proof.verify(token));
  assert.throws(() => proof.verifyAssessment(proof.issue({ id: 42, role: 'citizen' })));
});

test('expired and tampered proofs are rejected', () => {
  assert.throws(() => proof.verifyAssessment(proof.issueAssessment({ sub: '1' }, -1)));
  const token = proof.issueAssessment({ sub: '1' });
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: '2' })).toString('base64url');
  assert.throws(() => proof.verifyAssessment(parts.join('.')));
});

function result(detected = true, category = 'Road Damage') {
  const canonicalClass = detected ? (category === 'Street Light Damage' ? 'broken_streetlight' : 'pothole') : null;
  return { detected, canonicalClass, category, submittable: true, photos: [1, 2].map(index => ({ assessmentProof: `proof-${index}`, correctionCategories: AI_REPORT_CATEGORIES })) };
}

test('citizen accepts suggestion without an extra confirmation step', () => {
  const state = correction.assess(correction.empty(1), 1, result());
  assert.equal(state.category, 'Road Damage');
  assert.equal(correction.submission(state).citizenCategory, 'Road Damage');
});

test('manual selection survives repeated rendering without overwriting original suggestion', () => {
  const original = result(true, 'Street Light Damage');
  let state = correction.assess(correction.empty(1), 1, original);
  state = correction.select(state, 'Road Damage');
  state = correction.assess(state, 1, original);
  assert.equal(state.category, 'Road Damage');
  assert.equal(state.suggestion, 'Street Light Damage');
  assert.equal(original.category, 'Street Light Damage');
  assert.match(correction.explanation(state), /original AI suggestion/);
});

test('photo replacement invalidates selection and ignores obsolete assessment', () => {
  const state = correction.empty(2);
  assert.strictEqual(correction.assess(state, 1, result()), state);
  assert.deepEqual(correction.submission(state), {});
});

test('provisional suggestions remain unselected until the citizen chooses', () => {
  let state = correction.assess(correction.empty(), 0, result(false));
  assert.equal(state.category, null);
  state = correction.select(state, 'Flooding / Drainage');
  assert.equal(correction.submission(state).citizenCategory, 'Flooding / Drainage');
  assert.throws(() => correction.select(state, 'pothole'));
  assert.equal(correction.select(state, '').category, null);
});

test('optional citizen category retains proofs without inventing a choice', () => {
  const state = correction.assess(correction.empty(), 0, result(false, null));
  const submission = correction.submission(state);
  assert.equal(submission.citizenCategory, undefined);
  assert.deepEqual(submission.assessmentProofs, ['proof-1', 'proof-2']);
});

test('snapshot represents no explicit citizen choice as JSON null', () => {
  const value = snapshot();
  value.citizen_category = null;
  assert.doesNotThrow(() => validateSubmissionAssessment(value));
  assert.equal(value.original_ai.canonical_class, 'pothole');
});

test('missing proofs allow a manual category without claiming an AI result', () => {
  const assessment = result();
  assessment.photos[1].assessmentProof = null;
  const state = correction.assess(correction.empty(), 0, assessment);
  assert.equal(state.ready, false);
  assert.deepEqual(correction.submission(state), {});
  assert.deepEqual(correction.submission(correction.select(state, 'Road Damage')), { citizenCategory: 'Road Damage' });
  assert.doesNotThrow(() => validateSubmissionAssessment({ schema_version: 2, citizen_category: 'Road Damage', original_ai: null, evidence: null }));
});
