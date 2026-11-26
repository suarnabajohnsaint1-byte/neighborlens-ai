(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const client = window.AuthClient;
  const { freshPosition, cameraFailureMessage, cameraFrame, inspectCardFrame, steadyCard } = window.IdEnrollment;
  const documentPolicy = window.IdentityDocumentPolicy;
  const enrollmentHint = byId("idEnrollmentDocumentHint");
  const defaultEnrollmentHint = enrollmentHint.textContent;
  const uploadTestEnabled = window.CITIZEN_ID_UPLOAD_TEST === true;
  let testingUpload = false;
  let selectedDocumentType = "";
  let transaction;
  let account = null;
  let file = null;
  let preview = null;
  let scan = null;
  let pendingCaptureOcr = null;
  let confirmed = false;
  let busy = false;
  let scanning = false;
  let identitySaved = false;
  let registrationComplete = false;
  let generation = 0;
  let locationGeneration = 0;
  let cameraGeneration = 0;
  let stream = null;
  let alignmentTimer;
  let cardAligned = false;
  let lastCameraFrame = null;
  const alignmentCanvas = document.createElement("canvas");
  let devices = [];
  let signupActive = false;
  let barangayEdited = false;

  let enrollment = null;
  let provisionalReview = false;
  let scannerTestMode = false;
  const verificationFeedback = {
    OUTSIDE_BACOLOD_TEST: "Review the scanned details. Test scans cannot create an account.",
    VERIFIER_NOT_CONFIGURED: "Automatic ID verification is unavailable. You can review the scanned details, but registration requires approval.",
    VERIFIER_UNAVAILABLE: "ID verification could not be completed. Review the scanned details or try again later.",
    SCREENING_UNCLEARED: "Screening could not clear this capture. Review the scanned details or retake the photo.",
    VERIFIER_NOT_APPROVED: "The ID could not be verified. You can review the scanned details, but registration requires approval."
  };
  const retakePhotoDetail = "Retake the photo. Hold the ID steady, avoid reflections, and keep all four edges inside the guide.";
  let reviewToken = null;
  let reviewTimer;
  let reviewGeneration = 0;
  let localScreenWarning = false;
  const screeningClasses = new Set(["LOW_RISK", "SUSPICIOUS", "POTENTIALLY_FAKE", "INVALID", "UNABLE_TO_ASSESS"]);
  const editedFields = new Set();
  const fields = [
    "regFullName",
    "regBirthDate",
    "regAddress",
    "regDocumentType",
    "regIdNumber",
    "regExpiryDate",
  ];
  const fieldLabels = {
    fullName: "Full name",
    birthDate: "Date of birth",
    address: "Address on government ID",
    idType: "ID type",
    idNumber: "ID number",
    expiryDate: "Expiration date",
  };
  function canEditOcrResult(result) {
    const parsed = result?.fields || IdIdentityService.extractIdentityFields(result?.rawText, result?.words);
    return Boolean(documentPolicy.enrollmentDocumentType(parsed?.idType) &&
      (String(parsed?.fullName || '').trim().length >= 3 || String(parsed?.idNumber || '').trim().length >= 5) &&
      (String(result?.rawText || '').trim() || result?.words?.length));
  }

  function reviewStatus() {
    if (!scan) return;
    if (!scan.valid) {
      message(
        "identityReviewStatus",
        "The scan did not meet the document-reading requirements. Re-scan a clearer photo before confirming.",
        true,
      );
      return;
    }
    const missing = IdIdentityService.validateDocumentFields({
      ...facts(),
      idType: byId("regDocumentType").value,
      expiryDatePresent: scan.idType === byId("regDocumentType").value && scan.expiryDatePresent,
    }).missingFields;
    const text = missing.length
      ? "Not read from the image. Enter or correct: " +
      missing.map((key) => fieldLabels[key] || key).join(", ") +
      "."
      : scan.ocrDraft || provisionalReview
        ? confirmed
          ? "OCR details confirmed. Identity verification must complete before registration."
          : "Review or correct the scanned fields. The image is not yet verified for registration."
        : registrationComplete
          ? "Identity information saved. Manual review is not identity verification."
          : confirmed
            ? account
              ? "Reviewed information confirmed for your existing citizen account."
              : "Reviewed information confirmed. Complete your barangay and credentials below."
            : enrollment && !enrollment.basic
              ? "Check the verified details, then select Confirm reviewed information."
              : "Check the scanned fields, then select Confirm reviewed information.";
    message("identityReviewStatus", text, missing.length > 0);
    return missing;
  }

  function message(id, value, error = false) {
    const element = byId(id);
    element.textContent = value;
    element.setAttribute("role", error ? "alert" : "status");
    element.style.color = error ? "var(--accent-pink)" : "var(--text-dim)";
  }
  function screeningClassification(result) {
    if (result?.decision === "BLOCK_INVALID" || result?.code === "REGISTRATION_ID_INVALID") return "INVALID";
    const classification = result?.screening?.classification;
    if (!screeningClasses.has(classification)) return "UNABLE_TO_ASSESS";
    return classification === "LOW_RISK" && localScreenWarning ? "SUSPICIOUS" : classification;
  }
  function showScanResult({ verifiedType, confirmedFraud = false, unableReason } = {}) {
    const labels = { PHILSYS: "National ID", NATIONAL_ID: "National ID", DRIVERS_LICENSE: "Driver's License", REVIEWED: "Government ID" };
    const type = Object.hasOwn(labels, verifiedType) ? labels[verifiedType]
      : Object.hasOwn(IdIdentityService.SUPPORTED_ID_TYPES, verifiedType) ? IdIdentityService.SUPPORTED_ID_TYPES[verifiedType].label : "";
    let title = "Unable to Verify";
    let detail = unableReason || (reviewToken
      ? "Your scan was submitted for in-person review. Use the review reference above."
      : provisionalReview
        ? (verificationFeedback[provisionalReview] || "You can edit the scanned details below. Identity verification is required before registration.")
        : "We could not verify this ID. Retake the photo or use a supported verification method.");
    if (confirmedFraud) {
      title = "Fake ID";
      detail = "This ID failed verification. Please use a genuine government-issued ID.";
    } else if (type) {
      title = `Valid ${type}`;
      detail = "Your ID has been verified. Please review your information below.";
    }
    message("idVerifyStatus", "", !type || confirmedFraud);
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("div");
    description.textContent = detail;
    byId("idVerifyStatus").append(heading, description);
  }
  function clearUnreviewedFields() {
    for (const id of fields) if (!editedFields.has(id)) byId(id).value = "";
  }
  function saveReview(token) {
    clearTimeout(reviewTimer);
    reviewGeneration++;
    reviewToken = token;
    if (!token) {
      enrollmentHint.textContent = defaultEnrollmentHint;
      updateEnrollmentHint();
    }
    try {
      if (token) sessionStorage.setItem("pending_citizen_enrollment", token);
      else sessionStorage.removeItem("pending_citizen_enrollment");
    } catch { /* The open page can still check for approval. */ }
  }
  function discardProvisionalReview() {
    if (!provisionalReview) return;
    provisionalReview = false;
    confirmed = false;
    scan = null;
    clearUnreviewedFields();
    byId("identityFields").style.display = "none";
    update();
  }
  function showPendingReview(result) {
    enrollmentHint.textContent = `Present review reference ${result.reference} with your physical ID.`;
    updateEnrollmentHint();
    showScanResult();
  }
  async function checkPendingReview(token) {
    if (!signupActive || reviewToken !== token) return;
    if (busy) {
      reviewTimer = setTimeout(() => checkPendingReview(token), 1500);
      return;
    }
    const current = reviewGeneration;
    try {
      const result = await client.enrollmentStatus(token);
      if (!signupActive || current !== reviewGeneration) return;
      if (busy) {
        reviewTimer = setTimeout(() => checkPendingReview(token), 1500);
        return;
      }
      if (result.state === "pending") {
        showPendingReview(result);
      } else if (result.state === "approved") {
        enrollment = { token, classification: screeningClassification(result), manual: true };
        provisionalReview = false;
        scan ??= { valid: true };
        byId("identityFields").style.display = "block";
        updateExpiryField();
        reviewStatus();
        enrollmentHint.textContent = defaultEnrollmentHint;
        showScanResult({ verifiedType: "REVIEWED" });
        update();
        return;
      } else {
        saveReview(null);
        discardProvisionalReview();
        showScanResult();
        return;
      }
    } catch (error) {
      if (!signupActive || current !== reviewGeneration) return;
      if (busy) {
        reviewTimer = setTimeout(() => checkPendingReview(token), 1500);
        return;
      }
      if (error.code === "REGISTRATION_PROOF_REQUIRED" || error.status === 403) {
        saveReview(null);
        discardProvisionalReview();
        message("idVerifyStatus", error.message, true);
        return;
      }
    }
    reviewTimer = setTimeout(() => checkPendingReview(token), 15_000);
  }
  function resumePendingReview() {
    try {
      reviewToken ??= sessionStorage.getItem("pending_citizen_enrollment");
    } catch { /* Browser storage is optional. */ }
    if (reviewToken) void checkPendingReview(reviewToken);
  }
  function releasePhoto() {
    if (preview) URL.revokeObjectURL(preview);
    preview = null;
    file = null;
    testingUpload = false;
    byId("idUploadTestResult").hidden = true;
    byId("idUploadTestFields").replaceChildren();
    updateEnrollmentHint();
    byId("idCaptureProgress").hidden = true;
    for (const id of ["govIdPreview", "idCapturedImg"]) {
      byId(id).removeAttribute("src");
      byId(id).style.display = "none";
    }
  }
  function showCaptureProgress(container, status) {
    const progress = byId("idCaptureProgress");
    container.append(progress);
    const text = byId("idCaptureProgressText");
    text.textContent = status ?? "";
    text.hidden = !status;
    progress.hidden = false;
    if (status) message("idVerifyStatus", status);
  }
  function updateEnrollmentHint() {
    const pendingReference = reviewToken && enrollmentHint.textContent !== defaultEnrollmentHint;
    enrollmentHint.hidden = Boolean(account || (!preview && !pendingReference));
  }
  function releaseCameraStream() {
    clearInterval(alignmentTimer);
    lastCameraFrame = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    byId("idCameraVideo").srcObject = null;
    setCardAlignment(false);
  }
  function stopCamera() {
    cameraGeneration++;
    releaseCameraStream();
    setCameraHint("");
  }
  function setCardAlignment(aligned) {
    cardAligned = aligned;
    byId("idCardGuide").classList.toggle("is-aligned", aligned);
    byId("idCaptureBtn").disabled = busy || !stream || !aligned;
  }
  function setCameraHint(hint, container = byId("idCardGuide")) {
    const status = byId("idAlignmentStatus");
    if (status.parentElement !== container) container.append(status);
    status.hidden = !hint;
    if (status.textContent !== hint) status.textContent = hint;
  }
  function update() {
    const eligible = Boolean(scan?.valid && confirmed && (account || enrollment));
    const identityReviewed = Boolean(scan?.valid && confirmed && (account || enrollment || reviewToken));
    byId("signupCredentials").hidden = !account && !identityReviewed;
    const canChooseFile = Boolean(account || (uploadTestEnabled && !reviewToken && !enrollment));
    byId("idModeUploadBtn").hidden = !canChooseFile;
    updateEnrollmentHint();
    byId("idModeUploadBtn").style.display = canChooseFile ? "" : "none";
    if (!account) byId("idUploadAreaWrapper").style.display = "none";
    const submit = byId("signupSubmitBtn");
    submit.disabled = busy || registrationComplete || !eligible;
    submit.style.opacity = submit.disabled ? "0.4" : "1";
    if (registrationComplete) submit.textContent = "Opening Citizen Portal...";
    else if (busy && eligible && !scanning) submit.textContent = "Submitting...";
    else if (account)
      submit.textContent = identitySaved
        ? "Save identity corrections"
        : "Retry Identity Submission";
    else submit.textContent = "Register as Citizen";
    let status;
    if (registrationComplete)
      status = "Registration saved. Opening Citizen Portal...";
    else if (scanning)
      status = "Government ID scan in progress. Registration is not ready yet.";
    else if (busy && eligible)
      status = "Waiting for the server to confirm account and identity submission...";
    else if (busy)
      status = "Government ID verification is in progress.";
    else if (testingUpload) status = "Upload test only. Use the live camera to register.";
    else if (reviewToken && !enrollment) status = "Your application is pending in-person review.";
    else if (!account && scannerTestMode)
      status = "Scanner test only. Registration is disabled for this scan.";
    else if (!scan) status = preview ? "An authenticated ID is required to register." : "Government ID scan required before registration.";
    else if (!scan.valid)
      status = "The ID scan did not pass the reading requirements. A clearer image is required.";
    else if (!account && !enrollment)
      status = "ID verification is required before registration.";
    else if (!confirmed)
      status = "Scanned identity information must be reviewed and confirmed before submission.";
    else if (account)
      status = "Existing account. Only identity information will be submitted.";
    else
      status = "Identity information confirmed. Complete your account credentials to register.";
    byId("signupSubmitStatus").textContent = status;
    submit.title = eligible ? "" : status;
    byId("verifyIdBtn").style.display = file && !enrollment?.manual ? "inline-flex" : "none";
    byId("verifyIdBtn").disabled = busy;
    byId("cancelIdScanBtn").hidden = !scanning;
    byId("cancelIdScanBtn").style.display = scanning ? "inline-flex" : "none";
    byId("verifyIdBtn").textContent = busy
      ? "Reading ID..."
      : scan
        ? "Re-scan ID"
        : "Verify ID";
    byId("stepBarID").className =
      "step-bar-item " + (identityReviewed ? "done" : "active");
    byId("stepBarCreds").className =
      "step-bar-item" + (identityReviewed ? " active" : "");
    for (const id of [
      ...fields,
      "regUser",
      "regPass",
      "regPassConfirm",
      "confirmIdentityBtn",
      "govIdInput",
      "idModeUploadBtn",
      "idModeCameraBtn",
      "idCaptureBtn",
      "idSwitchCamBtn",
    ])
      byId(id).disabled =
        busy ||
        registrationComplete ||
        (Boolean(account) &&
          ["regUser", "regPass", "regPassConfirm"].includes(id));
    byId("idCaptureBtn").disabled ||= !stream || !cardAligned;

    byId("confirmIdentityBtn").disabled ||= !account && !enrollment && !provisionalReview;
    byId("regPass").required = byId("regPassConfirm").required = !account;
    byId("idCameraCapturedPreviewWrapper").querySelector(
      ".btn-thumb-retake",
    ).disabled = busy;
  }
  function isoDate(value) {
    if (!value) return "";
    const raw = String(value).slice(0, 10);
    const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return match
      ? `${match[3]}-${match[1]}-${match[2]}`
      : /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? raw
        : "";
  }
  function updateExpiryField() {
    const type = byId("regDocumentType").value;
    const field = byId("regExpiryDate");
    const requirement = documentPolicy.expiryRequirement(type);
    const sawExpiry = scan?.idType === type && scan.expiryDatePresent;
    const hide = requirement === "not_applicable" && !field.value && !sawExpiry;
    byId("regExpiryField").hidden = hide;
    byId("regExpiryHint").hidden = !hide;
    field.required = requirement === "required" || Boolean(sawExpiry);
    byId("regExpiryField").querySelector("label").textContent = field.required
      ? "Expiration Date" : "Expiration Date, if present";
    selectedDocumentType = type;
  }
  function populate(facts, preserveEdits = false) {
    byId("identityFields").style.display = "block";
    const values = {
      regFullName: facts.fullName || "",
      regBirthDate: isoDate(facts.birthDate),
      regAddress: facts.address || "",
      regDocumentType: facts.idType || facts.documentType || "",
      regIdNumber: facts.idNumber || "",
      regExpiryDate: isoDate(facts.expiryDate),
    };
    for (const [id, value] of Object.entries(values)) {
      if ((id === "regExpiryDate" || id === "regIdNumber") && values.regDocumentType !== byId("regDocumentType").value) {
        if (!preserveEdits || !editedFields.has(id)) byId(id).value = "";
        continue;
      }
      if (!preserveEdits || !editedFields.has(id)) {
        byId(id).value = value;
      } else if (!byId(id).value.trim() && value) {
        byId(id).value = value;
      }
    }
    updateExpiryField();
  }
  function facts() {
    return {
      documentType: byId("regDocumentType").value,
      fullName: byId("regFullName").value.trim(),
      birthDate: byId("regBirthDate").value || null,
      address: byId("regAddress").value.trim(),
      idNumber: byId("regIdNumber").value.trim(),
      expiryDate: byId("regExpiryDate").value || null,
      ocrConfidence: scan?.confidence ?? null,
    };
  }
  function validateFacts() {
    const data = facts();
    const validation = IdIdentityService.validateDocumentFields({
      ...data,
      idType: data.documentType,
      expiryDatePresent: scan?.idType === data.documentType && scan.expiryDatePresent,
    });
    if (validation.missingFields.length)
      throw new Error(
        "Complete the required identity fields: " +
        validation.missingFields.join(", ") +
        ".",
      );
    const type = IdIdentityService.SUPPORTED_ID_TYPES[data.documentType];
    if (!type)
      throw new Error(
        "Select a supported government ID type. Student IDs are not supported.",
      );
    if (data.birthDate > new Date().toISOString().slice(0, 10))
      throw new Error("Date of birth cannot be in the future.");
    for (const key of ["birthDate", "expiryDate"])
      if (data[key]) {
        const parsed = new Date(`${data[key]}T00:00:00Z`);
        if (
          !Number.isFinite(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== data[key]
        )
          throw new Error("Enter a valid calendar date.");
      }
    if (scan?.idType && scan.idType !== "UNKNOWN" && scan.idType !== data.documentType)
      throw new Error("The selected ID type differs from the scan. Re-scan the selected document.");
    const match = type.idNumberRegex.exec(data.idNumber);
    if (!match || match[0] !== data.idNumber)
      throw new Error("Check the ID number format for the selected document.");
    if (validation.isExpired)
      throw new Error("The document has expired. Use a current supported ID.");
    return data;
  }
  async function scanTestEnabled() {
    scannerTestMode = (await client.request("/api/auth/enrollment/options").catch(() => null))?.scanTest === true;
    return scannerTestMode;
  }

  async function locate({ resume = false } = {}) {
    const current = ++locationGeneration;
    if (document.hidden) return;
    const existingMap = window.getGeofenceMap?.("signupGeoCanvas");
    if (resume && existingMap) {
      existingMap.map.invalidateSize({ pan: false });
      if (byId("signupMapStatus")?.hidden === false) existingMap.tiles?.redraw();
    } else void window.renderGeofenceMap?.("signupGeoCanvas", null, null).catch(() => { });
    const scanTest = await scanTestEnabled();
    if (current !== locationGeneration || !signupActive) return;
    if (scanTest) {
      byId("signupLocationHint").textContent = "Location is optional during scanner testing.";
      message("signupGpsStatus", "Scanner test mode is active.");
      update();
      return;
    }
    if (!window.autoDetectBarangay) {
      byId("signupLocationHint").textContent =
        "Select your registration barangay below.";
      return;
    }
    try {
      const position = await window.autoDetectBarangay({
        statusElId: "signupGpsStatus",
        canvasId: "signupGeoCanvas",
        selectElId: null,
        onPolygonBarangay(name) {
          if (current === locationGeneration && signupActive && !account && !barangayEdited)
            byId("regBarangay").value = window.BACOLOD_BARANGAYS.includes(name) ? name : "";
        },
      });
      if (current !== locationGeneration || !signupActive) return;
      byId("signupLocationHint").textContent =
        position ? "Choose the barangay printed on your ID and register from inside its boundary."
          : "Allow location access to verify your barangay.";
    } catch {
      if (current === locationGeneration)
        message(
          "signupGpsStatus",
          "Location unavailable. Allow location access to verify your barangay.",
          true,
        );
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!signupActive) return;

    if (document.hidden) {
      locationGeneration++;
      window.stopAutoDetectBarangay?.("signupGeoCanvas");
      return;
    }

    void locate({ resume: true });
  });

  function reset() {
    locationGeneration++;
    window.stopAutoDetectBarangay?.("signupGeoCanvas");
    void window.selectGeofenceMapBarangay?.("signupGeoCanvas", "");
    barangayEdited = false;
    generation++;
    provisionalReview = false;
    reviewGeneration++;
    clearTimeout(reviewTimer);
    editedFields.clear();
    enrollment = null;
    localScreenWarning = false;
    enrollmentHint.textContent = defaultEnrollmentHint;
    stopCamera();
    releasePhoto();
    window._visionStepCb = null;
    window.stopIdentityOCR()?.catch(() => { });
    scan = null;
    scanning = false;
    identitySaved = false;
    registrationComplete = false;
    confirmed = false;
    account = null;
    transaction = window.AuthRegistration(client);
    byId("signupForm").reset();
    byId("regUser").removeAttribute("aria-invalid");
    byId("regUser").removeAttribute("aria-describedby");
    byId("identityFields").style.display = "none";
    byId("idCameraAreaWrapper").style.display = "none";
    byId("idCameraCapturedPreviewWrapper").style.display = "none";
    byId("idUploadAreaWrapper").style.display = "block";
    byId("idModeUploadBtn").classList.add("active");
    byId("idModeCameraBtn").classList.remove("active");
    byId("idUploadArea").querySelector(".upload-placeholder").style.display =
      "";
    message("signupMsg", "");
    message("idVerifyStatus", "");
    message("identityReviewStatus", "");
    update();
  }
  window.toggleAuth = function () {
    if (busy) return;
    signupActive = !signupActive;
    byId("loginSection").style.display = signupActive ? "none" : "block";
    byId("signupSection").style.display = signupActive ? "block" : "none";
    byId("loginPass").value = "";
    if (signupActive) {
      locate();
      resumePendingReview();
    }
    else reset();
  };
  async function selectPhoto(selected, camera = false) {
    if (busy || !account) return;
    const current = ++generation;
    editedFields.clear();
    registrationComplete = false;
    confirmed = false;
    scan = null;
    busy = true;
    scanning = true;
    clearUnreviewedFields();
    byId("identityFields").style.display = "none";
    message("idVerifyStatus", "Preparing ID photo…");
    message("identityReviewStatus", "");
    update();
    try {
      await window.validateIdentityImageFile(selected);
    } catch (error) {
      if (current === generation) {
        releasePhoto();
        busy = false;
        scanning = false;
        message("idVerifyStatus", error.message, true);
        update();
      }
      return;
    }
    if (current !== generation || !signupActive) return;
    busy = false;
    scanning = false;
    stopCamera();
    if (!camera || !preview) {
      releasePhoto();
      preview = URL.createObjectURL(selected);
    }
    file = selected;
    const image = byId(camera ? "idCapturedImg" : "govIdPreview");
    if (image.getAttribute("src") !== preview) image.src = preview;
    image.style.display = "block";
    byId("idCameraAreaWrapper").style.display = "none";
    byId("idCameraCapturedPreviewWrapper").style.display = camera
      ? "block"
      : "none";
    if (!camera)
      byId("idUploadArea").querySelector(".upload-placeholder").style.display =
        "none";
    message("signupMsg", "");
    update();
    await readPhoto();
  }
  async function recognizeId(image) {
    const result = await window.verifyGovernmentID(image);
    if (result.error) throw new Error(result.reason);
    if (!result.rawText?.trim())
      throw new Error(account ? "No readable text found. Retake or upload a clearer image." : "No readable text found. Retake a clearer live photo.");
    return result;
  }
  async function testUploadedId(image) {
    if (!uploadTestEnabled || !signupActive || busy || reviewToken || enrollment) return;
    const current = ++generation;
    stopCamera();
    releasePhoto();
    scan = null;
    confirmed = false;
    busy = true;
    testingUpload = true;
    byId("idCameraAreaWrapper").style.display = "none";
    byId("idCameraCapturedPreviewWrapper").style.display = "none";
    message("idVerifyStatus", "Preparing test image…");
    update();
    try {
      await window.validateIdentityImageFile(image);
      if (current !== generation || !signupActive) return;
      preview = URL.createObjectURL(image);
      const captured = byId("idCapturedImg");
      captured.src = preview;
      captured.style.display = "block";
      byId("idCameraCapturedPreviewWrapper").style.display = "block";
      showCaptureProgress(captured.parentElement, "Scanning ID text…");
      const result = await recognizeId(image);
      if (current !== generation || !signupActive) return;
      const parsed = IdIdentityService.prepareScanFields(
        result.fields || IdIdentityService.extractIdentityFields(result.rawText, result.words),
      );
      const details = byId("idUploadTestFields");
      for (const [key, label] of Object.entries(fieldLabels)) {
        const term = document.createElement("dt");
        term.textContent = label;
        const value = document.createElement("dd");
        value.textContent = (key === "idType"
          ? IdIdentityService.SUPPORTED_ID_TYPES[parsed.idType]?.label
          : parsed[key]) || "Not read";
        details.append(term, value);
      }
      byId("idUploadTestResult").hidden = false;
      message("idVerifyStatus", result.valid
        ? "Upload test complete. ID text was read. Use the live camera for verification."
        : "Upload test could not read enough ID text. Try a clearer image.", !result.valid);
    } catch {
      if (current === generation && signupActive)
        message("idVerifyStatus", "Upload test could not read this image. Choose a clear JPEG, PNG, or WebP.", true);
    } finally {
      if (current === generation) {
        busy = false;
        byId("idCaptureProgress").hidden = true;
        update();
      }
    }
  }
  function reviewScan(result, verifiedFacts, ocrDraft = false) {
    const parsed = verifiedFacts ? { ...verifiedFacts, idType: verifiedFacts.documentType }
      : IdIdentityService.prepareScanFields(
        result.fields || IdIdentityService.extractIdentityFields(result.rawText, result.words),
      );
    scan = {
      valid: Boolean(verifiedFacts) || result.valid === true ||
        ((ocrDraft || provisionalReview || enrollment?.basic) && canEditOcrResult(result)),
      ocrDraft,
      confidence: result.confidence ?? null,
      idType: parsed.idType,
      expiryDatePresent: Boolean(parsed.expiryDate || parsed.expiryDatePresent),
    };
    populate(parsed, !verifiedFacts);
    return reviewStatus();
  }
  function validVerifiedFields(verified) {
    const parsed = { ...verified, idType: verified.documentType };
    const validation = IdIdentityService.validateDocumentFields(parsed);
    const type = IdIdentityService.SUPPORTED_ID_TYPES[parsed.idType];
    return !validation.missingFields.length && !validation.isExpired &&
      type?.idNumberRegex.exec(parsed.idNumber)?.[0] === parsed.idNumber;
  }
  async function readPhoto(recognized) {
    if (!file || busy || enrollment?.manual ||
      (!account && !enrollment && !provisionalReview)) return;
    const current = ++generation;
    registrationComplete = false;
    confirmed = false;
    if (account) scan = null;
    else reviewStatus();
    busy = true;
    scanning = true;
    update();
    if (!recognized) {
      const capturedImage = byId("idCapturedImg");
      if (capturedImage.hasAttribute("src"))
        showCaptureProgress(capturedImage.parentElement, "Scanning ID…");
      else message("idVerifyStatus", "Scanning ID…");
    }
    try {
      const result = recognized ?? await recognizeId(file);
      if (current !== generation || !signupActive) return;
      if (provisionalReview || enrollment?.basic) {
        const fields = result.fields || IdIdentityService.extractIdentityFields(result.rawText, result.words);
        const idType = documentPolicy.enrollmentDocumentType(fields.idType);
        if (idType && (result.valid || canEditOcrResult(result))) {
          reviewScan({ ...result, fields: { ...fields, idType } });
          if (enrollment?.basic) {
            message("idVerifyStatus", "Review your scanned details to create a limited account. Your identity remains unverified.");
          } else if (provisionalReview === "OUTSIDE_BACOLOD_TEST") {
            message("idVerifyStatus", "Basic document checks passed. Review the scanned details.");
          } else showScanResult();
        } else {
          scan = null;
          clearUnreviewedFields();
          byId("identityFields").style.display = "none";
          showScanResult();
        }
        return;
      }
      if (!account) {
        const { facts: verified } = enrollment;
        if (!validVerifiedFields(verified)) {
          enrollment = null;
          showScanResult();
          return;
        }
        reviewScan(result, verified);
        showScanResult({ verifiedType: verified.documentType });
        return;
      }
      const missing = reviewScan(result);
      const summary = !result.valid ? "Scan needs a clearer image."
        : missing?.length ? "Some ID details could not be read. Re-scan the ID or enter the missing fields below."
          : "Check the scanned details below.";
      message(
        "idVerifyStatus",
        summary,
        !result.valid,
      );
    } catch (error) {
      if (current === generation) {
        if (account) message("idVerifyStatus", error.message, true);
        else showScanResult();
      }
    } finally {
      if (current === generation) {
        busy = false;
        scanning = false;
        byId("idCaptureProgress").hidden = true;
        window._visionStepCb = null;
        update();
      }
    }
  }
  window.switchIdInputMode = async function (mode) {
    if (mode === "upload" && !account) return;
    if (busy) return;
    if (!account && mode === "camera") saveReview(null);
    stopCamera();
    byId("idModeUploadBtn").classList.toggle("active", mode !== "camera");
    byId("idModeCameraBtn").classList.toggle("active", mode === "camera");
    byId("idUploadAreaWrapper").style.display =
      mode === "camera" ? "none" : "block";
    byId("idCameraAreaWrapper").style.display = "none";
    byId("idCameraCapturedPreviewWrapper").style.display = "none";
    if (mode === "camera") await startCamera();
  };
  async function startCamera(deviceId) {
    stopCamera();
    const cameraArea = byId("idCameraAreaWrapper");
    cameraArea.style.display = "none";
    const current = cameraGeneration;
    let previewReady = false;
    try {
      if (!account) {
        enrollment = null;
        provisionalReview = false;
        localScreenWarning = false;
        enrollmentHint.textContent = defaultEnrollmentHint;
        scan = null;
        confirmed = false;
        editedFields.clear();
        clearUnreviewedFields();
        releasePhoto();
        byId("identityFields").style.display = "none";
        byId("idCameraCapturedPreviewWrapper").style.display = "none";
        update();
      }
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Camera unavailable.");
      if (pendingCaptureOcr) {
        pendingCaptureOcr = null;
        void window.stopIdentityOCR();
      }
      void window.prepareIdentityOCR?.();
      message("idVerifyStatus", "Opening camera…");
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (current !== cameraGeneration || !signupActive) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      const video = byId("idCameraVideo");
      video.srcObject = stream;
      cameraArea.style.display = "block";
      await video.play();
      if (current !== cameraGeneration) return;
      previewReady = true;
      setCameraHint("Align the ID inside the outline.");
      message("idVerifyStatus", "");
      let stableFrames = 0;
      let hintFrames = 0;
      let previousHint;
      alignmentTimer = setInterval(() => {
        if (busy) return;
        const frame = inspectCardFrame(video, byId("idCardGuide"), alignmentCanvas);
        const steady = steadyCard(lastCameraFrame, frame);
        stableFrames = steady ? Math.min(stableFrames + 1, 2) : Number(frame.aligned);
        const hint = lastCameraFrame?.aligned && frame.aligned && !steady
          ? "Hold the ID steady." : frame.hint;
        lastCameraFrame = frame;
        const ready = stableFrames >= 2;
        setCardAlignment(ready);
        if (previousHint !== hint) hintFrames = 0;
        previousHint = hint;
        if (++hintFrames === 3) setCameraHint(hint);
      }, 150);
      update();
      const cameras = await navigator.mediaDevices
        .enumerateDevices()
        .then((rows) => rows.filter((row) => row.kind === "videoinput" && row.deviceId))
        .catch(() => []);
      if (current !== cameraGeneration || !signupActive) return;
      devices = [...new Map(cameras.map(camera => [camera.deviceId, camera])).values()];
      byId("idSwitchCamBtn").style.display =
        devices.length > 1 ? "inline-block" : "none";
    } catch (error) {
      if (current === cameraGeneration) {
        if (!previewReady) {
          stopCamera();
          cameraArea.style.display = "none";
        }
        update();
        message(
          "idVerifyStatus",
          cameraFailureMessage(error),
          true,
        );
      }
    }
  }
  window.switchIdCameraDevice = async function () {
    if (busy) return;
    const index = devices.findIndex(
      (device) =>
        device.deviceId === stream?.getVideoTracks()[0]?.getSettings().deviceId,
    );
    if (devices.length > 1)
      await startCamera(devices[(index + 1) % devices.length].deviceId);
  };
  window.captureIdFromCamera = async function () {
    if (busy) return;
    const video = byId("idCameraVideo");
    if (video.readyState < 2 || !video.videoWidth) {
      message(
        "idVerifyStatus",
        "Wait for a camera frame before capturing.",
        true,
      );
      return;
    }
    const current = cameraGeneration;

    const guide = byId("idCardGuide");
    if (!stream || !cardAligned) return;
    busy = true;
    setCardAlignment(cardAligned);
    setCameraHint("Please hold for a moment.");
    update();
    let stage = "camera";
    let recognition;
    let allowDraft = true;
    const activeCapture = () => current === cameraGeneration && signupActive;
    function discardDraft() {
      allowDraft = false;
      scan = null;
      clearUnreviewedFields();
      byId("identityFields").style.display = "none";
    }
    const recordOutcome = (code, status = null) => {
      byId("idVerifyStatus").dataset.scanStage = stage;
      byId("idVerifyStatus").dataset.scanCode = code;
      byId("idVerifyStatus").dataset.httpStatus = status ?? "";
    };
    recordOutcome("CAPTURE_STARTED");
    function showCapturedFrame(frame) {
      releasePhoto();
      preview = URL.createObjectURL(frame);
      updateEnrollmentHint();
      const image = byId("idCapturedImg");
      image.src = preview;
      image.style.display = "block";
      byId("idCameraAreaWrapper").style.display = "none";
      byId("idCameraCapturedPreviewWrapper").style.display = "block";
    }
    try {
      const { frame: crop, hint } = await cameraFrame(video, guide, alignmentCanvas, lastCameraFrame, releaseCameraStream);
      if (current !== cameraGeneration || !signupActive) return;
      if (!crop) {
        lastCameraFrame = null;
        setCardAlignment(false);
        setCameraHint(hint);
        recordOutcome("CAPTURE_NOT_STEADY");
        return;
      }
      showCapturedFrame(crop);
      const capturedPreview = byId("idCapturedImg").parentElement;
      setCameraHint("Please hold for a moment.", capturedPreview);
      showCaptureProgress(capturedPreview);
      const capturedImage = new File([crop], "captured-id.jpg", { type: "image/jpeg" });

      if (!account) {
        recognition = recognizeId(capturedImage).then(async result => {
          if (!activeCapture() || !allowDraft) return result;
          const parsed = result.fields || IdIdentityService.extractIdentityFields(result.rawText, result.words);
          const idType = documentPolicy.enrollmentDocumentType(parsed.idType);
          const screenContext = await window.hasScreenContextInIdCapture(capturedImage, result.rawText);
          if (!activeCapture() || !allowDraft) return result;
          localScreenWarning = screenContext;
          if (idType && !screenContext && (result.valid || canEditOcrResult(result))) {
            reviewScan({ ...result, fields: { ...parsed, idType } }, null, true);
          }
          return { ...result, fields: parsed };
        }).catch(error => ({ error }));
        pendingCaptureOcr = recognition;
        void recognition.then(() => {
          if (pendingCaptureOcr === recognition) pendingCaptureOcr = null;
        });
        function reviewCapturedPhoto(recognized) {
          file = capturedImage;
          busy = false;
          message("signupMsg", "");
          return readPhoto(recognized);
        }
        const scanTest = await scanTestEnabled();
        if (current !== cameraGeneration || !signupActive) return;
        stage = "freshPosition";
        const startPosition = scanTest ? null : await freshPosition();
        if (current !== cameraGeneration || !signupActive) return;
        stage = "startEnrollment";
        const { token } = await client.startEnrollment(startPosition);
        if (current !== cameraGeneration || !signupActive) return;
        recordOutcome("CHALLENGE_ISSUED", 200);
        stage = "freshPosition";
        const capturePosition = scanTest ? null : await freshPosition();
        if (current !== cameraGeneration || !signupActive) return;
        stage = "submitEnrollmentCapture";
        const approved = await client.submitEnrollmentCapture(token, capturePosition, capturedImage);
        if (current !== cameraGeneration || !signupActive) return;
        if (approved.decision === "VERIFIED") {
          const classification = approved.screening?.classification;
          if (approved.ocrPrefillAllowed !== true || classification !== "LOW_RISK" || !approved.facts) {
            discardDraft();
            showScanResult();
            return;
          }
          if (!validVerifiedFields(approved.facts)) {
            await recognition;
            if (activeCapture()) showScanResult();
            return;
          }
          allowDraft = false;
          recordOutcome("VERIFIED", 200);
          enrollment = { ...approved, token, classification };
          await reviewCapturedPhoto({ valid: true });
          return;
        }
        if (approved.ocrPrefillAllowed === false ||
          ["SUSPICIOUS", "POTENTIALLY_FAKE", "INVALID"].includes(screeningClassification(approved))) {
          discardDraft();
        }
        stage = "recognizeId";
        const recognized = await recognition;
        if (current !== cameraGeneration || !signupActive) return;
        if (recognized.error) throw recognized.error;

        const idType = (
          recognized.fields ||
          IdIdentityService.extractIdentityFields(
            recognized.rawText,
            recognized.words
          )
        ).idType;

        if (
          idType &&
          idType !== "UNKNOWN" &&
          !documentPolicy.enrollmentDocumentType(idType)
        ) {
          recordOutcome("UNSUPPORTED_DOCUMENT");

          const label =
            IdIdentityService.SUPPORTED_ID_TYPES[idType]?.label ||
            "Government ID";

          enrollmentHint.textContent = `NeighborLens AI · ${label}`;

          showScanResult({
            unableReason:
              "This ID type is unsupported for registration. Scan a supported government ID."
          });

          return;
        }

        if (!recognized.valid && !canEditOcrResult(recognized)) {
          stage = "recognizeId";
          recordOutcome("OCR_UNREADABLE");

          showScanResult({
            unableReason:
              "The ID text is unreadable. " + retakePhotoDetail
          });

          return;
        }

        recordOutcome(
          ["REVIEW_REQUIRED", "VERIFIED", "VERIFICATION_REQUIRED", "BASIC_REGISTRATION_ELIGIBLE"].includes(approved.decision)
            ? approved.decision
            : "UNEXPECTED_DECISION",
          200
        );

        const basic = approved.decision === "BASIC_REGISTRATION_ELIGIBLE";
        const testPreview = approved.verificationReason === "OUTSIDE_BACOLOD_TEST";
        if (basic || testPreview) {
          stage = "documentValidation";
          const documentType = documentPolicy.enrollmentDocumentType(idType);
          const parsed = IdIdentityService.prepareScanFields({
            ...(recognized.fields || IdIdentityService.extractIdentityFields(recognized.rawText, recognized.words)),
            idType: documentType
          });
          const validation = IdIdentityService.validateDocumentFields(parsed);
          const flagged = localScreenWarning ||
            ["SUSPICIOUS", "POTENTIALLY_FAKE"].includes(screeningClassification(approved));
          const needsRetake = !documentType || validation.missingFields.length ||
            parsed.birthDate > new Date().toISOString().slice(0, 10);
          if (flagged || needsRetake || validation.isExpired) {
            if (flagged || validation.isExpired) discardDraft();
            const unreadable = validation.missingFields.map(key => fieldLabels[key]).filter(Boolean).join(", ");
            recordOutcome(flagged ? "SCREENING_WARNING" : validation.isExpired ? "DOCUMENT_EXPIRED" : "OCR_FIELDS_INCOMPLETE", 200);
            showScanResult({
              unableReason: flagged ? "Possible manipulation or screen copy detected. " + retakePhotoDetail
                : validation.isExpired ? "This ID has expired. Scan a current ID."
                  : unreadable ? `Could not read ${unreadable}. Retake the photo.` : retakePhotoDetail
            });
            return;
          }
        }

        if (approved.decision === "BASIC_REGISTRATION_ELIGIBLE" &&
          approved.ocrPrefillAllowed === true && !localScreenWarning &&
          ["LOW_RISK", "UNABLE_TO_ASSESS"].includes(screeningClassification(approved))) {
          enrollment = { token, basic: true };
          await reviewCapturedPhoto(recognized);
          return;
        }

        if (approved.decision === "VERIFICATION_REQUIRED" &&
          approved.ocrPrefillAllowed === true && !localScreenWarning &&
          ["LOW_RISK", "UNABLE_TO_ASSESS"].includes(screeningClassification(approved))) {
          provisionalReview = Object.hasOwn(verificationFeedback, approved.verificationReason)
            ? approved.verificationReason : true;
          await reviewCapturedPhoto(recognized);
          return;
        }

        if (approved.decision === "REVIEW_REQUIRED" && approved.reference) {
          saveReview(token);
          showPendingReview(approved);

          if (
            approved.ocrPrefillAllowed === true &&
            screeningClassification(approved) === "LOW_RISK"
          ) {
            provisionalReview = true;
            await reviewCapturedPhoto(recognized);
          }

          reviewTimer = setTimeout(() => checkPendingReview(token), 15_000);

          return;
        }

        showScanResult();
        return;
      }

      busy = false;

      await selectPhoto(capturedImage, true);


    } catch (error) {
      if (current === cameraGeneration) {
        recordOutcome(
          /^REGISTRATION_[A-Z_]{1,48}$/.test(error.code || "")
            ? error.code
            : "SCAN_STAGE_FAILED",
          error.status
        );

        releaseCameraStream();
        byId("idCameraAreaWrapper").style.display = "none";

        if (account) {
          message("idVerifyStatus", error.message, true);
        } else {
          enrollment = null;
          const rejected = [
            "REGISTRATION_ID_COUNTERFEIT", "REGISTRATION_ID_INVALID", "REGISTRATION_ID_REVIEW_REQUIRED",
            "REGISTRATION_ID_RETAKE_REQUIRED", "REGISTRATION_ID_ALREADY_USED"
          ].includes(error.code) ||
            ["SUSPICIOUS", "POTENTIALLY_FAKE", "INVALID"].includes(screeningClassification(error));
          if (rejected) discardDraft();

          if (error.code === "REGISTRATION_OUTSIDE_BACOLOD") {
            message("signupGpsStatus", "Your GPS is outside Bacolod City.", true);
          }

          const retryDetail = {
            REGISTRATION_LOCATION_RETRY: "A fresh, more precise location is needed. Allow precise location and scan again.",
            REGISTRATION_PROOF_REQUIRED: "Your capture session ended. Start a new scan.",
            REGISTRATION_ID_RETAKE_REQUIRED: error.message || retakePhotoDetail,
            REGISTRATION_ID_INVALID: "This ID could not be validated. Please use a current, supported government ID.",
            REGISTRATION_ID_ALREADY_USED: "This ID or photo is already linked to an account. Sign in or recover that account.",
            REGISTRATION_STORAGE_UNAVAILABLE: "Your review application could not be saved. Please try again later."
          };

          showScanResult({
            confirmedFraud: error.code === "REGISTRATION_ID_COUNTERFEIT",
            unableReason: error.code === "REGISTRATION_OUTSIDE_BACOLOD"
              ? "Citizen registration requires your current location to be within Bacolod City."
              : error.code === "REGISTRATION_FRAUD_UNAVAILABLE" ||
                error.code === "REGISTRATION_VERIFICATION_UNAVAILABLE"
                ? "The verification service is temporarily unavailable. Please try again later."
                : retryDetail[error.code] ||
                (stage === "freshPosition"
                  ? "Allow precise location and scan again."
                  : stage === "recognizeId"
                    ? "The ID text could not be read. " + retakePhotoDetail
                    : undefined)
          });
          if (!rejected) await recognition;
        }
      }
    } finally {
      if (current === cameraGeneration) {
        if (!stream) setCameraHint("");
        byId("idCaptureProgress").hidden = true;
        busy = false;
        update();
      }
    }
  };
  window.retakeIdFromCamera = async function () {
    if (busy) return;
    if (testingUpload) {
      byId("govIdInput").click();
      return;
    }
    registrationComplete = false;
    confirmed = false;
    scan = null;
    releasePhoto();
    byId("identityFields").style.display = "none";
    update();
    await window.switchIdInputMode("camera");
  };
  async function recover() {
    try {
      const session = client.stored();
      if (!session?.apiToken) {
        history.replaceState(null, "", "login.html?complete-identity=1");
        showIdentityRecovery();
        message(
          "loginMsg",
          "Log in to continue identity submission without creating another account.",
        );
        return;
      }
      const verified = await client.verify(session.apiToken);
      if (
        verified.user?.role !== "citizen" ||
        Number(verified.user.id) !== Number(session.id)
      )
        throw new Error("Log in with your citizen account to continue.");
      const result = await client.identity(session.apiToken);
      if (!signupActive) window.toggleAuth();
      account = session;
      transaction = window.AuthRegistration(client, account);
      byId("regUser").value = account.username;
      byId("regBarangay").value = account.barangay || "";
      if (result.identity) {
        identitySaved = true;
        populate(result.identity);
        scan = { valid: true, confidence: result.identity.ocrConfidence };
        message(
          "idVerifyStatus",
          "Previously saved identity facts. Review and confirm; this is not a new OCR result.",
        );
      }
      message(
        "signupMsg",
        "Account already exists. Complete or retry only identity submission.",
      );
      update();
    } catch (error) {
      history.replaceState(null, "", "login.html?complete-identity=1");
      showIdentityRecovery();
      message("loginMsg", error.message, true);
    }
  }
  function showIdentityRecovery() {
    const recoverBtn = byId("recoverIdentityBtn");
    if (!recoverBtn) return;
    recoverBtn.hidden = !new URLSearchParams(
      window.location.search,
    ).has("complete-identity");
  }
  function clearLoginForm() {
    byId("loginUser").value = "";
    byId("loginPass").value = "";
  }
  if (new URLSearchParams(window.location.search).get("session") === "expired") {
    message("loginMsg", "Your session has ended. Please sign in again.", true);
    history.replaceState(null, "", "login.html");
  }
  showIdentityRecovery();
  byId("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const button = event.target.querySelector('[type="submit"]');
    busy = true;
    button.disabled = true;
    message("loginMsg", "");
    try {
      const session = await client.login(
        byId("loginUser").value.trim(),
        byId("loginPass").value,
      );
      window.LoginControls?.get(byId("loginForm"))?.rememberUsername();
      byId("loginPass").value = "";
      if (
        session.role === "citizen" &&
        new URLSearchParams(window.location.search).has("complete-identity")
      ) {
        busy = false;
        await recover();
      } else {
        clearLoginForm();
        window.location.replace(window.portalForRole(session.role));
      }
    } catch (error) {
      message("loginMsg", error.message, true);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  byId("signupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || registrationComplete) return;
    try {
      if (!scan?.valid || !confirmed)
        throw new Error(
          "Read your ID and confirm the reviewed information first.",
        );
      if (!account && !enrollment)
        throw new Error("ID verification is required before registration.");
      const data = validateFacts();
      const barangay = byId("regBarangay").value;
      if (!window.BACOLOD_BARANGAYS.includes(barangay))
        throw new Error("Select an official Bacolod barangay.");
      const username = byId("regUser").value.trim();
      const password = byId("regPass").value;
      if (!account && (username.length < 3 || username.length > 190))
        throw new Error("Username must be 3 to 190 characters.");
      if (
        !account &&
        (password.length < 6 || new TextEncoder().encode(password).length > 72)
      )
        throw new Error(
          "Password must be at least 6 characters and at most 72 UTF-8 bytes.",
        );
      if (!account && password !== byId("regPassConfirm").value)
        throw new Error("Passwords do not match.");
      busy = true;
      update();
      message(
        "signupMsg",
        "Submitting account and identity information. Waiting for server confirmation...",
      );
      const result = await transaction.submit(
        account ? { username, password, fullName: data.fullName, barangay } :
          { username, password, barangay, token: enrollment?.token, position: await freshPosition() },
        data,
      );
      account = result.account;
      identitySaved = true;
      const status = result.identity.documentValidationStatus;
      registrationComplete = status !== "fail";
      if (registrationComplete && enrollment?.manual) saveReview(null);
      reviewStatus();
      message(
        "signupMsg",
        status === "fail"
          ? "Account created. Identity saved but failed document validation; correct the details."
          : result.account.accountStatus === "ACTIVE_LIMITED"
            ? "Limited account created. Your identity remains unverified."
            : status === "needs_review"
              ? "Account created. Identity saved and needs manual review. Opening Citizen Portal..."
              : enrollment ? "Registration verified. Opening Citizen Portal..."
                : "Account created. Identity information saved. Opening Citizen Portal...",
        status === "fail",
      );
      releasePhoto();
      byId("idUploadArea").querySelector(".upload-placeholder").style.display =
        "";
      window.stopIdentityOCR()?.catch(() => { });
    } catch (error) {
      account = transaction.account();
      message(
        "signupMsg",
        (account
          ? identitySaved
            ? "Account exists; identity changes were not saved. "
            : "Account created; identity was not saved. Retry identity submission. "
          : "") + error.message,
        true,
      );
      if (!account && error.status === 409 && error.code !== "REGISTRATION_ID_ALREADY_USED") {
        byId("regUser").setAttribute("aria-invalid", "true");
        byId("regUser").setAttribute("aria-describedby", "signupMsg");
      }
    } finally {
      if (account) {
        byId("regPass").value = "";
        byId("regPassConfirm").value = "";
      }
      busy = false;
      update();
      if (!account && byId("regUser").hasAttribute("aria-invalid"))
        byId("regUser").focus();
    }
    if (registrationComplete) window.location.replace("citizen.html");
  });
  byId("signupForm").addEventListener(
    "invalid",
    (event) => {
      const label = {
        regBarangay: "Registration barangay",
        regUser: "Username",
        regPass: "Password",
        regPassConfirm: "Confirm password",
      }[event.target.id] || "Registration information";
      message("signupMsg", `${label}: ${event.target.validationMessage}`, true);
    },
    true,
  );
  byId("regUser").addEventListener("input", () => {
    if (byId("regUser").hasAttribute("aria-invalid")) {
      byId("regUser").removeAttribute("aria-invalid");
      byId("regUser").removeAttribute("aria-describedby");
      message("signupMsg", "");
    }
  });
  byId("govIdInput").addEventListener("change", (event) => {
    const selected = event.target.files[0];
    if (selected && !busy) {
      if (account) void selectPhoto(selected);
      else void testUploadedId(selected);
    }
    event.target.value = "";
  });
  byId("idUploadArea").addEventListener("click", (event) => {
    if (event.target !== byId("govIdInput") && !busy)
      byId("govIdInput").click();
  });
  byId("idUploadArea").addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      byId("govIdInput").click();
    }
  });
  byId("idModeUploadBtn").addEventListener("click", () => {
    if (!busy) byId("govIdInput").click();
  });
  byId("verifyIdBtn").addEventListener("click", () => readPhoto());
  byId("cancelIdScanBtn").addEventListener("click", () => {
    generation++;
    scanning = false;
    byId("idCaptureProgress").hidden = true;
    busy = false;
    confirmed = false;
    window._visionStepCb = null;
    window.stopIdentityOCR()?.catch(() => { });
    if (account || (!enrollment && !provisionalReview) || !scan?.valid) {
      scan = null;
      byId("identityFields").style.display = "none";
    }
    message("idVerifyStatus", "Scan cancelled. Select Verify ID to retry.");
    update();
  });
  byId("confirmIdentityBtn").addEventListener("click", () => {
    if (!account && !enrollment && !provisionalReview) return;
    try {
      validateFacts();
      if (!scan?.valid)
        throw new Error(
          "The image did not meet the existing scan threshold. Retake or upload a clearer ID.",
        );
      confirmed = true;
      message(
        "signupMsg",
        provisionalReview
          ? "OCR details corrected. Identity verification is required before registration."
          : "Information confirmed for submission.",
      );
      reviewStatus();
      update();
    } catch (error) {
      message("signupMsg", error.message, true);
      message("identityReviewStatus", error.message, true);
    }
  });
  for (const id of fields) {
    const el = byId(id);
    const handleFieldChange = () => {
      if (id === "regDocumentType" && el.value !== selectedDocumentType) {
        byId("regExpiryDate").value = "";
        editedFields.delete("regExpiryDate");
        updateExpiryField();
      }
      editedFields.add(id);
      if (registrationComplete)
        message(
          "signupMsg",
          "Account already exists. Confirm your corrections, then save identity changes.",
        );
      registrationComplete = false;
      confirmed = false;
      reviewStatus();
      update();
    };
    el.addEventListener("input", handleFieldChange);
    el.addEventListener("change", handleFieldChange);
  }
  byId("recoverIdentityBtn")?.addEventListener("click", recover);
  window.addEventListener("pagehide", () => {
    window.stopAutoDetectBarangay?.("signupGeoCanvas");
    generation++;
    signupActive = false;
    stopCamera();
    releasePhoto();
    scan = null;
    window._visionStepCb = null;
    window.stopIdentityOCR()?.catch(() => { });
    for (const id of [...fields, "regPass", "regPassConfirm", "loginUser", "loginPass"])
      byId(id).value = "";
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      busy = false;
      signupActive = false;
      reset();
      clearLoginForm();
      message("loginMsg", "");
      showIdentityRecovery();
      byId("loginSection").style.display = "block";
      byId("signupSection").style.display = "none";
    }
  });
  for (const [value, type] of Object.entries(
    IdIdentityService.SUPPORTED_ID_TYPES,
  ))
    byId("regDocumentType").add(new Option(type.label, value));
  byId("regBarangay").addEventListener("change", (event) => {
    barangayEdited = Boolean(event.target.value);
    void window.selectGeofenceMapBarangay?.("signupGeoCanvas", event.target.value);
  });
  for (const barangay of window.BACOLOD_BARANGAYS)
    byId("regBarangay").add(new Option(barangay, barangay));
  reset();
})();
