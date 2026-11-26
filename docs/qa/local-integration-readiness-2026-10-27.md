# Local integration readiness and migration recovery

The source recovery proposal in this forensic snapshot has since been implemented and tested. See [the migration recovery execution record](migration-recovery-2026-10-27.md) for restored sources, verified historical variants, migration 018, strict preflight, exact backup restoration, and remaining local approval. See [the citywide feed assessment](community-citywide-2026-10-27.md) for the later public-visibility fix. The historical observations below are retained as evidence; they are not the latest code status.

Assessed on 27 October 2026. Branch: `feature/brgy-com-feed-brgy-proof/24/10-2026`. HEAD: `ad816a61cb582a1a91597c4e3caea5c5cb66230c`. Existing staged and unstaged work was preserved. No commit, push, deployment, model replacement, permission grant, or configured-database write was performed during this readiness investigation.

## Decision

Do not run migration 017 against the configured database yet. The unchanged migration validator correctly rejects historical source drift in 001 and 009. Both exact applied sources have now been recovered. No ledger checksum replacement or baseline reset is necessary.

The database schema matches a fresh installation of the current 001–016 files. It differs from a replay of the recovered historical sources by one unique constraint/index on `community_posts.report_id`. That discrepancy requires an explicit forward reconciliation, rather than describing the entire mismatch as formatting drift.

Authenticated end-to-end tests against the configured database remain pending approval of the recovery and migration procedure. An unauthenticated health response is not evidence that those workflows work on this database.

## Verified database identity and preserved records

The configured target is local MySQL, not Aiven: `127.0.0.1:3306`, database `neighborlens_ai`, MySQL `8.0.46`, Windows host `DESKTOP-3I604SR`, server UUID `be95c421-b12f-11f1-bc1c-2cf05d82c3b2`. The SQL data directory is `C:\ProgramData\MySQL\MySQL Server 8.0\Data\`. The audit checked configuration and SQL identity before reading application data or taking a backup.

There are 16 migration ledger rows, covering 001–016, and 27 InnoDB tables. None of the six migration 017 tables or its discussion column exists. Fourteen historical migration files match the runner's accepted hashes; 001 and 009 do not. There are no orphaned report-to-Barangay references.

All table counts were checked before and after backup, after restoring the backup in private MySQL, and in the final local read-only preflight. They remained unchanged:

| Table | Rows | Table | Rows |
| --- | ---: | --- | ---: |
| admin_access_requests | 1 | admin_initialization | 1 |
| audit_logs | 636 | barangays | 61 |
| citizen_identities | 13 | community_comment_reactions | 2 |
| community_comments | 27 | community_media | 10 |
| community_personas | 8 | community_posts | 5 |
| community_publication_legacy | 1 | community_publication_media | 12 |
| community_publication_requests | 6 | community_publication_reviews | 4 |
| community_reactions | 3 | damage_verifications | 21 |
| notifications | 31 | report_action_proofs | 2 |
| report_coordination_messages | 0 | report_coordination_reads | 0 |
| report_images | 72 | report_severity_reviews | 0 |
| report_status_history | 17 | reports | 36 |
| schema_migrations | 16 | user_permissions | 1 |
| users | 42 | | |

The 42 active accounts comprise 37 Citizens, two Admins, and three Barangay officials. The one existing permission is `admin:create`; no routing-correction permission is granted. Individual usernames, password hashes, identity evidence, private messages, and secrets are not reproduced here.

## Historical source recovery and checksum evidence

The exact checksum algorithm is `migrationRunner.readMigration`: read SQL as UTF-8, calculate SHA-256 over that decoded text, and also accept LF and CRLF variants. SQL comments are included in the checksum. `parseStatements` removes line comments for execution, not for validation. The investigation used that existing function against quarantined candidates; it did not add accepted hashes to the runner.

For migration 001:

- Recorded and recovered SHA-256: `a65af462fddb093a40157d0d1776273f6cc28fb53aa3a7199f802d13397bf662`.
- Current SHA-256: `082a7aa1f22e01f7f9358ff8e79123552775a8861ed0fb2ba2680b68e06799c7`.
- The recovered source is the CRLF form of the file at Git commit `5c7849c23843ffe90fecb733c181bedb4f134d51`. Its Git LF blob SHA-256 is `9013a6dd7acb2a7864859bf03cb8d4c8cf0d0859edaa25e6f6467b60e0ebaf25`.
- The current file removed the opening SQLite-mirroring line comment and its following blank line. All 15 parsed statements are identical after line-ending normalization. This is confirmed non-executable source drift, although validation must still reject it.

For migration 009:

- Recorded and recovered SHA-256: `aad817432d3f4638b6f2aef86dcf2ea6e63ceb8c746097068450e8ad66acf14b`.
- Current SHA-256: `c7cb9ad5dee5cb2eb4b4a2ad517a5b2f157c514cabdece8237a8436edc1576b0`.
- Exact recovered source: 2,344 bytes, Git blob `d098748731ca3a76f43a87064350f209ce8bcd80`, found by read-only unreachable-object inspection. No `git fsck --lost-found`, checkout, reset, or garbage collection was used.
- Independent corroboration: the same 2,344 bytes appear in the original development session at `2026-10-17T07:03:35.645Z`, line 9298, as `008_community_feed.sql`. The successful rename patch at `2026-10-17T07:23:37.407Z`, line 9643, moved that source to `009_community_feed.sql`.
- The session is `C:\Users\cleme\.codex\sessions\2026\10\13\rollout-2026-10-13T21-17-45-01a13569-6f68-7a73-846a-1617c950c752.jsonl`. Its folder date is the chat creation date, not the date of every operation. Searching only October 17 folders would miss this evidence.
- The ledger records application at `2026-10-17 17:24:53`. This DATETIME is reported without assuming its original time zone.
- The current source adds `UNIQUE KEY community_post_report (report_id)` to the first CREATE TABLE statement. This changes database behavior; LF/CRLF, whitespace, encoding, or comment normalization does not explain the mismatch.
- All five candidate files were checked with the actual runner. The two independent historical candidates match exactly. Current source, extracted deployment copy, and the deployment ZIP member share the newer hash. Both matching historical files round-trip through UTF-8 without loss and have no BOM.

The search included all available Git refs/reflog, 1,672 unreachable blobs below 100 KB, the current worktree inventory, 16 relevant local ZIP archives, an extracted deployment tree, 870 VS Code History resource manifests, the two NeighborLens publication backup directories, and the relevant original development-session records. The archives yielded the newer file; reachable Git history contains only the newer 009 version, committed on October 18 at `7b5dad7c6e270dfc4c742243f5f5e078c01a6f0c`. The unreachable object and session recovered the missing applied version.

Both pre-publication SQL backups dated October 19 already contain the unique index. The available evidence establishes that it exists now and existed by those backups. It does not establish which operator or command added it to this database. No migration in the recorded 001–016 sequence explicitly adds that index after historical 009. Do not invent an ALTER event or actor to fill that gap.

## Actual schema comparison

Two private, disposable MySQL databases were built using byte-for-byte copies of the unchanged migration runner and only migrations 001–016. One used current sources. The other substituted the recovered 001 and 009. Migration 017 was excluded from both source directories and was not executed during this forensic comparison.

The actual database was inspected using a read-only consistent snapshot. Metadata covered all tables, column order/types/defaults/nullability/generated expressions/character sets, index order/uniqueness/prefixes/visibility/expressions, primary and unique constraints, foreign-key targets and update/delete rules, CHECK expressions, triggers, views, routines, and events. Database-schema names and auto-increment counters were excluded from structural comparison; SQL expressions and constraint names were not normalized away.

Actual metadata totals are 27 tables, 219 columns, 128 index-component rows, 99 constraints, 111 key-component rows, 46 foreign keys, and seven CHECK constraints. There are zero triggers, views, routines, or events.

- Current 001–016 reference: no structural differences.
- Recovered historical 001–016 reference: the actual database has the unique `community_post_report(report_id)` constraint/index. Historical replay has the non-unique `report_id` index that MySQL creates for the foreign key instead. No other structural differences were found.
- There are zero groups with duplicate non-null `community_posts.report_id` values in the actual database.

The root cause is edited historical migration source combined with an index change not represented by a separate recorded migration. This is a migration reproducibility/integrity problem. No current structural incompatibility with the inspected 017 DDL was found. That finding does not authorize migration or replace authenticated runtime tests.

The inspected `017_incidents_and_routing.sql` has 11 statements and SHA-256 `7115a391c9a3e05fa4ee60319d7266fb5e2a6219a39c1f86924fe7473a6c1032`. It creates six incident/routing/alias/coordination tables, adds `discussion_post_id` and its foreign key, expands the permission CHECK, and inserts the coordination lock row. Parent IDs in `users`, `reports`, `barangays`, `community_posts`, and `community_publication_requests` are all `INT UNSIGNED` primary keys. The required existing permission CHECK permits only `admin:create`; migration 016 coordination/severity tables exist. MySQL 8.0.46 enforces CHECK constraints. These prerequisites pass; the historical checksum gate still prevents application. Freeze and recheck the 017 hash before any approved application because it remains uncommitted work.

## Smallest proposed recovery

This is a review proposal. Historical working files, the migration runner, and the local ledger have not been changed to implement it.

1. Preserve the original ledger export, current files, recovered files, schema comparison, source provenance, and backup checksums. The recovered files are also copied into the verified backup's `recovered-migrations` folder, independent of the unreachable Git object.
2. Restore the exact applied 001 and 009 as immutable migration sources in a reviewed code change. Preserve the removed unique-index behavior through a new forward migration, rather than hiding it in 009.
3. Add a proposed `018_community_report_uniqueness.sql`. It must inspect the full index definition, accept the exact existing unique index without dropping/rebuilding it, add that index only when absent and data is eligible, and reject conflicting definitions or duplicate non-null report IDs. It must never delete or merge posts to satisfy uniqueness. The runner should insert its genuine ledger row only after successful execution.
4. Keep 017 unchanged. Its DDL references `community_posts.id`, not the report-ID unique index, and does not insert public posts. Applying approved 017 followed by approved 018 while application writes are stopped can restore consistent fresh-install and existing-install behavior before the application resumes.
5. Update the local preflight and migration tests to require the exact reviewed pending plan of 017 plus 018 and the reconciled schema. This is a pending-list change, not a checksum exception. Test fresh recovered 001–016, existing indexed snapshots, duplicate-data refusal, conflicting-index refusal, interrupted DDL, and runner re-execution on disposable databases before local application.
6. Inventory other installations before releasing restored historical sources. Installations that recorded the newer 001/009 hashes will need their own evidence-based review. Do not rewrite their ledgers or silently make all historical hash variants acceptable.

There is no need to propose a replacement baseline now that exact originals were recovered. A fabricated 009 ledger row, manual checksum UPDATE, disabled validator, broad hash allowlist, or deletion of the existing ledger would discard evidence and is not part of this plan.

Migration 018 is not implemented or tested in this investigation. Approval is needed for the concrete recovery change and expanded 017–018 local application plan. The existing strict preflight intentionally remains blocked on 001 and 009 until the reviewed source recovery is implemented.

## Backup and future application procedure

The verified backup is `.data/backups/local-before-017-1793047998437/before-017.sql`, 1,404,757 bytes. SHA-256: `4a0b8f4cc407fcde7c4d5c71e5c152715d9710a2c5781cb37b675d18c929f8a0`.

It was taken with single-transaction, routines, events, and triggers enabled, no tablespaces, and GTID output disabled. Credentials were supplied only to the child process environment. The dump was restored into private MySQL; all 27 table counts matched. The standard runner on that restored copy refused migration 001, preserved all 16 ledger rows, and did not apply 017. The dump contains sensitive application records and must remain private and ignored by Git.

Do not run the application step below before explicit approval and completion of the proposed source/forward-migration recovery.

1. Stop local application writers using their owning terminals and arrange a maintenance window. Identify the exact MySQL host, port, database, SQL hostname, UUID, data directory, and MySQL version again. Abort on a remote target, `DB_TARGET=aiven`, production mode, or an unexpected identity.
2. Export the ledger and complete schema metadata. Capture all 27 counts and the duplicate-report-ID query. No pending migration or partial structure beyond the reviewed plan is allowed.
3. Take a new full backup with the same options; calculate SHA-256, inspect the completion marker, restore it into a private instance, and verify all table counts. The existing backup is a proven recovery point, not permission to skip a fresh backup after new activity.
4. Review exact source hashes for every historical migration, 017, the proposed 018, and their rollback plans. Use the unchanged validator on the backup copy. Stop on any mismatch. Do not use the current full runner merely to check status on the real database: it creates the ledger table if absent and applies pending files after validation.
5. The current read-only command is:

```powershell
Set-Location 'C:\Users\cleme\Documents\GitHub\Neighborlens-AI'
node --env-file=.env server/infrastructure/database/mysql/preflight017.js
```

It currently reports `ready: false`, with 001/009 drift, and exits nonzero. Its JSON report is `.data/local-readiness-2026-10-27/strict-preflight.json`. It has no apply or checksum-override option. Once the approved 018 exists, this helper must first be updated and tested to validate that exact pending plan.

6. Only after explicit approval, successful recovery tests, a fresh verified backup, and a passing updated preflight should the operator execute the existing `npm run migrate:mysql`. The runner applies every pending SQL file, so verify that the list is exactly the approved 017–018 plan immediately beforehand. This command was not executed against the configured database here.
7. Verify that all original ledger rows and checksums remain byte-for-byte unchanged, with only genuine new migration rows appended. Verify six new 017 tables, the discussion column/foreign key, the expanded permission CHECK, the one lock row, and the exact report-ID unique index. Original application record counts must remain equal; `schema_migrations` increases by the number of approved newly applied files. No routing permission should appear automatically.
8. Start the reviewed API in isolation and perform the authenticated smoke plan below before resuming normal use. Preserve timestamped results and compare counts again, separating intentional test fixtures and audit/notification writes from existing data.

MySQL DDL implicitly commits. A failed multi-statement migration is not safely undone by ROLLBACK. Stop after a partial failure; capture the schema and ledger, then review repair or restore rather than rerunning blindly.

## Local API preview and port 3000

The updated preview listens on `http://127.0.0.1:4357`, PID 37304, started 27 October at 04:45:24 +08. It uses the existing application and actual configured local database, with a preview-only same-origin frontend API setting. It has no mock API, seed, or startup migration.

The latest read-only probes returned health 200 and protected review, citizen-comments, and incident-review routes 401. The three served review/detail JavaScript assets match disk. Earlier unauthenticated mutation-route probes also returned 401. No actual-account login or signed-token impersonation was used.

Port 3000 is PID 28444, `C:\Program Files\nodejs\node.exe`, command `node --env-file=.env server/app.js`, started 26 October at 17:46:25 +08. Its health returns 200, but the same three new routes return 404. This is evidence that the existing process has stale application routes. MySQL listens on port 3306, PID 7424. No existing process was terminated.

For a manual Windows PowerShell restart, inspect the live owner again because PIDs can change:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter 'ProcessId=28444' |
  Select-Object ProcessId, ExecutablePath, CommandLine, CreationDate
```

If it is still the expected API, press Ctrl+C in the terminal that started it. Do not stop every Node process. Confirm port 3000 has no listener, then start from the repository:

```powershell
Set-Location 'C:\Users\cleme\Documents\GitHub\Neighborlens-AI'
npm run server
```

In another terminal:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/api/health'
try {
  Invoke-RestMethod 'http://127.0.0.1:3000/api/reports/60/review'
} catch {
  [int]$_.Exception.Response.StatusCode
}
```

The second request should return 401 without authentication, rather than 404. The existence of report 60 is not inferred from this unauthenticated probe. Restarting the API does not repair migration drift or install 017. A previous automated restart attempt was rejected by automatic approval review as “blocked by policy”; it was not retried through another mechanism.

## Role and workflow assessment

The implementation separates shared rendering from server-enforced capabilities:

- Admin: report monitoring, activity, citizen comments, proof viewing, and private messages. The status route requires Barangay, and the status/severity services independently reject Admin mutation. Admin retains separate publication approval authority.
- Assigned Barangay: eligible operational transitions, proof and required resolution description, severity confirmation with evidence/reason, duplicate confirmation, routing flags, and internal replies. Current jurisdiction is checked server-side.
- Routing Admin: an active Admin with explicit `report:assign-jurisdiction`. This adds jurisdiction correction only. It does not satisfy Barangay-only status, severity, or duplicate-confirmation authorization.
- Citizen: original evidence/ownership/report status and linked-incident progress, without internal messages or staff controls.

Duplicate confirmation preserves report IDs and individual evidence. Existing discussions are aliased to a canonical discussion, while historical comments retain their original post IDs. New public discussion still requires authorized Admin approval. Dismissed candidates remain independent; recurring damage is distinguished from an unresolved duplicate. Incident suggestions alone do not merge reports.

Jurisdiction correction checks permission, reason, supporting report images, original GPS/accuracy, unique verified geofence result, and expected routing/incident versions. A linked group must be transferred consistently. Current access, publication scope, notifications, analytics, and retained private-message history are covered by isolated tests. Old officials lose access after transfer; historical messages are preserved.

These statements are supported by source and isolated test results. Authenticated configured-local verification of the new incident features remains deferred because 017 is absent.

## Assigning routing permission after approval

No permission was granted during this work. The 017 permission CHECK must be installed before a valid grant is possible. There is no automatic privilege attached to the username `superadmin`.

An authorized database operator must select exactly one intended active Admin under a transaction, verify their identity and the maintenance approval, then add only `report:assign-jurisdiction`. The insertion pattern is:

```sql
START TRANSACTION;
SELECT id, username, role, status
FROM users WHERE id = YOUR_VERIFIED_ADMIN_ID FOR UPDATE;
INSERT INTO user_permissions (user_id, permission, granted_by)
SELECT id, 'report:assign-jurisdiction', NULL
FROM users
WHERE id = YOUR_VERIFIED_ADMIN_ID AND role = 'admin' AND status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM user_permissions p
    WHERE p.user_id = users.id
      AND p.permission = 'report:assign-jurisdiction'
  );
SELECT ROW_COUNT() AS created;
```

The ID placeholder is deliberately not executable. Require one selected intended account and one created row, or verify an already-existing exact grant. Record operator, approval reference, timestamp, selected account, and before/after permission rows in the installation's maintenance audit. Use COMMIT only after those checks; otherwise ROLLBACK. An operator-level grant may have NULL `granted_by`; do not invent an application actor. Test that this Admin still receives 403 from status/severity mutation endpoints. Revocation is a separately audited removal of that exact grant.

## Barangay boundary authority and completeness

The local catalog contains all 61 expected Barangay names. It contains zero polygon geometries, zero boundary sources, and zero boundary versions. All 36 existing reports have `citizen_declared` jurisdiction. A name catalog and coarse service bounding box do not establish verified Barangay boundaries.

The [official Bacolod City profile](https://tourism.bacolodcity.gov.ph/about.php) lists 61 Barangays. The government-hosted [GeoRisk PSA Barangay layer metadata](https://portal.georisk.gov.ph/arcgis/rest/services/PSA/Barangay/MapServer/4?f=pjson) describes indicative boundaries observed in June 2016, based on the 2015 census layer. It supports polygon queries; its source and displayed CRS differ, so an eventual export needs explicit EPSG:4326 output verification. Government hosting establishes provenance, not current legal or operational boundary approval.

No current CPDO/NAMRIA/LGU-approved complete Bacolod polygon export was obtained or imported. The external layer's complete 61-feature geometry coverage and topology were not verified. The local operational dataset is definitively incomplete: 0 of 61 polygons. Obtain an approved dataset, reconcile official identifiers/names, verify all 61 geometries, coordinate order/CRS, overlaps, gaps, validity, source/date/version, and representative boundary points before enabling positive routing acceptance tests.

The older `docs/AUTHORITATIVE_BARANGAY_POLYGON_DATASET_REQUIREMENTS.md` includes community OSM/PhilGIS data among authoritative sources. Community data needs explicit government validation before that claim can be made; the older wording should not be used as evidence of approval. Runtime source/version strings are operator-provided metadata, not independent proof of authority. No synthetic boundary was inserted into the configured database.

## Test results and scope

Exact logs are in `.data/local-readiness-2026-10-27/`. Separate runs overlap; do not add them as unique coverage.

| Verification | Result | Evidence |
| --- | --- | --- |
| Final preflight unit + report review + incident routing integration | 36 passed, 0 failed, 0 skipped | readiness-focused-final.log |
| Private MySQL incident routing + report review migration suites, before the latest forensic-only instruction | 34 passed, 0 failed, 0 skipped | readiness-mysql.log |
| Final preflight unit rerun, including version suffix/unknown/MariaDB rejection | 6 passed, 0 failed, 0 skipped | preflight-unit-final.log |
| Backup restore | All 27 counts matched; original ledger preserved; runner refused 001 | backup-restore-verification.json |
| Forensic current/recovered source references | Two fresh 001–016 private schemas built successfully; no 017 executed | schema-comparison.json |
| Exact 009 recovery | Two independent candidates matched recorded checksum through unchanged runner | checksum-forensics.json |
| Configured-local strict preflight | Expected refusal: historical 001 and 009 drift | strict-preflight-final.log |
| Current preview | Health 200; new protected GET routes 401; three assets match disk | final-readonly-verification.json |
| Old API | Health 200; three updated GET routes 404 | final-readonly-verification.json |
| Configured-local authenticated post-017 end-to-end | Not run; awaiting approval and migration | No passing result claimed |
| Proposed migration 018 | Not implemented or tested | Requires reviewed follow-up |

The earlier broad regression results remain in `docs/qa/incident-routing-remediation.md`. They were not all rerun during this forensic investigation. The latest forensic phase made only read operations against the configured database and applied only 001–016 to disposable reference databases.

The final 36-test run adds explicit status and severity 403 assertions for both ordinary Admin and routing-permission Admin sessions. It uses isolated SQLite fixtures for workflow tests; the preflight unit tests use fake read-only connections. The earlier 34-test MySQL run predates these additional assertions and was not rerun after the instruction to leave 017 unexecuted.

## Post-approval actual-local smoke plan

The configured storage driver is Supabase. An ordinary upload could therefore modify cloud storage despite using local MySQL. Use an owned isolated API process with an environment-only `STORAGE_DRIVER=local` override and an owned absolute private upload directory outside the repository. Use loopback inference URLs. Do not edit shared `.env`, change live storage, or use cloud model endpoints for these fixtures.

Use authorized test credentials and normal login, with explicitly approved, uniquely tagged new fixtures. Do not forge tokens, promote pending accounts, disable another Admin, or alter existing reports merely to force a passing test.

1. Verify MySQL identity, all approved ledger hashes, API health, local AI health, and checkpoint identity.
2. Authenticate authorized Admin, assigned Barangay, another Barangay, and Citizen fixtures. Verify Admin monitoring/messages/comments and 403 status/severity attempts, including an explicitly granted routing Admin.
3. Verify eligible Barangay ongoing/resolution/rejection transitions, required proof/description, severity evidence/reason, and idempotent retries; reject unrelated Barangay and Citizen mutations.
4. Submit distinct Citizen reports, confirm duplicates through the assigned Barangay only, then approve publication through the assigned Admin. Verify one canonical discussion, independent report IDs, preserved historical comments, and independent dismissed/recurring incidents.
5. Exercise private messages and access after transfer. Validate notifications, routing/incident concurrency conflicts, analytics totals, and unchanged original evidence/coordinates/history.
6. With no approved polygons installed, assert correction fails closed. A successful geofence transfer smoke test remains blocked until a separately approved authentic boundary import exists. Never replace missing production/local authority with test polygons.
7. Record intended fixture inserts separately from before/after counts. Keep test audit evidence. Review fixture cleanup individually; never bulk-delete existing records or discussion history.

## Rollback and remaining blockers

No rollback is needed for this investigation because the configured database was not changed. The read-only preflight can be removed without affecting runtime business logic. Recovered-source copies and raw audit outputs should remain available to the operator.

If an approved future migration fails, stop writers, retain the failure/schema/ledger evidence, and restore the verified backup first to a separate private database. Verify identity, schema, ledger, and every count before considering replacement of the configured local database. A point-in-time restore loses later writes unless separately preserved and reconciled; do not overwrite current data while writers are active.

The existing 017 rollback script refuses to remove used incident/routing/discussion/permission history through an initial guard. It is only eligible before feature data exists. Its ordinary statements do not manage ledger rollback. After actual feature use, prefer a reviewed forward correction or complete maintenance-window recovery. Do not manually delete 017's ledger row to force a reapplication. The proposed 018 also needs a reviewed rollback policy: an index that predated reconciliation must not be dropped just because 018 recorded verification of it.

Remaining blockers are explicit approval and implementation of historical source restoration plus the forward index reconciliation, a fresh verified local backup and passing updated preflight, manual restart of the stale port-3000 API, authorized actual-local smoke fixtures, and an approved complete boundary dataset for positive jurisdiction-transfer validation. Aiven, production, existing records, and model weights remain untouched.

## Evidence files

Private evidence root: `.data/local-readiness-2026-10-27/`.

- `database-audit.json`: initial SQL identity, full table DDL, ledger, counts, routing and boundary inventory.
- `checksum-forensics.json`, `candidate-inventory.json`, `historical-patch-index.json`, `index-provenance.json`: exact candidate checksums and source provenance.
- `historical-backup-schema-evidence.json`: October 19 backup index evidence.
- `actual-schema-metadata.json`, `current-reference-schema.json`, `recovered-reference-schema.json`, `schema-comparison.json`: complete structural comparisons.
- `reference-source-current/`, `reference-source-recovered/`: isolated copies of only 001–016 and the unchanged runner.
- `backup-manifest.json`, `backup-restore-verification.json`: backup and restore evidence.
- `strict-preflight.json`, `final-readonly-verification.json`, `processes.json`: local readiness and runtime observations.

Do not publish raw backups, development-session records, authentication traces, or identity evidence. The public QA document contains only the facts needed to review the recovery.
