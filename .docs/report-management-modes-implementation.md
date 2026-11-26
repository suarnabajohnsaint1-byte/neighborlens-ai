# Report Management Modes

Branch: `citizen/detection/report/13-10-2026`.

## Root Causes

Pending Posts previously selected a checkbox inside the operational list. It did not change the title, active list mode, table actions or backend report dataset. The queue was a client-side intersection of cached reports and publication IDs. Publication filters were also forwarded to an export contract that did not support them.

Admin and Barangay assembled their controls differently. Admin lacked the shared card/list/split controls, and its compact filter sheet grouped sort/date controls with advanced filters. Moderation was embedded inside the operational Report Details view.

The new delayed-response tests also exposed two refresh problems. Mode re-entry during the notification refresh phase could miss the report reload. Loading text written directly into the card container bypassed the shared render cache, so an identical successful response could leave the Loading message visible. The refresh handoff now tracks the active mode, and all card loading/empty content uses the same rendering cache API as successful content.

## Behavior

Pending Posts opens `admin.html#reports?view=community-review`. It selects Community Review, updates the heading and matching count, clears incompatible filters, resets page one and defaults to oldest publication request first. Operational All/Pending/Ongoing/Resolved/Rejected tabs return to operational reports. Compatible view preferences survive mode changes. Operational filters are restored when returning within the same page; a fresh review-only session falls back to operational defaults on exit.

The review dataset comes from `GET /api/reports?publication=pending_approval`, not a cache intersection. The server requires Admin and applies a pending publication EXISTS predicate. `pending_approval` is the existing persisted state; it was not renamed to the prompt's illustrative `pending_review`. An ongoing or resolved operational report can still await publication approval. Approved, rejected and unrequested publications are not review queue members.

Search, category, classification, priority and barangay filters apply to that dataset. Review date filtering and sorting use publication request timing. The existing client pagination remains five rows for Admin; Barangay retains its existing authorized server pagination and page-size control. Excel exports all matching authorized records rather than just the current page. Its server-side pending predicate, request-date filtering and publication filter metadata match the review scope.

Approval/rejection removes the item from the review dataset, updates the card and notifications, reconciles pagination and preserves the operational report. AbortController, request revisions and session checks reject late results. An active reload is handed off correctly if modes change while the notification request is in flight. Logout/session changes clear review records, notification content and split details immediately.

## Shared Components

`frontend/js/shared/reportManagement.js` owns the common header/actions, status/mode strip, search/sort/date row, expandable advanced filters, view switcher and split-detail host. It adopts existing control nodes and IDs so current role-specific bindings and permissions remain intact. Both portals render this same layout instead of maintaining separate active toolbar structures. Existing role-specific HTML control definitions remain compatibility inputs; this was not a wholesale rewrite of their controllers.

`frontend/styles/report-management.css` owns the shared layout using existing theme tokens. No theme palette, framework, icon library or dependency was added. Existing Boxicons, report category assets and Excel icon remain in use. Tabs keep their active selection in view when the viewport changes.

ReportCard supplies card rendering and the shared display-title helper. PortalComponents continues to supply pagination, filter sheets, render caching and view preference persistence. Admin desktop List uses the existing table with separate operational/publication columns. Mobile List uses the same compact report card renderer instead of the conflicting stacked-table rules. Cards and Split Detail reuse these records rather than creating a second report store.

Split Detail uses the existing authorized ReportDetailsApi and existing report or publication view in an adjacent pane. Requests and mounted media/maps are cleaned up when the selection, mode or session changes. Opening a dialog clears the pane. Small viewports stack the existing pane instead of introducing another dialog.

## Separate Workflows

View Details opens the operational report view: evidence, description, AI information, location, history and operational review controls.

Review Post opens only publication review: existing sanitized preview, assigned reviewer, history, incident assignment and approval/rejection. Both presentations reuse the existing ReportDialog shell and data client. No second report modal, approval endpoint or publication store was created. Assigned-reviewer checks remain enforced server-side.

Publication moderation is no longer appended to Admin operational details. Citizen publication status remains available. Barangay cannot mount or call Admin moderation actions. Approval confirmation replaces content inside the active dialog temporarily rather than opening a second dialog; cancellation restores the review and focus.

## Verification

| Command | Result | Resources |
| --- | --- | --- |
| `npm test` | 998 passed | Isolated test adapters and mocked external providers |
| `npm run test:publication` | 50 passed | Unit tests and private MySQL 8.0.46 instances with real HTTP/Chromium |
| `node --test tests/migrations/community-publication-mysql.test.js` | 21 passed in the final layout run | Private MySQL, actual persisted roles, real browser |
| `npm run test:e2e:publication` | 10 passed | Isolated citizen desktop/mobile browser tests |
| `npm run test:e2e:browser` | 20 passed | Isolated Phase 1B browser fixtures |
| `npm run test:e2e:phase2` | 26 passed, 16 failed | Existing reviewer fixture/selector failures remain open |
| Focused Admin DOM and Phase 2 cache tests | 59 passed | DOM fixtures updated for required browser methods; attribution/security assertions retained |
| `git diff --check` | Passed | Working tree whitespace check |

Final logs are `tmp/report-management-delivery-regression.log`, `tmp/report-management-delivery-publication.log`, `tmp/report-modes-citizen-browser.log`, `tmp/report-management-phase1b.log`, `tmp/report-management-phase2.log` and `tmp/report-management-dom-final.log`. These runs overlap and are not a count of distinct tests. The tracked whole-worktree diff is `tmp/report-management-tracked-working-tree.patch`; it includes earlier/concurrent edits and excludes untracked file bodies. Final status showed 67 modified tracked entries and 20 untracked entries, including aggregated directories. Nothing was staged or committed.

The final isolated MySQL/browser run includes backend membership independent of operational status, unauthorized list/export rejection, real XLSX contents, notification persistence, assigned reviewer decisions, approval/rejection queue removal, matching counts, refresh/page persistence, mode switching, delayed response cancellation, shared controls, all view modes, split panels, separate operational/moderation dialogs, one active dialog during confirmation, safe error states and light/dark layouts.

Both portals were captured at 375, 768 and 1440 pixels in both themes. Tests check document overflow, active-tab visibility, header text fit and actual loaded rows/cards before capture. Additional existing review layout tests cover 320 pixels, and summary tests cover 390 through 1920 pixels. The final mobile and desktop screenshots were visually inspected; the mobile list no longer clips table content or leaves a stale Loading message after a successful reload.

Read-only configured MySQL check returned zero pending requests and zero matching report rows at the time of verification. This was an aggregate SELECT only. No live approval/rejection, report creation or Supabase write was performed against configured resources. State-changing tests ran in isolated resources. Inference and external storage were stubbed where specified; no live YOLO or Supabase publication write is claimed.

Phase 2 browser failures still use synthetic reviewer tokens that do not match persisted account roles and old page/modal selectors. Failures include navigation and missing `getAllReports`. Authorization and assertions were not weakened. New workflow browser coverage uses actual persisted Admin/Barangay accounts. The separately deferred severity defect was not changed.

## Screenshots

Supplied before references are preserved in `.data/report-management-before/admin-desktop-reference.png` and `.data/report-management-before/barangay-desktop-reference.png`. These are the user's supplied desktop references, not a newly captured baseline. A pre-change mobile baseline was not captured and is not being fabricated.

Final screenshots are in `.data/publication-screenshots/`:

```text
report-management-admin-light-375.png
report-management-admin-dark-375.png
report-management-admin-light-768.png
report-management-admin-dark-768.png
report-management-admin-light-1440.png
report-management-admin-dark-1440.png
report-management-barangay-light-375.png
report-management-barangay-dark-375.png
report-management-barangay-light-768.png
report-management-barangay-dark-768.png
report-management-barangay-light-1440.png
report-management-barangay-dark-1440.png
report-management-admin-split.png
report-management-barangay-split.png
```

Screenshots use fictional test records. Missing evidence in seeded legacy fixtures is displayed as unavailable, not replaced by demonstration photos. Other workflow tests verify two actual authenticated preview images.

## Changed Files

These files were edited for this workstream. Some already contained earlier changes; the complete working-tree diff is not exclusively this task.

```text
frontend/admin.html
frontend/barangay.html
frontend/js/admin/admin_logic.js
frontend/js/admin/adminViewState.js
frontend/js/barangay/barangay.js
frontend/js/reports/reportDetailsView.js
frontend/js/shared/communityPublication.js
frontend/js/shared/portalComponents.js
frontend/js/shared/reportCard.js
frontend/js/shared/reportDialog.js
frontend/js/shared/reportManagement.js
frontend/styles/portal-components.css
frontend/styles/report-management.css
server/application/use-cases/report.service.js
server/application/use-cases/reportExport.service.js
server/domain/reports/reportExport.rules.js
server/infrastructure/repositories/report.repository.js
server/infrastructure/repositories/reportExport.repository.js
server/infrastructure/repositories/reportPage.query.js
tests/integration/admin-classification.test.js
tests/integration/admin-mobile-dialog.test.js
tests/integration/phase-2-cache-remediation.test.js
tests/migrations/community-publication-mysql.test.js
.docs/report-management-modes-audit.md
.docs/report-management-modes-implementation.md
```

No source files were deleted. The obsolete publication checkbox and repeated publication line inside the issue cell were removed. Redundant live toolbar wrappers are replaced by the shared layout at mount. Existing unrelated styles and concurrent edits were preserved rather than deleted speculatively.

## Limits and Handoff

The broader Phase 2 browser suite is not fully green. Admin continues to use existing client pagination over an authorized fetched dataset; this phase does not claim server pagination or a high-volume performance benchmark for Admin. No live user approval or Supabase write is claimed. Before/mobile comparison is limited by the absent pre-change mobile capture.

No database migration, package installation, commit, push, merge or deployment was performed in this workstream. The existing local API and frontend servers were reused. The working tree remains dirty with prior and concurrent changes. Stop here for review.
