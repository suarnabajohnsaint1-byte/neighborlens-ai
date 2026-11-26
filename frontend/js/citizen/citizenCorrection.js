(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../../shared/reportVocabulary') : root.ReportVocabulary);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CitizenCorrection = api;
})(typeof self !== 'undefined' ? self : this, function (vocabulary) {
  'use strict';

  function empty(generation = 0) {
    return { generation, category: null, manual: false, suggestion: null, suggestedClass: null, provisional: false, categories: vocabulary.AI_REPORT_CATEGORIES.slice(), proofs: [], ready: false };
  }

  function assess(state, generation, result) {
    if (generation !== state.generation) return state;
    const photos = result.photos || [];
    const categories = vocabulary.AI_REPORT_CATEGORIES.slice();
    const proofs = photos.map(photo => photo.assessmentProof);
    const ready = result.submittable && photos.length === 2 && proofs.every(proof => typeof proof === 'string' && proof.length) && categories.length === 3;
    const provisional = result.submittable && Boolean(result.suggestion);
    const suggestedClass = provisional ? result.suggestion.canonicalClass : result.detected ? result.canonicalClass : null;
    const suggestion = vocabulary.reportCategoryFor(suggestedClass);
    const category = state.manual ? state.category : (provisional || (ready && result.detected)) ? suggestion : null;
    return { ...state, suggestion, suggestedClass, provisional, category, categories, proofs, ready };
  }

  function select(state, category) {
    if (category === '') return { ...state, category: null, manual: true };
    if (!state.categories.includes(category)) throw new Error('Invalid citizen report category.');
    return { ...state, category, manual: true };
  }

  function submission(state) {
    return { ...(state.category ? { citizenCategory: state.category } : {}), ...(state.ready ? { assessmentProofs: state.proofs.slice() } : {}) };
  }

  function explanation(state) {
    if (state.provisional && !state.manual) return 'Suggested from both photos. You can change it before sending for Barangay review.';
    if (!state.ready) return state.category ? 'Citizen-selected category; no original AI assessment recorded.' : '';
    if (state.category && state.suggestion && state.category !== state.suggestion) return `Citizen correction; original AI suggestion: ${state.suggestion}.`;
    if (state.manual && !state.suggestion) return 'Citizen-selected category; no AI category was confirmed.';
    return '';
  }

  return { empty, assess, select, submission, explanation };
});
