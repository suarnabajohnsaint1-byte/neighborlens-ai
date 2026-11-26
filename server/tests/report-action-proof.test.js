const test = require('node:test');
const assert = require('node:assert/strict');
const { validateActionProof, normalizeStatusNote } = require('../domain/reports/report.rules');
const { validateSubmissionAssessment } = require('../domain/reports/submissionAssessment.rules');

test('ongoing accepts optional action notes and zero to five photos', () => {
  for (const note of [null, 'Inspection started']) for (const count of [0, 1, 5]) assert.equal(validateActionProof('ongoing', note, count), null);
});
test('resolution requires both description and completion evidence', () => {
  assert.ok(validateActionProof('resolved', null, 1));
  assert.ok(validateActionProof('resolved', 'Repaired', 0));
  assert.equal(validateActionProof('resolved', 'Repaired', 1), null);
});
test('action photo counts are bounded integers', () => {
  for (const count of [-1, 6, 1.2, NaN, Infinity, '1']) assert.ok(validateActionProof('ongoing', null, count));
});
test('action media cannot be attached to rejection or pending transitions', () => {
  for (const status of ['rejected', 'pending']) assert.ok(validateActionProof(status, 'Note', 1));
});
test('action notes retain the existing 500 character limit and normalize whitespace', () => {
  assert.deepEqual(normalizeStatusNote('   '), { value: null });
  assert.equal(normalizeStatusNote('x'.repeat(500)).value.length, 500);
  assert.ok(normalizeStatusNote('x'.repeat(501)).error);
  assert.ok(normalizeStatusNote({}).error);
});
test('manual declarations cannot smuggle original AI results or proof metadata', () => {
  const manual = { schema_version: 2, citizen_category: 'Road Damage', original_ai: null, evidence: null };
  assert.doesNotThrow(() => validateSubmissionAssessment(manual));
  for (const extra of [{ original_ai: { status: 'DETECTED' } }, { evidence: {} }, { citizen_category: 'invented' }]) {
    assert.throws(() => validateSubmissionAssessment({ ...manual, ...extra }));
  }
});
