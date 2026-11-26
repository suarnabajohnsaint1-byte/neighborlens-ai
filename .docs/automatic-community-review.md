# Automatic Community Review

## Workflow

The citizen submission form no longer has a publication checkbox or a separate publication request. For each new citizen report with a recognized report barangay, the backend creates a pending publication request automatically. A request cannot opt out through a forged checkbox value or assert an approved state or reviewer.

The report, its original evidence associations, pending publication, private sanitized previews, audit entries and assigned Admin notification are saved through the report transaction. Storage work happens before that transaction; failed transactions remove the prepared previews and original uploads using the existing cleanup mechanisms. A notification failure rolls back the report and publication together. Realtime events are emitted after commit.

Report processing remains `pending` at creation. Publication starts as `pending_approval`. These statuses remain independent; approving publication does not resolve the report. No public post is created until the assigned active Admin approves it.

The assigned Admin receives a persisted notification titled `Community publication review`. The existing bell links to the reusable Report Details dialog, where the Admin can approve or reject with a reason. Notification reads use the existing authenticated notification endpoints. Historical review notifications are deduplicated per report in the bell, and duplicate generic report activity is omitted while a review entry is present. Citizen outcome notifications are retained. Resubmission and reassignment also notify the assigned reviewer.

## Compatibility and Security

Existing public legacy posts remain unchanged. Previously unshared private reports are not automatically backfilled or published. Their existing legacy sharing path remains available; new normal submissions do not require it.

Existing report submission permits unresolved barangays in some legacy/API workflows. The conservative compatibility behavior preserves these reports privately and exposes `blocked_jurisdiction`, rather than fabricating a barangay or approving publication. No publication request is inserted without a recognized jurisdiction. This is a derived state, not a schema change. A policy clarification was requested for this edge case; stricter registration/report-location requirements were not silently introduced.

No active Admin leaves a recognized-jurisdiction publication pending and unassigned. Once an active Admin is available, the existing assignment action can allocate it and generate the review notification. Existing ownership, role, jurisdiction, immutable assessment, evidence-proof and assigned-reviewer checks remain enforced. Existing owner-membership checks can still prevent approval if ownership or membership changes after submission.

Automatic evidence preparation uses the existing media pipeline, retaining the report upload limit of 10 MB per photo. It strips metadata and creates private WebP previews capped at 1600 pixels and 5 MB. The separate manual community-upload limits remain unchanged. Original submitted photos are not substituted with public storage URLs.

The existing report-sync client now reads the backend `error` field as well as `message`, so transaction failures produce useful feedback instead of only an HTTP status label.

## Verification

| Command | Result | Scope |
| --- | --- | --- |
| `npm test` | 998 passed, 0 failed, 0 skipped | Isolated unit and test-adapter integrations |
| `npm run test:publication` | 45 passed, 0 failed, 0 skipped | Service tests and private MySQL with real HTTP APIs and Chromium |
| `node --test tests/migrations/community-publication-mysql.test.js` | 16 passed, 0 failed, 0 skipped on final focused rerun | Private MySQL; automatic submission, forged opt-out, transaction rollback, jurisdiction-blocked compatibility, assigned Admin notification, persisted read state, approval and feed visibility |
| `npm run test:e2e:publication` | 8 passed, 0 failed, 0 skipped | Desktop/mobile browser; isolated test adapter, fixture inference, controlled reverse geocoding and injected failure responses |
| `node --test --test-concurrency=1 tests/integration/report-details.test.js tests/integration/phase-2-correction.test.js` | 50 passed, 0 failed, 0 skipped | Isolated ownership, details and evidence-proof regressions |
| `npm run test:e2e:phase2` | 26 passed, 16 failed | Existing browser suite; reviewer fixtures forge roles for citizen database accounts and use obsolete selectors. These failures were retained, not bypassed. No baseline comparison was performed in this task. |
| `npm run test:e2e:details` | 128 passed, 26 failed | Broader details, theme, authentication and Admin suite; failures remain open and are not all classified as fixture issues |
| `node --test tests/deferred/phase-4-severity-persistence.test.js` | 0 passed, 1 known failure, 0 skipped | Unchanged deferred severity fallback |

No state-changing tests targeted configured MySQL or Supabase. The existing local API health endpoint returned 200 and the frontend on port 5500 served the updated form without `requestCommunityPublication`. No signed-in browser workflow against configured MySQL was performed. `git diff --check` passed, with only existing LF/CRLF notices.

The broader details run exposed a mobile pagination button intercepted by the fixed bottom navigation, muted-text contrast around 4.01 in Light and 4.05 in Dark against a required 4.5, authentication/design failures, an inaccessible account modal in one test, and Admin overview expectations of 12 items where the current UI renders 5. Reviewer-role fixtures also remain incompatible with persisted-role enforcement. No baseline comparison was performed, so these are not asserted to be pre-existing or caused by this change. The underlying broad layout/theme/authentication issues were not changed in this focused business-flow task. Full portal acceptance is not claimed.

Screenshots are in `.data/publication-screenshots/`: `automatic-submit-desktop.png`, `automatic-submit-mobile.png`, `automatic-admin-notification-375.png`, `automatic-admin-notification-768.png`, `automatic-admin-notification-1440.png` and `automatic-admin-approved.png`. Their report content and gray evidence are isolated fictional fixtures, not live citizen data. The Admin notification popover remained within the viewport at 375, 768 and 1440 pixels.

Storage tests were adapted to isolate the publication service where they test only storage behavior. Integration cleanup assertions now include the two private previews, and preserve exact cleanup membership without depending on deletion order. The deleted-report fixture explicitly removes its pending publication dependencies before deleting the test report. Authorization and proof assertions were not weakened.

## Changed Files

```text
frontend/citizen.html
frontend/js/citizen/citizen.js
frontend/js/admin/admin_logic.js
frontend/js/shared/reports.js
frontend/js/shared/communityPublication.js
server/application/use-cases/report.service.js
server/application/use-cases/communityPublication.service.js
server/application/use-cases/notification.service.js
server/composition.js
server/infrastructure/repositories/communityPublication.repository.js
server/infrastructure/storage/communityMedia.adapter.js
server/tests/report.service.storage.test.js
tests/browser/community-publication.spec.js
tests/migrations/community-publication-mysql.test.js
tests/integration/ai-upload-memory.test.js
tests/integration/phase-2-correction.test.js
tests/integration/report-details.test.js
.docs/automatic-community-review.md
.docs/community-publication-implementation.md
```

Branch: `citizen/detection/report/13-10-2026`. Existing working-tree and concurrent edits were preserved, including the separate report-card stylesheet changes. No dependencies, schema migrations, model classes, inference thresholds or severity rules were changed. No commit, push, deployment or configured database mutation was performed in this follow-up. The approved local migration 011 from the preceding task remains separate from these changes.

Remaining limits include the unresolved jurisdiction policy, broader browser failures described above, the deferred severity failure, process-local realtime delivery and bounded storage cleanup without a durable cleanup worker. Supabase and physical-camera integration were not exercised here.
