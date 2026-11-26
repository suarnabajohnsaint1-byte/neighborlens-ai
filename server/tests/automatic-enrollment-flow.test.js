'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { interpretFraudAssessment } = require('../domain/identity/idScreening');
const { canAutofillIdFields } = require('../domain/identity/ocrPrefillPolicy');

class DomainError extends Error {
  constructor(message, kindOrDetails, details) {
    super(message);
    Object.assign(this, details || (typeof kindOrDetails === 'object' ? kindOrDetails : {}));
  }
}

function newService({ verifier, fraud, used = false, allowOutsideScan = false, clock = Date.now } = {}) {
  const module = { exports: {} };
  const mocks = {
    '../../../shared/geoContainment': {
      inspect: (lat, lon, geometry) => geometry && ({
        inside: lat >= 10.6 && lat <= 10.8 && lon >= 122.8 && lon <= 123.1,
        edgeMeters: 200
      })
    },
    '../../../shared/identityDocumentPolicy': { enrollmentDocumentType: type => ['DRIVERS_LICENSE', 'PHILSYS'].includes(type) ? type : null },
    '../../domain/identity/idScreening': require('../domain/identity/idScreening'),
    '../../domain/geofencing/geofence.rules': require('../domain/geofencing/geofence.rules'),
    '../../domain/identity/ocrPrefillPolicy': require('../domain/identity/ocrPrefillPolicy'),
    '../../domain/errors': {
      AppError: DomainError, ConflictError: DomainError, ForbiddenError: DomainError, ValidationError: DomainError,
      ErrorKind: { UNPROCESSABLE: 422, PROVIDER_UNAVAILABLE: 503 }
    },
    './enrollmentFacts': {
      verifiedFacts: facts => facts?.documentType && facts?.idNumber && facts?.fullName && facts?.birthDate && facts?.address ? facts : null,
      comparableFacts: facts => [facts.documentType, facts.idNumber, facts.fullName, facts.birthDate, facts.address, facts.expiryDate],
      normalizedValue: (_key, value) => String(value).replace(/[-\s]/g, '').toUpperCase()
    }
  };
  const filename = path.join(__dirname, '../application/use-cases/citizenEnrollment.service.js');
  const source = readFileSync(filename, 'utf8');
  vm.runInNewContext(`(function(require, module) { ${source}\n})`, { Buffer, setTimeout, clearTimeout }, { filename })(
    name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module
  );
  return module.exports.createCitizenEnrollment({
    loadBoundary: async () => ({ boundaryVersion: 'synthetic-boundary' }),
    verifier: verifier || { available: false },
    fraudAssessor: fraud || { available: true, assess: async () => ({
      cleared: false, screening: { classification: 'UNABLE_TO_ASSESS', checks: ['Image sharpness'], indicators: [] }
    }) },
    normalizeFrame: async bytes => bytes,
    verificationUnavailable: () => new DomainError('No issuer verifier.', { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' }),
    fingerprintKey: 'fixture-fingerprint-key-that-is-private',
    keyUsed: async () => used,
    documentUsed: async () => false,
    manualReview: null,
    allowOutsideScan,
    clock
  });
}

const photo = Buffer.from('synthetic-id-test-data');
const location = () => ({ latitude: 10.67, longitude: 122.96, accuracy: 15, timestamp: Date.now() });
const identity = { documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Test Citizen',
  birthDate: '1995-01-01', address: 'SYNTHETIC STREET', expiryDate: '2099-01-01' };
const readableResearch = {
  basicCapture: { document: { documentType: identity.documentType, idNumber: identity.idNumber } },
  screening: { classification: 'UNABLE_TO_ASSESS', checks: ['Image sharpness', 'Research manipulation model'] }
};

test('scan-only mode accepts no GPS and never issues enrollment approval', async () => {
  const service = newService({
    allowOutsideScan: true,
    fraud: { available: true, assess: async () => readableResearch },
    verifier: { available: true, verify: () => assert.fail('A test scan cannot request identity approval') }
  });
  const outside = { ...location(), latitude: 7.77, longitude: 125.00 };
  await assert.rejects(service.start({ ...outside, timestamp: outside.timestamp - 60000 }),
    { code: 'REGISTRATION_LOCATION_RETRY' });
  await assert.rejects(newService().start(null), { code: 'REGISTRATION_LOCATION_RETRY' });
  const regular = await service.start(location());
  await assert.rejects(service.capture({ token: regular.token, position: null, frames: [photo] }),
    { code: 'REGISTRATION_LOCATION_RETRY' });
  for (const [startPosition, capturePosition] of [[null, null], [outside, outside], [outside, location()], [location(), outside]]) {
    const { token } = await service.start(startPosition);
    const result = await service.capture({ token, position: capturePosition, frames: [photo] });
    assert.equal(result.verificationReason, 'OUTSIDE_BACOLOD_TEST');
    assert.equal(result.decision, 'VERIFICATION_REQUIRED');
    assert.equal(result.ocrPrefillAllowed, true);
    await assert.rejects(service.enroll({ token, position: location(), identity },
      () => assert.fail('A test scan cannot create an account')), { code: 'REGISTRATION_PROOF_REQUIRED' });
  }
});

for (const [name, assessment, code] of [
  ['unreadable document number', { ...readableResearch, basicCapture: { document: null } }, 'REGISTRATION_ID_RETAKE_REQUIRED'],
  ['credible manipulation warning', { screening: { classification: 'SUSPICIOUS' } }, 'REGISTRATION_ID_RETAKE_REQUIRED'],
  ['missing signed basic assessment', { screening: { classification: 'UNABLE_TO_ASSESS' } }, 'REGISTRATION_FRAUD_UNAVAILABLE']
]) {
  test(`scan-only mode blocks prefill for ${name}`, async () => {
    const service = newService({ allowOutsideScan: true, fraud: { available: true, assess: async () => assessment } });
    const { token } = await service.start(null);
    await assert.rejects(service.capture({ token, position: null, frames: [photo] }), { code });
    assert.throws(() => service.assertCaptureSession(token), { code: 'REGISTRATION_PROOF_REQUIRED' });
  });
}

test('readable inconclusive capture permits OCR editing without granting registration', async () => {
  const service = newService();
  const { token } = await service.start(location());
  const result = await service.capture({ token, position: location(), frames: [photo] });
  assert.equal(result.decision, 'VERIFICATION_REQUIRED');
  assert.equal(result.verificationReason, 'VERIFIER_NOT_CONFIGURED');
  assert.equal(result.ocrPrefillAllowed, true);
  await assert.rejects(service.enroll({ token, position: location(), identity }, async () => assert.fail('Must not register')),
    { code: 'REGISTRATION_PROOF_REQUIRED' });
});

test('suspicious scans do not prefill and cannot register', async () => {
  const service = newService({ fraud: { available: true, assess: async () => ({
    cleared: false, screening: { classification: 'SUSPICIOUS', checks: ['digitalManipulation'] }
  }) } });
  const { token } = await service.start(location());
  const result = await service.capture({ token, position: location(), frames: [photo] });
  assert.equal(result.decision, 'VERIFICATION_REQUIRED');
  assert.equal(result.ocrPrefillAllowed, false);
  await assert.rejects(service.enroll({ token, position: location(), identity }, () => assert.fail('Must not register')),
    { code: 'REGISTRATION_PROOF_REQUIRED' });
});

test('confirmed counterfeit overrides an inconclusive local assessment', async () => {
  const service = newService({
    verifier: { available: true, verify: async ({ captureId }) => ({
      captureId, status: 'rejected', documentType: 'DRIVERS_LICENSE', reason: 'confirmed_counterfeit'
    }) }
  });
  const { token } = await service.start(location());
  await assert.rejects(service.capture({ token, position: location(), frames: [photo] }),
    { code: 'REGISTRATION_ID_COUNTERFEIT', decision: 'BLOCK_INVALID' });
  await assert.rejects(service.enroll({ token, position: location(), identity }, () => assert.fail('Cannot register')),
    { code: 'REGISTRATION_PROOF_REQUIRED' });
});

test('automatic verified path does not require an admin reviewer', async () => {
  const service = newService({
    fraud: { available: true, assess: async () => ({
      cleared: true, screening: { classification: 'LOW_RISK', checks: ['imageReuse', 'digitalManipulation', 'monitorRecapture'] }
    }) },
    verifier: { available: true, verify: async ({ captureId }) => ({
      captureId, status: 'approved', issuerVerified: true, holderVerified: true, liveCapturePassed: true,
      fraudScreening: { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' },
      subject: 'synthetic-evidence-subject', facts: identity
    }) }
  });
  const { token } = await service.start(location());
  const result = await service.capture({ token, position: location(), frames: [photo] });
  assert.equal(result.decision, 'VERIFIED');
  assert.equal(result.ocrPrefillAllowed, true);
  let persisted = false;
  const registered = await service.enroll({ token, position: location(), identity }, async ({ facts, keys }) => {
    persisted = true;
    assert.equal(facts.idNumber, identity.idNumber);
    assert.equal(keys.length, 3);
    return { registered: true };
  });
  assert.ok(persisted);
  assert.equal(registered.registered, true);
  await assert.rejects(service.enroll({ token, position: location(), identity }, () => assert.fail('Cannot reuse token')),
    { code: 'REGISTRATION_PROOF_REQUIRED' });
});

test('location and duplicate evidence continue to block capture', async () => {
  const service = newService();
  await assert.rejects(service.start({ ...location(), latitude: 14.5, longitude: 120.9 }),
    { code: 'REGISTRATION_OUTSIDE_BACOLOD' });
  await assert.rejects(service.start({ ...location(), timestamp: Date.now() - 90_000 }),
    { code: 'REGISTRATION_LOCATION_RETRY' });
  const duplicateService = newService({ used: true });
  const { token } = await duplicateService.start(location());
  await assert.rejects(duplicateService.capture({ token, position: location(), frames: [photo] }),
    { code: 'REGISTRATION_ID_ALREADY_USED' });
});

test('research fraud scores never count as valid Philippine identity proof', () => {
  const assessment = interpretFraudAssessment({ purpose: 'document_fraud_research', assessment: 'review', documentFraudScores: [0.01] });
  assert.equal(assessment.cleared, false);
  assert.equal(assessment.screening.classification, 'UNABLE_TO_ASSESS');
  assert.deepEqual(assessment.screening.checks, ['Image sharpness', 'Research manipulation model']);
  assert.equal(canAutofillIdFields({ decision: 'VERIFICATION_REQUIRED', screening: assessment.screening }), false);
});
