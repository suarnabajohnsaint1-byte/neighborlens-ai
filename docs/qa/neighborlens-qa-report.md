# NeighborLens QA assessment

Latest continuation: [27 October Report Details full regression](report-details-full-regression-2026-10-27.md). Release remains YELLOW. Five additional defects were fixed; final Node and isolated MySQL suites pass. Earlier dated tables below remain historical evidence, not the latest aggregate result.


Date: 26 October 2026. Starting branch: `feature/brgy-com-feed-brgy-proof/24/10-2026`; starting HEAD: `ad816a6`. The working tree and index were clean at the initial audit. Recent changes included shared report UI/full-page details and removal of comments. No AGENTS file or existing GitHub workflow was found. Existing `docs/audits/barangay-beta-remediation.md` was reviewed and retained.

## Decision

**YELLOW: local core backend, publication and real AI/MySQL integration verified; release-specific work remains.** No P0 was confirmed in the executed scope. Two P1 findings were fixed: duplicate/lost-ack report submissions and unsafe destructive-test host targeting. This is not approval to deploy against Aiven or to describe the model as an approved YOLOv8m release.

The observed checkpoint remains YOLO11s `beta_testing_v3`; the newly required release architecture is YOLOv8 with validation mAP@50 ≥68%. No evaluated YOLOv8 candidate meets that gate. The user-approved review-required default and authorized manual severity/history workflow are now implemented; no unapproved physical thresholds are supplied. See the 27 October remediation section below.

## Confirmed defect count

| Priority | Confirmed | Fixed and verified | Open |
| --- | ---: | ---: | ---: |
| P0 Critical | 0 | 0 | 0 |
| P1 High | 2 | 2 | 0 |
| P2 Medium | 15 | 14 | 1 |
| P3 Low | 2 | 2 | 0 |
| Total | 19 | 18 | 1 |

QA-016 is the open model provenance issue. Missing physical severity policy is reported separately as a business-rule/coverage gap, not counted as an invented implementation failure. No unknown severity is now silently manufactured as low. QA-017 also fixes the Admin mobile advanced-filter dialog that remained hidden despite its open state. Full defect reproduction, expected/actual behavior, root causes, affected files, fixes and regressions are in [the bug register](bug-register.md).

## Environment and safety

Windows; Node 22.17.0/npm 10.9.2; MySQL 8.0.46; Python 3.13.7 virtual environment; torch 2.14.0+cu126; Ultralytics 8.4.150; FastAPI 0.141.1; CUDA available; Chromium desktop/mobile emulation. Requirements pin Ultralytics 8.4.152, so reproducibility against that exact pin remains unverified.

The configured MySQL host was `127.0.0.1`, port 3306, database `neighborlens_ai`. Only a read-only schema/account-status inventory was made there; no identities, password hashes or secrets were reported. It tracked migrations 001–014 and already allowed nullable verification severity, a schema drift from tracked SQL. Functional database tests used new temporary datadirs/random loopback ports and checked server identity. Other integration/browser tests explicitly injected temporary SQLite. Test processes used local storage even though the normal environment selected Supabase. No configured local database, Aiven database, Supabase object or production account was mutated.

Frontend HTML is served by the existing Express static routes. Test servers use the real app with controlled database/inference adapters and loopback URLs. Tests distinguish a separate cross-origin static frontend from same-origin backend serving where applicable. The actual local AI server used port 8016; no assumption that `127.0.0.1` inside Vercel points to Render was made. No live remote inference was invoked.

## Suite ledger

Current inventory: 42 `server/tests/*.test.js` files, 46 integration test files, nine migration test files, three actual-MySQL runtime test files, three opt-in E2E files, seven browser specs plus four imported browser case modules, 13 Python test modules, one standalone EvidenceZoom unit file and one deferred severity regression. File counts are inventory, not execution totals. Browser configurations were inspected for server ports, fixture adapters, teardown, network calls and desktop/mobile projects before running them.

Evidence filenames are under `.data/qa-2026-10-26/`. Logs/screenshots are local ignored artifacts; publish only redacted copies. Node TAP totals include parent test cases, so they are not comparable with leaf-only registration counts. Do not sum overlapping suites: security, publication and focused regressions overlap the main Node and migration suites.

| Run | Total | Passed | Failed | Skipped | Not run/blocked | Environment and evidence |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Initial unit command | 502 | 502 | 0 | 0 | 0 | temporary SQLite; `unit-baseline.log` |
| Initial integration command | 569 | 567 | 2 | 0 | 0 | temporary SQLite/controlled adapters; `integration-baseline.log` |
| Final combined `npm test` | 1092 | 1092 | 0 | 0 | 0 | unit + integration; `node-final-acceptance.log` |
| Focused security command | 41 | 41 | 0 | 0 | 0 | same safety fixtures; `security-verified.log` |
| Initial opt-in `test:e2e` | 3 | 0 | 0 | 3 | opt-in runtime/cloud environments not enabled | `e2e-baseline.log`; skipped is not passed |
| Actual `test:mysql` runtime | 43 | 43 | 0 | 0 | 0 | private daemon; `mysql-runtime-final.log` |
| Reusable private MySQL runner | 43 | 43 | 0 | 0 | 0 | new private daemon; `mysql-wrapper-verified.log`, 42.55 s |
| Initial Python | 171 | 163 | 8 | 0 | 0 | temporary fixtures; `python-baseline.log` |
| Final Python | 171 | 170 | 0 | 1 | historical v2 dataset unavailable | `python-final.log`, 67.79 s; 14 dependency deprecation warnings |
| EvidenceZoom | 24 | 24 | 0 | 0 | 0 | simulated DOM gestures including bubbling; `zoom-final.log` |
| Complete details run before QA-017 fix | 156 | 155 | 1 | 0 | 0 | `details-acceptance.log`; failed case resolved by the focused run below |
| Final filter/sidebar regression | 4 | 4 | 0 | 0 | 0 | after QA-017 fix; `details-overlay-final.log` |
| Barangay sheet/resize regression | 2 | 2 | 0 | 0 | 0 | after shared sheet fix; `barangay-overlay-final.log`, 25.4 s |
| Phase 1 browser command | 20 | 20 | 0 | 0 | 0 | Chromium desktop/mobile; `browser-phase1-baseline.log` |
| Phase 2 browser final | 44 | 44 | 0 | 0 | 0 | real authorized staff fixtures; `phase2-complete.log`, 2.4 min |
| Publication browser command | 14 | 14 | 0 | 0 | 0 | Chromium desktop/mobile; `publication-final.log` |
| Shared responsive reports | 16 | 16 | 0 | 0 | 0 | Chromium, all required widths/themes; `shared-verified.log`, 3.5 min |
| Barangay browser final | 32 | 32 | 0 | 0 | 0 | Chromium desktop/mobile; `barangay-final.log`, 2.2 min |
| Actual publication/MySQL command | 50 | 50 | 0 | 0 | 0 | `npm run test:publication`; `publication-command-final.log`, 64.83 s |
| Phase0 private MySQL/browser | 13 | 13 | 0 | 0 | 0 | `phase0-final.log`, 65.29 s |
| Real AI → Node → MySQL | 4 | 4 | 0 | 0 | 0 | actual checkpoint/API and private SQL; `fullstack-live-ai-mysql.log` |
| Severity migration/runner focus | 9 | 9 | 0 | 0 | 0 | private MySQL and controlled runner, including LF/CRLF history; `migrations-line-endings-final.log` |
| Other isolated migrations final | 59 | 58 | 0 | 1 | real-AI child intentionally disabled in this run | `migrations-other-verified.log`, 379.47 s; includes 66-case registration browser child, all passed |

The complete details run below exposed QA-017; its final focused rerun passes after the shared sheet fix. Earlier failures remain in their logs; final passing runs do not erase their history. The final migration coverage is the disjoint migration files in the publication command, phase0 command and other-migrations command; their parent TAP counts overlap unit/focused commands and are not a unique grand total.

Initial full Report Details execution: 156 total, 126 passed and 30 failed (`browser-details-baseline.log`). A later intermediate run had 146 passed, five failed and five not run (`details-final.log`), plus teardown error. These failures included global rate-limit saturation, obsolete mobile-table assertions and a hidden mobile filter sheet, which remained an actual product defect until QA-017 was identified. Tests now respect real request limits and current responsive rendering rather than disabling the limiter or weakening authorization. A subsequent complete run executed all 156 cases: 155 passed and one failed, exposing the actual hidden mobile filter-sheet bug QA-017 (`details-acceptance.log`). After fixing it, the four desktop/mobile filter-refresh and sidebar cases all passed (`details-overlay-final.log`). A third complete 156-case run was not repeated; the final focused result resolves that specific failure. Fixture rate-budget waits are included in browser suite duration and are not application response-time measurements.

Initial isolated migrations: 87 TAP cases, 77 passed and ten failed (`mysql-migrations-baseline.log`). Intermediate expanded run: 103 cases, 95 passed, seven failed and one intentional real-AI skip (`mysql-migrations-final.log`). Reasons included stale full-page navigation expectations, a fixed iteration cap that did not fetch all reply pages, wrong filter state after returning from details, and the confirmed export race. The final publication and phase0 suites above pass without relaxing complete row-count assertions. Other final migration results are reported separately to avoid counting overlapping parents twice.

## Module assessment

- **Citizen:** category remains independent of AI; two-photo validation, geofence, unavailable-AI fallback and owned-report access tested. Report retries now preserve the original ID and publication request, including concurrent manual requests. The browser freezes submit state/location and guards reentry. GPS/camera tests use controlled browser fixtures rather than a physical device.
- **Barangay:** backend jurisdiction checks, protected originals/action proofs, completion evidence, status history, analytics, GIS, retry and stale-response behavior were executed. A full page is used for View Details; split preview remains available. See final browser results for portal-specific navigation.
- **Admin:** private access provisioning, portal role isolation, account permissions, reports/review queue, independent operational/publication status, approved/rejected decisions, analytics, export and GIS were exercised. New public registrations do not acquire Admin merely by being first.
- **API/MySQL:** replay-safe report creation, locked status updates, rollback/evidence cleanup, migration drift checks and nullable severity verified. Migration 014 action request keys/hashes, unique action request constraint and proof-history foreign keys retain their integrity checks.
- **Community Feed:** approval/legacy visibility, jurisdiction, personas, reactions, nested ancestry, comment ownership and complete 265-child pagination verified. The test's old seven-page loop was corrected; no fictitious reply-loss fix was made.
- **Report Details/EvidenceZoom:** one shared details implementation, role-specific actions, private images and keyboard/zoom lifecycle tested. Duplicate gesture bubbling and stale initial table placeholders were fixed.
- **YOLO:** actual four-class model loaded, real API probes and held-out evaluation ran. mAP@50 is 67.85%; road-crack recall is 46.15%. Confidence is not severity. See [backend/AI findings](backend-ai-qa-report.md).
- **Authentication/RBAC:** existing unit/integration/security and real MySQL/browser cases include all nine role/portal credential combinations, forbidden direct API calls, cross-barangay/private-media boundaries, stale sessions and controlled bootstrap/recovery. No bypass was confirmed within this bounded assessment.

## Responsive, accessibility and performance checks

Chromium checks covered 375, 390, 768, 1280, 1440 and 1671 px in light/dark themes; some existing suites additionally cover 320/393/1024/2560. They inspect document overflow, local table/tab scrolling, cards/list/split, protected thumbnails, navigation, contrast and action accessibility. Shared screenshots: `.data/shared-reports/screenshots/`; publication screenshots: `.data/publication-screenshots/`; GIS screenshots: `.data/gis-design-final/`. Browser traces are retained on failure, including `.data/report-details-browser-results/` and temporary Barangay result paths.

Tests check keyboard focus, Escape/outside dismissal, labelled controls, real computed danger contrast, fixed navigation order and reduced-motion behavior where implemented. Screen readers, physical touch/pinch and all WCAG requirements were not independently assessed. No Firefox/WebKit result is claimed.

Bounded phase0 measurements used 350 matching records and a maximum GIS response batch of 200. The final run's actual workbook downloads took 494 ms (Admin) and 283 ms (Barangay). These are observed local runs, not SLAs. The same final run measured 137 ms for the filtered viewport; no before/after speedup is asserted. AI first-request latency was approximately 4.13 s and subsequent sampled requests 70–77 ms on the local GPU. No long-duration memory, heap-growth, notification endurance or production concurrency benchmark was performed.

## Changes, test maintenance and repeatability

Production fixes are confined to existing report, audit, AI, migration, repository and shared UI boundaries plus small AI tooling corrections. No business logic was rewritten wholesale. New regression files cover report retry, severity persistence, provider contract, test-target safety, private MySQL lifecycle and migration behavior. Existing tests were updated where their expected UI/role contract was obsolete: full-page details, explicit review dialog, mobile cards, default pagination, keyboard focus in a page rather than a modal trap, and portal-specific staff login. The older Phase 2 fixtures were also corrected to use real authorized Admin/Barangay accounts instead of issuing tokens with forged roles. Backend role checks were preserved. Required resolution evidence was added to fixtures instead of bypassing the rule.

Added migration 015 is required by a reproduced nullable-severity defect. It was executed only against disposable databases. Do not run it on a shared deployment without an operator backup/change plan. Never turn unknown historical severity into low as an automatic rollback workaround.

`.github/workflows/qa.yml` adds separate Node unit/integration/security jobs, isolated MySQL, browser E2E and Python contract/tooling jobs with failure artifacts. There was no pipeline to duplicate. No new lint dependency was added; local static validation includes `git diff --check`, JavaScript parsing and workflow YAML parsing. The workflow itself has not run on GitHub, and Linux/MySQL installation, dependency installation and hosted artifact behavior remain CI validation tasks.

Useful local commands from the repository root:

```powershell
npm test
npm run test:e2e
npm run test:e2e:browser
npm run test:e2e:details
npm run test:publication
npm run test:e2e:publication
node tests/support/run-isolated-mysql.js
node --test --test-concurrency=1 tests/migrations/*.test.js
npx playwright test --config=playwright.barangay.config.js
npx playwright test --config=playwright.shared-reports.config.js
.venv/Scripts/python.exe -m pytest ai/tests -q
```

The private MySQL executable defaults to the installed Windows MySQL 8 path; use `PRIVATE_MYSQL_EXECUTABLE` for another verified local installation. Browser configurations sharing port 4318 must run sequentially. New actual-inference MySQL tests require an explicitly started local AI endpoint and image fixture; do not point them at a production service.

Final static checks: 46 changed/new JavaScript files passed `node --check`; workflow YAML parsed successfully; `git diff --check` passed. The four reports were checked for unbalanced fences and recognizable secret/token patterns. The production checkpoint SHA256 remained unchanged, and the owned local AI test process was stopped. Existing unrelated `tmp/pdfs/` files were left untouched.

## Remaining release gates

1. Approve/document the exact model release and reconcile the installed/pinned Ultralytics versions. Review measured false positives/misses, especially road cracks, against an agreed acceptance target.
2. Define physical severity decision ownership/criteria and any authorized manual override/history before describing that workflow as complete.
3. Complete deployment-specific Vercel/Render and hosted-storage smoke tests in an explicitly safe environment. Local success is not evidence of deployed provider/model identity.
4. Apply approved schema changes with backup through normal deployment operations; no live migration was performed here.
5. Run the new workflow on GitHub and review its environment-specific failures before treating CI as verified.

Visual inspection of the generated Admin desktop list and Barangay 375 px dark cards confirmed readable structure and escaped fixture text; automated bounds checks remain the broader viewport evidence. No commit, push, merge, deployment or Git staging change was made. Unrelated files, prior audit documents and model weights remain preserved. The task's four QA documents are reviewable working-tree files; ignored raw evidence remains local.

## 27 October remediation

Status remains **YELLOW**, because model replacement and live deployment verification are blocked. Local report workflow changes are implemented and tested. The current branch and index were preserved; prior staged QA work was not reset. New edits remain unstaged. No commit, push, merge, model promotion, configured-database migration or remote deployment was performed.

The shared Admin/Barangay details view now separates activity from operational actions, styles the accessible action-photo chooser, supports preview removal and reuses EvidenceZoom. Private staff coordination has report-scoped persistence, authorized notifications, unread/read cursors and pagination. The shared table labels current triage as Severity instead of implying that a human confirmation is an AI class. Severity review defaults to REVIEW_REQUIRED, then requires authorized inspected impact and a meaningful confirmation/override reason. Original AI JSON stays unchanged; current triage and append-only reviewer history are distinct. Concurrent stale edits return 409; refresh preserves measured-input focus and drafts until an explicit latest-assessment reload.

Operational rejection now requires a reason and browser confirmation, records actor/time/history, persists the owner notification in the same transaction, remains terminal and leaves publication moderation independent. A failed notification write rolls back rejection instead of leaving partial success. A Pending Posts retry race was corrected by using the existing coalescing loader even when a request is finishing. QA-018 and QA-019 document the reproductions and regression evidence. No new P0 was confirmed in the executed scope.

Changed implementation files are grouped by purpose:

- Shared UI: `reportDetailsView.js`, `reportDetails.js`, new `reportReviewPanel.js`, `report-details.css`, and the existing Admin/Barangay/report-details HTML script lists. `admin_logic.js` corrects queue retry scheduling.
- Domain/application: `report.rules.js`, new `reportSeverity.rules.js`, `report.service.js`, `notification.service.js`, new `reportReview.service.js`, and shared `reportVocabulary.js`.
- Persistence/wiring: new `reportReview.repository.js`, migration/rollback 016, SQLite schema/version, `composition.js`, `env.js`, and existing reports routes.
- Verification: new rejection/severity unit tests, shared SQLite/MySQL scenario tests, new report-review browser configuration/spec, existing status fixtures updated to submit required rejection reasons, and publication/registration fixtures synchronized to actual scan/page readiness. Existing outcome/security assertions were retained. The CI workflow includes the new browser suite; CI itself was not run remotely.
- Evidence: the four existing QA documents were updated. No model weights or architecture labels were changed.

The backend/AI report contains the 31-checkpoint inventory, class mappings, dataset/epoch/scale/checksum evidence, all three same-split evaluations and per-class results. YOLOv8 candidate validation/test mAP50 is 54.14%/54.15% (v2) and 47.03%/46.98% (v4), compared with 68.71%/67.85% for current YOLO11s. YOLO11 metrics cannot close a YOLOv8 requirement. The existing clean training data fails 12 independent-scene coverage gates; v6 lacks certified lineage/readiness. No readiness bypass or training was attempted.

The production and local inference build-copy SHA256 remains `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`. Live remote model identity, Supabase connectivity and Aiven/Vercel configuration were not exercised. Existing secrets were not printed or copied into reports.

### Authorized deployment and rollback procedure

1. Obtain separate approval for the target deployment/database. Take a verified database backup and retain the current application release, migration ledger, storage settings and model checksum. Do not point disposable test scripts at Aiven.
2. Review migrations 015 and 016 against the actual schema and tracked checksums. The existing `npm run migrate:mysql` command applies missing migrations; run it only in the explicitly authorized target environment. No destructive reset/backfill is required. MySQL DDL is not generally transactional: if a migration partially fails, inspect tables and ledger before retrying; do not mark it applied by hand without review.
3. Deploy matching backend routes/service/repository, frontend script lists/styles and shared vocabulary together. Leave `REPORT_SEVERITY_POLICY_JSON` unset for the approved manual default. If an LGU policy is later approved, version and review it before configuring numeric rules. Keep credentials and shared inference secrets server-side.
4. Verify backend and inference health, real protected image access, exact model checksum/classes, login and role isolation. Exercise one controlled report through proof/action/rejection, private coordination, unread/retry and severity conflict recovery. Confirm separate publication approval and authorized-recipient notifications. Check actual hosted storage using dedicated safe test objects only after authorization.
5. For application rollback, restore the previous matching application assets/backend first. Preserve the additive tables and all new audit/history data. Export coordination/read/severity records before any separately approved schema rollback. The 016 rollback drops those new tables and must never run blindly. It does not restore manually changed current triage values; any data restoration must use reviewed history/backup and explicit scope. Migration 015 rollback also requires review of nullable data before restoring constraints.
6. Model promotion is a separate release gate. Retain the current verified checkpoint until a qualified YOLOv8 candidate, reviewed atomic promotion procedure and explicit replacement approval exist. Validate locally before requesting separate deployment approval; restore the retained checkpoint and manifest together if a future approved release is rolled back.

The migration fixtures now also honor `PRIVATE_MYSQL_EXECUTABLE`, matching the existing CI configuration instead of forcing a Windows executable path on Linux. This portability correction was exercised locally through the Windows fallback; a Linux/GitHub Actions run remains unverified.

## Final remediation run ledger — 27 October 2026

Results below supersede earlier provisional counts. Logs are under `.data/remediation-2026-10-26/`. Suites overlap; do not add these totals. TAP includes parent cases, and the registration migration suite also contains a nested 66/66 passing browser run. The optional inference case skipped in the complete migration invocation was executed separately against owned loopback FastAPI and passed. The Python skip is the unavailable historical v2 dataset immutability check, not a passing dataset audit. Current v6 and clean-dataset training-readiness gates failed separately and remain release blockers.

| Scope | Command | Final result | Evidence |
| --- | --- | --- | --- |
| Node unit/integration/security | `npm test` | 1,116 passed; 0 failed; 0 skipped | `node-release-final.log` |
| Private MySQL runtime | `node tests/support/run-isolated-mysql.js` | 43 passed; 0 failed; 0 skipped | `mysql-runtime-release.log` |
| Complete private MySQL migrations/integration | `node --test --test-concurrency=1 tests/migrations/*.test.js` | 115 passed; 0 failed; 1 optional real-inference case skipped | `migrations-release-complete.log` |
| Real FastAPI → Node → private MySQL | `QA_REAL_INFERENCE_URL=http://127.0.0.1:8016 and QA_REAL_IMAGE set; node --test tests/migrations/qa-backend-lifecycle-mysql.test.js` | 4 passed; 0 failed; 0 skipped | `real-ai-mysql-final.log` |
| Complete Report Details desktop/mobile | `npx playwright test --config=playwright.report-details.config.js` | 156 passed; 0 failed | `details-release-complete.log` |
| Phase 2 desktop/mobile | `npx playwright test --config=playwright.phase2.config.js` | 44 passed; 0 failed | `phase2-verified.log` |
| Barangay desktop/mobile | `npx playwright test --config=playwright.barangay.config.js` | 32 passed; 0 failed | `barangay-verified.log` |
| Shared Admin/Barangay responsive UI | `npx playwright test --config=playwright.shared-reports.config.js` | 16 passed; 0 failed | `shared-release-final.log` |
| Citizen publication desktop/mobile | `npx playwright test --config=playwright.publication.config.js` | 14 passed; 0 failed | `publication-verified.log` |
| New staff review browser workflow | `npx playwright test --config=playwright.report-review.config.js` | 8 passed; 0 failed | `review-browser-release.log` |
| EvidenceZoom standalone unit suite | `node --test tests/unit/evidence-zoom.test.js` | 24 passed; 0 failed | `evidence-zoom-final.log` |
| Python AI/tooling suite | `.venv/Scripts/python.exe -m pytest ai/tests -q` | 170 passed; 0 failed; 1 skipped; 14 deprecation warnings | `python-full.log` |
| Focused rejection notification/policy/persistence | `node --test --test-concurrency=1 tests/integration/report-review-workflow.test.js tests/migrations/report-review-mysql.test.js server/tests/notification.service.test.js server/tests/admin-live-reports.test.js` | 35 passed; 0 failed | `rejection-notification-verified.log` |

The full 156-case Report Details suite passed twice in this remediation; the final release run followed the rejection notification transaction fix. Earlier migration failures reproduced the queue race, a page-initialization fixture race and the rejection notification rollback bug; all failing cases were corrected and the complete migration suite rerun to zero failures. An initial Phase 2 launch was refused because another owned suite occupied its port; it was rerun after that suite exited and all 44 cases passed. No backend limiter was disabled to shorten tests.

Final checks: `git diff --check` passed; 32 changed/new JavaScript files passed syntax checks; the added-line scan found no new code comments or credential patterns. Checkpoint hashes were rechecked and unchanged. Desktop and 375/768/1440 review layouts were captured and visually inspected; blank fixture images/offline map placeholders in those screenshots do not establish live map/media availability. The existing production/candidate weights, configured databases, cloud storage and deployments were left unchanged. Prior staged work remains staged; this remediation’s new edits were not staged, committed or pushed.

Release decision remains YELLOW. Local regression results do not close QA-016, certify training data, authorize migration 016 on an existing deployment, verify hosted integrations, or replace the required model promotion/deployment approvals. The explicit deployment/rollback procedure and full candidate metrics are in the overall and backend/AI reports.

## Report Details regression — 27 October 2026

The latest bounded source audit and isolated runtime results are recorded in [Report Details full regression](report-details-full-regression-2026-10-27.md). It supersedes earlier run totals for this audit, preserves historical evidence, and keeps the target release YELLOW while migrations 017–018 and runtime prerequisites remain unresolved. Five newly reproduced defects cover transactional operational notifications, stale incident progress, omitted activity actors, excessive severity-form scrolling and dropped comment refreshes. No configured migration, cloud write, server restart or model replacement was performed.

Final verified totals for this continuation: Node 1,164 passed; full isolated migration suite 174 passed/1 optional skipped; actual MySQL runtime 43 passed; real AI-to-MySQL lifecycle 4 passed; Python 170 passed/1 historical-dataset skipped. Full browser runs: Details 156, shared reports 16, Barangay 32, publication 14, Phase 2 44, Citizen/auth 20, report review 24; all zero failures. The 192-combination visual matrix recorded no overflow, page exceptions or local 5xx. Optional default E2E checks remained three skipped; cloud storage was not enabled. See the focused report for the retained failed runs, exact evidence and target blockers.
