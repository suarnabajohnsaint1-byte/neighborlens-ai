(function (root, factory) {
    const commonJS = typeof module === 'object' && module.exports;
    const api = factory();
    if (commonJS) module.exports = api;
    else root.CitizenSeverityPresentation = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function renderSeverity(result, escapeHtml) {
        const suggestion = result.severitySuggestion;
        const measured = suggestion?.source === 'approved_measurement_rule'
            ? { MINOR: 'Minor', MAJOR: 'Major' }[suggestion.classification] : null;
        const basis = measured ? 'AI suggestion · Validated measurements · policy ' + suggestion.policyVersion
            : result.severityReason === 'CONFLICTING_SEVERITY' ? 'The two views disagree on severity.' : 'Insufficient severity evidence.';
        return `<p class="citizen-assessment-note" aria-live="polite"><span>Damage severity:</span>
                <strong data-damage-severity>${measured || 'Not assessed'}</strong></p>
            <p class="citizen-assessment-note"><span>Severity basis:</span> <span data-severity-basis>${escapeHtml(basis)}</span></p>`;
    }

    return { renderSeverity };
});
