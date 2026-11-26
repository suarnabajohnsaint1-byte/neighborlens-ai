const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFraudAssessmentClient, createKnownReplayCheck, createRegistrationVerifier } = require('../infrastructure/adapters/registrationVerifier');

const secret = 'isolated-fraud-test-secret-at-least-32';
const verifierSecret = 'isolated-verifier-test-secret-at-least-32';
const captureId = 'c'.repeat(32);
const frames = [Buffer.from('synthetic-fixture-one')];

test('the optional catalog rejects malformed configuration and only matches exact normalized bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neighborlens-replay-'));
  const file = path.join(directory, 'catalog.txt');
  try {
    assert.equal(createKnownReplayCheck()(frames[0]), false);
    assert.throws(() => createKnownReplayCheck(file)(frames[0]), { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });
    await fs.writeFile(file, 'invalid\n');
    assert.throws(() => createKnownReplayCheck(file)(frames[0]), { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });
    await fs.writeFile(file, createHash('sha256').update(frames[0]).digest('hex') + '\r\n');
    const matches = createKnownReplayCheck(file);
    assert.equal(matches(frames[0]), true);
    assert.equal(matches(Buffer.concat([frames[0], Buffer.from([0])])), false);
  } finally {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  }
});
const checks = { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' };
const approval = {
  captureId,
  framesSha256: frames.map(frame => createHash('sha256').update(frame).digest('hex')),
  purpose: 'registration_fraud_assessment',
  assessment: 'clear',
  checks
};

function client(result, signingSecret = secret) {
  return createFraudAssessmentClient({
    endpoint: 'http://127.0.0.1:8001/assess-capture', secret, verifierSecret,
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.Authorization, `Bearer ${secret}`);
      assert.equal(request.body.get('captureId'), captureId);
      const body = JSON.stringify(result);
      return new Response(body, {
        headers: { 'x-registration-fraud-signature': createHmac('sha256', signingSecret).update(body).digest('hex') }
      });
    }
  });
}

test('fraud approval is bound to the correct private signer, capture and frame bytes', async () => {
  const result = await client(approval).assess({ frames, captureId });
  assert.equal(result.cleared, true);
  assert.equal(result.screening.classification, 'LOW_RISK');
  assert.equal(result.screening.decision, 'PASS_SCREENING');
  const rejections = [
    client(approval, verifierSecret),
    client({ ...approval, captureId: 'a'.repeat(32) }),
    client({ ...approval, framesSha256: ['0'.repeat(64)] }),
    client({ ...approval, framesSha256: [...approval.framesSha256, '0'.repeat(64)] })
  ];
  for (const assessor of rejections) {
    await assert.rejects(assessor.assess({ frames, captureId }), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  }
});

test('issuer evidence is accepted only with a valid signature and capture hash', async () => {
  const verify = (result, signer) => createRegistrationVerifier({
    endpoint: 'http://127.0.0.1:8001/verify',
    secret: verifierSecret,
    fetchImpl: async () => {
      const body = JSON.stringify(result);
      return new Response(body, { headers: {
        'X-Registration-Verifier-Signature': createHmac('sha256', signer).update(body).digest('hex')
      } });
    }
  }).verify({ frames, captureId });
  const result = { captureId, framesSha256: approval.framesSha256, status: 'approved' };
  assert.deepEqual(await verify(result, verifierSecret), result);
  await assert.rejects(verify(result, secret), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  await assert.rejects(verify({ ...result, framesSha256: ['0'.repeat(64)] }, verifierSecret),
    { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
});

test('signed research, inconclusive and incomplete fraud results cannot approve enrollment', async () => {
  for (const result of [
    { ...approval, purpose: 'document_fraud_research', documentFraudScores: [0.001] },
    { ...approval, purpose: 'document_fraud_research', assessment: 'review',
      documentFraudScores: [0.999], monitorRecaptureSpectralPeak: 50, searchInterfaceDetected: false },
    { ...approval, purpose: 'document_capture_signals', assessment: 'review' },
    { ...approval, assessment: 'review' },
    { ...approval, checks: { ...checks, monitorRecapture: 'uncertain' } },
    { ...approval, checks: { imageReuse: 'clear' } }
  ]) {
    const assessment = await client(result).assess({ frames, captureId });
    assert.equal(assessment.cleared, false);
    assert.equal(assessment.screening.classification, 'UNABLE_TO_ASSESS');
    assert.equal(assessment.screening.decision, 'REVIEW_REQUIRED');
    assert.notEqual(assessment.retake, true);
    assert.notEqual(assessment.screenReplay, true);
  }
});

test('only an explicit capture-quality result requests a retake', async () => {
  const assessment = await client({
    ...approval, purpose: 'document_capture_signals', assessment: 'retake'
  }).assess({ frames, captureId });
  assert.equal(assessment.cleared, false);
  assert.equal(assessment.retake, true);
  assert.equal(assessment.screening.classification, 'UNABLE_TO_ASSESS');
  assert.equal(assessment.screening.decision, 'RETAKE_REQUIRED');
});

test('a fraud client with a missing endpoint or shared verifier key is unavailable', async () => {
  for (const options of [
    { endpoint: '', secret, verifierSecret },
    { endpoint: 'http://127.0.0.1:8001/assess', secret, verifierSecret: secret },
    { endpoint: 'https://fixture.invalid/assess', secret, verifierSecret }
  ]) {
    const assessor = createFraudAssessmentClient(options);
    assert.equal(assessor.available, false);
    await assert.rejects(assessor.assess({ frames, captureId }), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  }
  assert.equal(createRegistrationVerifier({ endpoint: 'https://fixture.invalid/verify', secret: verifierSecret }).available, false);
});

test('only a trusted, capture-bound fraud flag produces a suspicious-image result', async () => {
  const flagged = { ...approval, assessment: 'flagged', checks: { ...checks, monitorRecapture: 'flagged' } };
  const suspicious = await client(flagged).assess({ frames, captureId });
  assert.equal(suspicious.cleared, false);
  assert.equal(suspicious.screening.classification, 'SUSPICIOUS');
  assert.deepEqual(suspicious.screening.indicators, ['Possible screen recapture.']);
  const strong = await client({ ...flagged, classification: 'POTENTIALLY_FAKE' }).assess({ frames, captureId });
  assert.equal(strong.cleared, false);
  assert.equal(strong.screening.classification, 'POTENTIALLY_FAKE');
  assert.equal(strong.screening.decision, 'REVIEW_REQUIRED');
  const clearedWithWarning = await client({
    ...approval,
    advisory: {
      classification: 'POTENTIALLY_FAKE',
      indicators: ['digitalManipulation']
    }
  }).assess({ frames, captureId });

  assert.equal(clearedWithWarning.cleared, false);
  assert.equal(clearedWithWarning.screening.classification, 'POTENTIALLY_FAKE');
  assert.equal(clearedWithWarning.screening.decision, 'REVIEW_REQUIRED');
  assert.deepEqual(
    clearedWithWarning.screening.indicators,
    ['Possible digital editing.']
  );
  await assert.rejects(client(flagged, verifierSecret).assess({ frames, captureId }), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  const research = await client({ ...flagged, classification: 'POTENTIALLY_FAKE', purpose: 'document_fraud_research' }).assess({ frames, captureId });
  assert.equal(research.cleared, false);
  assert.equal(research.screening.classification, 'UNABLE_TO_ASSESS');
});
