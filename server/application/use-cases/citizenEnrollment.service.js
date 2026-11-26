const { canAutofillIdFields, canPreviewUnverifiedIdFields } = require('../../domain/identity/ocrPrefillPolicy');
const { createHmac, randomBytes } = require('node:crypto');
const { inspect } = require('../../../shared/geoContainment');
const { isFreshGpsFix, JurisdictionStatus } = require('../../domain/geofencing/geofence.rules');
const { enrollmentDocumentType } = require('../../../shared/identityDocumentPolicy');
const { screeningResult, captureRetakeScreening } = require('../../domain/identity/idScreening');
const { AppError, ErrorKind, ConflictError, ForbiddenError, ValidationError } = require('../../domain/errors');
const { verifiedFacts, comparableFacts, normalizedValue } = require('./enrollmentFacts');

const CAPTURE_WINDOW_MS = 2 * 60_000;
const APPROVAL_WINDOW_MS = 10 * 60_000;
const MAX_SESSIONS = 250;
const CONCLUSIVE_REJECTIONS = new Set(['revoked_document', 'issuer_data_mismatch', 'confirmed_counterfeit']);

function reviewRequired() {
  return new AppError('This ID requires additional review. No account was created.',
    ErrorKind.UNPROCESSABLE, { code: 'REGISTRATION_ID_REVIEW_REQUIRED', decision: 'REVIEW_REQUIRED' });
}

function retakeRequired(message, captureIssue = 'CAPTURE_QUALITY') {
  const error = new ValidationError(message, { code: 'REGISTRATION_ID_RETAKE_REQUIRED', decision: 'RETAKE_REQUIRED' });
  error.captureIssue = captureIssue;
  return error;
}

function checkPosition(position, boundary, now, maxAccuracy, allowOutsideScan = false) {
  const { latitude, longitude, accuracy, timestamp } = position || {};
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > maxAccuracy ||
    !isFreshGpsFix(timestamp, now)) {
    throw new ValidationError('Get a fresh, more accurate location before continuing.', { code: 'REGISTRATION_LOCATION_RETRY' });

  }

  const location = inspect(latitude, longitude, boundary);
  if (!location || location.edgeMeters <= accuracy) {
    throw new ValidationError('Location is uncertain. Move away from the city boundary and retry.', { code: 'REGISTRATION_LOCATION_RETRY' });
  }
  if (!location.inside && !allowOutsideScan) {
    throw new ForbiddenError('Citizen registration is available within Bacolod City.', { code: 'REGISTRATION_OUTSIDE_BACOLOD' });
  }
  return location.inside;
}

function addressBarangays(address, names) {
  const normalize = text => text.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const normalized = normalize(address);
  if (!/\b(?:CITY OF BACOLOD|BACOLOD (?:CITY|NEGROS OCCIDENTAL|NEG OCC))\b/.test(normalized)) return [];
  return names.filter(name => {
    const label = normalize(name);
    const pattern = label.match(/^BARANGAY (\d+)$/)
      ? `(?:BARANGAY|BRGY|BGY) (?:NO )?0*${label.slice(9)}` : label;
    return new RegExp(`(?:^| )${pattern}(?: |$)`).test(normalized);
  });
}

function createCitizenEnrollment({ loadBoundary, resolveJurisdiction, findBarangayByName, verifier, fraudAssessor, normalizeFrame, verificationUnavailable,
  fingerprintKey, keyUsed, documentUsed, manualReview, knownReplay, basicRegistrationEnabled = false,
  queueManualReview = Boolean(manualReview), allowOutsideScan = false, maxAccuracy = 100, clock = Date.now }) {
  const sessions = new Map();
  let boundaryPromise;
  const digest = (scope, value) => createHmac('sha256', fingerprintKey).update(scope + '\0').update(value).digest('hex');
  const documentKey = (facts, scope = 'document') => digest(scope, JSON.stringify([facts.documentType, normalizedValue('idNumber', facts.idNumber)]));
  const fraudUnavailable = () => new AppError('The ID fraud check is temporarily unavailable.',
    ErrorKind.PROVIDER_UNAVAILABLE, { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });

  async function confirmResidence(position, selected, facts, geometry) {
    if (!resolveJurisdiction) return null;
    const names = addressBarangays(facts.address, geometry.barangayNames);
    if (names.length !== 1) {
      throw new ValidationError('Use a government ID with a readable address showing Bacolod City and your barangay.',
        { code: 'REGISTRATION_ID_ADDRESS_UNCONFIRMED' });
    }
    const jurisdiction = await resolveJurisdiction(position);
    if (jurisdiction.status === JurisdictionStatus.AUTHORITATIVE_POLYGONS_PENDING) {
      throw new AppError('Barangay boundary verification is currently unavailable.', ErrorKind.PROVIDER_UNAVAILABLE,
        { code: 'REGISTRATION_LOCATION_UNAVAILABLE' });
    }
    if (!jurisdiction.barangayId) {
      throw new ValidationError('Your current GPS position could not confirm a barangay boundary. Retry from inside your barangay.',
        { code: 'REGISTRATION_LOCATION_RETRY' });
    }
    const [idAddressBarangay, selectedBarangay] = await Promise.all([
      findBarangayByName(names[0]), findBarangayByName(typeof selected === 'string' ? selected.trim() : '')
    ]);
    if (!idAddressBarangay || !selectedBarangay || Number(idAddressBarangay.id) !== Number(jurisdiction.barangayId) ||
        Number(selectedBarangay.id) !== Number(jurisdiction.barangayId)) {
      throw new ForbiddenError('The ID address, selected barangay and current GPS location must be in the same barangay.',
        { code: 'REGISTRATION_BARANGAY_MISMATCH' });
    }
    return { id: jurisdiction.barangayId, name: jurisdiction.boundary.name,
      cityVersion: geometry.boundaryVersion, barangayVersion: jurisdiction.boundary.version };
  }

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
    isScanTestEnabled: () => allowOutsideScan,
    assertCaptureSession(token) {
      active(token, 'capture');
    },
    async start(position) {
      const geometry = await boundary();
      const now = clock();
      const insideBacolod = allowOutsideScan && position === null
        ? false : checkPosition(position, geometry, now, maxAccuracy, allowOutsideScan);
      if (fraudAssessor && !fraudAssessor.available) throw fraudUnavailable();
      if ((!fraudAssessor && !verifier.available && !manualReview) ||
        typeof fingerprintKey !== 'string' || fingerprintKey.length < 32) throw verificationUnavailable();
      if (sessions.size >= MAX_SESSIONS) throw verificationUnavailable();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now + CAPTURE_WINDOW_MS;
      save(token, { state: 'capture', expiresAt, outsideBacolodTest: !insideBacolod });
      return { token, expiresAt, boundaryVersion: geometry.boundaryVersion };
    },
    async capture({ token, position, frames }) {
      const session = active(token, 'capture');
      const geometry = await boundary();
      const insideBacolod = allowOutsideScan && session.outsideBacolodTest && position === null
        ? false : checkPosition(position, geometry, clock(), maxAccuracy, allowOutsideScan);
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
        if (await keyUsed(imageKeys)) {
          throw new ConflictError('This document or capture is already associated with an account.',
            { code: 'REGISTRATION_ID_ALREADY_USED' });
        }
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

        if (knownReplay?.(normalizedFrame)) {
          screening = screeningResult('SUSPICIOUS', ['An exact match to a known replay sample was found.'],
            [...(screening?.checks || []), 'Exact replay fingerprint']);
          throw retakeRequired('This photo matches a known reused image. Retake it with the live camera.', 'KNOWN_IMAGE_REPLAY');
        }
        if (fraud?.retake) {
          throw retakeRequired('Capture a clearer image of the physical ID.');
        }
        if (fraud?.screenReplay) {
          throw retakeRequired('A search image appears in the photo. Scan the physical ID directly.', 'SCREEN_INTERFACE');
        }
        const scanTest = session.outsideBacolodTest || !insideBacolod;
        if (scanTest || (!verifier.available && basicRegistrationEnabled)) {
          if (['SUSPICIOUS', 'POTENTIALLY_FAKE'].includes(screening?.classification)) {
            throw retakeRequired('Screening flagged possible manipulation. Retake the ID photo with the live camera.', 'SCREENING_WARNING');
          }
          if (!fraud?.basicCapture) throw fraudUnavailable();
          const document = fraud.basicCapture.document;
          if (!document) throw retakeRequired('The ID number could not be read reliably. Retake the photo with the number fully visible.', 'ID_NUMBER_UNREADABLE');
          const limitedDocumentKey = documentKey(document, 'limited-document');
          const keys = [limitedDocumentKey, digest('limited-frame', normalizedFrame)].sort();
          if (await keyUsed([...keys, documentKey(document)]) || await documentUsed?.(document)) {
            throw new ConflictError('This document or capture is already associated with an account.',
              { code: 'REGISTRATION_ID_ALREADY_USED' });
          }
          active(token, 'processing');
          if (scanTest) {
            sessions.delete(token);
            return {
              decision: 'VERIFICATION_REQUIRED',
              verificationReason: 'OUTSIDE_BACOLOD_TEST',
              screening,
              ocrPrefillAllowed: true
            };
          }
          const expiresAt = clock() + APPROVAL_WINDOW_MS;
          save(token, { state: 'basic', expiresAt, keys, limitedDocumentKey });
          return { decision: 'BASIC_REGISTRATION_ELIGIBLE', expiresAt, screening, ocrPrefillAllowed: true };
        }
        const canQueueReview = queueManualReview && manualReview && screening?.classification !== 'UNABLE_TO_ASSESS';

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
            ocrPrefillAllowed: false
          };
        };

        const needsFraudReview =
          Boolean(fraudAssessor) && fraud?.cleared !== true;

        function unverified(verificationReason) {
          active(token, 'processing');
          sessions.delete(token);
          return {
            decision: 'VERIFICATION_REQUIRED',
            verificationReason,
            screening,
            ocrPrefillAllowed: Boolean(fraud && canPreviewUnverifiedIdFields(screening))
          };
        }

        if (!verifier.available) {
          if (canQueueReview) return await pending();
          return unverified('VERIFIER_NOT_CONFIGURED');
        }

        let result;

        try {
          result = await verifier.verify({
            frames: normalized,
            captureId
          });
        } catch (error) {
          if (error.code === 'REGISTRATION_VERIFICATION_UNAVAILABLE') {
            return canQueueReview ? await pending() : unverified('VERIFIER_UNAVAILABLE');
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
          if (canQueueReview) return await pending();
          return unverified(needsFraudReview ? 'SCREENING_UNCLEARED' : 'VERIFIER_NOT_APPROVED');
        }

        const subjectKey = digest('subject', result.subject.trim());
        const keys = [subjectKey, documentKey(facts), ...imageKeys].sort();

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

        const approval = {
          decision: 'VERIFIED',
          screening: screening || screeningResult('LOW_RISK', [], Object.keys(result.fraudScreening)),
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
        return { ...approval, ocrPrefillAllowed: canAutofillIdFields(approval) };
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
          error.screening = screening;
          if (error.decision === 'RETAKE_REQUIRED') {
            error.screening = error.captureIssue === 'CAPTURE_QUALITY' || !screening
              ? captureRetakeScreening(error.message)
              : { ...screening, decision: 'RETAKE_REQUIRED' };
          }
        }

        throw error;
      }

    },
    async enroll({ token, position, identity, barangay }, persist) {
      const state = sessions.get(token)?.state === 'basic' ? 'basic' : 'approved';
      if (!manualReview || !/^[A-Za-z0-9_-]{43}$/.test(token || '') || sessions.has(token)) active(token, state);
      const geometry = await boundary();
      checkPosition(position, geometry, clock(), maxAccuracy);
      if (manualReview && !sessions.has(token)) {
        const approval = await manualReview.approved(token, geometry.boundaryVersion, identity);
        return persist({ ...approval, residence: await confirmResidence(position, barangay, approval.facts, geometry) });
      }
      const session = active(token, state);
      const facts = verifiedFacts(identity, clock());
      const limited = state === 'basic';
      if (limited && (!facts || documentKey(facts, 'limited-document') !== session.limitedDocumentKey)) {
        throw new ValidationError('Enter complete ID details and use the ID number from the capture.');
      }
      if (!limited && (!facts || comparableFacts(facts).some((value, index) => value !== session.comparable[index]))) {
        throw new ValidationError('Reviewed ID details must match the verified document.');
      }
      session.state = 'enrolling';
      try {
        const residence = await confirmResidence(position, barangay, limited ? facts : session.facts, geometry);
        const result = await persist({
          keys: session.keys, limited, residence,
          facts: limited ? { ...facts, documentValidationStatus: 'needs_review', ocrConfidence: null }
            : { ...session.facts, ocrConfidence: facts.ocrConfidence }
        });
        sessions.delete(token);
        return result;
      } catch (error) {
        session.state = state;
        throw error;
      }
    }
  };
}

module.exports = { createCitizenEnrollment };
