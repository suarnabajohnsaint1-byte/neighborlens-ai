# QA bug register

Latest continuation: [27 October Report Details full regression](report-details-full-regression-2026-10-27.md). Release remains YELLOW. Five additional defects were fixed; final Node and isolated MySQL suites pass. Earlier dated tables below remain historical evidence, not the latest aggregate result.


Date: 26 October 2026. Environment for all entries: local Windows working tree, temporary SQLite or verified disposable MySQL 8.0.46, Chromium, and local Python inference where specified. Evidence filenames below are relative to `.data/qa-2026-10-26/`. Test data and credentials were isolated. P0–P3 refers to software risk, not infrastructure damage severity.

## QA-001 — Retried report submission creates duplicates or rejects a saved report

- Severity/priority: P1 High; Citizen, backend, persistence.
- Reproduce: submit a valid two-photo report, lose its successful response, retry identical content with the same key; also submit two concurrent copies.
- Expected: return one original report. Actual before: signed retry raised proof replay conflict; manual requests ignored their key and created duplicate reports/publication work.
- Root cause: report creation lacked an idempotency boundary; Citizen's asynchronous submit handler could reenter before validation finished.
- Files: `report.service.js`, `report.repository.js`, `audit.service.js`, `auditLog.repository.js`, `citizen.js`, shared `reports.js`.
- Fix: hash validated content and bytes; actor-row transaction lock and audit lookup; matching replay returns original; different payload conflicts; unused uploads are cleaned. Citizen guards active submission and snapshots location before awaits.
- Regression/evidence: `tests/integration/qa-report-retry.test.js`; new retry/double-submit cases in `community-publication.spec.js`; `qa-backend-lifecycle-mysql.test.js`. `report-retry-before.log` has three failures; `report-retry-final.log`, `publication-final.log` and `fullstack-live-ai-mysql.log` verify the fix.
- Status: fixed and verified, including actual concurrent MySQL requests. Optional absent keys remain backward compatible; new Citizen requests always send a key. Audit lookup scans that actor's create events; long-history indexing is a future performance concern, not a measured improvement.

## QA-002 — Unknown severity persisted as low

- Severity/priority: P2 Medium; AI/MySQL/backend.
- Reproduce: persist verification with `highestSeverity: null` after an assessment that provides no severity.
- Expected: SQL NULL/unassessed. Actual before: repository substituted `low`.
- Root cause: truthy fallback plus historical NOT NULL schema.
- Files: `damageVerification.repository.js`, migration/rollback `015_nullable_verification_severity.sql`, SQLite schema and schema version.
- Fix: nullish mapping and nullable column; no inferred backfill.
- Regression/evidence: `server/tests/qa-severity-persistence.test.js`, `tests/migrations/qa-severity-mysql.test.js`; `severity-regression-before.log`, `severity-migration-final.log` (eight focused cases).
- Status: fixed and verified on disposable databases only. Deployment migration remains an operator action. Legacy low values remain intact.

## QA-003 — Invalid AI geometry accepted as valid evidence

- Severity/priority: P2 Medium; AI contract/backend/UI.
- Reproduce: provider returns negative box size/origin, nonfinite coordinates, out-of-bounds rectangle, malformed dimensions or no prediction array.
- Expected: reject malformed provider response; an explicit empty array remains a valid no-detection result. Actual before: malformed evidence could pass normalization and be signed.
- Root cause: response normalization validated labels/confidence without equivalent geometry/shape checks.
- Files: `damageDetection.rules.js`, `damageDetection.service.js`.
- Fix: validate supplied geometry and image dimensions before assessment signing; require a prediction array. Missing optional geometry remains supported.
- Regression/evidence: `qa-inference-contract.test.js`; `inference-contract-before.log` (eight failures), `inference-contract-final.log` (62 related cases passed).
- Status: fixed and verified. Real local prediction probes also recorded zero supplied box-bound violations.

## QA-004 — Upstream AI error text exposed to clients

- Severity/priority: P2 Medium; backend security.
- Reproduce: inference provider returns an HTTP error containing internal details.
- Expected: safe application error. Actual before: adapters copied provider `.error`/`.detail` into user-facing exceptions.
- Root cause: raw upstream text was treated as safe error text.
- Files: `localYoloClient.js`, `roboflowClient.js`.
- Fix: generic provider/status failure message, preserving error classification.
- Regression/evidence: provider-text regression in `qa-inference-contract.test.js`; `inference-contract-final.log`.
- Status: fixed and verified. This does not prove unrelated logs never contain sensitive values.

## QA-005 — Applied migration checksum drift ignored

- Severity/priority: P2 Medium; MySQL tooling.
- Reproduce: alter the contents of an already tracked migration, then invoke the runner.
- Expected: fail before opening a migration transaction. Actual before: tracked filename was silently skipped regardless of stored checksum.
- Root cause: runner selected filenames but did not compare checksum metadata.
- File: `mysql/migrationRunner.js`.
- Fix: compare stored checksum with the existing file and require an additive migration on mismatch. Accept equivalent LF/CRLF checkout hashes, preserving Windows-to-Linux migration history without accepting changed SQL content.
- Regression/evidence: new `migration-runner.test.js` cases; `migration-drift-before.log`, `migration-line-endings-before.log`, `migrations-line-endings-final.log`.
- Status: fixed and verified. No existing applied SQL was rewritten.

## QA-006 — Destructive test helper could connect to a hosted database

- Severity/priority: P1 High preventive security; test infrastructure/MySQL.
- Reproduce safely: invoke test connection configuration with a fake nonloopback hostname and a recording connection stub.
- Expected: reject before any connection. Actual before: helper accepted arbitrary `DB_HOST` and could reach a configured hosted server before destructive test setup.
- Root cause: name isolation existed without host isolation in all paths.
- Files: `tests/support/local-test-target.js`, `mysql-test-db.js`, `report-analytics.mysql.test.js`, `mysql-runtime.e2e.test.js`.
- Fix: loopback-only host and safe `_test` database-name guards. New `run-isolated-mysql.js` starts a private daemon for repeatable runtime testing.
- Regression/evidence: `qa-test-isolation.test.js`, `test-isolation-final.log`; connection attempts remain zero for the rejected host. No hosted connection was attempted.
- Status: fixed and verified. No production data loss was observed or simulated.

## QA-007 — Stale concurrent operational update returns validation instead of conflict

- Severity/priority: P2 Medium; backend/Barangay/Admin.
- Reproduce: race two different ongoing commands against the same pending report.
- Expected: one state change, competing stale command conflicts. Actual before: the locked second command failed as an ordinary invalid transition.
- Root cause: state read before the lock was not compared with the locked state.
- File: `report.service.js`.
- Fix: check stale status after idempotency replay lookup and before transition validation.
- Regression/evidence: actual concurrent MySQL status test in `report-analytics.mysql.test.js`; `mysql-runtime-final.log` and `mysql-wrapper-verified.log` (43 passed).
- Status: fixed and verified. Resolution evidence requirements are unchanged.

## QA-008 — EvidenceZoom gestures execute twice

- Severity/priority: P2 Medium; shared evidence viewer/all portals.
- Reproduce: dispatch wheel or double-click on the actual image inside its viewport.
- Expected: one zoom step or one toggle. Actual before: bubbling invoked both image and viewport handlers, producing two steps or cancelling the toggle.
- Root cause: the same gestures were bound to both nested targets.
- File: `evidenceZoom.js`.
- Fix: bind one viewport target, falling back to the image when no viewport exists.
- Regression/evidence: bubbling regression in `tests/unit/evidence-zoom.test.js`; `zoom-before.log` (one failure), `zoom-final.log` (24 passed); browser details coverage.
- Status: fixed and verified.

## QA-009 — Dark error text fails readable contrast

- Severity/priority: P2 Medium; accessibility/all portals.
- Reproduce: show danger feedback on dark surfaces and compute foreground/background contrast.
- Expected: at least 4.5:1 for normal text. Actual before: approximately 1.98:1.
- Root cause: dark danger token reused a dark foreground.
- File: `themes.css`.
- Fix: use existing light danger foreground with a dark subtle surface.
- Regression/evidence: theme contrast browser case in `theme.cases.js`; baseline/final Report Details browser logs.
- Status: fixed and verified by computed CSS contrast, not a complete accessibility certification.

## QA-010 — Static loading row remains below real reports

- Severity/priority: P2 Medium; shared Admin/Barangay table.
- Reproduce: mount a table with its HTML loading placeholder and render ten actual records.
- Expected: ten data rows, no loading placeholder. Actual before: eleven rows including stale Loading.
- Root cause: reconciliation owned keyed data rows but never removed the original static body contents.
- File: `reportManagement.js`.
- Fix: release initial media and clear the body when taking ownership.
- Regression/evidence: static-placeholder case in `shared-reports.spec.js`; `table-loading-before.log`, `table-loading-final.log`; ten-row overview browser assertion retained.
- Status: fixed and verified.

## QA-011 — Atomic model promotion fails on Windows

- Severity/priority: P2 Medium; offline AI release tooling.
- Reproduce: run promotion tests against temporary checkpoints on Windows.
- Expected: fsync succeeds before atomic replacement. Actual before: bad file descriptor from fsync.
- Root cause: temporary target was reopened read-only before flushing.
- File: `ai/training/promote_production_model.py`.
- Fix: reopen with `r+b` before fsync.
- Regression/evidence: existing production-promotion tests; `python-baseline.log`, `python-final.log` (170 passed, one unavailable historical dataset skipped).
- Status: fixed and verified using temporary model fixtures. Production weights were never promoted or changed.

## QA-012 — Cosine similarity exceeds its valid range

- Severity/priority: P3 Low; AI pair similarity.
- Reproduce: compare identical float32 embedding vectors.
- Expected: similarity within [-1, 1]. Actual before: floating-point rounding produced 1.000000119.
- Root cause: unbounded floating-point dot product.
- File: `image_similarity.py`.
- Fix: clamp only the computed numerical result to the valid cosine range.
- Regression/evidence: existing similarity tests; `python-baseline.log`, `python-final.log`.
- Status: fixed and verified; no similarity acceptance thresholds changed.

## QA-013 — Dataset audit mixes path separators on Windows

- Severity/priority: P3 Low; offline AI dataset audit.
- Reproduce: audit nested dataset directories on Windows.
- Expected: consistent relative POSIX paths. Actual before: nested directory entries used backslashes while other entries used slashes.
- Root cause: platform-dependent string conversion.
- File: `audit_raw_images.py`.
- Fix: use `as_posix()` for nested relative directory values.
- Regression/evidence: existing raw-image audit test; `python-baseline.log`, `python-final.log`.
- Status: fixed and verified.

## QA-014 — Immediate Excel export ignores pending search

- Severity/priority: P2 Medium; Admin/Barangay export.
- Reproduce: type a filter, immediately click Export twice before the 250 ms debounce finishes.
- Expected: one workbook containing 350 matching fixture records. Actual before: the workbook included eight unrelated records (359 worksheet rows including heading).
- Root cause: export's direct listener ran before the parent committed its pending search.
- File: `reportManagement.js`.
- Fix: capture the export click and commit pending search before the existing export handler reads query state; remove listener on destroy.
- Regression/evidence: `phase0-security-browser.test.js` real filtered workbook assertion; `mysql-migrations-final.log` (before), `migrations-browser-verified.log` and `phase0-final.log` (after).
- Status: fixed and verified for both actual browser downloads. No export permission/filter rule was loosened.

## QA-015 — Active review tab can move outside its scroll region after text resize

- Severity/priority: P2 Medium; shared responsive report controls.
- Reproduce: enter Community Review, resize 375 → 768 → 1440 while fonts/text metrics settle.
- Expected: active tab remains fully visible in its local strip. Actual before: responsive assertion failed despite no document overflow.
- Root cause: resize observer watched only the strip, not button width changes.
- File: `reportManagement.js`.
- Fix: observe the existing tab buttons as well as their parent using the same observer and teardown.
- Regression/evidence: `community-publication-mysql.test.js` active-tab bounds assertion; `publication-layout-diagnostic.log` captures the failing run. Final verification is recorded in the overall suite ledger.
- Status: fixed and verified; `publication-command-final.log` records all 50 publication cases passing, including the active-tab bounds assertion.

## QA-016 — Canonical model release differs from historical expected identity

- Severity/priority: P2 Medium; model release provenance.
- Reproduce: load `models/production/best.pt` and inspect architecture, training name, class mapping and release manifest.
- Expected: an approved, documented production identity. Actual: YOLO11s `beta_testing_v3` with the correct four classes, whereas previous project descriptions specify YOLOv8m; no production manifest exists.
- Root cause: deployment artifact and historical documentation lack a reconciled release record.
- Affected paths: `models/production/best.pt`, production release documentation/manifest (not changed).
- Evidence: `model-identity.json`, `live-ai-results.json`, `heldout-metrics.json`.
- Status: open. Owner must approve the intended checkpoint/release identity. QA did not swap weights or fabricate a manifest approval.
- Regression: identity/class/hash were actually inspected; deciding which model is intended requires release ownership.

## QA-017 — Admin mobile More filters opens an invisible sheet

- Severity/priority: P2 Medium; Admin/shared filter accessibility.
- Reproduce: open Admin reports at mobile width and press More filters. Try selecting Barangay.
- Expected: the advanced-filter dialog is visible, usable, and applies/restores the query after reload. Actual before: `is-open` and `aria-expanded=true` were set, but the element still had `hidden=true` and computed `display:none`.
- Root cause: the sheet controller changed classes but did not clear the hidden attribute. Admin's global `[hidden]` rule has `!important`, so the responsive open class could not make it visible.
- File: `frontend/js/shared/portalComponents.js`.
- Fix: save the previous hidden state, clear it on opening, restore it on closing; keep the existing focus/backdrop/resize lifecycle.
- Regression/evidence: mobile Admin hard-refresh/filter browser case; `mobile-filter-diagnostic.log` captures the failing computed state. `details-overlay-final.log` passes four desktop/mobile refresh/sidebar cases, including selecting and applying the filter and preserving it on reload.
- Status: fixed and verified. No forced selection or hidden-control interaction was used to bypass the bug.

## Coverage and policy gaps, not invented code failures

No physical Minor/Major severity criteria or supported manual severity override/history were found. Unknown severity remains unassessed. Real cloud storage, deployed Vercel/Render, other browser engines, physical cameras, long-duration memory behavior and near-duplicate dataset leakage remain unverified. See `backend-ai-qa-report.md`.

Several baseline failures were stale tests, not application defects: View Details now navigates a full page; Review Post remains a review dialog; default overview pagination is five; a threaded-reply fixture stopped after seven five-row pages even though more remained. Tests were aligned to current behavior while retaining authorization, complete-record-count, focus, workbook-content and DOM assertions. Global rate limits remain enabled; large browser suites respect Retry-After instead of disabling protection.

## 27 October follow-up

QA-016 remains open under the explicit YOLOv8 ≥68% validation target. Current production is still YOLO11s. The 31-model inventory and common validation/test comparison are in the backend/AI report; no YOLOv8 candidate qualifies and the training readiness gates fail. Model files were not changed. Missing approved numeric LGU thresholds no longer blocks a supported manual workflow: the owner explicitly chose REVIEW_REQUIRED followed by reviewer confirmation.

## QA-018 — Operational rejection lacks a required reason and staff control

- Priority: P2 Medium; report workflow/backend/UI.
- Reproduce: authorized staff submits a rejected status with no note; inspect shared staff details for a supported rejection action.
- Expected: a deliberate confirmed rejection with meaningful reason, actor, history, owner notification and no publication-state side effect. Before: domain allowed reasonless rejection while shared controls omitted rejection.
- Root cause: rejection was not included in the shared allowed-control list and proof validation only addressed ongoing/resolved actions; owner notifications did not include the rejection rationale. A notification persistence error was caught after the status had already committed, leaving a rejected report without its owner notification.
- Fix: reusable vocabulary exposes permitted rejection, domain validates meaningful 10-character minimum reason, UI confirms the terminal action, existing transaction/idempotency/history/audit is retained, and notification includes the reason. Rejection notification persistence now shares the status/history/audit transaction; publishing occurs after commit. A controlled notification write failure rolls all of these records back. No citizen or foreign-Barangay permission is added.
- Files: shared `reportVocabulary.js`, `report.rules.js`, `report.service.js`, `notification.service.js`, `reportDetailsView.js`.
- Evidence: two failing-before/two passing-after rejection policy tests, plus a reproduced notification-failure rollback regression; shared SQLite/private MySQL scenarios test reasonless/unauthorized rejection, exact retry, terminal transition and unchanged pending publication. Browser scenarios exercise cancel/confirm/history/owner notification. Old rejection fixtures now supply a reason and assert the response instead of silently creating invalid fixtures.
- Status: fixed and locally verified. Evidence directory: `.data/remediation-2026-10-26/`.

## QA-019 — Pending Posts retry can be discarded during a finishing load

- Priority: P2 Medium; Admin publication review.
- Reproduce: load the queue, force a queue outage, reload, remove the outage and click Pending Posts while its loading flag is still set.
- Expected: queue recovers without another navigation. Before: Pending Posts stayed Unavailable despite restored service.
- Root cause: `setAdminReportMode` skipped `loadPublicationQueue` while loading; its existing coalescing/reload branch was never reached for that retry.
- Fix: always call the existing coalescing loader when entering review mode; the loader retains one follow-up request rather than dropping user intent.
- File: `frontend/js/admin/admin_logic.js`.
- Regression: existing private-MySQL Pending Posts outage/retry, oldest-first pagination, real unread counts and empty/loading state test. The first full migration run reproduced this failure; the complete publication migration suite then passed after the fix. No assertion was weakened.
- Status: fixed and locally verified.

New workflow regression coverage also verifies that refresh does not replace focused measurement fields, silently advance a stale reviewer draft’s expected version, or reset its evidence. A conflict exposes an explicit latest-assessment reload. These safeguards cover the newly introduced review panel and are not counted as additional historical defects.

Final regression evidence: `node-release-final.log` 1,116 passed; `migrations-release-complete.log` 115 passed/1 optional skipped/zero failed; `details-release-complete.log` 156 passed; `review-browser-release.log` 8 passed; `shared-release-final.log` 16 passed. Rejection notification rollback was reproduced in `rejection-notification-before.log` and verified after the transactional fix in `rejection-notification-verified.log` (35 passed). See the overall report for the remaining complete suite results. Eighteen of nineteen confirmed defects are fixed and locally verified; QA-016 remains open.

## QA-020 — P1 High: operational status notification outside the transaction

Ongoing/resolved changes could return success with committed status/history despite notification persistence failure. Reproduced with a failing repository write. All status notifications now share the report/proof/history/audit transaction and publish after commit; retries remain idempotent. Private MySQL verifies failed completion cleanup before successful retry. See the focused full-regression report and `status-notification-before.log`, `real-ai-mysql.log`.

## QA-021 — P2 Medium: stale incident progress on shared refresh

Unchanged report signatures skipped the incident panel. A Citizen could keep seeing no linked incident after an authorized duplicate confirmation. Shared refresh now reloads incident state, reveals new membership, ignores superseded responses and keeps honest setup/error feedback. Failing-before browser coverage and final desktop/mobile reruns are retained.

## QA-022 — P2 Medium: activity omitted the stored reviewer

The history API returned the authorized staff actor but the presentation discarded it. The shared timeline now renders the escaped stored username. Redacted Citizen history does not gain private reviewer information, and missing actors are not guessed. Unit red/green logs and staff screenshots verify the change.

## QA-023 — P2 Medium: severity editor caused excessive Barangay scrolling

The full editor was always expanded below operational controls. A native accessible disclosure now keeps the current assessment visible and allows explicit editing without hiding operational actions. Draft/open state survive refresh. The corresponding 1440px ongoing fixture shrank from 2,399px to 1,878px; validation is unchanged.

## QA-024 — P2 Medium: comment Refresh dropped during an active request

A delayed comments response could restore a deleted comment because the second Refresh was discarded. The loader now coalesces one follow-up request and avoids detached DOM updates. The browser regression holds a real response, deletes through the real API, then verifies the latest empty state after refresh.

All five are fixed in source and verified in isolated tests. See [the full regression report](report-details-full-regression-2026-10-27.md) for exact commands, counts, screenshots, retained failures, target blockers and rollback limits. Existing model provenance/promotion and official boundary gaps remain separate; no GREEN deployment claim follows from isolated passes.
