# Community Publication Approval

The submission workflow has subsequently changed to automatic Admin review without a citizen checkbox. See [automatic-community-review.md](automatic-community-review.md) for the current behavior and verification. Optional-sharing descriptions below record the earlier implementation checkpoint.

## Review Status

Implemented and verified against isolated MySQL and local browser environments. After the initial report, the user explicitly approved a local backup and migration 011 for the configured database. That local migration is now applied; details and follow-up verification are in [community-publication-fix.md](community-publication-fix.md). Earlier rollout statements below describe the original implementation checkpoint. No remote deployment was performed. Full browser regression acceptance remains subject to the failures listed below.

Branch: `citizen/detection/report/13-10-2026`.

## Behavior

Report creation still creates a pending operational report. The optional sharing checkbox submits a separate publication request after the report has been saved. Publication failure does not roll back or recreate the report. The citizen can retry from the saved Report Details view.

`POST /api/community/posts` creates a pending request for citizens, not a post. Barangay official posts retain their existing direct publication path. Ordinary Community Feed routes remain restricted to Citizen and Barangay accounts.

Publication states are `unshared`, `pending_approval`, `approved`, and `rejected`. Report processing states remain separate. Approving or rejecting publication does not update report status, AI assessments, citizen category corrections, evidence proofs, severity, or history.

Only the assigned active Admin can decide a request. Assignment selects an active Admin with the lowest pending workload, breaking ties by account ID. Ordered Admin row locks serialize allocation; this is account availability, not a claim about reviewer presence. With no active Admin, the request remains private and unassigned. An active Admin may trigger allocation when no reviewer is assigned or the previous reviewer is inactive. Active assignments cannot be arbitrarily stolen.

Approval rechecks the report, owner, jurisdiction, citizen eligibility, processing status, assignment, and request version. Operationally rejected reports cannot be approved for publication. Decisions, posts, public media associations, decision history, audit entries, and citizen notifications commit together. Events are emitted after commit. Repeated or conflicting decisions return 409 rather than publishing twice.

Rejected requests may be resubmitted with the current version and a new request key. A report has at most three submission attempts. Prior decisions and rejection reasons remain in the review history table. Rejection reasons are required and limited to 500 characters. Public descriptions are limited to 2000 characters and can be reviewed or changed before requesting publication from Report Details.

Approved citizen post text cannot be edited without another review policy. Citizen deletion remains available; deletion does not delete the original report. A deleted approved publication retains its review record and is not automatically republished.

## Migration Policy

The user explicitly selected preservation of existing public legacy posts. Migration 011 records existing citizen post IDs in `community_publication_legacy`. These posts remain visible subject to existing deletion and barangay restrictions. No Admin approval, reviewer, or review date is fabricated for them. New citizen posts need a matching approved request; direct insertion without approval is not sufficient for feed or detail access.

The migration adds:

| Table | Purpose |
| --- | --- |
| `community_publication_requests` | One request per report, assignment, content snapshot, lifecycle, attempt count and version |
| `community_publication_media` | Private, sanitized public-preview derivatives while review is pending |
| `community_publication_reviews` | Retained decision history and rejection reasons across resubmissions |
| `community_publication_legacy` | Explicit allowlist for previously public citizen posts |

No columns are added to `reports`. No processing status is repeated in a publication table. Original report, post, comment, reaction, and evidence records are not rewritten during forward migration.

The MySQL runtime remains exclusive. The SQLite schema additions are for the existing explicit test adapter only, not a runtime fallback. Its test schema version was advanced to 6.

Forward migration, repeated migration-runner execution, rollback, reapplication, preservation of existing reports/posts, concurrency, and populated community rollback were tested on temporary MySQL 8.0.46 instances with verified private data directories and random loopback ports. Supabase was not contacted.

Before a shared rollout, take and verify a database backup, stop publication writes, review the legacy allowlist policy, and run the existing migration runner in the approved environment. Deploy the new application only with migration 011 present. MySQL DDL is not transactionally rolled back by the runner.

The rollback file drops publication tables and therefore discards moderation records, including assignments, pending requests, decisions and the legacy allowlist. It does not delete reports or posts. Use downtime and a verified backup for recovery. Do not run the new code against the rolled-back schema. Do not blindly reapply a fresh legacy backfill after losing moderation records; restore and reconcile the approved backup first. Reverting to the old application also restores its old direct-publication behavior and is not a secure steady state.

No shared migration, storage mutation, deployment, Git commit, push, or merge was performed.

## Endpoints

All responses are non-cacheable. Existing authentication resolves roles and membership from the current user record, not untrusted request fields.

| Method | Path | Authorization | Behavior |
| --- | --- | --- | --- |
| POST | `/api/community/posts` | Citizen owner in the report barangay | Creates or idempotently retrieves a publication request |
| GET | `/api/community/publication-requests` | Citizen | Returns only the caller's requests, public description, status and rejection reason; no reviewer identities |
| GET | `/api/community/eligible-reports` | Existing Citizen/Barangay route boundary | Citizens receive owned eligible unshared/rejected reports; Barangay receives no citizen selection list |
| GET | `/api/admin/community-publications` | Active Admin | Queue metadata and pending count |
| GET | `/api/admin/community-publications/:reportId` | Active Admin | Review metadata and public preview, with protected media URLs |
| GET | `/api/admin/community-publications/:reportId/media/:order` | Active Admin | Sanitized preview bytes; never a public storage reference |
| POST | `/api/admin/community-publications/:reportId/assign` | Active Admin | Allocates an unassigned request or replaces an inactive reviewer |
| POST | `/api/admin/community-publications/:reportId/decision` | Assigned active Admin | Validates version and approves or rejects atomically |

Citizen request example:

```json
{
  "reportId": 123,
  "requestKey": "a-unique-request-key-1234",
  "body": "Reviewed public description"
}
```

For rejected requests, include the current `version`. Do not send owner IDs, reviewer IDs, approval state, precise location, or AI data as publication authority. Uploaded photos remain subject to existing multipart limits, signature validation, private storage checks, sanitization, and capacity limits. When no photos are supplied, submitted report photos are copied into sanitized derivatives; original evidence is not made public.

Decision example:

```json
{
  "state": "rejected",
  "version": 1,
  "reason": "Remove personal information from the public description."
}
```

Approval uses `state: "approved"` with the current version. Rejection is 400 without a nonempty valid reason. Wrong role or assignment is 403. Conflicting versions and duplicate decisions are 409. No valid authenticated session is 401.

## Frontend Reuse

The Admin All Reports view contains a For Community Review filter, pending count and compact publication indicators. It opens the existing `ReportDialog.create()` modal and `ReportDetailsView.mount()` view. No separate report modal or moderation dashboard was added.

`CommunityPublication.mount()` owns the reusable publication section in the authorized report view. It safely displays description and reasons as text, renders protected preview photos, exposes decisions only to the assigned Admin, aborts stale loads, and removes listeners/media resources when destroyed. Operational review controls remain separate.

Citizen entry points are the optional submission checkbox, existing Share to Community picker, and saved Report Details. Pending feedback states that the report is not public. Failed acknowledgements retain the request key while the picker remains open. Saved report data survives failed publication requests. Changing photos during the new async publication step cannot trigger an old submission render/reset.

Automatic notification opening now chooses a rendered bell rather than a hidden desktop/mobile counterpart. This fixes notifications being attached to an invisible container. Actual approval notification rendering and navigation to the saved Report Details are covered by the private MySQL browser test.

Comment pages request five root comments initially. View more comments and View more replies remain text-only. The existing reaction picker, private shared-report viewer, delete controls, and feed pagination were reconnected where controls had become unreachable. Existing navigation, icons and theme tokens are reused. No new frontend framework or dependency was added.

## Verification

| Command | Actual result | Environment |
| --- | --- | --- |
| `npm test` | 996 passed, 0 failed, 0 skipped | Existing unit tests and isolated SQLite-adapter integration tests |
| `npm run test:publication` | 42 passed, 0 failed, 0 skipped | 19 service unit tests plus two isolated MySQL/API/browser suites, including their parent tests |
| `npm run test:e2e:publication` | 8 passed, 0 failed | Desktop/mobile submission, partial-failure recovery and photo-replacement race; isolated test adapter, fixture inference, mocked reverse-geocoding and deliberate publication delay/failure |
| `npx playwright test --config=playwright.community-regression.config.js` | 171 passed, 45 failed | Existing broader desktop/mobile fixture suite; not a live environment |
| Three opt-in live E2E files with all live opt-in flags disabled | 0 passed, 0 failed, 3 skipped | Shared MySQL and Supabase tests intentionally not enabled |
| `node --test tests/deferred/phase-4-severity-persistence.test.js` | 0 passed, 1 known failure | Existing deferred severity defect, unchanged |
| `git diff --check` | Passed | Whitespace verification; Git emits existing LF/CRLF notices |

Counts are per command, not independent totals; service unit tests are included in both `npm test` and `test:publication`.

The broader browser failures were not hidden or waived. Inspected failures include reviewer fixtures that sign an Admin/Barangay token for a Citizen database account, obsolete modal/navigation/login route selectors, references to intentionally removed categories, and registration rate-limit saturation. A full baseline-vs-working-tree browser comparison was not performed, so all 45 failures are not asserted to be pre-existing. Do not weaken runtime role checks or restore unsupported categories to satisfy those fixtures. Full browser signoff remains open.

The Phase 4 failure still exposes `highest_severity NOT NULL` and the repository conversion of missing severity to `low`. No schema, repository mapping, or test change was made to conceal it.

Real MySQL verification used actual local authenticated HTTP responses and actual Chromium UI navigation, not mocked registration or publication success. It covered approval/rejection, duplicates, concurrent decisions, current-role enforcement, owner/jurisdiction isolation, inactive/unavailable reviewers, reassignment, retained rejection history, notification rollback, post-commit recipient events, private photo access, stable pseudonyms, nested comments, desired-state reactions, refresh, and 375/768/1440 layouts. Fictional fixtures were used. Leaflet initialization and controls were checked; external tile availability is not certified. Production Supabase access and shared-data migration are not verified by these local runs.

Screenshots are under `.data/publication-screenshots/` and `.data/community-screenshots/`. Execution logs are under `tmp/`.

## Manual Review

1. In an approved isolated environment, apply migration 011 using the existing MySQL runner and start the normal application. Do not point validation at shared production resources.
2. Sign in as a Citizen. Submit exactly two photos with sharing disabled; verify the report exists and no publication request/post is created.
3. Request publication from the saved Report Details or the Community picker. Confirm Pending Community Review and absence from a same-barangay neighbor's feed.
4. Sign in as the assigned Admin. Use For Community Review in All Reports, open the existing report dialog, and inspect evidence, public preview, assignment, and independent operational status.
5. Reject without a reason and verify validation. Reject with a reason, then verify the Citizen sees that reason and receives the correct notification without reviewer identity.
6. Resubmit with a reviewed public description. Approve through the assigned Admin and verify one public post, private-detail exclusion, one outcome notification and unchanged operational status.
7. Repeat a decision using its old version. Verify 409 and no duplicate post or notification. Verify Citizen and Barangay credentials cannot call moderation routes.
8. Suspend the assigned reviewer and allocate another active reviewer. Confirm the old session cannot decide and the assignment is audited.
9. Add at least seven root comments and nested replies. Check initial five, text-only View more controls, exact parent relationships and stable pseudonyms. Like, retry Like, switch reaction and remove it; verify counts do not duplicate.
10. Refresh desktop/mobile Citizen and Admin views in both themes. Verify uploaded previews, report links, keyboard controls and separate processing/publication statuses.

## Files

Application and migration changes:

```text
frontend/admin.html
frontend/citizen.html
frontend/report-details.html
frontend/js/admin/admin_logic.js
frontend/js/citizen/citizen.js
frontend/js/citizen/notificationCenter.js
frontend/js/community/communityApi.js
frontend/js/community/communityCards.js
frontend/js/community/communityComments.js
frontend/js/community/communityFeed.js
frontend/js/community/communityView.js
frontend/js/reports/reportDetailsView.js
frontend/js/shared/communityPublication.js
frontend/js/shared/reportEvidence.js
frontend/styles/community.css
frontend/styles/report-details.css
server/application/use-cases/community.service.js
server/application/use-cases/communityPublication.service.js
server/application/use-cases/notification.service.js
server/composition.js
server/domain/community/community.rules.js
server/infrastructure/database/mysql/migrations/011_community_publication.sql
server/infrastructure/database/mysql/migrations/rollback/011_community_publication.sql
server/infrastructure/database/sqlite/publication.sql
server/infrastructure/database/sqlite/sqliteAdapter.js
server/infrastructure/repositories/community.repository.js
server/infrastructure/repositories/communityPublication.repository.js
server/presentation/http/controllers/communityPublication.controller.js
server/presentation/http/routes/admin.routes.js
server/presentation/http/routes/community.routes.js
```

Tests, commands and documentation:

```text
package.json
playwright.publication.config.js
server/tests/community-publication.test.js
server/tests/community-state.test.js
tests/browser/community-publication.spec.js
tests/integration/community-enhancements.test.js
tests/integration/community.test.js
tests/integration/phase0-security-corrections.test.js
tests/migrations/community-mysql.test.js
tests/migrations/community-publication-mysql.test.js
tests/support/publication.js
.docs/community-publication-implementation.md
```

The existing staged changes in `frontend/js/community/communityComments.js` and `frontend/styles/community.css` were preserved. Only the reply page-size calculation and feed pagination styles were added on top of them. No unrelated staged changes were reverted.

Task diff relative to the existing index, excluding temporary logs: 29 modified files and 13 added files. Application files, tests and this report account for the 42 paths listed above. No dependency version or lockfile changes were made.

## Remaining Limits

Shared rollout requires an approved backup and migration window. It has not been applied automatically. Broad browser fixture acceptance and the separately deferred severity failure remain open. Request throttling and realtime delivery use existing process-local infrastructure; multi-instance event delivery, distributed edge protection, and durable outbox delivery are not implemented here. A committed notification remains retrievable if realtime delivery fails. Media cleanup uses bounded retries and logs cleanup failures; there is no new background cleanup worker. Rejected previews remain private until resubmitted; retention policy and archival need separate operational review. Reviewer allocation serializes Admin rows and should be load-tested before high-volume rollout.
