const createCitizenAssessmentRenderer = ({ UploadState: CitizenUploadState, presentation, escapeHtml, priorityBadge }) => {
    function uploadPrompt() {
        return document.getElementById('uploadArea')?.querySelector('p') || null;
    }

    function renderUploadState(state, detail = {}) {
        const prompt = uploadPrompt();
        const visionBox = document.getElementById('visionDetectBox');

        if (state === CitizenUploadState.IDLE) {
            if (prompt) prompt.textContent = 'Use different angles or sides. Both photos must show the same damage type.';
            if (visionBox) { visionBox.style.display = 'none'; visionBox.innerHTML = ''; }
            return;
        }

        if (state === CitizenUploadState.PREVIEW_LOADING) {
            if (prompt) prompt.textContent = detail.count === 1
                ? 'Take both photos using the camera.'
                : '2 photos selected';
            if (visionBox) { visionBox.style.display = 'none'; visionBox.innerHTML = ''; }
            return;
        }

        if (state === CitizenUploadState.AI_SCANNING) {
            if (prompt) prompt.textContent = '2 photos selected';
            if (visionBox) {
                visionBox.style.display = 'block';
                visionBox.innerHTML = `
                    <div data-upload-state="AI_SCANNING" style="display:flex; align-items:center; gap:10px; color:var(--accent-blue);
                                background:var(--color-info-subtle); border:1px solid var(--color-info-border);
                                border-radius:8px; padding:12px;">
                        <span class="spinner"></span>
                        <span style="font-size:0.85rem;"> Scanning both photos with the NeighborLens damage model…</span>
                    </div>`;
            }
            return;
        }

        if (state === CitizenUploadState.READY) {
            if (prompt) prompt.textContent = 'Both photos have been scanned.';
            if (visionBox) visionBox.style.display = 'block';
            if (detail.result) renderVisionResult(detail.result);
            return;
        }

        if (state === CitizenUploadState.ERROR) {
            if (prompt) prompt.textContent = detail.result
                ? 'Photo assessment complete.'
                : detail.count === 1
                    ? 'Take both photos using the camera.'
                    : '2 photos selected';
            if (detail.result) {
                if (visionBox) visionBox.style.display = 'block';
                renderVisionResult(detail.result);
            } else if (visionBox && detail.message) {
                visionBox.style.display = 'block';
                visionBox.innerHTML = `
                    <div style="color:${detail.tone === 'info' ? 'var(--accent-blue)' : 'var(--accent-pink)'}; font-size:0.83rem; padding:10px 12px;
                                background:${detail.tone === 'info' ? 'var(--color-info-subtle)' : 'var(--color-danger-subtle)'}; border:1px solid ${detail.tone === 'info' ? 'var(--color-info-border)' : 'var(--color-danger-border)'}; border-radius:8px;">
                        ${escapeHtml(detail.message)}
                    </div>`;
            }
        }
    }

    function renderVisionResult(result) {
        const visionBox = document.getElementById('visionDetectBox');
        if (!visionBox) return;
        visionBox.style.display = 'block';
        visionBox.innerHTML = presentation.renderAssessment(result, { escapeHtml, priorityBadge });
    }

    return renderUploadState;
};
