# Citizen enrollment

New citizen registration supports PhilSys National IDs and LTO driver's licenses. After the card is aligned, Tesseract reads the single guide crop locally. Express receives the same JPEG, normalizes it, and sends it to the loopback assessor. Fresh Bacolod GPS is checked when starting enrollment, submitting the capture, and creating the account. The permanent address printed on the ID can be outside Bacolod.

An approved capture fills the existing editable fields from trusted document facts. A readable capture with inconclusive screening can show an editable OCR preview under `VERIFICATION_REQUIRED`, which carries no enrollment approval. Confirmed invalid, flagged, or unusable captures do not populate fields. Unusable images return `RETAKE_REQUIRED`. The existing manual reviewer system remains an optional workflow when authorized reviewers are configured.

## Server configuration

1. Apply the MySQL migrations through `022_citizen_enrollment_tier.sql` with `npm run migrate:mysql`.
2. Serve the bundled boundary files alongside `frontend/assets/bacolod-boundary-version.json`. The browser maps and Express use the same city outline and 61-barangay reference dataset. Express checks both SHA-256 digests after normalizing CRLF to LF, validates the polygon structure, and rejects a missing or mismatched dataset. The old per-environment registration geometry variables are retired. If your deployment previously used a separately approved polygon, review the shared geometry before switching; publish any corrections in the shared dataset and advance the version.
3. Set `REGISTRATION_FRAUD_URL` to the private FastAPI endpoint, normally `http://127.0.0.1:8001/assess-capture`, and configure the same random ASCII `REGISTRATION_FRAUD_SECRET` of at least 32 characters in both services. Launch FastAPI with `python -m uvicorn ai.identity.forensics_api:app --host 127.0.0.1 --port 8001 --env-file .env --no-access-log`. The default `IDENTITY_RESEARCH_MODEL=none` measures OpenCV sharpness without model weights. A flat frame requires a retake. A screening outage requires a retry.
4. Set `REGISTRATION_FINGERPRINT_KEY` to a separate stable secret of at least 32 characters. Keep it stable across instances and restarts so the same verified subject and captures retain the same keys.
5. Set `REGISTRATION_REVIEWER_IDS` only for an authorized in-person workflow.
6. If using an approved machine verifier, set `REGISTRATION_VERIFIER_URL` and `REGISTRATION_VERIFIER_SECRET`. The verifier secret must differ from the fraud secret. Express only allows loopback endpoints and rejects redirects.
7. For a limited-account rollout, leave both verifier variables unset and set `REGISTRATION_BASIC_CITIZEN_ENABLED=true` in Express. In the private FastAPI service, configure `IDENTITY_RESEARCH_MODEL=freuid-a31`, `FREUID_ASSETS`, `FREUID_RESEARCH_LAYOUT`, and `REGISTRATION_CAPTURE_TESSERACT` (a local Tesseract executable with English data). The feature is off by default. Use the same fraud signer and fingerprint configuration across restarts. A missing, unsigned or image-mismatched response cannot authorize registration.

The boundary manifest pins the existing city outline from the ArcGIS city/municipal map layer and the existing PSGC-derived barangay map layer. The 61 barangay polygons and the city outline passed a Shapely topology check. The union and city reference differ by about 20.4% of the city polygon's area in the source coordinates, so enrollment uses the existing city outline. These are map references with no CPDO certification asserted. Existing report routing that requires a separately approved barangay jurisdiction continues to require that evidence. Browser GPS is a location policy input and can be spoofed.

The service keeps short-lived capture sessions in process memory. Run the capture steps on one instance or use routing affinity. A process restart invalidates in-progress captures. MySQL persists pending applications and enforces duplicate keys across instances. Pending records contain a reference, state, boundary version, advisory label and keyed proof values. Applicant facts are stored only in the existing identity record after activation. Raw captures and GPS fixes are processed in memory. An optional machine verifier must have an approved handling and retention policy.

The browser can recognize visible screen controls inside the same guide crop as an advisory signal. The crop can exclude nearby screen chrome, so production recapture detection still needs calibrated evidence.

## Screening and enrollment outcomes

Express returns `screening` with the classification, indicators and completed checks. `LOW_RISK` means screening checks ran and cleared. Independent approval is required for `VERIFIED`. FREUID research scores remain inconclusive for Philippine IDs and set no approval or rejection threshold.

`BASIC_REGISTRATION_ELIGIBLE` requires signed FREUID inference and a supported, unambiguous document number read by server-side OCR from the exact assessment JPEG. Express matches the submitted number and document type before saving the account and validates the remaining registration fields. An unreadable number requires a retake. Browser OCR still fills the existing form. A warning from a trusted fraud assessment requires a retake or review. A browser screen warning also keeps the form gated. The private local service returns extraction data only to Express, which keeps keyed document and image references and omits OCR data from the capture response.

MySQL stores the account tier `ACTIVE_LIMITED`, which the auth API exposes with `identityStatus: UNVERIFIED`. The account can sign in to see its own account, identity and report list and can change its password or sign out. Writes to reports, community and identity and admin, barangay and notification-stream access remain gated. Basic document and frame keys are separate from independently verified keys, so a limited claim cannot reserve a verified identity. There is currently no in-place upgrade workflow.

The test `tests/migrations/citizen-basic-enrollment-mysql.test.js` starts private MySQL and FastAPI, serves the live scanner and exercises the synthetic browser camera, client/server OCR, actual pretrained FREUID, database registration and login. Run it with `ENROLLMENT_TEST_TESSERACT` and `ENROLLMENT_TEST_FREUID_ASSETS`. Set `ENROLLMENT_TEST_PYTHON` and `PYTHONPATH` if needed for the local Python virtual environment. If the browser OCR CDN is unreliable, install `tesseract.js@5.1.1`, `tesseract.js-core@5.1.1` and `@tesseract.js-data/eng@1.0.0` into a test-only directory and point `ENROLLMENT_TEST_BROWSER_ASSETS` at its `node_modules`. Public rollout still requires checkpoint deployment rights, consented physical-device validation and production configuration review.

An enrollment outcome of `VERIFIED` authorizes submission of verifier-confirmed fields. `BLOCK_INVALID` is reserved for decisive, capture-bound evidence from the configured verifier. `REVIEW_REQUIRED` includes a pending application reference when successful local screening still leaves the identity unverified. `RETAKE_REQUIRED` applies to unusable captures. Invalid boundary data and a failed or unavailable screening service have distinct error codes. A dedicated monitor detector, printed-counterfeit detector, cross-application near-duplicate detection and a PhilSys-specific layout and manipulation policy still need authorized held-out evaluation.

## In-person review

1. Ask the applicant to show the pending reference in their registration tab and present the original physical ID. Keep the browser token private. The reference on its own cannot activate an account or read applicant data.
2. Use the reviewer account's existing authenticated session to call `GET /api/admin/citizen-enrollment`. The queue returns up to 50 pending references and screening labels. Pass the last item's `id` as the `after` cursor for another page. Applicants have 48 hours to obtain review.
3. Observe the live capture, inspect the original, match the applicant to the card, and confirm issuer evidence by a legitimate approved method. Investigate any warning. Leave the case pending if evidence remains inconclusive. An image model, visual resemblance to a card template, or successful OCR cannot independently satisfy these checks.
4. Record the evidence in the authorized operator's evidence system. Submit `POST /api/admin/citizen-enrollment/:reference/decision` with `decision: "approved"`, reviewed `facts`, an opaque stable `subjectReference`, a separate opaque `evidenceReference`, and the five affirmative `checks`: `issuerEvidenceChecked`, `holderPresentAndMatched`, `physicalOriginalInspected`, `liveCaptureObserved`, and `fraudChecksClear`. Reference values are 20–128 ASCII letters, digits, underscores, or hyphens. Use the same subject reference on repeat visits and keep the evidence reference traceable in the operator's case system. Never put ID numbers or names in those references.
5. Reject a conclusive failure with `decision: "rejected"` and `reason: "invalid_document"` or `"holder_mismatch"`. The decision and actor are written to the audit log in the same transaction.
6. After approval, the original tab opens the existing fields for manual entry. The applicant has 15 minutes to enter the reviewed facts, pass a fresh Bacolod GPS check, and create the account. MySQL consumes the approval and writes the user, identity, replay keys and activation audit entry in one transaction. Pending records cannot sign in.

The reviewer workflow is available through authenticated admin endpoints. Operators need an approved in-person process, an evidence system, and a way to access those endpoints. The production release requires operational signoff on those controls and the shared boundary. Authorized reviewers can approve either enrollment format after checking issuer evidence and matching the holder. LTO licenses require a valid license-number format and current expiry date. Digitally issued IDs require a separate issuer-supported flow.

## Private verifier contract

The existing optional verifier receives an authenticated multipart POST containing an opaque `captureId` and one normalized JPEG in the `frames` field. The endpoint has 12 seconds to return the matching `captureId` and a one-element `framesSha256` array. Sign the exact response bytes with HMAC-SHA-256 and the verifier secret, and send lowercase hex in `X-Registration-Verifier-Signature`. A successful approval also contains:

- `status: "approved"`
- `issuerVerified: true` after confirming issuer evidence and its agreement with the presented ID
- `holderVerified: true` after binding the verification to the applicant by an authorized method
- `liveCapturePassed: true` when the verifier has trusted evidence of live capture
- `fraudScreening.monitorRecapture`, `fraudScreening.digitalManipulation`, and `fraudScreening.imageReuse`, each `"clear"` after its check has run. Missing, uncertain, and flagged results prevent account creation.
- `subject`, a stable, opaque identifier for the verified applicant, consistent across the verifier's approved channels
- `facts` with `documentType`, `idNumber`, `fullName`, `birthDate`, `address`, and optional `expiryDate`. Dates use ISO calendar format.

With conclusive screening and no issuer or holder evidence, the automatic flow returns `VERIFICATION_REQUIRED`. Only an explicitly configured manual review workflow can queue an eligible application.

An automatic `VERIFICATION_REQUIRED` response includes `verificationReason`. Use `VERIFIER_NOT_CONFIGURED` or `VERIFIER_UNAVAILABLE` for deployment or transport problems. Use `SCREENING_UNCLEARED` when the configured assessor has not cleared the capture, and `VERIFIER_NOT_APPROVED` when screening cleared but verifier evidence did not satisfy enrollment. None of these outcomes issues approval. The existing OCR preview remains editable for eligible readable captures.

An authorized local verifier can report `status: "retake_required"` for an unreadable capture. For supported IDs, it can report `status: "rejected"` with the corresponding `documentType` and a trusted `revoked_document`, `issuer_data_mismatch`, or `confirmed_counterfeit` finding. For PhilSys it can also report `invalid_qr_signature`. Issuer evidence and holder verification require a supported verification procedure. [PSA National ID authentication guidance](https://psa.gov.ph/content/national-id-reliable-easy-authenticate-valid-id-filipinos-government-and-private)

## Independent fraud service contract

The fraud service receives an authenticated multipart POST containing `captureId` and one JPEG in the `frames` field. The response must echo `captureId` and that JPEG's SHA-256 hex digest as the sole element of `framesSha256`. The response's exact UTF-8 bytes are authenticated with the lowercase hex HMAC-SHA-256 in `X-Registration-Fraud-Signature`.

An authorized production service returns `purpose: "registration_fraud_assessment"`, `assessment: "clear"`, and a `checks` object with `monitorRecapture`, `digitalManipulation`, and `imageReuse` each set to `"clear"` after the corresponding validated check. A signed `assessment: "flagged"` can include `classification: "POTENTIALLY_FAKE"` if the local policy has validated the evidence behind that label. An optional signed `advisory` can carry a `SUSPICIOUS` or `POTENTIALLY_FAKE` classification and an array of the same check names as `indicators`. This allows an image-model warning to be shown alongside independent clearance. Signed research or review results cannot supply production clearance. Express also requires separate issuer, holder, and live capture approval.

Express screens the capture during an issuer-verifier outage. A local screening outage returns `REGISTRATION_FRAUD_UNAVAILABLE`. Local signals and uncalibrated model scores can support an OCR preview after a usable capture. Account creation still requires trusted approval.

### Issuer verification gaps

- **National ID:** PSA's National ID Check authenticates the QR payload. A front-only image does not supply the rear QR on physical cards. NeighborLens needs an approved PSA integration or a supported offline verification format with trusted issuer keys, a match against the printed fields, and approved holder verification. The QR check addresses document authenticity. PSA eVerify provides a separate holder authentication capability. [PSA authentication guidance](https://psa.gov.ph/content/national-id-reliable-easy-authenticate-valid-id-filipinos-government-and-private) · [PSA guidance on offline verification](https://psa.gov.ph/content/advisory?vcode=-25)
- **LTO Driver's License:** LTO documents certification against its license records and an LTMS QR workflow for the electronic license. Neither supplies NeighborLens with a documented, authorized automatic check for a photo of the physical license. Automatic approval needs authorized issuer evidence of the license's status and holder linkage. [LTO Citizen's Charter](https://lto.gov.ph/wp-content/uploads/2024/05/LTO_CC_05-30-2024.pdf) · [LTO electronic driver's license circular](https://www.lto.gov.ph/wp-content/uploads/2023/08/MC_HAV-2023-2410.pdf)
- **Both formats:** Automatic approval currently also requires trusted screening results for recapture, manipulation and reuse. The local FastAPI research assessor provides image signals and does not certify those checks for Philippine IDs.

## Offline research inference

Install the existing AI requirements in a research environment and add `timm==1.0.22` and `yacs==0.1.8`. Keep all weights and research images outside tracked Git files.

- For TruFor, set `IDENTITY_RESEARCH_MODEL=trufor`, `TRUFOR_SOURCE` to the pinned upstream checkout's `test_docker/src` directory, and `TRUFOR_WEIGHTS_ARCHIVE` to the original archive. The code verifies its SHA-256 before loading the tensors. The upstream code revision, archive digests, and license scope are in the research report.
- For FREUID a31, set `IDENTITY_RESEARCH_MODEL=freuid-a31`, `FREUID_ASSETS` to the directory containing the pinned `best.pt` and `field_boxes_v2.json`, and `FREUID_RESEARCH_LAYOUT` to one of the five layouts specified by the source model. There is no supplied PhilSys crop layout. Use this path to evaluate the original benchmark layouts.
- Set `IDENTITY_RESEARCH_DEVICE=cuda` on a compatible GPU or use the default CPU. Set a private `REGISTRATION_FRAUD_SECRET` of at least 32 ASCII characters, then run `python -m uvicorn ai.identity.forensics_api:app --host 127.0.0.1 --port 8001 --no-access-log`. The research API processes the single image in memory and returns model scores and OpenCV sharpness. MySQL separately enforces identity uniqueness and exact-frame reuse.

See [Phase 2.1 model and benchmark report](citizen-id-fraud-research.md) for source licenses, artifacts, and results.

## Local browser verification

New citizen enrollment opens the live camera scanner in local and public environments. Researchers can still run the standalone loopback worker with `node --env-file=.env scripts/start-freuid-diagnostic.js` against synthetic or redacted files. The worker returns research scores through its authenticated local endpoint.

Set `NEIGHBORLENS_ENROLLMENT_FIXTURE=1` and run `npm exec -- playwright test --config=playwright.registration.config.js --grep "synthetic PhilSys card|secure enrollment"`. The fixture uses an isolated loopback verifier and a synthetic card. The PhilSys test exercises real OCR, Express, identity persistence, and authenticated identity retrieval. The flag is consumed by test support only.

Run `node --test tests/migrations/citizen-enrollment-review-mysql.test.js` for the isolated MySQL scenario. It launches a real loopback FastAPI instance, applies MySQL migrations, submits synthetic captures without verifier credentials, and exercises reviewer authorization, the audit trail, and concurrent activation. Set `ENROLLMENT_TEST_PYTHON` to a Python executable with the AI dependencies installed if the default test environment differs.

### Single-capture regression commands

```powershell
node --test server/tests/automatic-enrollment-flow.test.js server/tests/registration-fraud.test.js server/tests/ocr-prefill-policy.test.js tests/integration/citizen-enrollment.test.js tests/migrations/citizen-enrollment-review-mysql.test.js
$env:NEIGHBORLENS_ENROLLMENT_FIXTURE = '1'
npx playwright test -c playwright.registration.config.js -g 'secure enrollment (freezes|runs|restores|reads visible)|upload test transitions|synthetic PhilSys card with bilingual|live-camera OCR rescan|opt-in upload'
.venv/Scripts/python.exe -m pytest ai/tests/test_identity_forensics.py ai/tests/test_identity_capture_benchmark.py -q
```

Files changed for this update:

- Scan and transport: `frontend/js/auth/auth.js`, `frontend/js/auth/authClient.js`, `frontend/js/shared/vision.js`.
- Server and configuration: `.env.example`, `server/composition.js`, `server/application/use-cases/citizenEnrollment.service.js`, `server/application/use-cases/citizenEnrollmentReview.service.js`, `server/domain/identity/idScreening.js`, `server/domain/identity/ocrPrefillPolicy.js`, `server/infrastructure/adapters/registrationVerifier.js`.
- Research: `ai/identity/forensics_api.py`, `ai/identity/benchmark_capture_cohorts.py`, `docs/citizen-id-fraud-research.md`.
- Tests: `server/tests/automatic-enrollment-flow.test.js`, `server/tests/ocr-prefill-policy.test.js`, `server/tests/registration-fraud.test.js`, `tests/browser/registration.spec.js`, `tests/integration/citizen-enrollment.test.js`, `tests/migrations/citizen-enrollment-review-mysql.test.js`, `tests/support/enrollment-verifier-fixture.js`.
- Local Postman files: `docs/qa/NeighborLens.postman_collection.json`, `docs/qa/synthetic-front.jpg`, and `docs/qa/synthetic-angle.jpg`. The second image is an alternative fixture for a fresh session.

## Local image reuse evaluation

Run `python -m ai.identity.benchmark_image_reuse pairs.csv --max-distance N` with an explicit candidate threshold and synthetic or consented local fixtures only. The manifest columns are `reference,capture,same_source`, where `same_source` is 0 or 1 and paths are relative to the manifest. Keep the manifest and fixtures outside the repository. The output is aggregate perceptual-hash match counts and mean Laplacian variance. These signals measure image similarity and sharpness. The tool has no issuer lookup, screen-recapture classifier, or FREUID weights.

## Monitor and AI-edit benchmark

Run `python -m ai.identity.benchmark_fraud_scores held-out.csv --threshold T --max-false-alarm F --max-missed-attack M` on scores from the selected model. Use CSV columns `sample_id,category,fraud_score` with pseudonymous sample IDs and categories `genuine`, `monitor_recapture`, and `ai_edited`. Pick the threshold and acceptable limits before opening the held-out results. Use independently captured test examples and keep source documents and capture sessions separated from training and calibration. For device and lighting comparisons, run a separate manifest per held-out cohort using the same threshold and matching genuine controls. Scores at or above the threshold indicate a flag. The command reports precision, recall, F1, false-positive and false-negative rates per attack category, and one-sided 95% error bounds. It exits 1 when any upper error bound exceeds the selected limit, or 2 for malformed or incomplete input. It reads scores only and does not run a model or authorize enrollment.
