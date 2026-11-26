const createCitizenReportSubmission = ({
    state, isCurrentUploadGeneration, location, getMaxAccuracy, validateGeofence,
    correctionModel, percent, getSession, addReport, reportForm, result, resetFormUI, loadMyReports,
    getLandmarkFile, getLandmarkDescription
}) => {
    const { showFormError, showAIResult } = result;

    function publicPhotoAssessment(photo) {
        if (!photo.rawResult) return null;
        const { assessmentProof, correctionCategories, suggested_box, single_photo_preview, ...assessment } = photo.rawResult;
        return assessment;
    }

    function photoDetailsFor(result) {
        return (result?.photos || []).map(photo => ({
            model: result.model?.label || null,
            task: 'detect',
            status: photo.state,
            detections: photo.boxes.map(box => ({
                damageType: box.displayName,
                confidence: percent(box.confidence),
                severity: box.severity,
                boundingBox: box.bbox
            })),
            rawAssessment: publicPhotoAssessment(photo)
        }));
    }

    function readPhoto(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read image file'));
            reader.readAsDataURL(file);
        });
    }

    let submissionRequest = null;
    async function submitReport(form) {
        const session = getSession();
        if (!session) return window.location.href = 'login.html';
        if (session.residencyVerified === false) return showFormError('Your registered residency must be verified before you can submit reports.');
        const submissionGeneration = state.generation;
        let gps;
        try {
            gps = location.submissionPosition ? await location.submissionPosition() : location.getDetectedGPS();
        } catch (error) {
            if (isCurrentUploadGeneration(submissionGeneration)) showFormError(error.message || 'Get a fresh GPS reading and retry.');
            return;
        }
        if (!isCurrentUploadGeneration(submissionGeneration)) return;
        const submissionLocation = gps ? { ...gps } : null;

        const description = document.getElementById('description').value.trim();
        const barangay = submissionLocation?.barangay || '';
        const files = state.files.slice();
        const assessment = state.assessment;
        const landmarkFile = typeof getLandmarkFile === 'function' ? getLandmarkFile() : null;
        const landmarkDescription = typeof getLandmarkDescription === 'function' ? getLandmarkDescription() : '';
        const maxAccuracy = getMaxAccuracy();

        if (!submissionLocation || !Number.isFinite(submissionLocation.lat) || !Number.isFinite(submissionLocation.lng)) {
            return showFormError('Report rejected: an exact live GPS location is required.');
        }
        if (!Number.isFinite(submissionLocation.accuracy) || submissionLocation.accuracy > maxAccuracy) {
            return showFormError(`Report rejected: GPS accuracy must be ${maxAccuracy} meters or better. Current accuracy: ${Math.round(submissionLocation.accuracy || 0)}m.`);
        }
        if (submissionLocation.area?.authoritative && session.barangay && barangay !== session.barangay) {
            return showFormError(`You can only submit reports from inside ${session.barangay}, your registered barangay.`);
        }

        const geoCheck = submissionLocation.area ? null : validateGeofence(submissionLocation.lat, submissionLocation.lng, barangay);
        if (submissionLocation.area?.outsideCity || (geoCheck && !geoCheck.valid && !geoCheck.isInsideBacolod)) {
            return showFormError(geoCheck?.message || 'Report rejected: GPS coordinates are outside Bacolod City jurisdiction.');
        }
        if (submissionLocation.area && !submissionLocation.area.authoritative) {
            if (submissionLocation.area.status === 'AUTHORITATIVE_POLYGONS_PENDING') {
                return showFormError('Barangay boundary verification is currently unavailable. Try again later.');
            }
            return showFormError('Current GPS must confirm a single barangay. Retry from inside your registered barangay.');
        }

        const btn = document.getElementById('submitBtn');
        btn.textContent = 'Processing…';

        const ai = {
            classification: assessment.classification,
            priority: assessment.priority,
            confidence: assessment.detected ? `${assessment.confidencePercent}%` : null,
            category: assessment.detected ? assessment.category : 'Inconclusive'
        };

        const images = await Promise.all(files.map(readPhoto));
        if (!isCurrentUploadGeneration(submissionGeneration) || assessment !== state.assessment) return;
        const error = reportForm.reportReadinessError();
        if (error) return showFormError(error);

        const correction = state.correction && correctionModel ? correctionModel.submission(state.correction) : {};
        const fingerprint = JSON.stringify([session.id, description, barangay, correction, submissionGeneration, landmarkDescription]);
        if (submissionRequest?.fingerprint !== fingerprint) {
            submissionRequest = { fingerprint, key: crypto.randomUUID(), position: submissionLocation };
        }
        const reportPosition = submissionRequest.position;
        const report = addReport({
            requestKey: submissionRequest.key,
            ...correction,
            description,
            location: location.resolveReportLocation(reportPosition, session),
            barangay,
            purok: reportPosition.purok || null,
            image: images[0] || '',
            images,
            files,
            rawFiles: files,
            landmarkFile: landmarkFile || null,
            landmarkDescription: landmarkDescription || null,
            accuracy: reportPosition.accuracy ?? null,
            gpsFixAt: reportPosition.timestamp,
            submittedBy: session.username,
            submittedById: session.id,
            aiClassification: ai.classification,
            aiPriority: ai.priority,
            aiConfidence: ai.confidence,
            aiCategory: ai.category,
            aiModel: assessment.model?.label || null,
            aiTask: 'detect',
            aiAssessment: assessment.state,
            aiSummary: assessment.summary || '',
            aiPhotoDetails: photoDetailsFor(assessment),
            aiSceneMatch: assessment.sceneMatch || null,
            visionDetected: assessment.detected,
            lat: reportPosition.lat,
            lng: reportPosition.lng,
        });

        if (report?.syncPromise) {
            const syncRes = await report.syncPromise;
            if (!isCurrentUploadGeneration(submissionGeneration)) return;
            if (syncRes && !syncRes.ok) {
                if (!syncRes.retryable) submissionRequest = null;
                return showFormError(syncRes.error || 'Server rejected report submission.');
            }
        }

        if (!isCurrentUploadGeneration(submissionGeneration)) return;
        state.submittedGeneration = submissionGeneration;
        showAIResult(ai, report.id, assessment);
        btn.textContent = ' Submitted!';

        if (window.CitizenNotificationCenter) {
            window.CitizenNotificationCenter.refresh().then(() => {
                window.CitizenNotificationCenter.open();
            }).catch(error => console.warn('[citizen] Notification refresh failed:', error));
        }

        setTimeout(() => {
            if (!isCurrentUploadGeneration(submissionGeneration)) return;
            form.reset();
            resetFormUI();
            loadMyReports();
            location.runAutoGeofence();
        }, 4000);
    }

    async function handleSubmit(event) {
        event.preventDefault();
        const button = document.getElementById('submitBtn');
        if (state.submissionPending || state.submittedGeneration === state.generation) return;
        const error = reportForm.reportReadinessError();
        if (error) return showFormError(error);
        const generation = state.generation;
        state.submissionPending = true;
        reportForm.updateSubmitAvailability();
        try {
            await submitReport(event.currentTarget);
        } catch (error) {
            if (isCurrentUploadGeneration(generation)) showFormError('The report could not be submitted. Please retry.');
            console.warn('[citizen] Report submission failed:', error);
        } finally {
            state.submissionPending = false;
            if (button?.textContent === 'Processing…') button.textContent = 'Submit to AI Analysis';
            reportForm.updateSubmitAvailability();
        }
    }

    return handleSubmit;
};
