const createCitizenPhotoWorkflow = ({
    state, isCurrentUploadGeneration, correctionModel, UploadState: CitizenUploadState, form, evidence,
    preview, renderAssessment, validateUploadedImage, comparePhotoScenes, detectPhotos, assessPair, closeCamera
}) => {
    const { renderSelectedPreviews } = preview;

    function nextUploadGeneration() {
        if (state.submittedGeneration === state.generation) {
            const button = document.getElementById('submitBtn');
            if (button) button.textContent = 'Submit to AI Analysis';
        }
        state.generation += 1;
        state.correction = correctionModel?.empty(state.generation) || null;
        form.clearGeneratedDescription();
        form.renderCitizenCorrection();
        return state.generation;
    }

    function renderUploadState(scanState, detail = {}) {
        state.scanState = scanState;
        form.updateSubmitAvailability();
        if (detail.result) form.renderCitizenCorrection(detail.result);
        renderAssessment(scanState, detail);
    }

    function deleteCitizenPhoto(index) {
        if (!state.files[index]) return;
        const remaining = state.files.filter((_, i) => i !== index);
        if (remaining.length === 0) {
            resetPhotoSelection();
            return;
        }
        evidence.closeCitizenPhotoZoom();
        state.files = remaining;
        const generation = nextUploadGeneration();
        state.assessment = null;
        evidence.clearDetectionOverlays();
        renderSelectedPreviews(state.files, generation);
        renderUploadState(CitizenUploadState.ERROR, {
            count: 1,
            tone: 'info',
            message: 'One photo remains. Take the second photo from another angle.'
        });
    }

    async function processDualPhotos(files) {
        evidence.closeCitizenPhotoZoom();
        const generation = nextUploadGeneration();
        evidence.clearDetectionOverlays();
        state.assessment = null;

        if (!files || files.length !== 2) {
            state.files = [];
            renderSelectedPreviews([], generation);
            renderUploadState(CitizenUploadState.ERROR, { message: 'Report rejected: you must provide exactly 2 issue photos.' });
            return;
        }

        state.files = files.slice(0, 2);
        renderSelectedPreviews(state.files, generation);
        renderUploadState(CitizenUploadState.PREVIEW_LOADING, { count: 2 });

        const images = [];
        for (const file of state.files) {
            let result;
            try {
                result = await validateUploadedImage(file);
            } catch {
                result = { valid: false, message: 'The selected photo could not be decoded. Choose a complete JPEG, PNG, or WebP image.' };
            }
            if (!isCurrentUploadGeneration(generation)) return;
            if (!result.valid) {
                const error = { state: 'VALIDATION_ERROR', message: result.message || 'The selected photo is invalid.' };
                state.assessment = assessPair([{ ok: false, error }, { ok: false, error }]);
                renderUploadState(CitizenUploadState.ERROR, {
                    result: state.assessment,
                    count: 2
                });
                return;
            }
            images.push(result.image);
        }

        renderUploadState(CitizenUploadState.AI_SCANNING);

        const scanFiles = state.files.slice();
        let entries;
        let sceneMatch = null;
        try {
            [entries, sceneMatch] = await Promise.all([
                detectPhotos(scanFiles),
                Promise.resolve().then(() => comparePhotoScenes(images)).catch(() => null)
            ]);
            if (!isCurrentUploadGeneration(generation)) return;
        } catch (error) {
            if (!isCurrentUploadGeneration(generation)) return;
            const failure = { ok: false, error: { state: 'AI_SERVICE_ERROR', message: error.message } };
            entries = [failure, failure];
        }

        if (!isCurrentUploadGeneration(generation) || scanFiles[0] !== state.files[0] || scanFiles[1] !== state.files[1]) return;

        state.assessment = assessPair(entries, sceneMatch);
        const terminalState = !state.assessment.submittable || state.assessment.state === 'AI_SERVICE_ERROR'
            ? CitizenUploadState.ERROR
            : CitizenUploadState.READY;
        renderUploadState(terminalState, { result: state.assessment, count: 2 });
        evidence.renderDetectionOverlays(state.assessment);
        form.autoFillFromVision(state.assessment);
    }

    function setupImagePreview() {
        const input = document.getElementById('imgInput');

        if (!input) return;
        if (input.__citizenUploadBound) return;
        input.__citizenUploadBound = true;

        input.addEventListener('change', async (e) => {
            e.preventDefault();
            const newFiles = Array.from(input.files || []);
            if (!newFiles.length) return;

            if (newFiles.length >= 2) {
                state.files = newFiles.slice(0, 2);
            } else {
                if (state.files.length >= 2) {
                    state.files = [newFiles[0]];
                } else {
                    state.files.push(newFiles[0]);
                }
            }

            if (state.files.length === 2) {
                await processDualPhotos(state.files);
            } else {
                evidence.closeCitizenPhotoZoom();
                const generation = nextUploadGeneration();
                state.assessment = null;
                evidence.clearDetectionOverlays();
                renderSelectedPreviews(state.files, generation);
                renderUploadState(CitizenUploadState.ERROR, {
                    count: 1,
                    tone: 'info',
                    message: 'Two photos are required. Use the camera to take both photos.'
                });
            }
        });
    }

    function resetPhotoSelection() {
        evidence.closeCitizenPhotoZoom();
        const generation = nextUploadGeneration();
        closeCamera();
        const input = document.getElementById('imgInput');
        if (input) input.value = '';

        state.files = [];
        state.assessment = null;
        evidence.clearDetectionOverlays();
        renderSelectedPreviews(state.files, generation);
        renderUploadState(CitizenUploadState.IDLE);
    }

    return { bind: setupImagePreview, processDualPhotos, deleteCitizenPhoto, resetPhotoSelection };
};
