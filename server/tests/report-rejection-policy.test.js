const test = require('node:test');
const assert = require('node:assert/strict');
const { validateActionProof, checkStatusTransition } = require('../domain/reports/report.rules');
const vocabulary = require('../../shared/reportVocabulary');

test('operational rejection requires a meaningful reason and permits no action photos', () => {
  for (const reason of [null, '', '   ', 'No', '..........']) assert.ok(validateActionProof('rejected', reason, 0));
  assert.equal(validateActionProof('rejected', 'Duplicate report; existing case covers this incident.', 0), null);
  assert.ok(validateActionProof('rejected', 'Duplicate report already handled.', 1));
});

test('authorized staff rejection remains terminal and independent of publication', () => {
  for (const role of ['barangay']) for (const status of ['pending', 'ongoing']) assert.ok(vocabulary.reviewStatuses(role, status).includes('rejected'));
  assert.deepEqual(vocabulary.reviewStatuses('citizen', 'pending'), []);
  assert.deepEqual(vocabulary.reviewStatuses('admin', 'pending'), []);
  for (const status of ['pending', 'ongoing', 'resolved', 'rejected']) assert.equal(checkStatusTransition('rejected', status).allowed, false);
});
