const createCitizenSubmissionResult = ({ getAllReports, aiDetailsMarkup, escapeHtml }) => {
    let errorTimeout;

    function showAIResult(ai, reportId, resultObj) {
        const el = document.getElementById('aiResult');
        if (!el) return;
        const persisted = getAllReports().find(report => report.id === reportId);
        if (persisted?.originalAi) {
            el.style.display = 'block';
            el.innerHTML = `<h3 class="submission-result-title">Report Submitted</h3>${aiDetailsMarkup(persisted)}`;
            return;
        }
        const isM = ai.classification === 'MAJOR';
        const confVal = typeof ai.confidence === 'string' ? ai.confidence.replace('%', '') : ai.confidence;
        const label = resultObj?.detected
            ? `${confVal}% AI confidence`
            : (resultObj?.stateLabel || 'Pending manual review');
        el.style.display = 'block';
        el.innerHTML = `
            <div style="background:${isM ? 'var(--color-danger-subtle)' : 'var(--color-info-subtle)'};
                        border:1px solid ${isM ? 'var(--accent-pink)' : 'var(--accent-blue)'};
                        border-radius:10px; padding:16px; margin-top:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="font-weight:700; color:${isM ? 'var(--accent-pink)' : 'var(--accent-blue)'};">
                         Report Submitted
                    </span>
                    <span style="font-size:0.75rem; color:var(--text-dim);">${escapeHtml(label)}</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.85rem;">
                    <div><span style="color:var(--text-dim);">Classification:</span>
                        <strong style="color:${isM ? 'var(--accent-pink)' : 'var(--accent-blue)'};">
                            ${escapeHtml(ai.classification || 'Pending Review')}
                        </strong>
                    </div>
                    <div><span style="color:var(--text-dim);">Priority:</span> <strong>${escapeHtml(ai.priority || '-')}</strong></div>
                    <div><span style="color:var(--text-dim);">Category:</span> ${escapeHtml(ai.category)}</div>
                    <div><span style="color:var(--text-dim);">ID:</span>
                        <code style="font-size:0.7rem;">${escapeHtml(reportId)}</code>
                    </div>
                </div>
            </div>`;
    }

    function showFormError(msg) {
        clearTimeout(errorTimeout);
        let el = document.getElementById('formError');
        if (!el) {
            el = document.createElement('p');
            el.id = 'formError';
            el.style.cssText = 'color:var(--accent-pink); font-size:0.82rem; margin-top:8px;';
            document.getElementById('submitBtn')?.insertAdjacentElement('beforebegin', el);
        }
        el.textContent = msg;
        errorTimeout = setTimeout(() => { el.textContent = ''; }, 3000);
    }

    function reset() {
        const result = document.getElementById('aiResult');
        if (result) { result.style.display = 'none'; result.textContent = ''; }
        const error = document.getElementById('formError');
        if (error) error.textContent = '';
        clearTimeout(errorTimeout);
    }

    return { showAIResult, showFormError, reset };
};
