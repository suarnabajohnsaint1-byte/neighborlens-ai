(function (root) {
    'use strict';
    if (root.BarangayPortal) return;
    let instance = null;

    function initialize() {
        if (instance || root.NEIGHBORLENS_ACCESS_GRANTED === false || root.getSession()?.role !== 'barangay') return;
        const document = root.document;
        root.PortalComponents.mountReportSummary(document.querySelector('[data-report-summary="barangay"]'));
        const management = root.ReportManagement.mount({ section: document.querySelector('.barangay-reports'), role: 'barangay' });
        const sidebarElement = document.getElementById('barangaySidebar');
        const store = root.BarangayViewStore;
        const mutations = root.ReportMutations;
        const view = root.BarangayReportListView.create({ document,
            vocabulary: root.ReportVocabulary, components: root.PortalComponents, apiBase: root.neighborLensApiUrl('/'), onOpen: id => root.location.assign(`report-details.html?id=${encodeURIComponent(id)}`) });
        const listeners = [];
        let summary = null;
        document.getElementById('brgyName').textContent = root.getSession().barangay;
        const dialog = root.ReportDialog.create({
            dialog: document.getElementById('reportModal'), client: root.ReportDetailsApi, view: root.ReportDetailsView,
            api: path => root.neighborLensApiUrl(path), session: () => root.getSession(),
            mutate: (...args) => mutations.update(...args)
        });
        const state = root.BarangayReportState.create({
            query: store.read().query, session: () => root.getSession(), mutations, load: root.BarangayReportsApi.load,
            persist: query => store.save({ query }),
            changed(value) {
                view.render(value);
                if (value.status !== 'ready') return;
                const next = JSON.stringify(value.data.stats);
                if (summary !== null && summary !== next) root.dispatchEvent(new CustomEvent('barangay:reports-changed'));
                summary = next;
            }
        });
        root.ReportExport?.bind(document.getElementById('barangayExportReports'), () => ({ ...state.snapshot().query }));
        const split = root.ReportManagement.split({ section: document.querySelector('.barangay-reports'), list: document.getElementById('reportsBody'), refresh: () => state.refresh() });
        const refresher = root.PortalRefresh.create({ window: root, document, cancel: state.cancel,
            refresh: async () => { await state.refresh(); await dialog.refresh(); } });
        function select(values, resetPage = true) {
            view.feedback('');
            if (values.status) store.navigate(values.status);
            return state.change({ ...(resetPage ? { page: 1 } : {}), ...values });
        }
        function clear() {
            const values = { status: 'all', search: '', category: 'all', classification: 'all', priority: 'all', dateFrom: '', dateTo: '', sort: 'newest' };
            return select(values);
        }
        const sheets = root.PortalComponents.sheets(document, { onClear: { barangayFilters: clear } });
        function listen(element, event, handler) {
            element.addEventListener(event, handler);
            listeners.push(() => element.removeEventListener(event, handler));
        }
        management.bind({ query: values => select(values), status: status => select({ status }), clear,
            page: delta => select({ page: state.snapshot().query.page + delta }, false) });
        listen(document.getElementById('retryReports'), 'click', () => state.refresh());
        listen(sidebarElement, 'portal-sidebar:navigate', event => {
            if (event.detail.status && event.detail.status !== state.snapshot().query.status) select({ status: event.detail.status });
        });
        listen(root, 'reports:mutation', event => {
            state.pendingChanged();
            if (event.detail.phase === 'failed') view.feedback(event.detail.error.message || 'The change could not be saved.');
            if (event.detail.phase === 'saved') view.feedback('Status saved.');
            if (event.detail.phase !== 'started' && document.visibilityState !== 'hidden') state.refresh();
        });
        function restoreRoute() {
            const query = store.read().query;
            if (JSON.stringify(query) !== JSON.stringify(state.snapshot().query)) state.change(query);
        }
        listen(root, 'popstate', restoreRoute);
        listen(root, 'hashchange', restoreRoute);
        function destroy(clearStorage = false) {
            if (!instance) return;
            refresher.destroy(); dialog.destroy(); sheets.destroy(); split.destroy(); management.destroy();
            listeners.splice(0).forEach(remove => remove());
            state.destroy(); view.clear();
            if (clearStorage) store.clear();
            instance = null;
        }
        listen(root, 'session:changed', () => destroy(true));
        listen(root, 'pagehide', () => destroy());
        instance = { state, refresh: () => refresher.refresh(), openReport: id => root.location.assign(`report-details.html?id=${encodeURIComponent(id)}`), destroy };
        refresher.start();
    }
    root.BarangayPortal = { refresh: () => instance?.refresh(), snapshot: () => instance?.state.snapshot(), openReport: (id, trigger) => instance?.openReport(id, trigger), cancel: () => instance?.state.cancel() };
    root.addEventListener('DOMContentLoaded', initialize);
    root.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
})(window);
