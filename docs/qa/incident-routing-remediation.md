# Report monitoring, incident linking and jurisdiction correction

Review date: 27 October 2026. This change uses the current branch and preserves the existing working tree. No commit, push, deployment, model replacement, or application of migration 017 to the configured database is included.

## Previous behavior verified in source

- Report submission already had HTTP request idempotency. It did not have a physical-incident membership model. A publication approval created a separate post for each report.
- Publication reviewers could change jurisdiction through `PATCH /api/admin/community-publications/:id`. That operation checked assignment and publication version, but lacked a separate routing permission, mandatory correction reason, supporting evidence, and authoritative boundary verification.
- The shared details implementation included staff operational controls. Admin status and severity writes now return 403; the assigned Barangay retains those operations.
- Staff comment lookup used the individual report's post. There was no canonical incident discussion or way to select preserved earlier discussions.
- The process on local port 3000 returned 404 for the new review and Citizen Comments endpoints. Those responses were missing routes in the old process, not evidence that a conversation or publication was empty.

## Implemented behavior

### Shared report details

The same `ReportDetailsView` serves the roles. Its photos, description, recorded location, Leaflet map, activity, evidence viewer, and messaging components remain shared.

Admin sees activity, read-only Citizen Comments, proof attached to activity, Message Barangay, and the private conversation. Operational status controls, proof upload, and severity confirmation are absent. The corresponding backend writes reject Admin credentials.

Barangay sees activity, an expanded Manage Report section, proof selection, permitted status transitions, severity confirmation, Citizen Comments, and the Admin conversation. Resolve still requires an action description and evidence. Rejection needs a meaningful reason and an eligible current state. Existing terminal-state rules remain enforced.

Citizen sees their own report and original evidence. A linked incident shows the canonical incident's progress separately from the original report status. Internal messages, routing history, candidate reports, and staff controls are omitted from the citizen response.

### Duplicate review and public discussions

Each report keeps its ID, owner, description, photos, timestamps, and independent publication decision. HTTP retries continue to use the existing submission idempotency mechanism.

The suggestion policy compares recorded coordinates and accuracy, damage category, report time, available server-recorded evidence hashes, and unresolved or closed status. It does not use YOLO confidence. The current suggestion window is 75 metres and 30 days; at most 50 suggestions are returned from a bounded candidate query. These are review aids, not proof of a duplicate. Different known damage classes are excluded. Closed nearby incidents are marked as possible recurring damage and cannot receive new unresolved duplicate links.

Only an active Barangay official assigned to both reports can confirm a link. A meaningful inspection reason and current incident versions are required. Admins, citizens, and officials in another Barangay receive 403. Dismissal records a decision while preserving independent reports and publications.

Confirmation creates incident membership; it does not merge report rows or change their operational statuses. Existing approval requirements remain in place for every member. The first approved member supplies the canonical public post. Later independent Admin approvals reference that discussion without creating another public post. Concurrent approvals are serialized and use current locked MySQL reads rather than an earlier repeatable-read snapshot.

When already-public reports are linked, their posts and comments stay stored under their original IDs. Additional posts become discussion aliases and are excluded from the main feed. Earlier comments are not moved, rewritten, or deleted. Earlier threads remain readable through their original post API and the staff Citizen Comments discussion selector. Owners retain their existing comment edit/delete rights. New comments and replies on an aliased thread receive 409 and identify the canonical discussion. Existing identical comment retries remain idempotent.

### Controlled jurisdiction correction

The permission is `report:assign-jurisdiction`. It is separate from `admin:create`, a username such as `superadmin`, and publication-review assignment. Migration 017 does not grant it to anyone automatically. Account self-service cannot grant permissions.

The designated administrator must provide a correction reason, expected routing version, target Barangay, and supporting image IDs belonging to the report. The server checks the original recorded GPS, acceptable accuracy, city service area, a unique matching boundary, and recorded boundary source/version. It saves the boundary hash with the review. A selected option or an arbitrary image URL is not sufficient authorization. Missing boundaries, invalid coordinates, excessive accuracy radius, overlapping boundaries, stale versions, and invalid evidence are rejected.

Original coordinates and the initial jurisdiction remain in the correction history. The same report row is reassigned. History records the actor, timestamp, reason, previous/new jurisdiction, previous routing source, and verified location evidence. Report lists and analytics use the updated jurisdiction. Notifications go to active previous/new Barangay officials and the reporting citizen. Private messages stay stored, but former Barangay officials lose report, message, history, evidence, and comment access through the current authorization checks.

An incident transfer must explicitly include all members, their current versions, and supporting photos for each report. Every member must verify against the same new boundary. Partial or conflicting transfers roll back. Publication scope and canonical/earlier discussions move with the reports; comment rows remain attached to their original posts.

Barangay officials can flag incorrect routing with a reason and supporting report photos. A flag notifies designated routing administrators and does not transfer the report. The old publication assignment endpoint delegates to the same controlled service, so it cannot bypass these rules.

Automatic geofence routing remains preferred. Legacy citizen-declared routing remains labelled `citizen_declared` when authoritative polygons are unavailable; it is not represented as a verified polygon assignment. A loaded boundary conflict or no-match no longer falls back to a declared Barangay. No nearest or random Barangay is selected.

## Files and architecture

- Domain: `server/domain/reports/incident.rules.js` contains suggestion and input rules.
- Application: `incident.service.js` coordinates authorization, review decisions, publication relationships, and routing transactions through injected ports. `reportReview.service.js`, `communityPublication.service.js`, `community.service.js`, and `report.service.js` integrate the existing workflows.
- Infrastructure: `incident.repository.js` holds new SQL. Existing Barangay and permission repositories support transactional current reads. Composition wires the services without application-to-infrastructure imports.
- HTTP: `reports.routes.js` exposes incident review, duplicate decisions, routing flags, and jurisdiction correction using existing authentication, rate limiting, and error handling.
- Frontend: `incidentReviewPanel.js`, `reportReviewPanel.js`, and `reportDetailsView.js` reuse the shared full-page details layout. The new panel uses the existing refresh event after jurisdiction changes. HTML entry points load the shared component; styling stays in `report-details.css`.
- Database: migration 017 adds incidents, membership, routing versions, append-only coordination events, post aliases, a non-unique publication discussion reference, and the separate permission. Existing unique report/post constraints remain. The test-only SQLite schema mirrors these additions.
- Tests: shared incident scenarios execute against isolated SQLite and private MySQL. Browser checks cover the actual shared components and real HTTP endpoints. Existing role fixtures now perform operational writes as assigned Barangay staff. Integration databases are isolated per test process to prevent synthetic boundaries leaking between suites.

## Migration and operator setup

Migration 017 has been tested only on disposable databases. It has not been applied to local `neighborlens_ai`, Aiven, or production. Existing approved local application of migrations 015–016 predates the current no-live-database-change instruction.

An authorized installation operator must back up and verify the target before applying any pending migration. Use the existing migration command only after reviewing the target and migration ledger. MySQL DDL is not transactionally reversible; investigate any partial application before retrying. The readiness table is created last so an incomplete installation does not advertise the feature as ready.

The configured local database has historical checksum differences for migrations 001 and 009. This change does not rewrite that ledger or weaken checksum validation. Resolve those differences through an operator-reviewed history reconciliation before using the general migration runner there.

After an approved migration, designate a routing administrator explicitly through an operator-controlled database maintenance session. Verify the active Admin account first. For example, with an intentionally chosen account name:

```sql
START TRANSACTION;
SELECT id, username, role, status
FROM users
WHERE username = 'CHOSEN_ROUTING_ADMIN'
FOR UPDATE;

INSERT INTO user_permissions (user_id, permission, granted_by)
SELECT id, 'report:assign-jurisdiction', NULL
FROM users
WHERE username = 'CHOSEN_ROUTING_ADMIN'
  AND role = 'admin' AND status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM user_permissions p
    WHERE p.user_id = users.id
      AND p.permission = 'report:assign-jurisdiction'
  );

SELECT ROW_COUNT() AS permission_rows_created;
```

Before committing, confirm the selected account and expected row count. Record the maintenance ticket, responsible operator, and chosen account in the installation's audit record. Roll back if the account is missing, inactive, or unexpected. Do not put database credentials or bootstrap tokens into browser code. Revocation is an explicit audited operator action against that permission row.

Without migration 017, the new review endpoint returns `503 INCIDENT_REVIEW_NOT_READY` with an installation message. Existing report monitoring, messages, and comments continue using their existing tables; the application does not migrate databases during startup or requests.

## Verification

Final verification completed on 27 October 2026. Test logs and screenshots are under the ignored `.data/remediation-2026-10-26` directory. Browser traces contain disposable fixture sessions and should not be published. Counts below describe separate runs; overlapping scenarios are not a count of unique tests.

| Verified command or suite | Passed | Skipped | Failed | Final log |
| --- | ---: | ---: | ---: | --- |
| `npm test` | 1,133 | 0 | 0 | `incident-node-release.log` |
| `node --test --test-concurrency=1 tests/migrations/*.test.js` | 136 | 1 | 0 | `incident-migrations-verified.log` |
| `node tests/support/run-isolated-mysql.js` | 43 | 0 | 0 | `incident-runtime-mysql.log` |
| `npx playwright test --config=playwright.report-details.config.js` | 156 | 0 | 0 | `incident-details-verified.log` |
| `npx playwright test --config=playwright.report-review.config.js` | 16 | 0 | 0 | `incident-review-browser-release.log` |
| Phase 2 browser suite, isolated port 4351 | 44 | 0 | 0 | `incident-phase2-verified.log` |
| Barangay browser suite, isolated port 4352 | 32 | 0 | 0 | `incident-barangay-browser.log` |
| `npx playwright test --config=playwright.shared-reports.config.js` | 16 | 0 | 0 | `incident-shared-release.log` |
| `.venv/Scripts/python.exe -m pytest ai/tests -q` | 170 | 1 | 0 | `incident-python-verified.log` |
| Real FastAPI through Node to private MySQL | 4 | 0 | 0 | `incident-real-ai-mysql.log` |

The new incident/routing MySQL suite contributes 19 passing tests to the migration run, including the real browser correction, unused-schema rollback/reapplication, and refusal to roll back used history.

The migration run's optional live-inference case was skipped in that general run. It was then enabled and passed in the separate four-test run. That run used a loopback FastAPI service on port 8016, the unchanged production checkpoint, and a held-out fixture image. Its private MySQL instance had a verified temporary data directory and random loopback port. The temporary AI process was stopped afterward.

The Python skip is the existing immutable-data check for the unavailable historical `neighborlens_v2` dataset. There were 14 dependency deprecation warnings. The first Python attempt used `.venv-yolo`, which lacks the preprocessing dependency `imagehash`; all tests were rerun using the existing complete `.venv` environment. No dependencies or model files were replaced to bypass a failure.

Phase 2 and Barangay used temporary copies of their existing Playwright configurations with distinct ports and teardown paths so they could run alongside Report Details. The executed configuration paths were `.data/remediation-2026-10-26/phase2-reference.config.cjs` and `.data/remediation-2026-10-26/barangay-reference.config.cjs`. The corresponding checked-in configurations are `playwright.phase2.config.js` and `playwright.barangay.config.js` for sequential reproduction.

Confirmed failures fixed during verification included stale MySQL read snapshots causing duplicate approval or comment-retry failures, the jurisdiction header not refreshing after a successful correction, migration test dependency/rollback order after adding foreign keys, and obsolete browser expectations for removed Admin assessment controls. Readiness probes now run before mutation transactions, followed by the coordination lock and current reads. General public discussion reads do not acquire incident mutation locks. Tests were rerun after these corrections.

Desktop and mobile screenshots were inspected. Role controls, the top evidence/location layout, comments, conversation, and narrow-screen overflow were checked. `git diff --check` passed. Production checkpoint SHA-256 remained `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`.

Tests include duplicate HTTP retry coverage in the existing submission suites; multiple reporters; nearby distinct classes; recurrence; rejected unauthorized confirmation; concurrent linking; independent publication approval; concurrent canonical publication; original comment preservation; archived discussion access; notification rollback; routing permission isolation; missing evidence/reason; invalid GPS and boundary overlap; stale/concurrent correction; whole-incident transfer; scope changes; current private-message access; notifications; analytics; migration reapplication and rollback safeguards; desktop/mobile role layouts; and actual MySQL-backed browser assignment.

## Limits and rollback

- No authoritative LGU boundary dataset is invented or installed by this change. Corrections remain blocked until valid boundary data and location evidence exist. Synthetic polygons occur only in isolated tests.
- Suggestions are bounded heuristics. They can miss old or distant reports. An existing linked group cannot be silently merged into another group, unlinked, or split through this API. Those corrections require a separately reviewed recovery procedure that preserves discussion history.
- If a canonical public post has been deleted through the existing owner workflow, subsequent approvals stop with a conflict. The system does not silently recreate, move, or republish that discussion. Recover it through an authorized reviewed correction.
- Report analytics continue to count individual submissions. Incident progress is additional information; reports are not silently subtracted from existing totals.
- The incident coordination row serializes linking, publication decisions, and routing correction for correctness. This is suitable for the current workload; high-volume deployments should measure contention before replacing it with more granular locking.
- This does not promote or retrain an AI model, change the current model release gate, or verify a production deployment.

For code rollback, stop the updated application and restore the preceding reviewed build while keeping a full database backup. Do not assume an older application understands incident aliases or routing capabilities. Test the restored build on a copy first.

The supplied `rollback/017_incidents_and_routing.sql` is permitted only before the feature has stored incident, routing, discussion-reference, or permission data. Its initial guard fails before destructive DDL when those records exist. An unused-schema rollback removes only the new structures and restores the prior permission constraint; existing report/post/comment rows remain. Reconcile the migration ledger only as part of that operator-controlled rollback.

After the feature has been used, preserve the database and use a reviewed forward correction or restore the complete pre-change backup during a maintenance window. Do not run a destructive schema rollback against active discussion history. Restoring a backup also restores its point-in-time state, so account for submissions received after that backup.

For local review, the owned preview runs at `http://127.0.0.1:4357`. The old process on port 3000 was not stopped: automatic approval review rejected its restart with “blocked by policy.” A manual restart by its owner is needed before that port can serve the updated routes.

The subsequent [27 October local readiness and migration forensic assessment](local-integration-readiness-2026-10-27.md) records exact recovery of historical 001/009, full schema comparisons, the verified backup, stale-process evidence, and the proposed forward index reconciliation. Configured-local migration 017 and authenticated post-migration smoke tests remain unexecuted pending explicit approval; isolated regression passes above do not imply that the configured database is migrated.

The [migration recovery execution record](migration-recovery-2026-10-27.md) now records the prepared 017–018 recovery and exact backup bundle. The [citywide Community Feed assessment](community-citywide-2026-10-27.md) records the corrected public scope while preserving operational jurisdiction and private coordination.
