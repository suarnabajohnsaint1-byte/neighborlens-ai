'use strict';

function canAutofillIdFields(result) {
  return result?.decision === 'VERIFIED' && result.screening?.classification === 'LOW_RISK';
}

function canPreviewUnverifiedIdFields(screening) {
  return screening?.classification === 'LOW_RISK' ||
    (screening?.classification === 'UNABLE_TO_ASSESS' &&
      Array.isArray(screening.checks) && screening.checks.includes('Image sharpness'));
}

module.exports = { canAutofillIdFields, canPreviewUnverifiedIdFields };
