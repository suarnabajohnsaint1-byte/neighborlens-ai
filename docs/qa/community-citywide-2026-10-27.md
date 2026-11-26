# Citywide Community Feed audit and regression record

Assessed on 27 October 2026. A real scope bug was confirmed. Public Community Feed reads reused the authenticated account's Barangay as a mandatory repository filter. A Citizen could see only their home-Barangay posts, and direct post, media, comment, reply, and reaction access followed the same restriction. Operational report jurisdiction and public feed visibility had been coupled.

Concurrent partial citywide changes were preserved and backed up under `.data/citywide-feed-2026-10-27/before-review/`. The other agent was paused at the user's request before shared files were changed further. The partial implementation was reviewed and extended rather than replaced wholesale.

## Final behavior

The Citizen Community Feed opens directly to approved/public discussions across Bacolod City. Following the user's final clarification, there is no Barangay dropdown. The location heading is Bacolod City. The frontend does not send `barangay` or `barangayId`, even if stale client query state contains them. Search, Latest, Most reacted, pagination, reactions, comments, and replies remain available.

The backend default has no account-Barangay restriction. Explicit optional API filters remain validated for compatibility, but the Citizen interface does not expose or send them. A Citizen without an assigned home Barangay can read and engage with the public feed. Authentication and active-account checks remain enforced; this change does not open staff data or write endpoints to unauthenticated visitors.

Only supported Bacolod City records pass the public read query. Existing approval/legacy/official-publication rules, soft deletion checks, and canonical alias exclusion remain in the shared repository predicate. Pending and rejected Citizen publications stay private, even if adversarial test rows contain a post/media reference. Individual approval is not bypassed by incident linking. Historical approved alias discussions remain readable; their comments are not transferred to another post.

## Confirmed defects corrected

1. Account Barangay was used as public visibility scope. Public list and direct reads now use authenticated community viewer authorization, separately from operational membership.
2. The partial fix still denied Citizens with no home-Barangay ID. Public reads and engagement now validate active role/session state without requiring a home assignment.
3. Realtime public events were still sent only to the home-Barangay channel. Public invalidations now reach community subscribers citywide and contain only event type, public post ID, and kind. Personal notifications retain user-specific delivery; Admin report events retain their separate channel.
4. Internal jurisdiction flags produced public feed invalidations. Flags and dismissed duplicate reviews now remain internal. Incident changes notify the public feed only when a published discussion is affected; duplicate citywide broadcasts for old/new jurisdictions were removed.
5. Cross-Barangay official comments inherited the post's Barangay label. Comment and parent-comment attribution now use the actual official's jurisdiction, while Citizen pseudonyms and avatar variants remain anonymous and stable.
6. Ambiguous/malformed optional filters were accepted, and Barangay-name search did not search the citywide location dimension. Filters are validated and resolved to a supported ID; names, body/category text, and report-ID searches use bound SQL parameters.
7. The inherited dropdown could restrict or confuse the default public feed. It and its handler/styles were removed, and stale frontend filter values are stripped before the request is sent.

Failing tests were recorded before the corresponding fixes in `red-regressions.log`, `red-official-attribution.log`, and `red-private-events.log`. No publication/private-data assertion was weakened to make the new visibility pass. Legacy tests expecting a different Barangay's public discussion to return 404 were updated to the confirmed citywide requirement; ownership and private operational failures remain asserted.

## Files changed or integrated

- `server/domain/community/community.rules.js`: separate public viewer authorization and validated optional filter input.
- `server/application/use-cases/community.service.js`: citywide reads, active-session engagement, filter resolution, and correct official comment attribution.
- `server/infrastructure/repositories/community.repository.js`: shared approved/public reads, citywide default, supported optional filter lookup, global search/count/pagination, and official attribution joins. The temporary dual-signature list adapter was removed; there is one list-query implementation.
- `server/infrastructure/events/notificationEvents.js` and `server/application/use-cases/notification.service.js`: citywide public invalidations and unchanged private delivery.
- `server/application/use-cases/incident.service.js`: publication-aware public invalidation after committed incident changes, preserving internal coordination privacy.
- `frontend/js/community/communityApi.js`, `communityFeed.js`, and `communityView.js`: direct citywide feed, no Barangay selector, no hidden frontend Barangay restriction.
- `frontend/styles/community.css`: removed selector-specific styling and kept narrow-screen tab labels readable.
- `server/tests/community-api-citywide.test.js`, `community-state.test.js`, `tests/integration/community-citywide.test.js`, and `tests/migrations/community-citywide-mysql.test.js`: client, domain, API, MySQL, privacy, canonical, pagination, and browser regressions.
- `tests/integration/community.test.js` and `phase0-security-corrections.test.js`: public cross-Barangay engagement and realtime expectations, retaining author-only edits/deletes and role isolation.
- `tests/integration/community-enhancements.test.js`: deterministic synthetic persona allocation and independent persisted post/user association checks. The full run exposed a random-name collision in its old inequality assertion; production persona generation was not changed and the original inequality assertion remains.

Report ownership, operational report queries, operational transitions, private-message authorization, authentication middleware, model weights, and database schemas were not broadened by this feed fix. Migration recovery changes are documented separately.

## Isolated test evidence

The common API scenario runs against both temporary SQLite and private MySQL 8.0.46. The MySQL wrapper creates a random-port instance with a verified temporary data directory, runs genuine migrations through 018 there, and uses normal API authentication and authorization. Test photos are synthetic fixtures. Supabase and external inference services are not used.

Fixtures include Citizens from Villamonte, Mandalagan, and Granada; approved publications from those Barangays and Taculing; pending and rejected requests; an approved duplicate discussion with a preserved historical comment; an unpublished report linked to that public incident; and private Admin–Barangay messages. Additional adversarial pending/rejected post and media rows verify the SQL approval gate directly.

All three Citizens receive the same four public post IDs. The approved duplicate is removed from the default canonical list, its old comments remain under their original post IDs, and linked unpublished content does not appear in the feed. Pending/rejected direct post, media, report, and comment reads return 404. Citizen staff-thread reads return 403, including the report owner. An unrelated Barangay cannot operate on or read the private review of another jurisdiction's report. My Reports retains owner-only data, including the owner's report submitted in another Barangay.

A bounded pagination test adds 61 approved synthetic fixtures, one per supported Barangay. Each Citizen receives the same 65 distinct public IDs across four pages of 20, covering exactly 61 Barangays. There is no row multiplication, overlap, skipped page result, or implicit home restriction. All temporary additions are removed by their own known fixture IDs before browser testing.

The MySQL run measured 12 page requests at approximately 82 ms average and 192 ms maximum in that run. These are local synthetic measurements, not a production performance guarantee. No new performance migration was added. Large production-scale query-plan/load validation remains separate from this bounded correctness check.

Chromium used the real MySQL-backed API and frontend for all three Citizen sessions at widths 390, 768, 1280, and 1440. It verified four public cards, no Barangay selector, the Bacolod City heading, citywide search/order, no horizontal overflow, anonymous comments, comment persistence after reload, and absence of Barangay parameters in feed requests. Twelve screenshots are stored under the evidence directory. The synthetic single-pixel evidence appears as solid photo blocks; no model inference or image-recognition result is claimed.

| Run | Result | Evidence under `.data/citywide-feed-2026-10-27/` |
| --- | --- | --- |
| Public-client unit + SQLite citywide API scenario | 15 passed, 0 failed, 0 skipped | `open-feed-sqlite.log` |
| Private MySQL citywide API and real-browser scenario | 15 passed, 0 failed, 0 skipped | `open-feed-mysql-browser.log` |
| Community, publication, incident/routing and report-review MySQL regression after backend fixes | 80 passed, 0 failed, 0 skipped | `mysql-community-final.log` |
| Citywide, operational authorization and Phase 0 security integration | 43 passed, 0 failed, 0 skipped | `security-final.log` |
| Architecture/domain/citywide focused checks | 42 passed, 0 failed, 0 skipped | `focused-final.log` |
| Full Node release regression | 1,160 passed, 0 failed, 0 skipped | `node-release-final.log` |

These runs overlap and should not be added as unique coverage. Initial failures are retained: old filter expectations, an architecture scanner matching the word Select in a user-facing error, and a random persona collision in a nondeterministic fixture. The final changes preserve the architecture checks, replace the obsolete visibility expectations with positive citywide and negative privacy checks, and verify independent persisted personas with deterministic test data.

## Running local process and remaining limits

Port 3000 remains the original PID 28444, started before these backend changes. It was not restarted or modified in memory. Its old filter validation explains the screenshot's Unsupported community filter response when the newer frontend sent a Barangay filter. Removing that dropdown/request does not hot-reload Express or prove that the old running process serves the corrected backend.

The owner must manually stop that API in its original terminal and start the reviewed version with `npm run server` before the Live Server page on port 5500 can use the new behavior. The application should then be refreshed. No automated port-3000 restart, configured-database migration, production access, commit, push, or deployment was performed.

The configured local database remains at 001–016. Full canonical incident behavior was verified on disposable migrated databases; it cannot be claimed active on the configured database until the separately approved 017–018 procedure is executed. The normal approved citywide list can still read the existing publication tables without inventing incident data.

This audit does not claim guest posting, production geographic authority, full model accuracy, or elimination of every possible defect. Existing anonymous avatar assets were preserved. Citywide feed access does not grant access to private report evidence, report ownership, staff conversations, or another Barangay's operational controls.
