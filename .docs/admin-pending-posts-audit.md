# Admin Pending Posts Audit

## Findings Before Implementation

The existing report transaction already supports automatic publication preparation and assigned-reviewer notifications. Approval creates a sanitized post, media associations, review history, audit entry and citizen notification in one transaction. Assigned active Admin checks, row locks, versions and unique report/post keys prevent unauthorized or duplicate publication. These mechanisms will be reused.

`frontend/admin.html` has five summary cards. `frontend/styles/admin-overview.css` uses auto-fit on desktop and a two-column mobile override with a full-width first card. Neither satisfies the required six-card single-row layout.

`frontend/js/admin/admin_logic.js` has a reusable All Reports filter, pagination, queue loading and one shared Report Details dialog. The publication filter uses report sorting rather than oldest publication request first. Its publication count exists only as a filter caption. Queue failures can resemble an empty result.

The Admin bell mixes persisted review notifications with synthetic report activity and local read markers. Its badge is therefore not the database unread notification count. Existing notification list, unread count, mark-read, mark-all-read and SSE endpoints support all authenticated users and can replace that mixed calculation without adding endpoints.

`frontend/js/shared/communityPublication.js` renders the existing review section but approves immediately without confirmation. It does not expose saved review history or jurisdiction resolution. The account confirmation modal is tied to account operations; a small reusable confirmation helper in the existing shared component module can use the same dialog/button styles without adding another Report Details modal.

`server/application/use-cases/report.service.js` skips automatic review when the report barangay is unresolved. `communityPublication.service.js` derives a blocked state and also ties citizen eligibility to the incident barangay. These rules conflict with the newly approved separation of registration and incident location. Existing author ownership, active-account and reviewer checks must remain.

Migration 011 requires a non-null publication barangay. The reports jurisdiction-source enum permits only citizen-declared and geofence-resolved values. Migration 012 is required to accept pending reviews with unknown incident jurisdiction and accurately attribute subsequent Admin assignment. The user approved an additive migration, isolated migration testing and a backed-up local application. No registration/OCR address will be copied into incident location.

Public posts still require an actual barangay for scoped feed delivery. The existing review will allow an authorized assigned Admin to resolve that incident assignment independently before publishing. Unknown jurisdiction will not prevent saving or reviewing/rejecting a report. An approval without a resolved incident barangay cannot silently publish to an invented location.

## Scope

Reuse the existing publication repository/service/routes, report repository, barangay catalog, notification persistence/events, All Reports list/pagination, theme tokens and shared report dialog. Add only a jurisdiction update operation on the existing publication resource, history projection, a shared confirmation helper and the Pending Posts summary card. Preserve existing reports/posts and migration 011 history. Do not backfill old private reports or reinterpret legacy public posts as approved. Keep operational and publication states independent.

The working tree already contains extensive uncommitted implementation and concurrent edits. They will be preserved. The prior verification recorded 998 passing unit/integration tests, focused publication/browser passes, 16 Phase 2 browser failures, 26 broader browser failures and one unchanged deferred severity failure. Those counts are historical context, not results of this task.
