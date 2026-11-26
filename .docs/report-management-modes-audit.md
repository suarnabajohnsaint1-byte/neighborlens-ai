# Report Management Modes Audit

The Admin Pending Posts action currently checks a publication checkbox and intersects the cached operational reports with publication IDs. The title, operational status tabs, generic table columns and View action remain unchanged. Publication membership is not requested as a filtered report dataset. The stored publication flag is also forwarded to Excel export even though export validation does not support it.

Admin uses a static table with client pagination and generic filter sheets. Barangay uses server-paginated authorized reports, ReportCard, BarangayReportState, ReportListView, PortalComponents pagination/sheets/view toggles and organized sort/date controls. The two toolbars duplicate layout and differ in view controls and status coverage. Existing IDs and controller bindings must be preserved during shared toolbar migration.

The existing shared ReportDialog and ReportDetailsView currently include publication moderation inside operational details. The new requirement separates these workflows. A selectable presentation inside the same dialog shell can reuse authorized report loading and CommunityPublication without creating a second report modal or API client.

Implementation will reuse existing report listing and export endpoints with an Admin-only pending-publication filter, existing publication state `pending_approval`, existing report cards and pagination, shared toolbar construction and shared dialog infrastructure. The prompt's `pending_review` is a UI description, not permission to rename persisted states. No schema migration is needed. Barangay authorization remains server-derived. Existing dirty worktree changes will be preserved.
