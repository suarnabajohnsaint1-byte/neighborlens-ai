const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const test = require('node:test');
const { createFraudAssessmentClient, createRegistrationVerifier } = require('../infrastructure/adapters/registrationVerifier');

const secret = 'isolated-fraud-test-secret-at-least-32';
const verifierSecret = 'isolated-verifier-test-secret-at-least-32';
const captureId = 'c'.repeat(32);
const frames = [Buffer.from('fixture-one'), Buffer.from('fixture-two')];
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
    client({ ...approval, framesSha256: [...approval.framesSha256].reverse() }),
    client({ ...approval, framesSha256: approval.framesSha256.slice(0, 1) })
  ];
  for (const assessor of rejections) {
    await assert.rejects(assessor.assess({ frames, captureId }), { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
  }
});

test('signed research, inconclusive and incomplete fraud results cannot approve enrollment', async () => {
  for (const result of [
    { ...approval, purpose: 'document_fraud_research', tamperingScores: [0.001, 0.002] },
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
