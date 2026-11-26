'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canAutofillIdFields } = require('../domain/identity/ocrPrefillPolicy');

const captureSignals = {
  classification: 'UNABLE_TO_ASSESS',
  decision: 'REVIEW_REQUIRED',
  checks: ['Image sharpness'],
  indicators: ['Local image signals do not establish the fraud risk for this ID.']
};

test('readable but inconclusive scan cannot prefill the enrollment form', () => {
  assert.equal(canAutofillIdFields({ decision: 'RETAKE_REQUIRED', screening: captureSignals }), false);
});

test('only verified low-risk scans permit prefill', () => {
  const screening = { classification: 'LOW_RISK', checks: [] };
  assert.equal(canAutofillIdFields({ decision: 'VERIFIED', screening }), true);
  assert.equal(canAutofillIdFields({ decision: 'VERIFICATION_REQUIRED', screening }), false);
});

test('suspicious, invalid, fake and retake scans do not prefill', () => {
  for (const classification of ['SUSPICIOUS', 'INVALID', 'POTENTIALLY_FAKE', 'RETAKE_REQUIRED', null, '']) {
    assert.equal(canAutofillIdFields({ decision: 'VERIFIED', screening: { ...captureSignals, classification } }), false);
  }
});

test('missing or unavailable screening cannot grant prefill', () => {
  assert.equal(canAutofillIdFields(), false);
  assert.equal(canAutofillIdFields(null), false);
  assert.equal(canAutofillIdFields({ decision: 'VERIFIED', screening: null }), false);
});
