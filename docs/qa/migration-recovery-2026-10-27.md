# Migration recovery execution record

Prepared on 27 October 2026 from the existing working tree on `feature/brgy-com-feed-brgy-proof/24/10-2026`. The configured database remains at migrations 001–016. Migrations 017 and 018 have been applied only to disposable MySQL databases and restored private backup copies. No configured-database migration, Aiven change, production change, port-3000 restart, commit, push, or deployment was performed.

## Restored sources and supported histories

The following repository files now contain their exact recovered applied bytes:

| File | Recovered SHA-256 |
| --- | --- |
| `001_init_schema.sql` | `a65af462fddb093a40157d0d1776273f6cc28fb53aa3a7199f802d13397bf662` |
| `009_community_feed.sql` | `aad817432d3f4638b6f2aef86dcf2ea6e63ceb8c746097068450e8ad66acf14b` |

The restored opening comment in 001 is part of its recovered historical source. No new explanatory code comments were added. Migration 009 no longer contains the later report-ID unique index. That index belongs to forward migration 018 instead.

Exact newer SQL sources were preserved under `server/infrastructure/database/mysql/migration-history/`, outside the active migrations directory:

- 001 without its original opening comment: `082a7aa1f22e01f7f9358ff8e79123552775a8861ed0fb2ba2680b68e06799c7`.
- 009 with `community_post_report(report_id)`: `c7cb9ad5dee5cb2eb4b4a2ad517a5b2f157c514cabdece8237a8436edc1576b0`.

`migrationHistory.json` maps only those documented versions to their immutable source artifacts. `readAppliedMigration` first validates the canonical source, then checks the actual versioned SQL against its pinned digest and the ledger's recorded digest. Existing LF/CRLF compatibility remains. Unknown hashes, altered archived SQL, and missing applied sources fail before pending migrations are acquired for execution. Archived CREATE statements are never replayed on an upgrade.

This preserves every existing ledger filename, checksum, ID, and application timestamp. It is not a manual checksum replacement, ignored mismatch, arbitrary accepted-hash list, or fabricated migration row. Fresh installations use the restored canonical files; known newer installations validate against their own preserved source version. Other, unrecognized installation histories require investigation and remain blocked.

## Forward migration 018

`018_community_report_uniqueness.sql` has SHA-256 `34e3fff8a3dcd9be3a1e95df9f4ded44174fd62c21f800707d98fa6d41a4a95a`.

It requires the expected nullable `INT UNSIGNED` report reference and rejects duplicate non-null report IDs. It inspects the complete named index definition, including uniqueness, column count, full-column coverage, expression, index type, order, and visibility. A conflicting `community_post_report` definition stops the migration before index DDL.

If a valid single-column full unique index already exists, including an equivalent differently named index, the migration executes a harmless SELECT and retains the existing index. Otherwise it adds `community_post_report(report_id)`. It never drops or recreates a valid existing index, merges posts, transfers comments, rewrites approvals, or deletes records. Multiple NULL report references remain valid. If index DDL succeeds but the ledger insertion is interrupted, retry verifies the existing index and records successful completion once.

Migration 017 is unchanged: SHA-256 `7115a391c9a3e05fa4ee60319d7266fb5e2a6219a39c1f86924fe7473a6c1032`, 11 statements. It precedes 018. Its foreign keys use existing primary IDs, not the report-ID unique index. The application must remain out of normal use until both approved migrations finish.

## Verification

Private MySQL 8.0.46 instances used random loopback ports and verified temporary data directories. Tests used genuine migration runners and ledger inserts rather than pre-populating pretend applied rows.

| Check | Result | Evidence under `.data/migration-recovery-2026-10-27/` |
| --- | --- | --- |
| Canonical fresh install 001–018 and repeat run | PASS | `recovery-mysql-final.log` |
| Historical unindexed 001–016 upgrade | PASS | `recovery-mysql-final.log` |
| Historical ledger with existing unique index | PASS | `recovery-mysql-final.log` |
| Known newer 001/009, LF and CRLF, and mixed version histories | PASS | `recovery-mysql-final.log` |
| Equivalent alternate index, conflicting indexes, duplicate data, NULL references, interrupted ledger insertion, archive tampering | PASS | `recovery-mysql-final.log` |
| Recovery suite | 19 passed, 0 failed, 0 skipped | `recovery-mysql-final.log` |
| Broad migration regression before the later citywide changes | 155 passed, 0 failed, 1 skipped | `migrations-regression-initial.log` |
| Strict configured-local preflight | PASS; only 017 and 018 pending | `preflight-final.log` |
| Native JSON backup unit and private MySQL checks | 3 passed, 0 failed, 0 skipped | `json-precision-tests-final.log` |
| Full Node regression after the integrated migration and citywide changes | 1,160 passed, 0 failed, 0 skipped | `../citywide-feed-2026-10-27/node-release-final.log` |
| Fresh backup restore and private 017–018 upgrade | PASS; original data and ledger preserved | `operator-precision-verifier-final.log` |
| Configured-local 017–018 execution | NOT RUN; explicit approval required | No execution claimed |

The optional live FastAPI case was skipped in the broad migration run. These migration tests do not claim AI accuracy or a new model release. Later Community Feed integration results are recorded in the separate citywide report.

The reusable synthetic migration baseline contains 30 Citizens, 12 Barangay officials, two Admins, 120 reports, 25 separated candidate duplicate pairs, 240 report images, 120 publication requests, 80 approval/rejection reviews, 60 comments/replies, and 20 internal messages. Timestamps and fixture keys are deterministic. Six explicitly synthetic polygons are confined to disposable databases. Images are existing synthetic test fixtures, not evidence of model accuracy. Seeding twice does not duplicate records. All original application-table row fingerprints match after upgrade, including evidence, severity/status history, messages, publication decisions, and comment parent links.

Fresh and supported upgraded installations reach identical table definitions after excluding auto-increment counters. The valid alternate-index case intentionally retains its existing equivalent index name instead of rebuilding it merely to match a name.

## Backup integrity finding

The earlier backup remains preserved at `.data/backups/local-before-017-1793047998437/`. It is a historical recovery point, not the current application snapshot. Local activity added a report and related publication/comment records while the existing API remained available. The new backup includes 37 reports, six posts, 28 comments, seven publication requests, five review records, and all other current records. No test data was inserted into that database.

Stricter restore checks found that an ordinary text dump could preserve counts yet change native JSON floating-point values by one representable step during MySQL JSON parsing. This was reproduced in private MySQL and affects homography values in ten `damage_verifications.raw_payload` records in a plain restore. The [MySQL issue tracker describes JSON text parsing precision loss](https://bugs.mysql.com/bug.php?id=112904). No original database values were changed to accommodate the backup, and comparisons were not relaxed with a tolerance.

The backup tool now captures native numeric JSON paths, types, and exact server-provided numeric text using bound parameters. A hashed `native-json-numbers.sql` companion restores those values with native numeric casts after the text dump is restored. It preserves automatic timestamps, restores the session SQL mode afterward, and refuses JSON tables with triggers requiring separate review. Private tests cover tiny doubles, maximum unsigned integers, minimum signed integers, decimals, quoted JSON keys, preserved nonnumeric content, and trigger refusal. The original model and inference business logic are unchanged.

The complete backup bundle is:

- Directory: `.data/backups/local-migration-recovery-1793063834384/`.
- Main dump: `before-017-018.sql`, 1,439,725 bytes, SHA-256 `07d08a8a46dc70b06629e90068e56d99aada4a1f8d28b8b972c6da7019f98029`.
- Native numeric companion: `native-json-numbers.sql`, SHA-256 `e4d5c857d4078845c650df67c69fee8126471e1e06e924103e5dfe8d6483de0c`.
- Manifest: `manifest.json`, containing identity, both file hashes, counts, source hashes, and application-table fingerprints.

The companion contains 329 targeted updates restoring 18,866 numeric JSON values in a restored copy. These statements were never run against the configured database. Both files are required for an exact verified restore of this snapshot. They contain private data and must remain ignored and unpublished.

The bundle was restored to private MySQL, matched to the current local snapshot, upgraded with 017–018, and checked again. All 27 original table counts and all 26 original application-table row fingerprints matched. Every original ledger row remained unchanged; only two genuine migration rows were appended on the private copy. The existing report unique-index DDL remained unchanged. Repeating the runner applied nothing.

The restoration evidence is in `.data/migration-backup-verification-1793063859745/`. Earlier failed plain-dump comparisons remain available rather than being replaced by success-only logs.

## Exact local execution procedure

This procedure is prepared, not executed. Approval to edit recovery code is not approval to migrate the configured database.

1. Freeze the reviewed source and configuration, arrange a maintenance window, and stop application writers using their owning terminals. Do not terminate port 3000 through an agent or stop all Node processes. Do not grant routing permission or import boundaries as part of this migration.
2. Verify `.env` selects `DB_DRIVER=mysql`, `DB_TARGET=local`, host `127.0.0.1`, port 3306, database `neighborlens_ai`, and non-production mode. Verify SQL hostname `DESKTOP-3I604SR`, server UUID `be95c421-b12f-11f1-bc1c-2cf05d82c3b2`, and the Windows MySQL data directory. Abort on any remote or unexpected target.
3. From Windows PowerShell, run the read-only preflight:

```powershell
Set-Location 'C:\Users\cleme\Documents\GitHub\Neighborlens-AI'
node --env-file=.env server/infrastructure/database/mysql/preflight017.js
if ($LASTEXITCODE -ne 0) { throw 'Migration preflight failed.' }
```

Require `ready: true`, no historical source failures, exactly 017 then 018 pending, valid dependencies, and no duplicate or conflicting report index. Save `.data/migration-recovery-2026-10-27/strict-preflight.json` with the maintenance record. Check the reviewed 001, 009, 017, and 018 hashes above. Any new file, source change, ledger change, or partial schema requires a new review.

4. Take a fresh backup and verify that exact bundle. Existing backups are retained:

```powershell
$migrationBackupOutput = node --env-file=.env tests/support/backup-local-mysql.js
if ($LASTEXITCODE -ne 0) { throw 'Local backup failed.' }
$migrationBackup = $migrationBackupOutput | ConvertFrom-Json
node --env-file=.env tests/support/verify-migration-backup.js $migrationBackup.manifest
if ($LASTEXITCODE -ne 0) { throw 'Backup restore verification failed.' }
```

The first tool only reads the verified local database and writes a new private backup bundle. The second restores and migrates a disposable MySQL copy; it never applies DDL or DML to the configured database. It requires the restored snapshot and original ledger to match the current local records exactly. If local activity changed the snapshot, stop writers and repeat; do not skip the failure. MySQL 8.0.46 and the existing private-MySQL test prerequisites were used for verification.

5. Obtain explicit approval for the verified local application of **017 and 018 together**, identifying the backup manifest, source hashes, record counts, maintenance window, and recovery operator. Keep application writers stopped and prevent code/configuration changes between preflight and application.
6. Only after that approval, rerun preflight immediately and execute:

```powershell
npm run migrate:mysql
if ($LASTEXITCODE -ne 0) { throw 'Migration failed. Stop and inspect partial DDL.' }
```

The command applies every pending file. It is safe for this procedure only when the reviewed pending list is still exactly 017–018. It was not run against the configured database during this work.

7. Before restarting writers, verify 18 ledger rows and exact preservation of the original 16; six new 017 tables; the discussion column and foreign key; the expanded permission CHECK; one coordination lock row; the valid report unique index; and unchanged original application rows. No routing permission should be granted automatically. Compare restored JSON values and original-table fingerprints, not counts alone.
8. Run separately authorized local smoke tests with approved test accounts and fixtures. The configured storage driver is Supabase, so any future local upload smoke must use a separate process with local storage and private test uploads. Positive geographic correction remains blocked until an approved complete boundary dataset exists. Do not seed the existing database without separate authorization.

## Rollback and partial failure

MySQL DDL implicitly commits. A failed 017 or 018 cannot be safely undone by issuing ROLLBACK. Stop writers, preserve the error, inspect actual schema and ledger, and take a separate backup of the failed state using `mysqldump` before attempting repair. The strict pre-migration backup helper deliberately refuses a partial schema, so do not use it as a bypass after failure.

Migration 018 has no automatic destructive rollback. The report unique index may have existed before remediation; never drop it just because 018 verified it. Retaining a valid index does not delete or rewrite records. The 017 rollback SQL is eligible only before incident/routing/discussion/permission history has been used, and its guard must remain enforced. Do not delete ledger rows to force reapplication.

For complete recovery, first verify the approved bundle in private MySQL. Restore it into a newly named local recovery database, keeping the original database intact. With the MySQL client started by an authorized operator against `127.0.0.1:3306`, select the new recovery database before sourcing the two files:

```sql
CREATE DATABASE neighborlens_ai_restore_20261027;
USE neighborlens_ai_restore_20261027;
SOURCE C:/Users/cleme/Documents/GitHub/Neighborlens-AI/.data/backups/local-migration-recovery-1793063834384/before-017-018.sql;
SOURCE C:/Users/cleme/Documents/GitHub/Neighborlens-AI/.data/backups/local-migration-recovery-1793063834384/native-json-numbers.sql;
```

These are future recovery instructions, not actions performed here. Use the actual newly approved bundle if a fresher backup was taken. Verify both file hashes, all original application-table fingerprints, schema, and the original 16 ledger rows before any cutover. Obtain separate approval for configuration cutover or replacing an existing database. A point-in-time recovery omits later writes; preserve and reconcile those records first. Never DROP the original database or overwrite current records merely to make the migration runner pass.

For code recovery, preserve the current worktree and apply a reviewed file-level change. Do not use a blanket Git reset. Do not assume an older runtime understands incident aliases or routing history after the feature has been used.

## Remaining approval steps

The code, historical source artifacts, forward migration, strict preflight, backup tools, and isolated verification are prepared. The remaining approval is for the maintenance-window application of 017–018 to the verified local database, using a fresh matching backup bundle. Runtime restart, local test seeding, routing permission assignment, boundary import, Aiven access, and production deployment are separate actions and were not silently authorized or performed.
