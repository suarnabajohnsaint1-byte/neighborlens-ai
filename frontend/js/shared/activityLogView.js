(function (root) {
    function markup(logs, { describe, date }) {
        const escape = root.ReportPresentation.escape;
        return logs.length ? logs.map(row => `<div class="log-entry">[${escape(date(row.createdAt || row.created_at))}] ${escape(describe(row))}</div>`).join('') : '<p class="portal-empty-state">No activity matches these filters.</p>';
    }
    root.ActivityLogView = { markup };
})(window);
