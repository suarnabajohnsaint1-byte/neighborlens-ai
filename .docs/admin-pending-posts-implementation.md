# Admin Pending Posts Implementation

Verified on 19 October 2026. Branch: `citizen/detection/report/13-10-2026`.

## Workflow

Valid citizen report submission saves the operational report, one pending publication review, two private publication previews, audit entry and assigned Admin notification through the existing transaction. Publication is automatic; a citizen checkbox is not required. A failed notification insert rolls back report/review persistence and removes uploaded objects.

Unknown incident barangay no longer prevents saving or entering the review queue. The assigned active Admin may reject the publication or assign a recognized incident barangay. Assignment updates report jurisdiction and publication scope together, increments the review version and records an audit event. Citizen registration barangay, location text, GPS coordinates, original AI data and operational status are not copied or rewritten. Publishing still requires a real incident barangay for the existing scoped feed; no address is guessed.

The report form and backend now also accept a blank incident barangay. The form still requires exact GPS, the existing accuracy threshold and an in-service-area result. It does not require a successful barangay name lookup when the location is confirmed inside Bacolod. Shared geofence implementation and registration validation are unchanged. Desktop/mobile browser tests submit an unresolved in-city location through the real report endpoint without substituting the account's registration barangay.

Approval and rejection remain separate from road-repair processing status. Decisions enforce assigned Admin authorization, active database membership, token version, row locks, review version and ownership. Approval confirmation uses the shared component module. Rejection requires a trimmed reason of at least five characters, up to 500 characters. Reviewer IDs, timestamps and prior decisions are shown from persisted history. Concurrent approvals create one post; stale decisions receive 409 and reload the current review.

The existing Report Details component is reused. Successful incident assignment refreshes both modal and standalone report details without a page reload. Public post DTOs and media continue through existing anonymous, authorized interfaces. No private identity fields or evidence storage references were added to public responses.

## Admin Interface

Six equal-width summary cards share one horizontal row: Total Reports, Pending, Resolved, Major Issues, Minor Issues and Pending Posts. Narrow layouts scroll inside the summary container. The old shared mobile two-column rule now excludes Admin summaries rather than overriding other portals.

Pending Posts uses the server publication count, independently of operational Pending and unread notifications. Clicking opens the existing All Reports interface, clears conflicting filters, sorts pending requests oldest first and retains five-item pagination. Filter and page survive refresh. Loading, zero, unavailable and retry states are explicit.

The bell displays persisted notifications and the server unread count. Read and mark-all-read use existing authenticated endpoints. Review notifications use the title `New post awaiting approval` and the actual report ID. Existing SSE delivery triggers coalesced refreshes rather than creating another stream or polling loop. A notification endpoint failure does not invalidate a successfully loaded publication count.

## Approved Local Migration

Migration `012_pending_publication_jurisdiction.sql` was applied only to the approved loopback MySQL database `neighborlens_ai`, after a complete restricted-access backup. It makes pending publication barangay nullable and adds `admin_assigned` to report jurisdiction sources. No reports or posts were backfilled or assigned invented approval history.

Backup: `C:\Users\cleme\.codex\backups\neighborlens-012-2oJI4j\before-publication-012.sql`

Backup size: 1,059,976 bytes.

Backup SHA256: `7bdf5ed4c4a1439c1e95c59b0927e37887e318a0291e4a16d558ccc20d060946`.

Migration checksum: `207922b19471004029ac6e97a3c03f0f2a73de11c8c7dd4068330705d08cbfd6`.

Ordered full-row hashes matched before and after for reports (30), report images (60), community posts (1), publication requests (0), publication media (0), publication reviews (0), legacy allowlist (1), notifications (9) and users (41). Verification metadata is beside the backup in `verification.json`. A rollback guard refuses to narrow the schema while null pending scopes or Admin-assigned jurisdiction values exist. MySQL DDL is not transactionally reversible; do not bypass that guard.

## Verification

| Command | Result | Environment |
| --- | --- | --- |
| `npm test` | 998 passed, 0 failed | Explicit isolated SQLite adapters and mocked external services |
| `npm run test:publication` | 47 passed, 0 failed | Unit tests, private MySQL 8.0.46 on random loopback ports, real HTTP and Chromium |
| `npm run test:e2e:publication` | 10 passed | Isolated desktop/mobile report submission tests |
| `npm run test:e2e:browser` | 20 passed | Isolated Phase 1B browser fixtures |
| `npm run test:e2e:phase2` | 26 passed, 16 failed | Isolated Phase 2 browser fixtures |
| `node --test tests/deferred/phase-4-severity-persistence.test.js` | 1 failed | Existing deferred `low` versus NULL severity regression |
| `git diff --check` | Passed | Working tree whitespace check |

Private MySQL/browser coverage includes automatic pending creation, committed notifications, rollback and media cleanup, legacy post preservation, migration rollback/reapplication, unresolved jurisdiction rejection/resubmission/assignment, different registration and incident barangays, authorization and stale versions, approval confirmation and cancellation, concurrent decisions, scoped feed visibility, private media, persisted history, comments, nested replies, desired-state reactions, oldest-first pagination, refresh persistence, notification read state, independent endpoint failures, loading and zero states.

The summary row was checked in both themes at 1920, 1671, 1440, 1280, 1024, 768 and 390 pixels. Tests assert six equal widths/heights in one row and no document-level horizontal overflow after responsive layout settles. Review layouts also cover 320, 375, 768 and 1440 pixels, two authenticated preview images and touch-sized controls.

Screenshots are in `.data/publication-screenshots/`, including `pending-posts-summary-{light|dark}-{width}.png`, `admin-pending-light.png`, `admin-pending-dark.png`, `automatic-admin-approved.png` and `admin-resolved-incident-jurisdiction.png`. These use fictional identities and generated image fixtures, not real citizen documents. Final light mobile and dark desktop summary screenshots were visually inspected.

The 16 Phase 2 failures remain open. Tests construct reviewer tokens by changing a persisted citizen's role, then navigate to staff pages; current database-backed authorization rejects that identity mismatch. Failures include redirects, missing `getAllReports` and obsolete modal/button selectors. These tests were not weakened and authorization was not relaxed. Passing private MySQL approval tests instead log in actual persisted Admin and Barangay users. Historical broader Report Details browser failures were not reclassified as fixed by this work.

The local API health endpoint responded successfully. No state-changing acceptance test was run against configured MySQL or Supabase. Local schema application and row preservation are verified; an actual user's configured database approval flow and live Supabase publication writes are not claimed as tested. Inference was stubbed in workflow tests; no model, threshold or severity changes were made. SQLite changes are for explicit isolated test adapters only, not a runtime fallback.

## Files Changed in This Workstream

Existing files may also contain earlier or concurrent changes; this list identifies files edited for this workstream, not exclusive authorship of their entire Git diff.

```text
frontend/admin.html
frontend/report-details.html
frontend/js/admin/adminLiveReports.js
frontend/js/admin/admin_logic.js
frontend/js/citizen/citizen.js
frontend/js/reports/reportDetails.js
frontend/js/shared/communityPublication.js
frontend/js/shared/portalComponents.js
frontend/js/shared/reportDialog.js
frontend/styles/admin-overview.css
frontend/styles/portal-components.css
frontend/styles/report-details.css
frontend/styles/style.css
server/application/use-cases/communityPublication.service.js
server/application/use-cases/notification.service.js
server/application/use-cases/report.service.js
server/application/use-cases/report.validation.js
server/composition.js
server/infrastructure/database/mysql/migrations/012_pending_publication_jurisdiction.sql
server/infrastructure/database/mysql/migrations/rollback/012_pending_publication_jurisdiction.sql
server/infrastructure/database/sqlite/publication.sql
server/infrastructure/database/sqlite/schema.sql
server/infrastructure/database/sqlite/sqliteAdapter.js
server/infrastructure/repositories/communityPublication.repository.js
server/presentation/http/controllers/communityPublication.controller.js
server/presentation/http/routes/admin.routes.js
tests/integration/audit-remediation.test.js
tests/integration/backend-qa.test.js
tests/integration/report-image-security.test.js
tests/integration/supabase-transaction-rollback.test.js
tests/migrations/community-mysql.test.js
tests/migrations/community-publication-mysql.test.js
tests/browser/community-publication.spec.js
.docs/admin-pending-posts-audit.md
.docs/admin-pending-posts-implementation.md
```

Regression expectations now account for two original photos plus two private sanitized publication previews and the additional publication audit entry. Corrupt-file rejection, transactional cleanup, ownership and privacy assertions remain enforced.

`tmp/admin-pending-posts-working-tree.patch` contains the tracked working-tree diff, including earlier and concurrent edits. It is not an exclusive patch for this task and does not contain untracked file bodies. Git status also lists the untracked publication implementation, migrations, tests and documentation. No files were staged.

Final verification logs: `tmp/pending-posts-regression-complete.log` (998/998), `tmp/pending-posts-publication-complete.log` (47/47), `tmp/pending-posts-browser-complete.log` (10/10), `tmp/pending-posts-phase1b-complete.log` (20/20), `tmp/pending-posts-phase2.log` (26 passing, 16 failing) and `tmp/pending-posts-deferred-severity.log` (one known failure). Final Git status showed 55 modified tracked entries and 18 untracked entries, including aggregated directories. `git diff --check` exited 0. No staged changes were present.

## Remaining Limits

Phase 2 reviewer fixtures and the deferred severity failure prevent a claim that every regression suite is green. Distributed event delivery, a durable notification outbox, background media cleanup and high-volume allocation load testing are outside this workstream. Existing process-local throttling is not a guarantee against distributed denial of service. Dependency advisories previously deferred to infrastructure hardening remain separate release considerations.

The working tree remains dirty with earlier and concurrent changes, including additional theme edits. None were reverted. No commit, push, merge or deployment was performed. Stop here for review before another phase.
