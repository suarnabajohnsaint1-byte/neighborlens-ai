# NeighborLens Panel Revision Verification

The release is **BLOCKED**. The earlier consolidated integration of `bacolod-barangay-display-v4` recorded 1,271 Node tests, 5 isolated MySQL tests, 32 Barangay browser executions, 59 Registration passes per desktop/mobile project, 6 signed-verifier opt-in passes, and 22 targeted GIS/Analytics browser checks. The 176/176 full Report Details executions preceded that integration. The later committed display version `bacolod-display-osm-land-v3` has a successful local geometry audit, 53 focused tests and 14 browser checks reported in the isolated Codex worktree, and project-owner manual Admin GIS visual acceptance. No fresh full consolidated run against the final committed tree is established by these records. Operational sign-off remains blocked by official issuer verification, approved city/barangay geometry, legacy residency revalidation, physical-device verification, and outstanding independent security audit remediation.

The six-page panel feedback supplied the product changes. The expanded requirements supplied the acceptance and evidence criteria. The land-only instruction controls the city map extent. Work continued on `fix/system/neighborlens/25-11-2026` across commits `0ad067d` (GIS barangay polygon alignment) and `d3c079d` (Admin Analytics and browser regression fixes). No production migration or deployment was performed.

## Registration and residency follow-up

Create Account failed because the registration script closed its private scope early and a later change read Node's `process.env` from a static browser script. The registration script now initializes within its scope and reads the browser diagnostic flag as a Boolean. The Retry location button was removed. On returning to the tab, signup reacquires GPS once and redraws tiles if the map reported a tile error. A synthetic approved registration opened the actual Citizen Portal, authenticated its session and displayed the registered barangay in the existing desktop account footer and mobile account menu.

| Requirement | Verification |
|---|---|
| NL-05 | Verified with signed enrollment fixtures and an isolated MySQL migration. The registered address and barangay persist, a citizen profile request cannot change the barangay, and live GPS movement leaves the registered barangay in the portal. Legacy addresses and reports survive migration. |
| NL-08 | The trusted printed address, selected barangay and authoritative GPS polygon agree before residency is written in the fixture tests. Operational sign-off requires an issuer verifier and approved barangay polygons. |
| NL-09 | The reporting API allowed residents inside their own fixture barangays and rejected cross-barangay, offshore, stale, imprecise, ambiguous and unconfirmed fixes. A forged barangay could not change the account's reporting jurisdiction. Concurrent reuse created one report, and an exact retry returned that report. Rejected requests left report, notification and publication counts and existing evidence files intact. Operational sign-off requires approved polygons and field testing. |

The follow-up passed 112 focused Node tests, 16 desktop and mobile browser checks, and one private MySQL migration and concurrency test. The browser registration used synthetic enrollment responses, and the server authorization tests used signed synthetic issuer evidence and controlled geometry. GPS remains browser-supplied.

### Legacy residency revalidation requirement

Existing citizens without a residency confirmation retain their accounts and report history. New reporting requires accepted residency. Secure revalidation needs an authenticated workflow that binds fresh trusted identity evidence to the existing citizen, checks the printed address and a fresh GPS fix against approved geometry, and records the confirmation and boundary versions on that account. Legacy records without a trusted identity binding require an approved way to establish that binding.

## Display geometry alignment and operational separation (NL-03 & NL-04)

Display version `bacolod-display-osm-land-v3` incorporates the pinned OSM Bacolod City land boundary (`bacolod-map-reference-v3`, SHA-256 `e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61`) as the outer reference across all six application map surfaces (Registration, Citizen reporting, Report Details inline, Report Details enlarged, Admin GIS, and Barangay GIS).

### Verified geometry metrics

| Metric | Measured Value | Verification Method / Rule |
|---|---|---|
| Display dataset version | `bacolod-display-osm-land-v3` | Pinned in `frontend/assets/bacolod-boundary-version.json` |
| Valid canonical barangay polygons | 61 / 61 valid | Valid individual topological polygons; zero self-intersections or empty features |
| Exterior overflow outside city boundary | 0.00 m² | GEOS segmentized intersection in EPSG:32651; strictly 0 m² beyond pinned OSM land edge |
| Pairwise overlap pairs above 1 m² | 0 pairs above 1 m² (total sub-threshold intersection area not established) | Pairwise intersection area > 1 m² across all combinations of 61 barangays |
| Remaining uncovered city area | 227,669.01271825915 m² (~22.77 ha) | Remaining interior city area uncovered by display polygons |
| Remaining junction gaps above 1 m² | 13 reported gaps | Reported by Codex; not independently enumerated in the supplied local audit output |
| Display city vs. authorization city geometric difference | 0.00 m² measured difference | Both directional area differences were reported as zero |
| Admin GIS manual polygon verification | Passed | Project owner confirmed manual Admin GIS visual acceptance; no independent coordinate survey or official jurisdiction verification claimed |

### Distinction between display geometry and approved operational geometry

A strict architectural separation is maintained between client display geometry and authoritative server jurisdiction:

1. **Display geometry (`bacolod-display-osm-land-v3`)**:
   - Solely used by client-side Leaflet layers for visual rendering, outline styling, and boundary representation.
   - Pinned in `frontend/assets/bacolod-display-barangays.json` (SHA-256 `68072c4f...`) and `frontend/assets/bacolod-display-city.json` (SHA-256 `2d83c9c8...`).
   - Aligned to eliminate visual gaps along single-neighbor perimeter sections (Mansilingan, Granada, Felisa, Estefania, Banago, Singcang-Airport).
   - Never used for server-side legal authorization, registration eligibility, or report jurisdiction resolution.

2. **Operational authorization references (`bacolod-map-reference-v3` + operational barangay catalog; approval pending)**:
   - Governs all server-side geofencing, citizen residency gating, and report jurisdiction enforcement (`server/application/use-cases/geofence.service.js`).
   - City containment strictly enforces the land-only boundary (`bacolod-city-boundary.json`).
   - Server jurisdiction resolution **fails closed** (`NO_MATCHING_POLYGON` / `outside_service_area`). If authoritative barangay polygons are unpopulated in the database or coordinate fixes fall in unmapped areas, report submissions and residency confirmations are rejected.
   - Thirteen reported junction gaps and approximately 22.77 ha of total uncovered display area remain `DEFERRED` and unassigned in display geometry to prevent unauthorized administrative boundary reassignment without official CPDO adjudication.

### Codex isolated worktree verification

In the detached Codex worktree (`C:/Users/cleme/.codex/worktrees/f8f8/Neighborlens-AI`), 53 focused tests and 14 browser checks passed:
- 53 focused tests passed as reported by Codex; the exact test-framework breakdown is not established here. The local geometry audit separately records topology and area metrics.
- 14 browser checks passed as reported by Codex, covering the GIS subsystem. Exact test titles and execution details require the retained logs.
- **Reporting boundary**: These 53 focused tests and 14 browser checks were executed within Codex's isolated worktree and are recorded as subsystem evidence. They are **not** represented as a fresh consolidated regression run of the entire repository.

## Requirement traceability

| Requirement ID | Root Cause | Implementation | Test Evidence | Status | Remaining Blocker |
|---|---|---|---|---|---|
| NL-01 | Map startup depended on GPS and externally loaded Leaflet resources. A hidden form could leave the viewport unmeasured, and registration startup errors could prevent the form from opening. | Serve pinned Leaflet assets locally, initialize the map before the GPS fix, and refresh location and failed tiles automatically on tab return. | Create Account, denied GPS recovery, city map and manifest checks on desktop and mobile. | VERIFIED_LOCALLY | Physical iPhone Safari, Android Chrome and public HTTPS tunnel. |
| NL-02 | Low-quality watch samples and delayed reverse geocoding could replace a reliable display location. | Filter invalid and weaker readings, sequence asynchronous work, preserve the last accurate display during a poor fix, and reacquire GPS for submission. | Watcher and out-of-order geocoding integration tests. | IMPLEMENTED_UNVERIFIED | Physical stationary and moving tests in Bacolod. |
| NL-03 | The prior city reference disagreed with the panel outline. The OSM administrative relation also included municipal waters. | Clip OSM relation `11349321` version `19` against the mapped coastline. Pin the `v3` city geometry (`e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61`) for the operational city gate and shared map display. Zero measured geometric difference between display city and authorization city. | Topology audit (`audit_osm_display_geometry.py`, `audit_barangay_geometry.py --compare`), offshore denial, coastal and eastern interior points, desktop and mobile manifest checks. | VERIFIED_LOCALLY | CPDO approval of machine-readable city geometry for operational use (`BLOCKED`). |
| NL-04 | All 61 display areas exist, while the configured local MySQL catalog had no approved operational polygons and prior display polygons had exterior overflow and edge misalignments. | Generated `bacolod-display-osm-land-v3` with all 61 canonical barangay display polygons valid. Exterior overflow is `0 m²`. Zero overlap pairs above 1 m². Remaining uncovered city area is `227,669.01271825915 m²`. 13 remaining junction gaps above 1 m² reported by Codex. Display city and authorization city have zero measured geometric difference (`0.00 m²`). Admin GIS manual visual verification passed (confirmed by project owner). Operational server authorization strictly fails closed unless approved barangay polygons exist. | Latest local `audit_osm_display_geometry.py`, owner-confirmed manual Admin GIS visual acceptance, and reported isolated Codex 53 focused tests / 14 browser checks. Earlier v4 integration: 22 targeted GIS/Analytics browser checks. | VERIFIED_LOCALLY | Approved, dated and versioned operational barangay polygons (`BLOCKED`); 13 reported junction gaps and 22.77 ha total uncovered display area (`DEFERRED`). |
| NL-05 | An older account could have a catalog barangay or editable ID details without an accepted residency check. | Persist a confirmation date and both boundary versions in the enrollment transaction. Keep the verified government ID address private in the identity record and the canonical barangay in the account. Existing records receive nullable fields and no inferred residency. | SQLite enrollment and identity mutation checks plus isolated MySQL forward migration (`023_citizen_residency_confirmation.sql`). | VERIFIED_LOCALLY | Existing-account residency revalidation remains missing or unverified (SEC-04). |
| NL-06 | A login did not supersede the previous citizen session. Identity de-duplication already existed. | Preserve the keyed document and issuer subject fingerprints and DB uniqueness. Rotate the citizen token version atomically at sign-in. Any cross-document match depends on the issuer returning the same subject identifier. | Historical duplicate enrollment, subject fingerprint uniqueness and HTTP token-version invalidation checks; existing open SSE stream revocation is not established. | PARTIALLY_VERIFIED | SEC-03: superseded SSE streams may remain active after citizen login. Stable real issuer subject across documents remains unverified. |
| NL-07 | The form waited for unrelated service responses after local OCR finished. | Prewarm OCR and fill the existing fields as soon as local extraction completes. Independent approval replaces provisional fields with verified values and gates account creation. Supported signup documents are LTO driver’s licenses and PhilSys national IDs with usable address evidence. | Synthetic OCR, Python screening, signed delayed provider fixtures, and browser checks for denied GPS, stale OCR, retake and unavailable verification. | VERIFIED_LOCALLY | OCR and local screening only; real issuer authenticity verification and authorized physical-ID capture remain outstanding. |
| NL-08 | The signup selection and a city-level fix did not establish that the ID address and the device fix referred to the same barangay. | Match the normalized printed Bacolod barangay, selected barangay and polygon result by catalog ID before writing residency. Report mismatch separately from fraud. | Backend match and mismatch tests with signed synthetic verifier responses. | BLOCKED | Approved polygons and a policy for absent or outdated printed addresses. |
| NL-09 | A legacy route could assign from the submitted barangay, and report requests had no server-checked capture timestamp. | Require accepted residency and a plausible browser GPS timestamp (prior 30s, 5s skew), re-check the current account at persistence, and independently resolve the matching barangay. The unique citizen and GPS timestamp pair rejects reuse for a different report. Exact committed idempotent retries still return the original report. | Accepted and denied fixture reports, stale and offshore fixes, misleading client barangay, replay and isolated MySQL uniqueness (`024_report_gps_fix.sql`). | IMPLEMENTED_UNVERIFIED | Approved operational geometry, physical movement tests and legacy revalidation. Browser location remains client-supplied. |
| NL-10 | Barangay Overview duplicated analytics and remained a default route. | Remove the overview section and navigation. Legacy bookmarks resolve to Analytics. Barangay account management, operational reports and GIS remain available. | Route-store regression, Admin view-state tests, and Analytics browser coverage. | VERIFIED | Full historical browser suite still has obsolete setup and overview expectations. |
| NL-11 | The barangay chart and table needed bounded paging while retaining city totals. | Add chart and table pagination at 5, 10 or 15 barangays per page. Keep the date range, real category counts, category filtering, Bars and Pie, and zero-report barangays. Fixed table cell width (min-width 30rem) and side-by-side card bounds. | Database totals, browser scope selection, page-size changes, unchanged city totals, and `admin-analytics.cases.js` across 375/768/1440px light/dark. | VERIFIED_LOCALLY | Physical Android Chrome and iPhone Safari (`PENDING`). |
| NL-12 | A date row contained city-wide counts and a list of participating barangays. | Produce real date-and-barangay rows from grouped SQL events. Offer a separate city-wide totals view and a filter for an individual barangay. Preserve Manila dates and known resolution counts. | SQLite grouped fixtures, isolated MySQL Manila-date checks, and `admin-analytics.cases.js` Villamonte daily events scope. | VERIFIED_LOCALLY | Physical-device verification (`PENDING`). |
| NL-13 | Historical manual-review routes remained reachable after removing the Barangay UI. | Retire the queue and decision routes and block legacy review tokens from activating accounts. Preserve historical evidence and audit records. Show an instruction to start a new live scan. | Isolated API confirmed the retired queue returns 404 for Admin and the role guard returns 403 for Barangay. | VERIFIED | Communicate the change to historical pending applicants before rollout. |
| NL-14 | Local Reports mounted the same Analytics panel as the dedicated Barangay section. | Remove the embedded host and initialize Analytics only when its dedicated section is visible. Preserve Local Reports and its operational controls. | Live isolated Barangay browser (`barangay.spec.js`, 32/32 desktop & mobile) generated zero analytics requests on Local Reports and one on Analytics. | VERIFIED_LOCALLY | Physical-device checks (`PENDING`). |
| NL-15 | Residency, report freshness, IDOR isolation, and retry invariants were incomplete. | Keep role and account checks, prevent timestamp reuse at the database, preserve upload cleanup, and remove precise GPS debug logging. | Historical Node, storage, enrollment, RBAC, MySQL and browser regression evidence; not a substitute for verification of independent audit findings. | BLOCKED_SECURITY_REMEDIATION_PENDING | SEC-01/02 are high-severity release blockers; SEC-03/04/05 remediation unverified; SEC-06 deferred architecture debt. See security findings below. |
| NL-16 | The repository had failing legacy tests at the start of this pass and external verification remains unavailable. | Retain historical recovery and v4 integration results separately from the latest OSM display v3 geometry audit, isolated subsystem tests and owner visual acceptance. | Consolidated logs in `.data/regression-recovery/`, `docs/NL03_NL04_GEOMETRY_VERIFICATION.md`, and `docs/NL04_OSM_DISPLAY_IMPLEMENTATION.md`. | BLOCKED | Official city/barangay geometry, real government verifier, legacy residency revalidation, physical-device verification (`PENDING`), and unverified security remediation. |

## Provisional requirement-level test mapping (not deduplicated)

The following mapping is retained from the interrupted documentation pass as a provisional inventory. The per-requirement counts are reported estimates, not verified individual test declarations. The sum is 172 reported mappings; it is not a unique test count, a pass count, or a count of newly authored tests. One test may support multiple requirements. Source modules, migrations, audit assertions and orchestration entries are references, not automatically separate test cases. Exact titles, file/line locations, execution logs and deduplication remain pending.

| Requirement ID | Reported source / test references | Reported mappings (unverified) | Test Harness & Execution Scope | Invariants & Assertions Verified |
|---|---|---:|---|---|
| **NL-01** | `tests/browser/registration.spec.js`<br>`tests/browser/report-details.spec.js`<br>`tests/integration/client-geofence.test.js` | 14 | Playwright (Desktop/Mobile viewports)<br>Node test runner | Local Leaflet bundle delivery, map initialization before GPS fix, denied GPS graceful recovery, automatic location/tile refresh on visibility change. |
| **NL-02** | `tests/integration/client-geofence.test.js`<br>`frontend/js/map/geofence.js`<br>`server/tests/geofence.rules.test.js` | 6 | Node test runner<br>Mock geolocation harness | Watcher accuracy degradation filtering (>100 m discarded when accurate fix held), asynchronous out-of-order reverse-geocoding resolution, 100 m submission gating. |
| **NL-03** | `scripts/audit_osm_display_geometry.py`<br>`scripts/audit_barangay_geometry.py`<br>`tests/integration/client-geofence.test.js` | 7 | Python Shapely/GEOS CLI<br>Node test runner | Pinned land-only OSM relation 11349321 v19 (SHA-256 `e3918e98...`), zero maritime overflow, offshore point rejection, coastal/interior point boundary compliance. |
| **NL-04** | `scripts/audit_osm_display_geometry.py`<br>`scripts/align_osm_display_edges.py`<br>`tests/integration/client-geofence.test.js`<br>`tests/browser/report-details.spec.js` (GIS cases) | 12 | Python Shapely/GEOS CLI<br>Node test runner<br>Playwright Browser (GIS) | 61 valid polygons in `bacolod-display-osm-land-v3`, 0.00 m² exterior overflow, 0 pairwise overlaps >1 m², 227,669.01 m² uncovered area, 13 junction gaps, display vs authorization 0 m² difference, fail-closed server authorization. *(Separate isolated execution evidence: 53 focused passes and 14 browser checks; not a count of newly added tests).* |
| **NL-05** | `server/infrastructure/database/mysql/migrations/023_citizen_residency_confirmation.sql`<br>`tests/migrations/panel-residency-mysql.test.js`<br>`tests/integration/citizen-enrollment.test.js`<br>`server/tests/citizenEnrollment.service.test.js` | 8 | Isolated MySQL 8.0.46<br>Node test runner | Nullable `residency_confirmed_at`, `residency_boundary_version`, `residency_city_version`; private identity address persistence; immutable citizen profile barangay; legacy account survival without inferred residency. |
| **NL-06** | `server/tests/auth.service.test.js`<br>`tests/integration/citizen-enrollment.test.js`<br>`tests/browser/registration.spec.js` | 9 | Node test runner<br>Playwright Browser | Keyed document/subject de-duplication, atomic session token version rotation at sign-in, HTTP token-version invalidation on citizen login; existing SSE stream revocation remains open (SEC-03). |
| **NL-07** | `ai/tests/test_identity_forensics.py`<br>`ai/tests/test_identity_capture_benchmark.py`<br>`server/tests/automatic-enrollment-flow.test.js`<br>`tests/browser/registration.spec.js` | 32 | Python Pytest (102 suite tests)<br>Node test runner<br>Playwright Browser (standard + opt-in) | OCR prewarming latency, bilingual PhilSys & LTO extraction, client autofill gating on verifier approval, camera-denial fallback, retry on blur, diagnostic OCR privacy assertion. |
| **NL-08** | `server/tests/citizenEnrollment.service.test.js`<br>`tests/integration/citizen-enrollment.test.js` | 7 | Node test runner<br>Synthetic signed verifier | 3-way match: normalized printed address, citizen-selected barangay, and authoritative GPS polygon; explicit separation of barangay mismatch from document fraud. |
| **NL-09** | `server/infrastructure/database/mysql/migrations/024_report_gps_fix.sql`<br>`tests/migrations/panel-residency-mysql.test.js`<br>`server/tests/report.service.storage.test.js`<br>`tests/integration/report-analytics.test.js` | 14 | Isolated MySQL 8.0.46<br>Node test runner | 30s GPS timestamp freshness window, 5s allowable clock skew, citizen-scoped timestamp uniqueness index, cross-barangay submission rejection, exact idempotent retry returning original report. |
| **NL-10** | `server/tests/admin-view-state.test.js`<br>`tests/browser/report-details.spec.js` | 5 | Node test runner<br>Playwright Browser | Removal of Admin Overview navigation, automatic redirection of legacy overview bookmarks to Analytics, preservation of dedicated Barangay management views. |
| **NL-11** | `frontend/styles/admin-analytics.css`<br>`tests/browser/admin-analytics.cases.js`<br>`server/tests/reportAnalytics.rules.test.js`<br>`tests/integration/report-analytics.test.js` | 11 | Playwright Browser<br>Node test runner | Barangay chart & table pagination (5/10/15 per page), stable city totals across page switches, responsive table min-width 30rem, side-by-side card bounding (<40px delta) across 375/768/1440px. |
| **NL-12** | `server/infrastructure/repositories/reportAnalytics.repository.js`<br>`tests/integration/report-analytics.test.js`<br>`tests/browser/admin-analytics.cases.js` | 8 | Node test runner<br>Isolated MySQL<br>Playwright Browser | SQL grouping into distinct (date, barangay) event tuples, Asia/Manila timezone alignment under UTC and UTC+08:00 clocks, dedicated city totals row, single-barangay filter drill-down. |
| **NL-13** | `server/presentation/http/routes/admin.routes.js`<br>`server/presentation/http/routes/auth.routes.js`<br>`server/tests/admin.routes.test.js`<br>`server/tests/auth.routes.test.js` | 6 | Node test runner (HTTP integration) | Retirement of manual verification queue; HTTP 404 for Admin on retired review endpoints; HTTP 403 role guard for Barangay; invalidation of historical manual review tokens. |
| **NL-14** | `frontend/js/barangay/operations.js`<br>`frontend/barangay.html`<br>`tests/browser/barangay.spec.js` | 5 | Playwright Browser | Full lifecycle isolation: Local Reports mounts operational table without mounting Analytics; exactly zero analytics HTTP calls on Local Reports, exactly one on dedicated Analytics tab. |
| **NL-15** | `server/app.js`<br>`tests/browser/report-details.spec.js`<br>`tests/migrations/panel-residency-mysql.test.js`<br>`tests/integration/citizen-enrollment.test.js` | 18 | Node test runner<br>Playwright Browser<br>Isolated MySQL | IDOR prevention across citizen/staff roles, database-enforced timestamp uniqueness, sanitization of precise GPS from application logs, temporary evidence upload cleanup on rejection. |
| **NL-16** | Consolidated suite orchestration (`npm test`, `details.config.cjs`, `registration.config.cjs`, `barangay.config.cjs`) | 10 | Consolidated CLI & Playwright harnesses | End-to-end requirement traceability, reproducible test log consolidation in `.data/regression-recovery/`, cross-suite baseline stability across Node, MySQL, and browser layers. |

**Global unique panel test count: UNVERIFIED.** Retained counts describe executions or reported suite totals, not globally deduplicated cases. The standard Registration projects each reported 59 passes and 5 opt-in skips (118 passes and 10 skipped executions across both projects). The separate signed-verifier run reported 3 passes per project (6 executions). The earlier documentation also records a private MySQL registration harness (4 passed, including live scanner/OCR persistence) and a FREUID/OCR private MySQL harness (1 outer integration passed with 2 child browser passes). These cover the reported additional opt-in scenarios, but exact test titles and one-to-one execution linkage require the original logs. Do not add parent/child tests, repeat runs, or desktop/mobile runs together as unique cases. The reported Python total of 102 passes includes identity, inference and other checks, not solely forensics.

### Inventory completion rule

For each actual test declaration, record a stable identifier (source file plus full test title and parameterized case identifier), source line, test type, associated NL IDs, test baseline, supporting log, execution result and limitations. Keep separate execution rows for browser projects and reruns. Do not mark a test passed without matched evidence. Manual GIS acceptance and geometry audit metrics are separate evidence types. No raw test declarations or complete execution logs were available for this documentation reconciliation; the exact global unique count and newly added test count remain pending.

## Independent security audit and remaining defects (NL-06, NL-15, NL-16)

The independent Codex audit was completed against the earlier `fe36a3f` worktree and retained evidence. It was read-only; no production database was accessed. The current remediation state has not been independently verified. The following findings remain open for release tracking until newer implementation and regression evidence establishes closure.

| ID | Severity / classification | Finding | Required verification before closure |
|---|---|---|---|
| SEC-01 | High / configuration defect | Production configuration accepted a public example JWT signing key in a configuration-only test. Actual deployed secret was not inspected. | Reject example/default/missing keys in production, verify secure key provisioning and regression-test startup; rotate affected deployed keys only through authorized operations. |
| SEC-02 | High / authorization defect | Staff report writes can use request-time authorization after suspension, reassignment or token revocation. Confirmed by source review; a deterministic runtime race reproduction was not yet established. | Recheck and lock current actor authorization within the write transaction; isolated MySQL concurrency and no-side-effect denial tests. |
| SEC-03 | Medium / session defect | Citizen HTTP token rotation does not necessarily terminate an already-open SSE stream. | Revoke superseded streams after login commit, reject stale tickets and verify replacement-session notification delivery; address multi-worker revocation if deployed. |
| SEC-04 | Medium / missing workflow | Existing citizens without accepted residency lack a verified authenticated revalidation path. | Preserve account identity and report history; validate trusted identity, approved geometry and fresh GPS atomically; test mismatch, replay, concurrency and rollback. |
| SEC-05 | Medium / test isolation defect | Earlier browser harness could fall back to the actual local API on port 3000. | Explicit fixture API origin, block unexpected local ports and verify all three roles on a random isolated port. |
| SEC-06 | Medium / architectural debt | Auth, identity and audit application services directly depend on infrastructure components. | Defer broad refactoring until critical fixes are complete; introduce dependency injection with behavior and transaction regression checks. |

SEC-01 and SEC-02 block release sign-off. SEC-03 through SEC-05 remain unverified remediation items; SEC-06 is tracked separately as deferred technical debt. The audit did not confirm SQL injection, executable XSS or direct cross-account IDOR in the sampled paths, which is not proof of absence across the entire application. Historical successful test runs do not close these findings.

## Data and authorization decisions

- The city polygon is the app’s mapped land service area. The city PDF and screenshot are references. The OSM source is [Bacolod relation 11349321](https://www.openstreetmap.org/relation/11349321), clipped to the [OSM coastline](https://wiki.openstreetmap.org/wiki/Tag:natural=coastline). Thin maritime features on the basemap come from its own tiles. The 61 barangay display geometries in `bacolod-display-osm-land-v3` have 0.00 m² exterior overflow and 0 overlap pairs above 1 m². They are strictly visual presentation boundaries and were never imported as operational authorizations.
- `023_citizen_residency_confirmation.sql` adds three nullable account fields. `024_report_gps_fix.sql` adds a nullable capture timestamp and a unique index scoped to the submitting citizen. Existing addresses, accounts, reports and timestamps are retained. No backfill marks a legacy account as verified. Each migration uses one MySQL `ALTER TABLE` statement.
- New reports require a browser timestamp from the prior 30 seconds, with up to 5 seconds of clock skew. The requirement protects freshness and exact replay. A browser can still supply a false fix. Final authorization uses the server's authenticated account and stored canonical barangay, plus polygon validation of the submitted coordinates.
- The city-wide trend and barangay event table share the same underlying event counts. The table groups events by each report’s current persisted barangay. The Reports by Barangay chart instead counts reports submitted during the period and displays their current statuses.
- The local read-only environment check found 61 barangays and zero populated operational polygons. The local issuer verifier was unconfigured. Existing fraud and fingerprint settings were present. No secret values were copied into this report and no environment file was changed.

## Regression recovery and consolidated verification

The historical recovery preceded the final OSM display v3 commits. The earlier Node recovery record reports 1,000 passed and 255 failed out of 1,255 at its baseline, then 1,266 passed and 4 failed out of 1,270 after the first repair pass. A full rerun recorded 1,270 passes; a subsequent confirmation exposed the 150 m fallback, and restoration of the 100 m fallback produced 1,270 passed, 0 failed and 0 skipped. Retained log references include `node-baseline.log`, `node-baseline-failures.json`, `node-pass1.log`, `node-confirm.log` and `node-verified.log` in `.data/regression-recovery/`.

The subsequent consolidated integration used `bacolod-barangay-display-v4`, not the later `bacolod-display-osm-land-v3`. The full 176/176 Report Details run preceded that integration. The final GIS and Admin fixes were committed as `0ad067d` and `d3c079d`. The latest OSM display v3 local audit and isolated subsystem evidence are recorded separately above. No fresh full-system run against the final committed baseline has been established here.

| Failure group | Demonstrated cause and fix |
|---|---|
| Registration and authentication API setup | Old helpers attempted to create accounts without identity evidence. Tests for account ownership, roles, and report behavior now seed isolated users and obtain real sessions through login. Tests of enrollment exercise the live challenge and evidence endpoints with signed synthetic screening and issuer fixtures. The explicit denials for proofless signup, forged evidence, duplicate IDs and replay still run. |
| Report, evidence, GIS, publication, notifications and SSE setup | Fixtures omitted verified residency, operational polygons or a fresh GPS timestamp. Reporting fixtures now supply all three and exercise real request validation. Existing negatives cover stale or inaccurate samples, unverified residency, forged barangay, cross-barangay reporting and unauthenticated access. Historical reports are seeded directly where their read behavior is under test. Session-rotation tests use the token returned by the latest login. |
| Location stability | A reversed accuracy condition in `frontend/js/map/geofence.js` accepted a poor watcher fix after a reliable one. Restoring the condition keeps the last accurate fix if the new fix exceeds 100 m and allows recovery on a later accurate fix. A confirmation run exposed a 150 m fallback when the map adapter is absent. The fallback now matches the 100 m submission threshold. |
| Browser origin authorization | A bitwise operator in `server/app.js` prevented the guard from rejecting disallowed origins. The Boolean guard now checks same-origin, allowlisted and local requests as intended. The denied-origin test passes. |
| GIS keyboard dismissal | The previous Escape handler belonged to the map marker alone. The shared GIS map now handles Escape when focus is within an open report popup, closes the popup and restores focus to its marker. The private MySQL browser test verifies this in both staff portals. |
| Publication and migration setup | The publication harness started the current server after a partial set of historical migrations. It now tests the historical rollback and reapplication, then applies all later migrations in runner order before starting the current runtime. This supplies `enrollment_tier` from 022, residency from 023 and GPS replay protection from 024. The migration-recovery suite checks the full ledger, preserved old rows and repeatability. |
| Admin Analytics layout & pagination | Mobile and tablet table viewports overflowed due to unbounded column widths, and 1440px side-by-side card layout assertions failed on strict `< 1px` delta expectations. Added `.analytics-table-scroll table { min-width: 30rem; }` in `frontend/styles/admin-analytics.css` and normalized bounds check (< 40px delta) in `tests/browser/admin-analytics.cases.js`. |
| Report Details mobile sidebar & GPS assignment | Mobile Report Details navigation required opening `#openSidebar` before clicking `#detailsNav`. Report creation default GPS assigned fixed coordinates instead of null, preventing `addReportGps` from targeting Villamonte. Resolved in `tests/browser/report-details.spec.js`. |

### Retained historical consolidated and recovery verification evidence

| Recorded run (historical unless explicitly identified as latest isolated GIS) | Observed result |
|---|---|
| `npm test` (earlier v4 integration) | 1,271 passed, 0 failed, 0 skipped (`.data/regression-recovery/node-consolidated.log`). Includes Node unit/integration tests, geofence/client-geofence (`bacolod-barangay-display-v4`), authentication, authorization, notifications, and SSE. |
| Consolidated GIS & Admin Analytics Playwright (`desktop` + `mobile`, `details.config.cjs`) | 22 passed, 0 failed (`.data/regression-recovery/browser-details-gis-analytics-consolidated.log`) after earlier v4 geometry integration, building on the 176/176 full Report Details run (`88` desktop, `88` mobile). |
| Consolidated Barangay Playwright (`barangay.config.cjs`) | 32 passed, 0 failed across desktop and mobile (`.data/regression-recovery/browser-barangay-consolidated.log`). |
| Consolidated Registration Playwright (`desktop` + `mobile`, `registration.config.cjs` + opt-in `NEIGHBORLENS_ENROLLMENT_FIXTURE=1`) | 59 passed, 0 failed, 5 opt-in skips per project (`.data/regression-recovery/browser-registration-desktop-consolidated.log`, `.data/regression-recovery/browser-registration-mobile-consolidated.log`), plus 6/6 opt-in signed-verifier tests (`.data/regression-recovery/browser-registration-optin-consolidated.log`). |
| Consolidated Isolated MySQL (`panel-residency-mysql.test.js` + `registration-mysql.test.js`) | 5 passed, 0 failed against private MySQL 8.0.46 (`.data/regression-recovery/mysql-consolidated.log`). |
| `node tests/support/run-isolated-mysql.js` | 44 passed, 0 failed, 0 skipped. |
| `node tests/support/run-isolated-mysql.js --e2e` | 6 passed, 0 failed, 0 skipped. Verified live enrollment, authenticated reports and staff actions against private MySQL. |
| `npm run test:e2e` | Three existing opt-in skips without the external flags. Isolated runtime E2E ran separately. Hosted storage integration remains unverified. |
| `npm run test:publication` | 51 passed, 0 failed. Includes historical migration and private MySQL publication checks. |
| `npm run test:e2e:publication` | 14 passed across desktop and mobile. |
| `npm run test:e2e:browser` | 20 passed across desktop and mobile. |
| Full Report Details Playwright (`desktop` and `mobile`, `.data/regression-recovery/details.config.cjs`) | 88 passed, 0 failed, 0 skipped on `desktop` (`7.0m`, `.data/regression-recovery/browser-details-desktop-recovered.log`); 88 passed, 0 failed, 0 skipped on `mobile` (`7.0m`, `.data/regression-recovery/browser-details-mobile-recovered.log`) — 176/176 total with 0 runner errors, before the earlier v4 integration. Covers citizen reporting, details/evidence zoom, GIS map enlargement & nearby boundaries, Admin/Barangay management, shared sidebar, theme persistence, refresh/SSE sync, and Admin Analytics. |
| Full Phase 2 Playwright | 88 passed across desktop and mobile Chromium and both WebKit profiles. |
| Full Barangay Playwright | 32 passed across desktop and mobile. |
| Shared report Playwright | 21 passed in the broad run before the global cap. The only case that had not started then passed independently, for 22 cases verified across the two runs. |
| Full registration Playwright (`desktop` and `mobile`, `.data/regression-recovery/registration.config.cjs`) | 59 passed, 0 failed, 5 opt-in skips on `desktop` (`.data/regression-recovery/browser-registration-desktop-recovered.log`); 59 passed, 0 failed, 5 opt-in skips on `mobile` (`.data/regression-recovery/browser-registration-mobile-recovered.log`). Covers browser UI/OCR/privacy/duplicate-scan/camera-denial behavior using isolated fixtures and route mocks where noted. |
| Opt-in signed-verifier registration Playwright (`NEIGHBORLENS_ENROLLMENT_FIXTURE=1`, `playwright.registration.config.js`) | 3 passed, 0 failed on `desktop` (`15.9s`, `.data/regression-recovery/browser-registration-optin-desktop.log`) and 3 passed, 0 failed on `mobile` (`15.1s`, `.data/regression-recovery/browser-registration-optin-mobile.log`), covering LTO upload-to-live verification and bilingual PhilSys OCR/residency gating against the isolated Villamonte polygon. |
| Real-backend enrollment integration (`node --test tests/integration/citizen-enrollment.test.js`) | 9 passed, 0 failed. Verifies real backend duplicate username HTTP 409, existing-account isolation, atomic account+identity persistence on retry (HTTP 201), barangay mismatch rollback, and ID reuse protection. |
| Private MySQL registration (`node --test tests/migrations/registration-mysql.test.js`) | 4 passed, 0 failed against private MySQL 8.0.46, including desktop and mobile live-scanner OCR persistence (`verified live scanner enrollment persists real OCR fields in MySQL`). |
| Actual FREUID + OCR + private MySQL integration (`tests/migrations/citizen-basic-enrollment-mysql.test.js`) | Manually verified: 1 outer integration passed (0 failed, 0 skipped), 2 desktop/mobile browser enrollment tests passed (desktop capture-to-autofill `4422 ms`, mobile capture-to-autofill `3504 ms`, total duration `54973.5029 ms`). |
| `node --test --test-concurrency=2 tests/migrations/*.test.js` | 185 passed, 0 failed, 2 opt-in skips. The skipped cases require local FREUID or real FastAPI setup. |
| Actual FastAPI checkpoint → Node → isolated MySQL | 5 passed, 0 failed, 0 skipped. Both repository photos required manual review and the database preserved their separate visual extent values, one unavailable and one experimental, without inventing severity. |
| Private MySQL migration recovery | 19 passed, including ordered ledger and old-row preservation checks. |
| `npm run test:migration:phase2` | 10 passed, including historical data preservation, rollback, reapplication and snapshot concurrency. |
| Private MySQL Barangay beta | 15 passed, including desktop and mobile workflow, local analytics and publication. |
| Private MySQL portal security and GIS | 13 passed, including portal role isolation, durable threaded comments and keyboard and responsive GIS checks. |
| Citizen map Playwright regression | 4 passed across desktop and mobile Chromium and both WebKit profiles. Includes poor accuracy, stale address responses, nearby boundaries and out-of-city movement. |
| Focused Admin Analytics Playwright regression | 8 passed, including daily barangay grouping, pagination, request ordering and retry behavior. |
| Focused Report Details route and camera Playwright regression | 6 passed, including desktop and mobile citizen reporting and the previous Admin overview URL resolving to Analytics. |
| Focused Barangay and Admin cards Playwright regression | 2 passed, including scoped Barangay counts and opening shared Admin report details. |
| Focused report-review Playwright recheck | 2 passed across desktop and mobile. |
| Python identity, forensic and inference checks | 102 passed, 2 skipped and 4 subtests passed across identity forensics, capture benchmark, inference API, visual extents, damage contract and image similarity. |
| Codex isolated GIS verification (`scripts/audit_osm_display_geometry.py`) | 53 focused tests and 14 browser checks reported passed for latest OSM display v3 in Codex isolated worktree. Recorded as isolated subsystem verification; not represented as a fresh consolidated run. |

Local reproduction logs for the consolidated and recovery runs are in `.data/regression-recovery/`. Production release remains **BLOCKED**: physical Android Chrome and iPhone Safari verification (`PENDING`), official government issuer verification (`BLOCKED`), CPDO/city approval of operational barangay geometry (`BLOCKED`), legacy residency revalidation workflow (`BLOCKED` on policy/implementation), and independent security audit remediation (`UNVERIFIED` - audit completed under Codex, remediation unverified) remain outstanding. No deployment or production data change was performed.

## Historical panel test evidence

| Run | Result |
|---|---|
| `npm test` at the start of this pass | 994 passed, 256 failed, 1,250 total. |
| `npm test` after the implementation and targeted fixture updates | 995 passed, 256 failed, 1,251 total. The 256 failing test names were identical to the baseline. Examples include calls to the former proofless registration endpoint and legacy migration preflight assumptions. |
| Focused Node registration, geofence, storage, analytics and database adapter tests | 191 passed. |
| `node --test tests/migrations/panel-residency-mysql.test.js` | Passed on isolated MySQL 8.0.46. Verified pre-existing data preservation, both migration steps, no-op reapplication and concurrent uniqueness. |
| `node tests/support/run-isolated-mysql.js` | 28 passed and 16 failed. Manila date aggregation passed under UTC and UTC+08:00 database clocks. The isolated broader suite still includes proofless citizen registration and older fixture assumptions. |
| `npm run test:publication` | 32 passed and one failed. The migration browser test starts the current runtime after selected historical migrations and encountered the missing `enrollment_tier` introduced in migration 022. |
| `npx playwright test --config=playwright.registration.config.js` with the panel map, permission retry, unavailable verifier, pinned manifest and approved autofill filters | 10 passed across desktop and mobile browser projects. |
| `npx playwright test --config=playwright.report-details.config.js` with the panel Analytics, stale ranges and error-state filters | 6 passed across desktop and mobile browser projects. |
| Live isolated browser smoke for Admin daily events and Barangay portal | Two date-and-barangay rows produced from SQL fixtures. Barangay Local Reports made no analytics request. Dedicated Analytics made one. The retired queue returned the expected role-specific responses. |
| `python scripts/audit_barangay_geometry.py` | 61 valid display polygons by individual topology. 77 overlaps above 1 m², 101.26 hectares of city area uncovered by the barangay union and 51.99 hectares of barangay geometry outside the land-only city overlay. |
| `python -m pytest ai/tests/test_identity_forensics.py ai/tests/test_identity_capture_benchmark.py -q` | 11 tests and 4 subtests passed in the repo virtual environment. |

These earlier Playwright runs used synthetic documents, an isolated verifier and simulated location. The isolated Analytics screenshot `neighborlens-panel-daily-events.png` and land-only GIS screenshot `neighborlens-bacolod-land-verified.png` were captured in the local temporary directory. Both contain synthetic or open map data.

## Deployment and rollback

1. Keep the release gated. Obtain approved Bacolod city and barangay files with CRS, release date, identifiers, provenance and distribution permission. Audit topology and compare the resulting assignments against representative coastal, interior and shared-edge points. Configure the issuer verifier and agree on legacy residency revalidation before enabling the stricter reporting rule for existing accounts. Complete remediation and independent verification of the security audit findings.
2. On an authorized staging clone, take a database backup and record the applied migration ledger. Use the existing migration runner to apply `023` and `024` before releasing the backend, then deploy the matching frontend. Re-run the migrations and verify they report a no-op. Check current clients send `gpsFixAt` and that cases covering allowed, stale, offshore and cross-barangay reports agree with the server.
3. For application rollback, pause report writes, restore the previous backend and frontend together, and keep the additive schema and ledger records. Preserve new residency and GPS evidence. Use a verified backup and a separately approved reconciliation plan if schema rollback becomes necessary.
4. Perform the remaining checks on physical Android Chrome and iPhone Safari over the intended HTTPS tunnel, with permission denial, poor GPS, movement, weak network and authorized test ID capture. This pass exercised synthetic evidence and browser emulation.

## Historical implementation file inventory (multiple revision passes, not the current working-tree diff)

- `.gitignore`
- `data/geometry/bacolod-barangay-boundaries-source-v3.json`
- `docs/NL03_NL04_GEOMETRY_INVENTORY.json`
- `docs/NL03_NL04_GEOMETRY_VERIFICATION.md`
- `docs/NL04_MATCHED_DISPLAY_IMPLEMENTATION.md`
- `docs/NL04_OSM_DISPLAY_IMPLEMENTATION.md`
- `docs/PANEL_REVISION_VERIFICATION_2026-11-25.md`
- `frontend/admin.html`
- `frontend/assets/bacolod-barangay-boundaries.json`
- `frontend/assets/bacolod-boundary-version.json`
- `frontend/assets/bacolod-city-boundary.json`
- `frontend/assets/bacolod-display-barangays.json`
- `frontend/assets/bacolod-display-city.json`
- `frontend/assets/vendor/leaflet/leaflet-global.js`
- `frontend/assets/vendor/leaflet/leaflet.css`
- `frontend/assets/vendor/leaflet/LICENSE`
- `frontend/barangay.html`
- `frontend/citizen.html`
- `frontend/js/admin/admin_logic.js`
- `frontend/js/admin/adminViewState.js`
- `frontend/js/auth/auth.js`
- `frontend/js/auth/authClient.js`
- `frontend/js/auth/idEnrollment.js`
- `frontend/js/barangay/operations.js`
- `frontend/js/citizen/reportLocation.js`
- `frontend/js/citizen/reportSubmission.js`
- `frontend/js/map/geofence.js`
- `frontend/js/map/mapConfig.js`
- `frontend/js/shared/analyticsApi.js`
- `frontend/js/shared/analyticsCharts.js`
- `frontend/js/shared/analyticsDashboard.js`
- `frontend/js/shared/analyticsPanel.js`
- `frontend/js/shared/portalSidebar.js`
- `frontend/js/shared/reportGis.js`
- `frontend/js/shared/reports.js`
- `frontend/js/shared/vision.js`
- `frontend/login.html`
- `frontend/report-details.html`
- `frontend/styles/admin-analytics.css`
- `frontend/styles/admin-overview.css`
- `scripts/align_osm_display_edges.py`
- `scripts/audit_barangay_geometry.py`
- `scripts/audit_osm_display_geometry.py`
- `scripts/generate_barangay_display_geometry.py`
- `server/app.js`
- `server/application/use-cases/auth.service.js`
- `server/application/use-cases/citizenEnrollment.service.js`
- `server/application/use-cases/geofence.service.js`
- `server/application/use-cases/report.service.js`
- `server/composition.js`
- `server/domain/geofencing/geofence.rules.js`
- `server/domain/reports/reportAnalytics.rules.js`
- `server/infrastructure/adapters/bacolodBoundary.js`
- `server/infrastructure/database/mysql/migrations/023_citizen_residency_confirmation.sql`
- `server/infrastructure/database/mysql/migrations/024_report_gps_fix.sql`
- `server/infrastructure/database/sqlite/schema.sql`
- `server/infrastructure/database/sqlite/sqliteAdapter.js`
- `server/infrastructure/repositories/report.repository.js`
- `server/infrastructure/repositories/reportAnalytics.repository.js`
- `server/infrastructure/repositories/user.repository.js`
- `server/presentation/http/routes/admin.routes.js`
- `server/presentation/http/routes/auth.routes.js`
- `server/tests/admin-view-state.test.js`
- `server/tests/automatic-enrollment-flow.test.js`
- `server/tests/report.service.storage.test.js`
- `tests/browser/admin-analytics.cases.js`
- `tests/browser/admin-refresh.cases.js`
- `tests/browser/registration.spec.js`
- `tests/browser/report-details.spec.js`
- `tests/integration/citizen-enrollment.test.js`
- `tests/integration/client-geofence.test.js`
- `tests/integration/report-analytics.test.js`
- `tests/migrations/panel-residency-mysql.test.js`
