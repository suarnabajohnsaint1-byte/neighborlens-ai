const { canAutofillIdFields } = require('../../domain/identity/ocrPrefillPolicy');
const { createHmac, randomBytes, randomInt } = require('node:crypto');
const { inspect } = require('../../../shared/geoContainment');
const { enrollmentDocumentType } = require('../../../shared/identityDocumentPolicy');
const { screeningResult, captureRetakeScreening } = require('../../domain/identity/idScreening');
const { AppError, ErrorKind, ConflictError, ForbiddenError, ValidationError } = require('../../domain/errors');
const { verifiedFacts, comparableFacts } = require('./enrollmentFacts');

const CAPTURE_WINDOW_MS = 2 * 60_000;
const APPROVAL_WINDOW_MS = 10 * 60_000;
const MAX_POSITION_AGE_MS = 30_000;
const MAX_SESSIONS = 250;
const CHALLENGES = ['tilt-left', 'tilt-right'];
const CONCLUSIVE_REJECTIONS = new Set(['revoked_document', 'issuer_data_mismatch', 'confirmed_counterfeit']);

function reviewRequired() {
  return new AppError('This ID requires additional review. No account was created.',
    ErrorKind.UNPROCESSABLE, { code: 'REGISTRATION_ID_REVIEW_REQUIRED', decision: 'REVIEW_REQUIRED' });
}

function retakeRequired(message) {
  return new ValidationError(message, { code: 'REGISTRATION_ID_RETAKE_REQUIRED', decision: 'RETAKE_REQUIRED' });
}

function checkPosition(position, boundary, now, maxAccuracy) {
  const { latitude, longitude, accuracy, timestamp } = position || {};
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > maxAccuracy ||
    !Number.isFinite(timestamp) || now - timestamp > MAX_POSITION_AGE_MS || timestamp - now > 5_000) {
    throw new ValidationError('Get a fresh, more accurate location before continuing.', { code: 'REGISTRATION_LOCATION_RETRY' });
  }
  const location = inspect(latitude, longitude, boundary);
  if (!location || location.edgeMeters <= accuracy) {
    throw new ValidationError('Location is uncertain. Move away from the city boundary and retry.', { code: 'REGISTRATION_LOCATION_RETRY' });
  }
  if (!location.inside) {
    throw new ForbiddenError('Citizen registration is available within Bacolod City.', { code: 'REGISTRATION_OUTSIDE_BACOLOD' });
  }
}

function createCitizenEnrollment({ loadBoundary, verifier, fraudAssessor, normalizeFrame, verificationUnavailable,
  fingerprintKey, keyUsed, documentUsed, manualReview, maxAccuracy = 100, clock = Date.now }) {
  const sessions = new Map();
  let boundaryPromise;
  const digest = (scope, value) => createHmac('sha256', fingerprintKey).update(scope + '\0').update(value).digest('hex');
  const fraudUnavailable = () => new AppError('The ID fraud check is temporarily unavailable.',
    ErrorKind.PROVIDER_UNAVAILABLE, { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });

  async function boundary() {
    boundaryPromise ??= Promise.resolve().then(loadBoundary).then(value => {
      if (!inspect(0, 0, value)) throw new Error();
      return value;
    }).catch(() => {
      boundaryPromise = undefined;
      throw new AppError('Bacolod location verification is unavailable.', ErrorKind.PROVIDER_UNAVAILABLE,
        { code: 'REGISTRATION_LOCATION_UNAVAILABLE' });
    });
    return boundaryPromise;
  }

  function active(token, state) {
    const session = typeof token === 'string' ? sessions.get(token) : null;
    if (!session || session.state !== state || session.expiresAt <= clock()) {
      throw new ForbiddenError('Start a new live ID verification session.', { code: 'REGISTRATION_PROOF_REQUIRED' });
    }
    return session;
  }

  function save(token, session) {
    sessions.set(token, session);
    const cleanup = setTimeout(() => {
      if (sessions.get(token) === session) sessions.delete(token);
    }, Math.max(0, session.expiresAt - clock()));
    cleanup.unref();
  }

  return {
    assertCaptureSession(token) {
      active(token, 'capture');
    },
    async start(position) {
      const geometry = await boundary();
      const now = clock();
      checkPosition(position, geometry, now, maxAccuracy);
      if (fraudAssessor && !fraudAssessor.available) throw fraudUnavailable();
      if ((!fraudAssessor && !verifier.available && !manualReview) ||
        typeof fingerprintKey !== 'string' || fingerprintKey.length < 32) throw verificationUnavailable();
      if (sessions.size >= MAX_SESSIONS) throw verificationUnavailable();
      const token = randomBytes(32).toString('base64url');
      const challenge = CHALLENGES[randomInt(CHALLENGES.length)];
      const expiresAt = now + CAPTURE_WINDOW_MS;
      save(token, { state: 'capture', challenge, expiresAt });
      return { token, challenge, expiresAt, boundaryVersion: geometry.boundaryVersion };
    },
    async capture({ token, position, frames }) {
      const session = active(token, 'capture');
      const geometry = await boundary();
      checkPosition(position, geometry, clock(), maxAccuracy);
      active(token, 'capture');
      session.state = 'processing';
      let screening;


      try {
        if (!Array.isArray(frames) || frames.length !== 1) {
          throw retakeRequired('Exactly one ID image is required.');
        }

        let normalizedFrame;

        try {
          normalizedFrame = await normalizeFrame(frames[0]);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw retakeRequired(error.message);
          }
          throw error;
        }

        const normalized = [normalizedFrame];
        const imageKeys = [digest('frame', normalizedFrame)];
        const captureId = randomBytes(24).toString('base64url');

        let fraud;

        try {
          fraud = await fraudAssessor?.assess({
            frames: normalized,
            captureId
          });
        } catch (error) {
          if (error.code === 'REGISTRATION_VERIFICATION_UNAVAILABLE') {
            screening = screeningResult(
              'UNABLE_TO_ASSESS',
              ['The local fraud screening service is unavailable.'],
              []
            );
            throw fraudUnavailable();
          }

          throw error;
        }

        screening = fraud?.screening;

        if (fraud?.retake) {
          throw retakeRequired('Capture a clearer image of the physical ID.');
        }

        const pending = async () => {
          if (!manualReview || !fraud || !geometry.boundaryVersion) {
            throw reviewRequired();
          }

          active(token, 'processing');

          const application = await manualReview.submit({
            token,
            boundaryVersion: geometry.boundaryVersion,
            screening,
            imageKeys
          });

          sessions.delete(token);

          return {
            ...application,
            ocrPrefillAllowed: canAutofillIdFields(screening)
          };
        };

        const needsFraudReview =
          Boolean(fraudAssessor) && fraud?.cleared !== true;

        if (!verifier.available) {
          if (manualReview) {
            return await pending();
          }

          throw needsFraudReview
            ? reviewRequired()
            : verificationUnavailable();
        }

        let result;

        try {
          result = await verifier.verify({
            frames: normalized,
            challenge: session.challenge,
            captureId
          });
        } catch (error) {
          if (
            manualReview &&
            error.code === 'REGISTRATION_VERIFICATION_UNAVAILABLE'
          ) {
            return await pending();
          }

          throw error;
        }

        if (result?.captureId !== captureId) {
          throw verificationUnavailable();
        }

        const rejectedType = enrollmentDocumentType(result.documentType);

        if (
          result.status === 'rejected' &&
          rejectedType &&
          (
            CONCLUSIVE_REJECTIONS.has(result.reason) ||
            (
              rejectedType === 'PHILSYS' &&
              result.reason === 'invalid_qr_signature'
            )
          )
        ) {
          throw new AppError(
            'The verifier found that this ID is invalid. Registration is blocked for this capture.',
            ErrorKind.UNPROCESSABLE,
            {
              code: result.reason === 'confirmed_counterfeit'
                ? 'REGISTRATION_ID_COUNTERFEIT'
                : 'REGISTRATION_ID_INVALID',
              decision: 'BLOCK_INVALID'
            }
          );
        }

        if (result.status === 'retake_required') {
          throw retakeRequired(
            'Capture a clearer image of the ID and try again.'
          );
        }

        const facts = verifiedFacts(result?.facts, clock());

        if (
          needsFraudReview ||
          result.status !== 'approved' ||
          result.issuerVerified !== true ||
          result.holderVerified !== true ||
          result.liveCapturePassed !== true ||
          result.fraudScreening?.monitorRecapture !== 'clear' ||
          result.fraudScreening?.digitalManipulation !== 'clear' ||
          result.fraudScreening?.imageReuse !== 'clear' ||
          typeof result.subject !== 'string' ||
          !result.subject.trim() ||
          result.subject.length > 200 ||
          !facts
        ) {
          if (manualReview) {
            return await pending();
          }

          throw reviewRequired();
        }

        const subjectKey = digest('subject', result.subject.trim());
        const keys = [subjectKey, ...imageKeys];

        if (manualReview) {
          keys.push(manualReview.documentKey(facts));
        }

        keys.sort();

        if (await keyUsed(keys) || await documentUsed?.(facts)) {
          throw new ConflictError(
            'This document or capture is already associated with an account.',
            {
              code: 'REGISTRATION_ID_ALREADY_USED'
            }
          );
        }

        active(token, 'processing');

        const expiresAt = clock() + APPROVAL_WINDOW_MS;

        save(token, {
          state: 'approved',
          expiresAt,
          facts,
          keys,
          comparable: comparableFacts(facts)
        });

        const {
          documentType: verifiedType,
          idNumber,
          fullName,
          birthDate,
          address,
          expiryDate
        } = facts;

        return {
          decision: 'VERIFIED',
          screening,
          expiresAt,
          facts: {
            documentType: verifiedType,
            idNumber,
            fullName,
            birthDate,
            address,
            expiryDate
          }
        };
      } catch (error) {
        sessions.delete(token);

        if (error.code === 'ER_NO_SUCH_TABLE') {
          throw new AppError(
            'Enrollment storage is unavailable.',
            ErrorKind.PROVIDER_UNAVAILABLE,
            {
              code: 'REGISTRATION_STORAGE_UNAVAILABLE'
            }
          );
        }

        if (error instanceof AppError) {
          error.screening =
            error.decision === 'RETAKE_REQUIRED'
              ? captureRetakeScreening(error.message)
              : screening;
        }

        throw error;
      }

    },
    async enroll({ token, position, identity }, persist) {
      if (!manualReview || !/^[A-Za-z0-9_-]{43}$/.test(token || '') || sessions.has(token)) active(token, 'approved');
      const geometry = await boundary();
      checkPosition(position, geometry, clock(), maxAccuracy);
      if (manualReview && !sessions.has(token)) {
        return persist(await manualReview.approved(token, geometry.boundaryVersion, identity));
      }
      const session = active(token, 'approved');
      const facts = verifiedFacts(identity, clock());
      if (!facts || comparableFacts(facts).some((value, index) => value !== session.comparable[index])) {
        throw new ValidationError('Reviewed ID details must match the verified document.');
      }
      session.state = 'enrolling';
      try {
        const result = await persist({ ...session, facts: { ...session.facts, ocrConfidence: facts.ocrConfidence } });
        sessions.delete(token);
        return result;
      } catch (error) {
        session.state = 'approved';
        throw error;
      }
    }
  };
}

module.exports = { createCitizenEnrollment };
