# Report Details full regression — 27 October 2026

## Executive summary

Release recommendation: **YELLOW**. Five additional product defects were reproduced: one High transaction failure and four Medium presentation/refresh defects. The fixes preserve Admin monitoring-only access, Barangay operational authority, Citizen ownership, Admin publication approval, anonymous public discussions and citywide visibility. No P0 disclosure or destructive privilege bypass was confirmed in the executed scenarios.

This is a local source and disposable-environment assessment. It does not approve deployment. The configured local MySQL database still requires migrations 017–018. Neither migration was executed there. Authoritative boundary coverage and the separate YOLOv8 promotion gate remain unresolved. Production/Aiven, real Supabase writes and physical-device testing were excluded.

## Git state and safety

The starting working tree contained substantial staged, unstaged and untracked changes. `git status --short`, `git diff --check`, `git diff --stat` and `git diff --cached --stat` were executed before edits. The starting status is retained in `.data/qa-full-2026-10-27/git-before.txt`. The existing staged set contained 63 paths. No reset, stash, checkout, staging, commit, push, merge or deployment command was run.

The existing migration recovery, citywide fixes and other agents' changes were retained. The configured database was inspected through the existing read-only preflight. No test fixture was inserted there. Test writes used temporary SQLite or private MySQL datadirs, random loopback ports, local evidence storage and synthetic accounts. The production checkpoint was not replaced or retrained.

Unlike the previous session's process inventory, the current inspection found no listener on ports 3000 or 4357. Those historical PIDs must not be treated as current evidence. No existing application server was terminated or restarted. The test-owned FastAPI service used 127.0.0.1:8017. Browser preview servers were owned by their test fixtures.

## Environment and evidence

Node 22, Windows MySQL 8.0.46, Chromium desktop/mobile emulation and the existing Python environments were used. The complete Python suite runs in `.venv`; `.venv-yolo` fails collection because it lacks `imagehash`. No dependency was silently installed to conceal that environment difference.

Evidence root: `.data/qa-full-2026-10-27/`. TAP and Playwright logs are retained, including failed and interrupted runs. Do not add overlapping totals together. Parent TAP cases are included in Node totals. Visual viewport checks are assertions inside browser cases, not additional independently counted Playwright tests.

## Expected versus actual business rules

PASS below means the rule was exercised against the indicated isolated API/database/browser evidence. BLOCKED refers to the configured target or an unavailable prerequisite, not an invented successful test.

| Rule | Expected | Actual and evidence | Result |
| --- | --- | --- | --- |
| Admin report access | Authorized cross-Barangay monitoring | Report Details and private MySQL permission scenarios | PASS |
| Admin operational status | Reject ongoing/resolved/rejected direct calls | HTTP 403; unchanged status/history SQL assertions | PASS |
| Admin physical severity | No confirmation/editor | HTTP 403; no review row; editor absent | PASS |
| Admin proof upload | No operational proof uploader | Forbidden status route rejects before upload middleware; no form | PASS |
| Admin comments | Authorized published discussion, read-only | Correct discussion, escaped text, no editing controls | PASS |
| Admin coordination | Send/read responsible report's thread | Real API/browser exchange and reload persistence | PASS |
| Admin publication | Approval remains separate and mandatory | Publication lifecycle and role-isolation suites | PASS |
| Routing administrator | Separate explicit permission | Ordinary Admin denied; designated actor tested with synthetic verified boundaries | PASS |
| Barangay report access | Current assigned jurisdiction only | Cross-Barangay GET, history, messages and mutations denied | PASS |
| Barangay transitions | Centralized existing transition policy | Pending to ongoing/resolved/rejected; ongoing to resolved/rejected; terminal reports cannot transition | PASS |
| Pending direct resolution | Existing policy permits with evidence | No new ongoing-only restriction was invented | CHANGED INTENTIONALLY |
| Resolution evidence | Description plus JPEG/PNG/WebP, up to five, 10 MB each | Validation, previews, protected retrieval and real SQL proof rows | PASS |
| Failed action persistence | Roll back status, proof/history/audit and notification together | Fault-injected notification/storage/proof failures and cleanup assertions | PASS |
| Status retries/concurrency | One event for matching retry; conflict for competing stale command | Existing actual MySQL concurrency scenarios | PASS |
| Rejection | Eligible state, meaningful reason, confirmation and notification | Cancel/confirm browser behavior; actor/history/publication SQL assertions | PASS |
| Severity | Review-required by default; authorized impact/reason/evidence | Missing impact, invalid evidence, stale version and rollback tests | PASS |
| Severity provenance | Confidence does not measure physical severity | Manual reviewer/history retained; no new numeric thresholds | PASS |
| Duplicate review | Suggestion only until assigned official confirms | Multiple signals, distinct damage, recurrence and concurrency scenarios | PASS |
| Incorrect routing flag | Official flags without transferring | Evidence and reason required; report ID/jurisdiction unchanged | PASS |
| Jurisdiction correction | Verified boundary/evidence, specific Admin permission | Atomic concurrent correction, previous/new jurisdiction and access revocation tested | PASS |
| Configured incident/routing | Migration prerequisites must exist | 017–018 remain pending; setup-dependent unavailable response tested on disposable downgrade | BLOCKED |
| Citizen private reports | Owner only | Other owners and wrong jurisdictions denied | PASS |
| Citizen staff controls | No status/severity/internal messages | DOM absence and forbidden direct API calls | PASS |
| Citywide public feed | Same eligible discussions across homes | Three Citizen homes; all 61 supported Barangays; pagination/search/sorting | PASS |
| Publication privacy | Pending/rejected content stays private | Public detail/media/comments/reactions cannot reveal it | PASS |
| Canonical discussion | One eligible public incident thread | Alias suppression, approval and historical comment retention verified | PASS |
| Public identity | Anonymous persona and existing avatar | No private user identifiers in public DTO; literal content rendered safely | PASS |
| Operational scoping | Citywide feed does not broaden report access | Corrected citywide assertion retains private-report HTTP 403 | PASS |
| Internal messaging | Report-specific, staff-only, idempotent | Send/reply/reload, pagination, cursor, validation, XSS and lost-ack retry | PASS |
| Transfer messaging | Old jurisdiction loses access; new one receives future coordination | Existing private history retained under current access checks; recipients checked | PASS |
| Notifications | Stored recipients and private channels | SQL recipient checks; public incident events only for eligible discussions | PASS |
| Activity | Persisted status events, dates, reviewer | No fabricated stages; stored actor now visible to staff only | PASS |
| Browser refresh | Update incident/comments without stale overwrite | New failing-before and passing-after browser tests | PASS |
| Responsive layout | Both staff roles, states, themes and required widths | Six widths, two themes, four statuses, two roles; no overflow | PASS |
| Authorized link reversal | Existing confirmed incident safely split again | No unlink workflow exists; no destructive reversal was invented | NOT RUN |
| Official boundary coverage | Complete authoritative Bacolod polygons | Existing configured catalog has no approved complete polygon dataset | BLOCKED |
| Model release | Verified YOLOv8 candidate meets separate promotion criteria | Current checkpoint is not promoted by these workflow tests | BLOCKED |

The Pending direct-resolution row records a pre-existing intentional policy choice, not a new behavioral change in this audit. `shared/reportVocabulary.js` remains the source of transition truth.

## Confirmed defects and remediation

### QA-020 — P1 High: successful operational update could lose its notification

Reproduce: make the notification repository reject a write, then PATCH a pending report to ongoing. Before the fix, the response was 200 and status/history/audit were committed. Resolution had the same non-transactional branch. A lost notification could not be recovered by replaying the completed idempotent action.

Root cause: only rejection persisted its notification inside the report transaction. Ongoing/resolved notifications were written after commit and errors were swallowed.

Fix: persist every operational status notification using the locked current report and the same transaction as status, history, proof and audit. Publish only after a successful commit. Matching retries do not create another notification. No transition or evidence rule was relaxed.

Evidence: `status-notification-before.log`, `status-notification-after.log`, `focused-after.log`, `real-ai-mysql.log`. The real private MySQL completion test injects a notification failure after uploading a proof, verifies ongoing status and zero committed proof rows, compares stored files before/after, then resolves successfully with valid evidence.

### QA-021 — P2 Medium: incident progress stayed stale during background refresh

Reproduce: open a Citizen report, confirm a duplicate using another authorized session, then trigger the shared refresh without changing the original report row. Before the fix the incident section stayed hidden.

Root cause: unchanged report signatures refreshed only the staff review panel. IncidentReviewPanel was mounted once and exposed no refresh method. A previously hidden section also was not explicitly revealed when membership appeared.

Fix: refresh the incident panel through the shared details lifecycle, reveal valid incident progress, retain unchanged drafts, discard superseded responses and show setup/network errors honestly. The Citizen's original status and evidence remain independent.

Evidence: `incident-refresh-before.log`, `browser-review-final-complete.log`, `refresh-release.log`.

### QA-022 — P2 Medium: persisted reviewer identity omitted from activity

Reproduce: load staff history containing `changed_by_username`. The API supplied the actor but the shared presentation discarded it.

Fix: carry the stored username into the timeline and escape it in the shared view. Citizen history remains redacted by the existing backend; no actor is guessed for redacted or historical missing values. Dates still use the shared Asia/Manila formatter.

Evidence: `timeline-actor-before.log`, `focused-after.log`, staff status screenshots.

### QA-023 — P2 Medium: severity editor made the Barangay page excessively long

The desktop ongoing fixture was 2,399 pixels tall with the full severity form always expanded. This pushed comments and incident review far down the page.

Fix: keep current severity and operational actions visible, with a native keyboard-accessible disclosure for editing severity. Opening state and unfinished input survive shared refresh. Required assessment validation is unchanged. No new colors, gradients or redesign were introduced.

The corresponding final screenshot is 1,878 pixels tall: 521 pixels shorter. Evidence: `severity-disclosure-before.log`, the visual matrix and before/after screenshots. This is a fixture-specific measurement, not a universal performance claim.

### QA-024 — P2 Medium: Refresh lost while public comments were loading

Reproduce: hold a successful comments response, delete its comment through the real API, click Refresh while the held request is loading, then release the stale response. The deleted comment remained visible before the fix.

Root cause: the comments loader returned immediately during loading and discarded the second request.

Fix: coalesce one follow-up reload after the active request finishes and avoid mutating detached components. API failures remain errors, not empty threads.

Evidence: `comments-refresh-before-reproduced.log` records the deleted comment versus expected empty-state failure. `refresh-release.log` and the complete review run verify recovery.

## Test harness findings

The old MySQL security/browser assertion expected cross-Barangay public comments to return 404. The confirmed citywide rule requires 200. The corrected assertion verifies anonymous output and retains private report denial; no authorization assertion was removed to conceal a disclosure.

Its GIS fixture also assumed a report retained a standalone marker after Fit matching reports. Existing pixel-based clustering legitimately groups nearby reports. The four single-pin status fixtures now use separated deterministic locations and explicitly fit the dataset; the separate 350-overlapping-report cluster test remains intact. No GIS application behavior was changed for this test.

An overlapping invocation of the same Playwright configuration caused missing trace files in its shared output directory. That failed run is retained and excluded from passing evidence. The final run uses a distinct output directory. One earlier failed migration-suite child did not exit; only that verified test-owned child was stopped so the parent could finish. Application servers were untouched. The final clean suite is reported separately.

## Request paths and persistence

- Operational action: shared details submit → ReportMutations → protected status PATCH → Barangay-only HTTP guard → report service and centralized transition/proof policy → locked report row → status/history/proof/audit/notification transaction → post-commit event → shared reload.
- Severity: ReportReviewPanel → severity POST → staff authentication and assigned-Barangay service policy → domain evidence validation → expected-review lock/replay validation → review/current triage/audit transaction → refreshed assessment/history.
- Internal coordination: ReportReviewPanel → messages POST → current report access rechecked under lock → sender-scoped request-key replay → message/audit/recipient notifications transaction → review/read cursor endpoints → escaped conversation DOM.
- Citizen comments: staff report lookup and jurisdiction → approved/legacy/canonical discussion mapping → public-only comment repository → read-only anonymous DOM. Public feed paths remain citywide; operational paths remain scoped.
- Incident/routing: shared incident panel → authenticated API → migration readiness → incident lock, current report/user and explicit permission → domain duplicate/location checks → incident/routing/history/notification transaction → public event only when an eligible public discussion exists.

MySQL assertions cover counts and relationships as well as returned JSON. Existing migration recovery tests preserve full original row fingerprints and ledger rows across fresh/historical/index-already-present upgrades. 001/009 sources, archive registry and 017/018 SQL were not changed by this audit.

## Visual evidence

The matrix records 96 combinations per browser project: two roles × four statuses × two themes × six widths (390, 768, 1024, 1280, 1440, 1920). Diagnostics JSON records overflow, local server errors and unhandled page exceptions. Synthetic road photographs are fixtures, not actual incident evidence or AI-accuracy demonstrations.

- Before: [Barangay ongoing, dark, 1440](../../.data/qa-full-2026-10-27/visual-before/desktop-barangay-ongoing-dark-1440.png).
- After: [Barangay ongoing, dark, 1440](../../.data/qa-full-2026-10-27/visual/desktop-barangay-ongoing-dark-1440.png).
- [Admin pending, light, 390](../../.data/qa-full-2026-10-27/visual/desktop-admin-pending-light-390.png).
- [Barangay pending, light, 390](../../.data/qa-full-2026-10-27/visual/desktop-barangay-pending-light-390.png).

Files are local ignored evidence. The full matrix includes resolved/rejected views and both themes. Existing review-suite screenshots also show conversations, public comments, selected proof previews and severity history. Focus, sidebar behavior, keyboard zoom, carousel and map tests are included in the full details suite. Automated labels/keyboard checks are not a manual screen-reader or physical-device certification.

## AI and evidence

The real checkpoint was loaded by FastAPI on a test-owned loopback port. Real `/predict` and pair verification requests returned HTTP 200, flowed through Node assessment proofs and were persisted in private MySQL. The lifecycle run also checks ownership, action proof validation, publication separation and Citizen tracking. Mocked inference contracts remain separately covered by Node/Python tests.

Checkpoint SHA256: `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`, unchanged from the previous verified checkpoint. This is not evidence that a YOLOv8 ≥68% release candidate has been trained or approved. No retraining, replacement or promotion was performed.

## Files changed in this audit

Application: `server/application/use-cases/report.service.js`; `frontend/js/reports/reportDetailsView.js`; `frontend/js/reports/reportReviewPanel.js`; `frontend/js/reports/incidentReviewPanel.js`; `frontend/js/shared/reportPresentation.js`; `frontend/styles/report-details.css`.

Regression coverage: `server/tests/report-presentation.test.js`; `tests/support/report-review-scenarios.js`; `tests/migrations/qa-backend-lifecycle-mysql.test.js`; `tests/migrations/phase0-security-browser.test.js`; `tests/browser/report-review.spec.js`.

Documentation: this report, the four requested existing QA documents and the exact `.gitignore` exception for this report. These paths already contained uncommitted work in several cases; only the described additions were made.

## Commands and final result ledger

The completed result ledger is appended below after all owned regression processes finish. Historical failed logs remain available; a passing focused rerun does not rewrite them.

## Target readiness and rollback

The strict local preflight reports genuine applied migrations 001–016 and pending 017–018. Its checksum safeguards pass. The existing valid `community_posts.report_id` unique index has no duplicate non-null report references. Applying pending migrations remains an explicit operator action after a fresh verified backup and approval. See [migration recovery](migration-recovery-2026-10-27.md) for the complete backup, native-JSON precision restore, execution and rollback procedure.

No schema change was made during this audit, so no configured-database rollback is required. To revert this audit's source changes, reverse only its reviewed hunks; do not reset files wholesale over other agents' staged/unstaged work. Keep the failed/passing evidence and rerun affected suites after any source reversal. Do not automatically remove the already-existing unique index or modify historical ledger checksums.

Remaining target blockers: unapplied 017–018; no current configured API verified on 3000/4357; authoritative polygon coverage not established; separate model promotion gate unmet. Confirmed incident unlink/reversal is not supported by an existing authorized API and was not invented in this remediation. Browser engines other than Chromium, real cloud storage failures and manual screen-reader/physical-device behavior remain unverified.

## Executed regression commands

All commands were launched from the repository root. No command below migrates the configured application database.

```powershell
npm test
node --test --test-concurrency=1 tests/migrations/*.test.js
node tests/support/run-isolated-mysql.js
npx playwright test --config=playwright.report-details.config.js
npx playwright test --config=playwright.shared-reports.config.js
npx playwright test --config=playwright.barangay.config.js
npx playwright test --config=playwright.publication.config.js
npx playwright test --config=playwright.phase2.config.js
npx playwright test --config=playwright.phase1b.config.js
npx playwright test --config=playwright.report-review.config.js --output=.data/qa-full-2026-10-27/review-final-results
.venv/Scripts/python.exe -m pytest ai/tests -q
npm run test:e2e
node --env-file=.env server/infrastructure/database/mysql/preflight017.js
```

Real inference was executed separately, using the unchanged checkpoint and test-owned FastAPI process:

```powershell
.venv/Scripts/python.exe -m ai.inference.inference_api --host 127.0.0.1 --port 8017 --weights models/production/best.pt
$env:QA_REAL_INFERENCE_URL = 'http://127.0.0.1:8017'
$env:QA_REAL_IMAGE = (Get-ChildItem data/datasets -Recurse -File -Filter '*.jpg' | Select-Object -First 1).FullName
node --test tests/migrations/qa-backend-lifecycle-mysql.test.js
```

The image is an existing local dataset example, not a fabricated model accuracy evaluation. The test starts its own private MySQL instance and selects local storage. The normal configured database and hosted storage are not used.

Additional coverage verifies a 500-character message, spoofed sender/recipient fields, matching replay and unchanged persisted rows after authorized GET endpoints. A first version of the test incorrectly ordered the composite-key read-cursor table by a nonexistent `id`; that test SQL was corrected to use its actual primary key. The resulting test error is retained in `review-integrity-final.log` and is not classified as an application defect.

## Safe manual local startup

Before starting an API, verify the current owner of any listener:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter 'ProcessId = OWNER_PID' |
    Select-Object ProcessId, CreationDate, CommandLine
```

Replace `OWNER_PID` with the inspected numeric PID. If it is an existing authorized application process, ask its owner to press Ctrl+C in that terminal. Do not kill an unknown process. From the correct repository and environment, `npm run server` loads the current source; a non-watch Node process does not reload changed JavaScript automatically. The incident/routing functions still need separately approved migrations before that configured target can be called ready.

Routing correction remains a separate `report:assign-jurisdiction` permission in the existing permission repository and migration 017 CHECK constraint. A designated active Admin must receive that explicit grant through a reviewed operator/account-permission action; do not promote Citizen/Barangay accounts or grant operational status authority. No real account permission was changed during QA. Plain Admin access still does not authorize a routing correction.

## Final measured results

| Command/run | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| `npm test`, final complete run | 1,164 | 0 | 0 | `node-release.log`, 182.60 s |
| All `tests/migrations/*.test.js`, final complete run | 174 | 0 | 1 | `mysql-migrations-final.log`, 663.37 s |
| Isolated actual MySQL runtime wrapper | 43 | 0 | 0 | `mysql-runtime.log`, 51.12 s |
| Real FastAPI → Node → private MySQL | 4 | 0 | 0 | `real-ai-mysql.log`, 22.99 s |
| MySQL security/browser focused final | 13 | 0 | 0 | `security-browser-verified.log`, 66.78 s; also passes in full migration rerun |
| Full Report Details browser | 156 | 0 | 0 | `playwright.report-details.config.js.log` |
| Full shared reports browser | 16 | 0 | 0 | `playwright.shared-reports.config.js.log` |
| Full Barangay browser | 32 | 0 | 0 | `playwright.barangay.config.js.log` |
| Publication browser | 14 | 0 | 0 | `playwright.publication.config.js.log` |
| Phase 2 browser | 44 | 0 | 0 | `playwright.phase2.config.js.log` |
| Citizen/auth Phase 1b browser | 20 | 0 | 0 | `playwright.phase1b.config.js.log` |
| Full review/messaging/incident/visual browser | 24 | 0 | 0 | `browser-review-final-complete.log` |
| Final refresh/lost-ack browser focus | 3 | 0 | 0 | `refresh-release.log` |
| Python, existing complete `.venv` | 170 | 0 | 1 | `python-full.log`, 73.28 s; 14 dependency warnings |
| Default opt-in E2E command | 0 | 0 | 3 | `optional-e2e.log`; no cloud opt-in was enabled |

The optional real-AI child skipped in the general migration command was executed separately with real inference and passed. The Python skip is the unavailable historical v2 dataset. The default E2E skips are not passes; the separate isolated runtime and real-AI runs supply their stated local coverage, while live cloud storage remains untested. The unsuccessful `.venv-yolo` invocation had three collection errors for missing `imagehash`; the complete existing `.venv` run is the passing Python evidence. Ultralytics there is 8.4.150, Python 3.13.7 and torch 2.14.0+cu126, with CUDA available; this does not certify the separately pinned Ultralytics version.

The migration run includes the complete embedded real-Tesseract registration browser suite. It also exercises fresh/historical migration recovery, JSON numeric backup fidelity, canonical discussion/publication behavior, concurrency, report review and protected downgrade readiness. The initial complete migration run failed an obsolete citywide assertion; the clean final run passes without checksum overrides.

### Category summary

These are overlapping measured suites or named browser cases, not a unique grand total. Admin/Barangay rows count their two role-specific reference-layout cases; other coverage is included in the full details/review rows above. Messaging counts send/reply/reload and lost-ack cases in both projects. UI counts the two visual-matrix cases, containing 192 combinations. Blocked counts below identify named target checks, not hidden failed tests. Critical/High columns mean **currently open confirmed defects in this audit**.

| Category | Passed | Failed | Blocked | Critical bugs | High bugs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Admin Report Details | 2 | 0 | 1 | 0 | 0 |
| Barangay Report Details | 2 | 0 | 1 | 0 | 0 |
| Backend/API, Node suite | 1,164 | 0 | 1 | 0 | 0 |
| MySQL/migrations | 174 | 0 | 1 | 0 | 0 |
| Security, MySQL/browser | 13 | 0 | 0 | 0 | 0 |
| Community Feed, citywide private MySQL | 15 | 0 | 0 | 0 | 0 |
| Messaging, browser cases | 4 | 0 | 0 | 0 | 0 |
| UI/Responsive, matrix cases | 2 | 0 | 0 | 0 | 0 |
| AI integration, real lifecycle | 4 | 0 | 1 | 0 | 0 |

The first four blocked entries refer to the same configured-target readiness gate: pending 017–018 and no currently verified running API. They are not four distinct missing migrations. AI's blocked entry is the independent model architecture/promotion gate. Boundary authority and unimplemented confirmed-incident reversal are additional limitations explicitly listed above. No unsafe reversal or random jurisdiction was substituted to turn those entries green.

### Final configured read-only inventory

`local-final.json` records the verified Windows local MySQL identity, 16 genuine migration rows and pending 017/018, strict checksums ready, 61 Bacolod catalog entries, zero polygons and zero boundary source/version entries. It records 37 reports, six public post rows, 29 comments, seven publication requests, five publication reviews, one coordination message and two coordination read rows. These are observed real application counts, not QA fixtures or an assertion that external user activity stopped during the audit. No configured write was performed by the inventory or test harnesses.

The restored migration 001/009 sources and 017/018 digests remain the ones documented in migration recovery. Target readiness remains **YELLOW** until approved backed-up migrations, correct local API startup and the blocked geography/model requirements are addressed. There are no open confirmed P0/P1 findings from the executed scope; five new defects were fixed, not merely hidden with empty states or weakened validation.

Final source verification also ran `node --test tests/unit/evidence-zoom.test.js`: 24 passed, zero failed/skipped (`evidence-zoom-final.log`). The final Node suite includes the added spoofed-sender/maximum-length and GET side-effect tests. The final migration suite includes the same scenarios against private MySQL, with zero failures.

The final dedicated visual rerun (`visual-release.log`, two passed cases) additionally captured console errors and failed requests. Across both diagnostics files: 192 combinations, zero horizontal overflows, zero unhandled page exceptions, zero console errors, zero failed network requests and zero local HTTP 5xx responses. These counts describe this deterministic matrix, not every third-party network condition or a physical-device guarantee. `preservation-final.json` confirms all four protected migration hashes and the production checkpoint hash remain unchanged; the staged path set still contains 63 entries.

## Severity editor removal — later 27 October 2026 amendment

This user-requested amendment supersedes QA-023's earlier progressive-disclosure editor. The Barangay Report Details page no longer creates Severity Review, its heading/empty-state, expandable assessment form, measurements, dropdowns, textareas, Save Assessment button or historical-assessment UI. No replacement severity card or placeholder is rendered. The Reported Damage/original YOLO summary remains, directly after the operational controls, with redundant inner padding removed.

The shared review panel's measurement helpers, assessment submission handlers, conflict/reload controls and severity draft state were removed, rather than hiding a working editor with CSS. Messaging, comments, queued refresh and lifecycle cleanup remain in the same reusable component. The shared details view no longer attempts to append the removed section. Unused severity-specific CSS was removed; empty proof previews do not reserve space.

Operational validation remains unchanged. Report submission does not require a physical severity confirmation. Status updates depend on centralized status transitions, jurisdiction, action description/rejection reason and required completion photos. The removed form was not a backend prerequisite. Reject, Mark Ongoing, Resolve, action description and proof upload remain available according to the report's existing eligible state. Admin still receives no operational controls and is rejected by the direct status/severity APIs.

No backend service, repository, domain rule, schema or migration was changed by this amendment. Existing severity history remains retrievable through the protected review API; an authorized historical assessment created in the disposable fixture remains exactly unchanged after viewing, Refresh and page reload. Legacy API severity validation and authorization tests remain in place. No automatic Minor/Major assignment was introduced. Private MySQL now additionally asserts that submission → ongoing → resolution leaves classification/priority NULL and creates zero severity-review rows.

Changed application files: `frontend/js/reports/reportReviewPanel.js`, `frontend/js/reports/reportDetailsView.js`, `frontend/styles/report-details.css`. Tests changed: `tests/browser/report-review.spec.js`, `tests/migrations/qa-backend-lifecycle-mysql.test.js`. Existing staged changes were preserved; an independent concurrent change to `frontend/styles/admin-overview.css` was observed and left untouched.

Obsolete browser tests that edited severity or maintained an assessment draft were replaced with tests for complete DOM absence, operational resolution with required evidence, zero frontend assessment requests, original-prediction preservation, and historical-data retention. The visual matrix now requires zero severity sections/editors/measurement nodes, rather than merely a collapsed form. Existing rejection, Admin 403, message, comment, incident and responsive scenarios remain.

Evidence root: `.data/severity-ui-removal-2026-10-27/`. These are new executions, not the earlier full-regression totals. `before.log` is an initial smoke run that loaded the changed source; it is not failing-before evidence.

Executed commands:

```powershell
npm test
node --test --test-concurrency=1 tests/migrations/report-review-mysql.test.js tests/migrations/qa-backend-lifecycle-mysql.test.js tests/migrations/barangay-beta-mysql.test.js tests/migrations/qa-severity-mysql.test.js
node --test --test-concurrency=1 tests/integration/phase0-security-corrections.test.js tests/integration/incident-routing.test.js tests/integration/report-review-workflow.test.js
npx playwright test --config=playwright.report-review.config.js --output=.data/severity-ui-removal-2026-10-27/review-results
npx playwright test --config=playwright.report-details.config.js --output=.data/severity-ui-removal-2026-10-27/details-results
npx playwright test --config=playwright.report-review.config.js --grep='Barangay operates an unassessed' --output=.data/severity-ui-removal-2026-10-27/prediction-results
```

The browser tests use controlled inference responses and server-signed assessment proofs to verify the persisted original prediction/confidence, independently of physical severity. They do not claim a new real-model accuracy evaluation. MySQL writes use disposable private instances/local evidence storage. The optional real FastAPI case is skipped in this scoped MySQL command. Configured migrations, real records and production model weights were not touched. No application server was restarted, and no commit, staging, push or deployment command was issued.

Verified results for the removal amendment so far: `node.log` 1,164 passed/zero failed; `mysql.log` 37 passed/zero failed/one optional live-inference skip; `authorization.log` 47 passed/zero failed; `review-browser.log` 24 passed/zero failed; `prediction-browser.log` two passed/zero failed. The full Report Details command is recorded separately after completion. These suites overlap and must not be summed as unique cases.

The dedicated original-prediction browser test now obtains valid server-signed previews from the controlled inference fixture before submission. Both desktop and mobile verify Original YOLO prediction/Pothole and Original AI confidence/90%, then mark ongoing, require action evidence, resolve, and confirm the original snapshot/confidence are unchanged while physical classification/priority remain NULL. No `/severity` request is sent by the page. Existing historical severity is tested separately through the protected API and survives viewing/reload.

Desktop dark and mobile light screenshots were visually inspected. Operational controls remain, and Reported Damage follows them with no Severity Review section or reserved placeholder. Current screenshots/diagnostics are copied into `.data/severity-ui-removal-2026-10-27/visual/`. The matrix covers the existing six widths and both themes. This is a UI removal, not a new severity policy or production model evaluation.

Final removal-amendment result: the complete Report Details browser suite finished with **156 passed, zero failed** (`details-browser.log`). The final scoped totals are Node 1,164 passed; isolated MySQL 37 passed/one optional live-inference skipped; authorization/workflow 47 passed; Report Review browser 24 passed; original-prediction/operational browser focus two passed. All executed final cases passed. The 192-combination matrix recorded zero overflow, page exceptions, console errors, failed requests or local 5xx. The protected migration/model hashes match the prior verified values, and the staged patch remained byte-identical. No configured migration or application-data mutation was performed.

## Admin incident panel and live Report Details layout amendment — 27 October 2026

This amendment removes the normal Admin setup-warning card without changing incident API readiness or permissions. An ordinary Admin sees read-only Incident information only when an actual linked incident exists. Routing history alone no longer creates a panel. The jurisdiction correction form still requires the explicit routing permission; duplicate confirmation remains with the authorized Barangay. Both ordinary and routing-authorized Admin tokens remain forbidden from ongoing, resolution and rejection mutations.

Missing migration 017 still produces the real HTTP 503/INCIDENT_REVIEW_NOT_READY response. The HTTP error handler records a structured, credential-free diagnostic with the dependency code and migration filename. The Admin component suppresses only this specific dependency card. Unexpected failures remain visible as a compact inline error, and successful recovery clears the stale error. Neither fake success responses nor empty-data fallbacks were added. A private-MySQL test temporarily removes a required table, verifies the real API error and diagnostic, and checks the Admin DOM in Chromium; its table is restored in cleanup. No configured database was changed.

Confirmed UI defects and fixes:

- P2: conversation required a redundant Refresh button, and repeated quiet loads replaced every message/comment node and briefly displayed loading text. The button/listener are removed. Existing visible-page polling (10 seconds), focus/visibility refresh and mutation events fetch updates automatically. A shared keyed reconciler updates only changed rows and preserves unchanged nodes, scroll position and the focused draft. Discussion selector options are not rebuilt when unchanged. Already-read messages no longer trigger another read-marker write on every poll. Earlier-message pagination remains available without an empty footer.
- P2: a refresh event arriving while the parent controller was awaiting child comments could be discarded. The controller now coalesces it into one follow-up refresh. Successful quiet recovery also clears the stale-data warning.
- P3: fixed-height 180px photos ended above adjacent taller cards; failing-before evidence measured a 36.6875px bottom difference. Above the mobile carousel breakpoint, the photo grid fills the existing row height. Both image tiles, Description and Location now share top/bottom edges in the three-column desktop layout. Mobile retains its 200px carousel and Previous/Next controls.
- P3: reply metadata was appended as adjacent inline nodes, producing Reply immediately against the anonymous author name. Reply, author and date now share a wrapping metadata row with explicit whitespace and an 8px column gap. Public persona/avatar and reply content remain unchanged; all text still uses textContent.

Application changes are limited to `frontend/js/reports/incidentReviewPanel.js`, `frontend/js/reports/reportReviewPanel.js`, `frontend/js/reports/reportDetails.js`, `frontend/styles/report-details.css`, and the diagnostic in `server/presentation/http/middleware/errorHandler.middleware.js`. Coverage changes are in `tests/browser/report-review.spec.js`, `tests/support/incident-routing-scenarios.js` and `tests/migrations/incident-routing-mysql.test.js`. The earlier severity-removal changes remain intact. No status/evidence requirement, severity record, incident relationship, database schema or publication rule was removed.

Failing-before evidence: `.data/admin-incident-panel-2026-10-27/before.log` contains two unwanted-Admin-panel failures. `.data/report-live-layout-2026-10-27/before.log` reproduces the Refresh button and photo-height defects; `glitch-before.log` demonstrates disconnected existing message nodes after polling. The subsequent focused run passes four browser cases covering live updates, refresh coalescing and both role layouts, including real persisted replies and deletion refresh.

Final executions for this amendment:

```powershell
npm test
node --test --test-concurrency=1 tests/migrations/incident-routing-mysql.test.js tests/migrations/report-review-mysql.test.js tests/migrations/qa-backend-lifecycle-mysql.test.js
npx playwright test --config=playwright.report-review.config.js --output=.data/report-live-layout-2026-10-27/browser-results
npx playwright test --config=playwright.report-details.config.js --output=.data/report-live-layout-2026-10-27/details-results
```

Evidence root: `.data/report-live-layout-2026-10-27/`. Node: 1,164 passed, zero failed/skipped (`node.log`). Private MySQL: 40 passed, zero failed, one optional real-FastAPI case skipped (`mysql.log`). Report Review Playwright: 30 passed, zero failed (`browser.log`). These include Admin direct-API restrictions, authorized routing/duplicate actions, unassessed Barangay resolution with required photos, historical severity preservation, send/reply/reload and lost-acknowledgement idempotency, automatic polling, read-only public comments and reply spacing. The complete Report Details Playwright suite finished with 156 passed, zero failed (13.5 minutes, `details.log`). All final executed tests passed; the optional real-FastAPI skip remains explicitly unexecuted in this amendment.

The final matrix contains 192 role/status/theme/viewport combinations at 390, 768, 1024, 1280, 1440 and 1920px. Its two diagnostics files record zero horizontal overflow, unhandled page exceptions, console errors, failed requests and local HTTP 5xx responses. Original prediction/90% rendering uses controlled inference fixtures, not a new model accuracy test. Current representative screenshots and both diagnostics files are copied under the evidence root's `visual/` directory; desktop light and mobile light screenshots were visually inspected, including the separated reply label and equal desktop photo/card heights.

The staged patch initially matched its saved snapshot byte-for-byte. An external staging operation subsequently staged the current changes while tests were running; this agent issued no staging command and did not undo that operation. Protected migration/model hashes remain unchanged (`preservation.json`). The unrelated Admin overview stylesheet change was left alone. Pending configured migrations were not applied, port 3000 was not restarted, Aiven/production were not accessed for writes, model weights were not changed, and no commit/push/deploy was performed. Automatic refresh is periodic while the page is visible; this amendment does not claim instantaneous push delivery.

Rollback: use the saved pre-edit source copies in `.data/admin-incident-panel-2026-10-27/before/` and `.data/report-live-layout-2026-10-27/before/` to selectively reverse this amendment's hunks after reviewing subsequent edits. Do not reset the working tree or overwrite unrelated staged changes. There is no database rollback for these UI/diagnostic changes. Configured-environment readiness remains YELLOW while migration-dependent capabilities await separately approved local setup; isolated passing tests do not apply those migrations.

Final verification: Report Review 30/30 and Report Details 156/156 passed. Current screenshots were visually inspected at desktop light/dark, tablet and mobile widths. The 192-combination matrix remains free of recorded overflow or browser diagnostics errors. The existing port-3000 listener was observed as PID 12932 and was not terminated or restarted. Only the QA report was amended after the external staging operation; this agent did not stage it.
