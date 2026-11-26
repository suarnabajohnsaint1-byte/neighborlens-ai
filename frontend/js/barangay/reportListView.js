(function (root) {
    'use strict';
    function create({ document, vocabulary, components, apiBase, onOpen }) {
        const list = document.getElementById('reportsBody');
        const notice = document.getElementById('reportLoadFeedback');
        let lastQuery = '';
        const table = root.ReportManagement.createTable({ section: document.querySelector('.barangay-reports'), list,
            columns: root.ReportManagement.portalColumns.barangay, views: document.getElementById('barangayViewToggle'),
            storageKey: 'neighborlens_report_layout', apiBase, printPreview: '/api/reports/print-preview', onOpen });
        function render(state) {
            const { data, query, status } = state;
            list.setAttribute('aria-busy', String(status === 'loading'));
            notice.hidden = status !== 'error';
            notice.querySelector('span').textContent = status === 'error' ? `${state.error}${data ? ' Showing the last successful data.' : ''}` : '';
            for (const [name, id] of Object.entries({ total: 'statTotal', pending: 'statPending', ongoing: 'statOngoing', resolved: 'statResolved', major: 'statMajor', minor: 'statMinor' })) {
                document.getElementById(id).textContent = data ? (data.filteredStats || data.stats)[name] : status === 'error' ? 'Unavailable' : '...';
            }
            const queryKey = JSON.stringify(query);
            if (queryKey !== lastQuery) {
                document.querySelectorAll('[data-query]').forEach(control => { control.value = String(query[control.dataset.query] ?? ''); });
                lastQuery = queryKey;
            }
            document.querySelectorAll('[data-status-filter]').forEach(button => {
                const key = button.dataset.statusFilter;
                const label = key === 'all' ? 'All' : vocabulary.statuses[key];
                button.setAttribute('aria-pressed', String(key === query.status));
                button.textContent = data ? `${label} (${data.stats[key === 'all' ? 'total' : key]})` : label;
            });
            const count = document.getElementById('filterCount');
            count.textContent = status === 'loading' ? 'Updating reports...' : data ? `${data.pagination.total} reports` : status === 'error' ? 'Reports unavailable' : '';
            table.render({ reports: data?.reports || [], status, query });
            const pagination = data?.pagination || { page: 1, pages: 1, total: 0, pageSize: query.pageSize };
            components.pagination(document, 'reports', pagination, pagination.pageSize, 'reports');
            const clearBtn = document.getElementById('clearFilters');
            if (clearBtn && query) {
                const hasActiveFilters = query.status !== 'all' ||
                    Boolean(query.search?.trim()) ||
                    query.category !== 'all' ||
                    query.classification !== 'all' ||
                    query.priority !== 'all' ||
                    Boolean(query.dateFrom) ||
                    Boolean(query.dateTo) ||
                    query.sort !== 'newest';
                clearBtn.disabled = !hasActiveFilters;
            }
            const moreBadge = document.getElementById('moreFiltersCount');
            if (moreBadge && query) {
                const extraCount = ['classification', 'priority', 'category', 'dateFrom', 'dateTo'].filter(k => query[k] && query[k] !== 'all').length;
                moreBadge.hidden = extraCount === 0;
                moreBadge.textContent = String(extraCount);
            }
        }
        return { render, clear() { table.destroy(); },
            feedback(message) { const element = document.getElementById('statusFeedback'); element.hidden = !message; element.textContent = message || ''; } };
    }
    root.BarangayReportListView = { create };
})(window);
