(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/reportPresentation'), require('../shared/portalComponents'), require('../shared/reportCard'));
    else root.CitizenReports = factory(root.ReportPresentation, root.PortalComponents, root.ReportCard);
})(typeof self !== 'undefined' ? self : this, function (presentation, components, cards) {
    'use strict';

    const pageSize = 6;
    let controller = null;

    const summary = cards.summary;

    const timestamp = presentation.timestamp;

    function selectReports(reports, options = {}, session) {
        const query = String(options.query || '').trim().toLocaleLowerCase();
        const status = Object.hasOwn(presentation.statuses, options.status) ? options.status : '';
        const oldest = options.sort === 'oldest';
        const owned = session?.role === 'citizen' && Array.isArray(reports) ? reports.filter(report => {
            if (!report || typeof report !== 'object') return false;
            const owner = session.id != null && report.submittedById != null && String(report.submittedById) === String(session.id);
            return owner || Boolean(session.username && report.submittedBy === session.username);
        }) : [];
        const filtered = owned.filter(report => {
            if (status && report.status !== status) return false;
            if (!query) return true;
            const item = summary(report);
            return [report.id, report.backendId, report.description, report.location, report.barangay, report.citizenCategory,
                report.aiCategory, item.title, item.detail, item.correction].some(value => String(value ?? '').toLocaleLowerCase().includes(query));
        }).sort((left, right) => {
            const a = timestamp(left.createdAt);
            const b = timestamp(right.createdAt);
            if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
            const tie = String(left.backendId ?? left.id).localeCompare(String(right.backendId ?? right.id), undefined, { numeric: true });
            return (oldest ? a - b : b - a) || (oldest ? tie : -tie);
        });
        const size = [3, 5, 6, 10, 20].includes(Number(options.pageSize)) ? Number(options.pageSize) : pageSize;
        const pageCount = Math.ceil(filtered.length / size);
        const requested = Number.isSafeInteger(Number(options.page)) ? Number(options.page) : 1;
        const page = Math.max(1, Math.min(requested, pageCount || 1));
        const offset = (page - 1) * size;
        return { items: filtered.slice(offset, offset + size), total: filtered.length, page, pageCount,
            from: filtered.length ? offset + 1 : 0, to: Math.min(offset + size, filtered.length) };
    }

    function mount(root) {
        const list = root.querySelector('#myReports');
        const search = root.querySelector('#myReportsSearch');
        const filter = root.querySelector('#myReportsStatus');
        const sort = root.querySelector('#myReportsSort');
        const pagination = root.querySelector('#myReportsPagination');
        const count = root.querySelector('#myReportsCount');
        const limit = root.querySelector('#myReportsPageSize');
        const escape = presentation.escape;
        let page = 1;
        let context = null;

        function rowMarkup(report) {
            return cards.render(report, { detailsUrl: window.reportDetailsUrl(report), apiBase: window.neighborLensApiUrl('/') });
        }

        function render() {
            const session = window.getSession();
            const nextContext = session?.role === 'citizen' && session.apiToken ? JSON.stringify([session.id, session.username, session.apiToken]) : null;
            if (context !== nextContext) {
                context = nextContext;
                search.value = '';
                filter.value = '';
                sort.value = 'newest';
                page = 1;
            }
            const result = selectReports(context ? window.getAllReports() : [], { query: search.value, status: filter.value, sort: sort.value, page, pageSize: limit.value }, session);
            page = result.page;
            const load = window.getReportLoadState?.() || { status: 'ready' };
            const feedback = load.status === 'error' ? `<p class="mr-empty" role="alert">${escape(load.message)} <button type="button" class="btn-logout" data-retry-reports>Retry</button> <a href="login.html">Sign in</a></p>` : '';
            components.render(list, result.items.length ? feedback + result.items.map(rowMarkup).join('')
                : feedback || `<p class="mr-empty" role="status">${!context ? 'Sign in to view your reports.' : load.status === 'loading' || load.status === 'idle' ? 'Loading your reports...' : search.value.trim() || filter.value ? 'No reports match your search or status filter.' : 'No reports submitted yet.'}</p>`);
            window.ReportEvidence?.hydrate(list);
            count.textContent = result.total ? `Showing ${result.from}-${result.to} of ${result.total} reports` : load.status === 'error' ? 'Report data unavailable' : load.status === 'ready' ? 'Showing 0 reports' : '';
            pagination.hidden = !context || load.status !== 'ready';
            pagination.querySelector('.portal-page-number').textContent = `Page ${page} of ${result.pageCount || 1}`;
            pagination.querySelector('[data-page="-1"]').disabled = page <= 1;
            pagination.querySelector('[data-page="1"]').disabled = page >= result.pageCount;
        }

        for (const [element, event] of [[search, 'input'], [filter, 'change'], [sort, 'change'], [limit, 'change']]) {
            element.addEventListener(event, () => { page = 1; render(); });
        }
        pagination.addEventListener('click', event => {
            const button = event.target.closest('button[data-page]');
            if (!button || button.disabled) return;
            page += Number(button.dataset.page);
            render();
        });
        list.addEventListener('click', event => { if (event.target.closest('[data-retry-reports]')) window.syncReportsFromBackend(); });
        window.addEventListener('pagehide', () => { components.invalidate(list); list.replaceChildren(); count.textContent = ''; });
        window.addEventListener('pageshow', event => { if (event.persisted) render(); });
        return { render };
    }

    function refresh() {
        const root = document.getElementById('myReportsSection');
        if (!root) return;
        if (!controller) controller = mount(root);
        controller.render();
    }

    return { refresh, selectReports, summary, pageSize };
});
