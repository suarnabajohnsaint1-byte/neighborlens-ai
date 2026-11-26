const { createHmac, randomBytes } = require('node:crypto');
const { ConflictError, ForbiddenError, ValidationError } = require('../../domain/errors');
const { comparableFacts, normalizedValue, verifiedFacts } = require('./enrollmentFacts');

const REVIEW_WINDOW_MS = 48 * 60 * 60_000;
const ACTIVATION_WINDOW_MS = 15 * 60_000;
const CHECKS = ['issuerEvidenceChecked', 'holderPresentAndMatched', 'physicalOriginalInspected',
  'liveCaptureObserved', 'fraudChecksClear'];
const REJECT_REASONS = new Set(['invalid_document', 'holder_mismatch']);

function createCitizenEnrollmentReview({ repository, audit, fingerprintKey, reviewerIds, keyUsed, documentUsed, clock = Date.now }) {
  const ids = new Set(String(reviewerIds || '').split(',').map(id => id.trim()).filter(id => /^[1-9]\d*$/.test(id)));
  const digest = (scope, value) => createHmac('sha256', fingerprintKey).update(scope + '\0').update(value).digest('hex');
  const invalidProof = () => new ForbiddenError('This review application is no longer available.', { code: 'REGISTRATION_PROOF_REQUIRED' });
  const duplicate = () => new ConflictError('This document or capture is already associated with an account.',
    { code: 'REGISTRATION_ID_ALREADY_USED' });
  const factsDigest = (reference, facts) => digest('review-facts', JSON.stringify([reference, comparableFacts(facts)]));
  const documentKey = facts => digest('document', JSON.stringify([facts.documentType, normalizedValue('idNumber', facts.idNumber)]));

  function authorize(user) {
    if (user?.role !== 'admin' || !ids.has(String(user.id))) throw new ForbiddenError('Enrollment reviewer access is required.');
    if (typeof fingerprintKey !== 'string' || fingerprintKey.length < 32) throw invalidProof();
  }

  async function find(token) {
    if (typeof fingerprintKey !== 'string' || fingerprintKey.length < 32 ||
        !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw invalidProof();
    const row = await repository.findByToken(digest('review-token', token));
    if (!row || row.expires_at <= clock() || row.state === 'used') throw invalidProof();
    return row;
  }

  return {
    available: ids.size > 0,
    documentKey,
    async submit({ token, boundaryVersion, screening, imageKeys }) {
      if (await keyUsed(imageKeys)) throw duplicate();
      const reference = randomBytes(12).toString('hex');
      const now = clock();
      const expiresAt = now + REVIEW_WINDOW_MS;
      await repository.create({ reference, tokenKey: digest('review-token', token), boundaryVersion,
        classification: screening?.classification || 'UNABLE_TO_ASSESS', imageKeys, expiresAt, now });
      return { decision: 'REVIEW_REQUIRED', reference, screening, expiresAt };
    },
    async status(token) {
      const row = await find(token);
      return {
        state: row.state, reference: row.reference, expiresAt: Number(row.expires_at),
        screening: { classification: row.screening }
      };
    },
    async queue(user, after = 0) {
      authorize(user);
      if (!/^\d{1,10}$/.test(String(after))) throw new ValidationError('Invalid enrollment queue cursor.');
      return repository.list(clock(), Number(after));
    },
    async decide(user, reference, input) {
      authorize(user);
      if (!/^[a-f0-9]{24}$/.test(reference || '')) throw new ValidationError('Invalid enrollment review reference.');
      let factsKey = null;
      let subjectKey = null;
      const now = clock();
      const state = input?.decision;
      let details;
      if (state === 'approved') {
        const facts = verifiedFacts(input.facts, now);
        // These opaque references point to the authorized operator's records. They contain no document numbers.
        if (!facts || !CHECKS.every(check => input.checks?.[check] === true) ||
            !/^[A-Za-z0-9_-]{20,128}$/.test(input.subjectReference || '') ||
            !/^[A-Za-z0-9_-]{20,128}$/.test(input.evidenceReference || '')) {
          throw new ValidationError('Approval requires valid document facts, all in-person checks, and independent evidence references.');
        }
        factsKey = factsDigest(reference, facts);
        subjectKey = digest('subject', input.subjectReference);
        if (await keyUsed([subjectKey, documentKey(facts)]) || await documentUsed(facts)) throw duplicate();
        details = { method: 'in_person', evidence_key: digest('review-evidence', input.evidenceReference) };
      } else if (state === 'rejected' && REJECT_REASONS.has(input.reason)) {
        details = { reason: input.reason };
      } else {
        throw new ValidationError('Invalid enrollment review decision.');
      }
      const updated = await repository.decide({ reference, state, factsKey, subjectKey, now,
        classification: state === 'rejected' && input.reason === 'invalid_document' ? 'INVALID' : null,
        decisionExpiresAt: now + (state === 'approved' ? ACTIVATION_WINDOW_MS : REVIEW_WINDOW_MS) },
        (id, tx) => audit(user.id, state === 'approved' ? 'approve' : 'reject', 'citizen_enrollment_review', id, tx, details));
      if (!updated) throw new ConflictError('This application is no longer pending.');
      return { state };
    },
    async approved(token, boundaryVersion, identity) {
      const row = await find(token);
      if (row.state !== 'approved') throw invalidProof();
      if (row.boundary_version !== boundaryVersion) throw invalidProof();
      const facts = verifiedFacts(identity, clock());
      if (!facts || factsDigest(row.reference, facts) !== row.facts_key) {
        throw new ValidationError('Entered ID details must match the document reviewed in person.');
      }
      if (await documentUsed(facts)) throw duplicate();
      const keys = [row.subject_key, documentKey(facts), ...JSON.parse(row.frame_keys)].sort();
      return { facts, keys, reviewId: row.id };
    }
  };
}

module.exports = { createCitizenEnrollmentReview };
