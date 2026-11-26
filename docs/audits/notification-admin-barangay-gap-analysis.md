# Admin and Barangay notification integration audit

Baseline: `d22f4b29da003f5312b2f03e803afa65b2e4f62e`, clean working tree at start. The earlier [Auth and RBAC audit](NEIGHBORLENS_AUTH_RBAC_FULLSTACK_AUDIT.md) identified recipient-scoped notifications, and [incident routing remediation](../qa/incident-routing-remediation.md) described jurisdiction checks and transactional coordination. The relevant implementation continued through `84d99b8` (Admin notifications) and `d2494d3` (staff messaging and report workflows), before the baseline merge. The findings below come from inspecting the baseline and testing this working tree. Prior results were used to locate evidence.

| Feature | Existing | Verified | Gap | Action |
|---|---|---|---|---|
| Admin notification center | Admin-only rendering and ticket client | VERIFIED_WORKING | Notification loading was coupled to publication queue refresh | Moved the staff bell and stream to a shared component. Preserved the publication-review entry point |
| Barangay notification center | Notification APIs available to the role | MISSING | Dashboard had no bell, badge, list or notification stream | Mounted the shared staff component in the Barangay header |
| Admin → Barangay alerts | Transactional notice for assigned Barangay staff plus unrelated Admins | PARTIALLY_IMPLEMENTED | Extra recipients | Kept active staff in the report's current Barangay as the recipients |
| Barangay → Admin alerts | Transactional, recipient-specific notices | VERIFIED_WORKING | Prior implementation omitted first contact | Retained active Admin participants for replies. On threads without an Admin author, checked active Admin candidates against report access |
| Real-time SSE delivery | Single-use tickets, per-user channels, limits and cleanup | PARTIALLY_IMPLEMENTED | Barangay had no client. An open connection could outlive its JWT | Shared the staff client and carried authenticated session expiry into stream authorization |
| Unread count synchronization | Recipient-scoped API count and read events | PARTIALLY_IMPLEMENTED | Barangay had no badge or read controls | Used the existing count and read routes. Reloaded the authoritative list on read events and reconnect |
| Database persistence | Notifications migration 003 and coordination migration 016 | VERIFIED_WORKING | Message and notification inserts already shared a transaction | Kept the tables and transaction. Isolated post-commit delivery failures from the successful write |
| Authorization isolation | Notification ownership and report jurisdiction enforced server-side | PARTIALLY_IMPLEMENTED | Recipient selection was broader than conversation participation, and open streams lacked session expiry | Tightened recipient resolution and verified direct access denials, stream expiry and logout |

## Recipient and delivery rules

The coordination conversation belongs to a report. Inspection of the coordination schema, report ownership, and staff access policy found no explicit conversation assignee or responsible Admin group. Both routing priorities are NOT_APPLICABLE in the current model. Community publication has its own reviewer assignment for publication decisions. The Admin report access policy grants active Admins access to report conversations across jurisdictions.

An Admin message alerts active officials in the report's current jurisdiction. For Barangay messages, threads with a prior Admin author retain the existing active-participant routing. Threads without a prior Admin author alert active Admins who pass the same report authorization check used by the conversation endpoint. The authenticated sender is excluded in the repository. When no candidate is eligible, the message commits and its existing coordination audit entry records a zero notification recipient count. The transaction, idempotency key, and per-user post-commit SSE path are shared with existing messages.

The report ID is the conversation reference. Existing rows retain their contents, and legacy coordination notifications still deep-link using their existing title. New rows use `coordination_message` in the existing type column. The description contains a report reference without the private message body. The report details endpoint rechecks current access when the link is opened, including after reassignment.

Message, audit and notification writes share a transaction. The report row lock serializes message submission, and the existing request-key constraint prevents repeated or concurrent retries from producing extra rows. The publisher runs after commit. If it throws, the response still acknowledges the committed message and the next recipient is attempted. The next list fetch can recover a missed event. The emitter is in-process, and the one-use tickets are stored in memory. The tested SSE guarantees apply to a single process. Cross-replica delivery and recovery of an isolated missed event while the connection remains open depend on a subsequent refresh trigger.

Notification listing uses recipient and creation indexes, and unread counting uses the recipient and read-state index. The staff list retains the existing 100-row Admin limit. A page owns at most one staff stream, coalesces overlapping list reloads, closes its connection on page exit or session change, and reconnects after five seconds. Reconnection and focus fetch the persisted list and count. There is no notification polling loop or client-side authoritative storage.

## Implementation

| Files | Purpose and reused abstraction |
|---|---|
| `frontend/js/shared/staffNotifications.js`, `frontend/admin.html`, `frontend/barangay.html`, `frontend/styles/barangay.css` | Shared staff bell, unread count, read controls, states and ticket stream using the existing notification styles and APIs. Replaces the Admin-only stream module |
| `frontend/js/admin/admin_logic.js` | Retains Admin publication labels and review dialog behavior while delegating the notification list to the shared component |
| `frontend/js/reports/reportDetails.js`, `frontend/js/shared/api.js` | Focuses the existing report conversation from notification links. Allows the read request to finish during navigation and guards expired-response handling against session changes |
| `server/infrastructure/repositories/reportReview.repository.js`, `server/application/use-cases/reportReview.service.js` | Resolves recipients using current jurisdiction and coordination authors. For a thread without an Admin author, validates active Admin candidates against report access. Records the recipient count and reuses the existing notification repository and post-commit per-user emitter |
| `server/application/use-cases/auth.service.js`, `server/presentation/http/middleware/auth.middleware.js`, `server/presentation/http/controllers/notification.controller.js` | Bounds ticket use and active streams by the bearer session expiry using existing authentication and cleanup |
| `tests/support/report-review-scenarios.js`, `tests/integration/notification-security.test.js`, `tests/browser/report-review.spec.js` | Covers transactional failures, retry and recipient scoping on SQLite and isolated MySQL, ticket expiry and revocation, and real browser delivery and navigation in both directions |

## Verification on the working tree

| ID | Acceptance criteria | Status | Evidence |
|---|---|---|---|
| NTF-BRG-001 | Barangay notification center | PASS | Authenticated desktop and mobile tests observed the badge and list after a live message, opened the correct thread, and verified persisted read state after reload. Read-all uses the same staff action and recipient-scoped API tested by the Admin and MySQL checks |
| NTF-MSG-001 | Two-way notifications with a resolved recipient | PASS | Both browser directions produced live events. The SQLite and private MySQL suites verified recipient sets, ownership, distinct messages, concurrent retry, failed insert, transaction rollback and recovery after a post-commit publisher exception |
| NTF-MSG-001 | Barangay first contact without an Admin participant | PASS | Multi-Admin API and database checks cover authorization, suspension, atomic rollback, retries and zero recipients. The browser opens a first-contact alert received over SSE and reads the correct conversation |
| NTF-RT-001 | Live delivery, reconnect and read synchronization | PASS | Closed the browser's live stream, sent a reply during the gap, and recovered the count and one row for the missed event after reconnect. A second Admin tab reflected mark-all-read. Security tests covered ticket binding, expiry, logout and the five-stream limit |
| NTF-UI-001 | Shared staff UI and authorized navigation | PASS | Both portals use the same component and conversation target. Admin notification, theme and publication-review regressions passed, including real Chromium against private MySQL |
| NTF-SEC-001 | Recipient isolation and authorization | PASS | A foreign Barangay session received no private event, could not mark the notice read, and received 403 on direct thread access. SQLite and MySQL also verified that a nonparticipating Admin got no alert, a citizen could not access staff routes, and spoofed recipient fields had no effect |

Executed commands and results:

```powershell
node --test --test-concurrency=1 server/tests/notification.service.test.js tests/integration/notification-security.test.js tests/integration/notifications.test.js tests/integration/report-review-workflow.test.js tests/integration/auth-routing.test.js tests/migrations/report-review-mysql.test.js tests/migrations/community-publication-mysql.test.js
node --test --test-concurrency=1 tests/integration/notification-security.test.js tests/integration/report-review-workflow.test.js tests/migrations/report-review-mysql.test.js
npx playwright test --config=playwright.report-review.config.js --output=.data/staff-notification-review-regression
npx playwright test --config=playwright.report-details.config.js --grep 'admin report notifications track|admin shared components stay responsive|Admin monitors assigned' --output=.data/staff-notification-admin-regression
npx playwright test --config=playwright.report-review.config.js --grep 'staff dashboards deliver' --output=.data/staff-notification-tabs
```

| Execution | Passed | Failed | Skipped | Local log |
|---|---:|---:|---:|---|
| Node, MySQL and MySQL-backed publication browser regression | 107 | 0 | 0 | `.data/staff-notifications-regression.log` |
| Final isolation, rollback and delivery-failure checks | 54 | 0 | 0 | `.data/staff-notifications-resilience-final.log` |
| Report Review browser regression | 32 | 0 | 0 | `.data/staff-notification-review-regression.log` |
| Admin notification and responsive browser regression | 6 | 0 | 0 | `.data/staff-notification-admin-regression.log` |
| Final two-way browser check with cross-tab read sync | 2 | 0 | 0 | `.data/staff-notification-tabs.log` |

The counts overlap. The new two-way browser scenario used real HTTP and SSE with the isolated SQLite application. Private MySQL 8.0.46 verified the same server-side messaging and notification paths, including migration application and repeat-run idempotency. The separate publication regression exercised the shared Admin bell against that database engine in Chromium. Fault-injection cases intentionally logged persistence and publisher errors and verified their actual responses. No new schema migration was required. `git diff --check` passed.

## First-contact routing verification

The follow-up changed `server/infrastructure/repositories/reportReview.repository.js` and `server/application/use-cases/reportReview.service.js`. It extended `tests/support/report-review-scenarios.js` and `tests/browser/report-review.spec.js`. The two suites reuse the existing isolated database and browser harnesses.

```powershell
node --test --test-concurrency=1 server/tests/notification.service.test.js tests/integration/notification-security.test.js tests/integration/notifications.test.js tests/integration/report-review-workflow.test.js tests/migrations/report-review-mysql.test.js
npx playwright test --config=playwright.report-review.config.js --grep 'staff dashboards deliver|lost message acknowledgement|exchange escaped' --output=.data/first-contact-browser
```

- Node, SQLite and private MySQL 8.0.46 recorded 73 passed, 0 failed and 0 skipped in `.data/first-contact-api.log`. Exact recipient sets excluded the sender, non-Admin users and a suspended Admin. Both eligible Admin fixtures could open the conversation. A failure on the second recipient insert rolled back the message and both alerts. Concurrent retry produced one message and one alert per recipient. With no active Admin, the message persisted and its audit recorded zero recipients. The existing participant-only reply test still passed.
- Desktop and mobile Playwright recorded 6 passed, 0 failed and 0 skipped in `.data/first-contact-browser.log`. The first-contact case received one actual SSE event, showed the unread badge, and opened the correct private conversation from the notification. The existing participant reply, reconnect, cross-tab read, lost-acknowledgement and escaped-message checks also passed.

**Final status: COMPLETE_AND_VERIFIED.** First-contact routing uses the current report authorization policy. If a report has no eligible Admin, the sender can still save a message and the zero-recipient outcome is auditable. Live delivery was verified on the existing single-process SSE transport.
## Staff UI regression follow-up

- UI-001. Normal link activation started the read request and navigated immediately. The handler ignored the mutation's unread count and depended on a later GET, which could still be in flight when the page unloaded. The shared staff component now waits for a successful read, applies the returned count and read state, and opens the existing destination. It serializes read actions and invalidates GET responses started before a read. A fresh list reconciles concurrent SSE events. Failed reads retain the unread item and leave the notification center open for retry. Admin publication alerts continue to open the review dialog. Mark-all now queries the resulting unread count so new notices can be reconciled. The shared Citizen SSE consumer also handles a nonzero count after mark-all by reloading the list.
- UI-002. The wheel handler only changed scale with a center-origin transform. The viewer now projects the cursor through the current transform, adjusts translation at the new scale, and clamps using the rendered image size inside the letterbox. Pinch uses the same calculation with the two-finger focal point. Existing pan, keyboard shortcuts, reset and scale limits remain in the viewer.

Changed UI paths include `frontend/js/shared/staffNotifications.js`, `frontend/js/admin/admin_logic.js`, `frontend/js/shared/evidenceZoom.js`, and the shared mark-all contract in `server/application/use-cases/notification.service.js`. The reproduction run in `.data/ui-remediation-before.log` captured the Barangay click navigating away after a failed read and an 87.5px wheel-anchor error. Its initial Admin fixture received three additional publication alerts, which were cleared before seeding unread messages in the corrected test. A later combined browser run exhausted the real per-IP notification quota when moving from desktop to mobile. The mobile traces show HTTP 429 during fixture setup. The projects are verified using fresh isolated servers.

| Follow-up check | Status | Evidence |
|---|---|---|
| UI-001 staff badge, 3 → 2 → 1 → hidden | PASS | Both portals on desktop and mobile. Failed PATCH kept the old count and item unread. Actual clicks persisted the read, opened the conversation, and kept counts correct on return. Already-read links left the count unchanged |
| UI-001 mark-all, cross-tab reads, reconnect and existing Admin publication dialog | PASS | Shared desktop/mobile messaging scenarios and private MySQL publication/browser suite. The mark-all unit test returns the measured count when a concurrent notice remains unread |
| UI-002 wheel and touch anchor | PASS | Wheel tested at three painted-image positions with two zoom-in/out cycles on desktop and mobile. Actual Barangay touch pinch verified image coordinates and reset. Existing wheel, pan, keyboard and focus tests passed |
| UI-002 desktop pinch case | NOT_RUN | Touch case runs on the mobile project. Desktop records one intentional skip |

```powershell
npx playwright test --config=playwright.report-review.config.js --project=desktop --grep 'notification click commits|staff wheel zoom' --output=.data/ui-remediation-before
npx playwright test --config=playwright.report-review.config.js --grep 'notification click commits|staff wheel zoom|Barangay touch pinch|staff dashboards deliver' --output=.data/ui-remediation-final
npx playwright test --config=playwright.report-review.config.js --project=mobile --grep 'notification click commits|staff wheel zoom|Barangay touch pinch|staff dashboards deliver' --output=.data/ui-remediation-mobile
npx playwright test --config=playwright.report-details.config.js --grep 'evidence photo zoom controls|admin report notifications track' --output=.data/ui-remediation-controls
node --test --test-concurrency=1 tests/unit/evidence-zoom.test.js server/tests/notification.service.test.js tests/integration/notifications.test.js tests/integration/notification-security.test.js tests/migrations/community-publication-mysql.test.js
node --test tests/unit/evidence-zoom.test.js
```

The combined run passed all four applicable desktop tests, skipped desktop pinch, and recorded two mobile setup failures from the shared IP quota. All five mobile tests passed with a fresh server. Existing Report Details browser checks passed 4/4, the notification/unit/MySQL regression passed 74/74, and the zoom unit rerun after pinch passed 24/24. Counts overlap. Logs are in `.data/ui-remediation-*.log`.
