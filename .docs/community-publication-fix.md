# Community Publication Follow-up

## Cause and Local Repair

The configured local MySQL database had migrations 001 through 010, but none of the four tables required by migration 011. Both the feed visibility query and publication status query therefore failed. No approval checks were removed to bypass this failure.

The user explicitly approved a local backup and migration 011. Only `011_community_publication.sql` was applied to `neighborlens_ai` on loopback port 3306. Its checksum was recorded in `schema_migrations`.

The full SQL backup is outside the repository at `C:\Users\cleme\.codex\backups\neighborlens-011-RPgYWj\before-publication-011.sql`. Directory inheritance was removed and access restricted to the current Windows account. The completed dump is 1,053,780 bytes; SHA-256 is `a6d1e0e3d12db9bc7d9761f8335bb1a2bc8a06a66accca2eb4c2bb46297bfa68`. Backup restoration was not tested against the configured database.

Before/after hashes of the complete ordered report and community-post rows matched. All 30 reports and the existing community post were unchanged. The citizen post was preserved through the explicit legacy allowlist, not marked as Admin-approved. Read-only repository queries subsequently returned one visible community post, zero publication requests, and `unshared` for existing Report 56.

## Presentation and Error Handling

The reusable publication section now has consistently styled controls, a responsive metadata grid, two-column preview photos, compact spacing, clear labels, accessible loading feedback and keyboard focus. Approve and reject retain distinct primary/secondary styling. An unshared Admin view explicitly explains that no publication request exists.

The feed error message and retry control share one responsive notification row. Known missing publication tables produce HTTP 503 with `COMMUNITY_SETUP_REQUIRED`, without SQL or schema-name disclosure. Setup failures do not offer a misleading transient retry; temporary failures still support retry and recovery. Existing authorization failures retain their original status. No unapproved posts are returned as an error fallback.

The existing process on port 3000 was not terminated or restarted. Migration-dependent queries no longer need the missing tables created. The new setup-error diagnostics load when that API process is next restarted. Frontend changes are served by the existing port 5500 server and require a page refresh.

## Verification

| Command or Check | Actual Result | Environment |
| --- | --- | --- |
| `npm test` | 998 passed, 0 failed, 0 skipped | Isolated unit and test-adapter integration suites |
| `npm run test:publication` | 44 passed, 0 failed, 0 skipped | Unit tests and private MySQL instances with real HTTP APIs and Chromium |
| `npm run test:e2e:publication` | 8 passed, 0 failed, 0 skipped | Isolated test database, fixture inference and reverse geocoding |
| `node --test tests/migrations/community-publication-mysql.test.js` | 15 passed, 0 failed, 0 skipped after the final gallery adjustment | Private MySQL, real HTTP API and Chromium; injected failures only for error-layout cases |
| `node --test tests/deferred/phase-4-severity-persistence.test.js` | 0 passed, 1 known failure, 0 skipped | Isolated deferred regression; unchanged severity fallback |
| Configured MySQL readback | Four publication tables, migration recorded, feed and moderation repository queries succeed | Read-only transaction on the configured local database |
| `git diff --check` | Passed | Existing LF/CRLF notices only |

The private MySQL suite verifies citizen request, assigned Admin approval, protected previews, owner notification, refresh, comments, nested replies, reactions, concurrent decisions and role isolation. Missing-schema tests temporarily rename a table only inside the disposable MySQL instance, verify both endpoints fail closed with 503, restore the table, and verify recovery.

Both themes were checked at 320, 375, 768 and 1440 pixels. Assertions cover horizontal overflow, button touch height and successful retry. Screenshots are in `.data/publication-screenshots/`, including `publication-layout-light-1440.png`, `publication-layout-dark-320.png` and `feed-setup-light-375.png`. Placeholder gray evidence in those screenshots belongs only to isolated test fixtures.

No signed-in browser session for the configured database was available to this tool session. Its authenticated browser workflow was not tested; the real browser lifecycle was verified against private MySQL instead. Supabase integration was not exercised. Existing broader browser failures from the initial implementation report were not rerun or declared resolved. The deferred Phase 4 severity failure remains unchanged.

## Files Changed in This Follow-up

```text
frontend/js/community/communityState.js
frontend/js/community/communityView.js
frontend/js/shared/communityPublication.js
frontend/styles/community.css
frontend/styles/report-details.css
server/presentation/http/controllers/community.controller.js
server/presentation/http/controllers/communityPublication.controller.js
server/presentation/http/controllers/communityError.js
server/tests/community-error.test.js
tests/migrations/community-publication-mysql.test.js
.docs/community-publication-implementation.md
.docs/community-publication-fix.md
```

No migration source, dependency version, authentication protocol, report processing status, AI assessment or severity logic was changed in this follow-up. Existing staged edits were preserved. No commit, push or deployment was performed.
