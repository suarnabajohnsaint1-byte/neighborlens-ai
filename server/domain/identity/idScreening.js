const DECISION = Object.freeze({
  LOW_RISK: 'PASS_SCREENING',
  SUSPICIOUS: 'REVIEW_REQUIRED',
  POTENTIALLY_FAKE: 'REVIEW_REQUIRED',
  UNABLE_TO_ASSESS: 'REVIEW_REQUIRED'
});

const FRAUD_CHECKS = Object.freeze({
  monitorRecapture: 'Possible screen recapture.',
  digitalManipulation: 'Possible digital editing.',
  imageReuse: 'Possible reuse of an ID image.'
});

function screeningResult(classification, indicators, checks) {
  return { classification, decision: DECISION[classification], indicators, checks };
}

function captureRetakeScreening(message) {
  return {
    ...screeningResult('UNABLE_TO_ASSESS', [message], ['Capture quality']),
    decision: 'RETAKE_REQUIRED'
  };
}

function basicCaptureEvidence(result) {
  if (result.purpose !== 'document_fraud_research' || result.assessment !== 'review' ||
      typeof result.model !== 'string' || !result.model.startsWith('FREUID a31 research (') ||
      !Array.isArray(result.documentFraudScores) || result.documentFraudScores.length !== 1 ||
      !Number.isFinite(result.documentFraudScores[0]) ||
      !Array.isArray(result.laplacianVariance) || result.laplacianVariance.length !== 1 ||
      !Number.isFinite(result.laplacianVariance[0]) || result.laplacianVariance[0] <= 0 ||
      !Object.hasOwn(result, 'captureDocument')) return null;
  const { documentType, idNumber } = result.captureDocument || {};
  const valid = typeof idNumber === 'string' && (
    (documentType === 'DRIVERS_LICENSE' && /^[A-Z][0-9]{10}$/.test(idNumber)) ||
    (documentType === 'PHILSYS' && /^[0-9]{16}$/.test(idNumber))
  );
  return { document: valid ? { documentType, idNumber } : null };
}

function interpretFraudAssessment(result) {
  if (['document_capture_signals', 'document_fraud_research'].includes(result.purpose) && result.assessment === 'retake') {
    return { cleared: false, retake: true, screening: captureRetakeScreening('A camera frame contains no readable detail.') };
  }
  if (['document_capture_signals', 'document_fraud_research'].includes(result.purpose) &&
      result.assessment === 'review' && result.searchInterfaceDetected === true) {
    return { cleared: false, screenReplay: true, screening: screeningResult('SUSPICIOUS',
      ['Search image controls were found in the captured photo.'], ['Visible search interface']) };
  }
  if (result.purpose !== 'registration_fraud_assessment') {
    const localChecks = result.purpose === 'document_capture_signals'
      ? ['Image sharpness']
      : [];
    return {
      basicCapture: basicCaptureEvidence(result),
      cleared: false, screening: screeningResult('UNABLE_TO_ASSESS',
        ['Local image signals do not establish the fraud risk for this ID.'],
        result.purpose === 'document_fraud_research' ? ['Image sharpness', 'Research manipulation model'] : localChecks)
    };
  }
  const completedChecks = Object.keys(FRAUD_CHECKS).filter(check => ['clear', 'flagged', 'uncertain'].includes(result.checks?.[check]));
  const indicators = completedChecks.filter(check => result.checks[check] === 'flagged').map(check => FRAUD_CHECKS[check]);
  if (result.assessment === 'flagged' && indicators.length) {
    const classification = result.classification === 'POTENTIALLY_FAKE' ? 'POTENTIALLY_FAKE' : 'SUSPICIOUS';
    return { cleared: false, screening: screeningResult(classification, indicators, completedChecks) };
  }
  const cleared = result.assessment === 'clear' && Object.keys(FRAUD_CHECKS).every(check => result.checks?.[check] === 'clear');
  const advisoryRisk = result.advisory?.classification;
  const advisoryIndicators = Array.isArray(result.advisory?.indicators) ? Object.keys(FRAUD_CHECKS)
    .filter(check => result.advisory.indicators.includes(check)).map(check => FRAUD_CHECKS[check]) : [];
  if (['SUSPICIOUS', 'POTENTIALLY_FAKE'].includes(advisoryRisk)) {
    return {
      cleared: false,
      screening: screeningResult(
        advisoryRisk,
        advisoryIndicators.length
          ? advisoryIndicators
          : ['Additional fraud indicators require review.'],
        completedChecks
      )
    };
  }
  return {
    cleared, screening: cleared
      ? screeningResult('LOW_RISK', ['No significant fraud indicators were reported by the completed checks.'], completedChecks)
      : screeningResult('UNABLE_TO_ASSESS', ['The available fraud checks did not produce a conclusive result.'], completedChecks)
  };
}

module.exports = { interpretFraudAssessment, screeningResult, captureRetakeScreening };
