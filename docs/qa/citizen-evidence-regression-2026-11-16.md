# Citizen report evidence regression

## Findings

- **High. Duplicate evidence could satisfy the two-view requirement.** The Citizen Portal sent one inference request per photo and treated scene similarity as advisory. Two matching predictions could display `DETECTED` even when the inputs were identical. The report endpoint hashed bytes for retry keys and signed proof binding, then persisted matching bytes as two attachments. The old browser regression explicitly expected identical copies to pass.
- **High. Inference confidence could make unsuitable evidence appear confirmed.** The upload checks established that the file decoded as a supported image. The four-class detector could still assign a supported damage class to a software screen. The previous [backend QA report](backend-ai-qa-report.md) documented class false positives, and the [annotation guideline](../dataset_audit/ANNOTATION_GUIDELINE.md) already identified duplicate scenes as a dataset risk. Neither was an intake control.
- A direct FastAPI predictor probe with the existing local production checkpoint identified both Camo Studio crops as `broken_streetlight` at **77.08%** and **78.09%**. These inputs are cropped from the supplied browser screenshot. It displayed **78.9%** for the original capture.

## Intake and review

| Case | API behavior | Citizen and persistence behavior |
| --- | --- | --- |
| Identical bytes or a convincing normalized copy | HTTP 422, `DUPLICATE_EVIDENCE` | Retake from different angles. No AI proof or new report. |
| Obvious unsuitable content | HTTP 422, `INVALID_EVIDENCE` | Replace the photo. No bounding boxes, proof, or new report. |
| Ambiguous evidence | HTTP 200 assessment, `EVIDENCE_REVIEW_REQUIRED` | Retake or submit for manual Barangay review. A submitted report is pending with no confirmed AI detection. |
| Distinct photos | Both photos proceed to the existing inference policy | Normal category suggestions, correction and low-confidence reporting remain available. |

The paired preview validates both files before calling YOLO. The report endpoint checks the uploaded bytes independently, including submissions that omit AI proofs. It still verifies any supplied proofs for ownership, photo order, SHA-256, expiry and replay protections. A retry of an already-persisted, matching request still returns the original report. FastAPI also rejects exact copies on its direct pair endpoint before matching or inference. Barangay and Admin permissions, GPS checks, and the existing Admin publication review continue to apply.

The perceptual comparison uses an orientation-corrected 96 × 96 RGB sample. The hard duplicate threshold requires a log aspect-ratio difference of at most 0.015, mean maximum-channel distance of at most 4 on the 0–255 scale, and at least 96% of pixels within 12. The review range allows a ratio difference of up to 0.07, mean distance up to 12, and at least 64% of pixels within 12. Scene similarity does not decide evidence duplication.

Suitability uses flat regions and color distribution to catch obvious graphics, including both tested Camo crops and a simple flat-color icon. It sent 6 of 203 decodable `data/raw` images to review and hard-rejected none. This is a local sanity check. A validated benchmark must cover real nighttime photos, edited copies, varied UI screenshots, screen photos, and other out-of-domain inputs. This heuristic cannot authenticate a photo, detect AI-generated content reliably, or reliably identify heavily cropped and transformed copies. Ambiguous evidence enters the existing pending workflow. Reviewers must confirm distinct views or request replacements. A separate queue or automatic publication hold would require an explicit policy decision.

## Changes

- `.gitignore` includes this audit in the repository's QA document exceptions.
- Citizen preview and report display. `frontend/citizen.html`, `frontend/js/citizen/citizen.js`, `frontend/js/citizen/damagePairAssessment.js`, `frontend/js/citizen/yoloDamageDetector.js`, `frontend/js/shared/reportPresentation.js`.
- Node evidence rules and runtime. `server/application/use-cases/damageDetection.service.js`, `server/application/use-cases/report.service.js`, `server/application/use-cases/reportEvidence.js`, `server/domain/reports/evidenceSuitability.rules.js`, `server/domain/reports/submissionAssessment.rules.js`, `server/infrastructure/storage/imageInput.adapter.js`, `server/presentation/http/controllers/ai.controller.js`.
- Direct FastAPI guard and contract test. `ai/inference/inference_api.py`, `ai/tests/test_inference_api_contract.py`.
- Unit regressions. `server/tests/application-ports.test.js`, `server/tests/assessment-evidence-remediation.test.js`, `server/tests/damage-contract.test.js`, `server/tests/damage-detection.test.js`, `server/tests/pair-stability.test.js`, `server/tests/report.service.storage.test.js`, `server/tests/report.service.test.js`.
- Browser regressions. `tests/browser/auth-design.cases.js`, `tests/browser/phase-1b.spec.js`, `tests/browser/phase-2.spec.js`, `tests/browser/report-details.spec.js`.
- Node integration regressions. `tests/integration/ai-upload-memory.test.js`, `tests/integration/audit-remediation.test.js`, `tests/integration/backend-qa.test.js`, `tests/integration/citizen-ai-damage.test.js`, `tests/integration/citizen-ai-frontend.test.js`, `tests/integration/notification-security.test.js`, `tests/integration/notifications.test.js`, `tests/integration/phase-1b-pair-workflow.test.js`, `tests/integration/phase-2-correction.test.js`, `tests/integration/report-evidence.test.js`, `tests/integration/report-image-security.test.js`, `tests/integration/report-transaction-rollback.test.js`, `tests/integration/report-workflow.test.js`, `tests/integration/reports.test.js`, `tests/integration/supabase-transaction-rollback.test.js`.
- MySQL regression fixtures. `tests/e2e/mysql-runtime.e2e.test.js`, `tests/migrations/community-publication-mysql.test.js`, `tests/migrations/qa-backend-lifecycle-mysql.test.js`, `tests/mysql/fullstack-auth.mysql.test.js`, `tests/mysql/multi-admin-isolation.mysql.test.js`.
- `tests/support/image-fixtures.js` loads six files from `tests/fixtures/report-evidence/`. `camo-studio.png` and `camo-studio-second.png` contain only the evidence previews from the user-provided screenshot. `road-angle-a.jpg`, `road-angle-b.jpg`, `road-other.png`, and `road-other.webp` are metadata-stripped derivatives of existing `data/raw/damages_road/` files `2.jpg`, `25.jpg`, `11.jpg`, and `24.jpg`, respectively. They are application test fixtures.

## Verification

- `node --test tests/integration/report-evidence.test.js` — 8 passed. The same fixture pairs hit both assessment routes and direct report submission. Rejected inputs leave the report, attachment, publication-request and upload counts unchanged. The stub would return a 78.9% positive for rejected inputs if invoked. The tests assert zero provider calls for those inputs.
- `.venv-yolo/Scripts/python.exe -m pytest -q ai/tests/test_inference_api_contract.py` — 32 passed.
- `node --test tests/migrations/qa-backend-lifecycle-mysql.test.js` with the local FastAPI service and the two raw alternate-view fixtures — 5 passed against private MySQL 8.0.46. This verifies rejection without writes, real inference through Node, signed assessment persistence, retry safety, and report authorization. The before/after SHA-256 of `models/production/best.pt` matched.
- `npm run test:e2e:browser` — 20 passed on desktop and mobile Chromium.
- `npm run test:e2e:phase2` filtered to Camo, borderline duplicates, the normal assessment, and stale proof responses — 8 passed on desktop and mobile Chromium.
- `npm run test:e2e:details` filtered to camera capture and the two-photo scan — 4 passed on desktop and mobile Chromium.
- `npm test` — 1,169 passed and 14 failed. The untouched `14f742c` baseline reproduced the same 14 failures in `admin-account-manager.test.js`, `client-geofence.test.js`, and `geofence-reacquisition.test.js`.
