(() => {
    const correctionModel = window.CitizenCorrection;
    const { UploadState, readinessError } = window.CitizenSubmissionReadiness;
    const { assessPair, percent } = window.DamagePairAssessment;
    const presentation = window.CitizenAssessmentPresentation;
    const escapeHtml = window.ReportPresentation.escape;
    const state = {
        files: [], assessment: null, correction: correctionModel?.empty() || null,
        generatedDescription: null, descriptionOwnedByCitizen: false,
        scanState: UploadState.IDLE, generation: 0, submissionPending: false, submittedGeneration: null
    };
    const isCurrentUploadGeneration = generation => generation === state.generation;
    const loadMyReports = () => window.CitizenReports?.refresh();
    const location = createCitizenReportLocation(options => window.autoDetectBarangay(options));
    const form = createCitizenReportForm({
        state, correctionModel, readinessError, escapeHtml,
        landmarkReadinessError: () => (landmarkField.isComplete() ? null : 'A landmark photo and description are required.')
    });
    const landmarkField = createCitizenLandmarkField({
        container: document.getElementById('landmarkField'),
        onChange: () => form.updateSubmitAvailability(),
        onCapture: () => reportCamera?.openLandmark(file => landmarkField.setPhoto(file))
    });
    const evidence = createCitizenEvidenceViewer({
        getAssessment: () => state.assessment,
        describeAssessmentPhoto: presentation.describeAssessmentPhoto,
        overlay: window.DetectionOverlay,
        Zoom: window.EvidenceZoom
    });
    const preview = createCitizenPhotoPreview(isCurrentUploadGeneration);
    const renderAssessment = createCitizenAssessmentRenderer({
        UploadState, presentation, escapeHtml, priorityBadge: value => priorityBadge(value)
    });
    const result = createCitizenSubmissionResult({
        getAllReports: () => getAllReports(), aiDetailsMarkup: report => aiDetailsMarkup(report), escapeHtml
    });
    let reportCamera;
    const photos = createCitizenPhotoWorkflow({
        state, isCurrentUploadGeneration, correctionModel, UploadState, form, evidence, preview, renderAssessment,
        validateUploadedImage: CitizenPhotoValidation.validateUploadedImage,
        comparePhotoScenes: CitizenSceneComparison.comparePhotoScenes,
        detectPhotos: files => window.YoloDamageDetector.detectPhotos(files),
        assessPair,
        closeCamera: () => reportCamera?.close()
    });
    function resetFormUI() {
        photos.resetPhotoSelection();
        landmarkField.reset();
        result.reset();
        location.reset();
        form.reset();
    }

    const handleSubmit = createCitizenReportSubmission({
        state, isCurrentUploadGeneration, location, correctionModel, percent, result, resetFormUI, loadMyReports,
        getMaxAccuracy: () => window.MAX_REPORT_LOCATION_ACCURACY_METERS || 100,
        validateGeofence: (...args) => window.validateReportGeofence?.(...args),
        getSession: () => getSession(), addReport: report => addReport(report), reportForm: form,
        getLandmarkFile: () => landmarkField.getPhoto(), getLandmarkDescription: () => landmarkField.getDescription()
    });

    Object.assign(window, {
        loadMyReports, resetFormUI, deleteCitizenPhoto: photos.deleteCitizenPhoto,
        openCitizenPhotoZoom: evidence.openCitizenPhotoZoom, closeCitizenPhotoZoom: evidence.closeCitizenPhotoZoom,
        toggleCitizenFullscreen: evidence.toggleCitizenFullscreen, runAutoGeofence: location.runAutoGeofence,
        getDetectedGPS: location.getDetectedGPS, mergeDetectedLocation: location.mergeDetectedLocation,
        resolveReportLocation: location.resolveReportLocation
    });
    window.addEventListener('reports_updated', loadMyReports);

    window.addEventListener('DOMContentLoaded', () => {
        if (window.NEIGHBORLENS_ACCESS_GRANTED === false) return;
        loadMyReports();
        if (window.location.hash === '#my-reports' && typeof showSection === 'function') {
            showSection('myReportsSection', document.querySelector('.nav-links li:nth-child(2)'));
        }
        photos.bind();
        evidence.bind();
        form.setupForm(handleSubmit);
        location.setupLocationMap();
        const cameraDialog = document.getElementById('reportCameraDialog');
        if (cameraDialog) reportCamera = window.ReportCamera.mount(cameraDialog, photos.processDualPhotos, () => state.files);
        location.bindTracking();
        landmarkField.mount().then(() => form.updateSubmitAvailability()).catch(error => {
            console.error('[citizen] Landmark initialization failed:', error);
            const container = document.getElementById('landmarkField');
            if (container) container.textContent = 'Unable to load the landmark field. Refresh the page to try again.';
        });
    }, { once: true });
    window.addEventListener('pagehide', event => {
        if (event.persisted) return location.suspend();
        evidence.closeCitizenPhotoZoom();
        preview.revokePreviewObjectUrls();
        reportCamera?.close();
        location.reset();
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) location.syncTracking();
    });
})();
