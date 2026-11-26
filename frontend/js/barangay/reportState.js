(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BarangayReportState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    function create({ query, load, session, mutations, changed, persist = () => {} }) {
        let state = { query: { ...query }, data: null, status: 'idle', error: '' };
        let generation = 0, controller = null, pending = null, disposed = false;
        const fingerprint = () => { const user = session(); return JSON.stringify([user?.id, user?.role, user?.barangay, user?.apiToken]); };
        const actor = fingerprint();
        const snapshot = () => ({ ...state, query: { ...state.query } });
        function publish() { changed(snapshot()); }
        function cancel() { generation++; controller?.abort(); controller = null; pending = null; }
        function refresh() {
            if (disposed) return Promise.resolve();
            if (actor !== fingerprint()) {
                cancel();
                state = { ...state, data: null, status: 'error', error: 'Your session changed. Sign in again.' };
                publish();
                return Promise.resolve();
            }
            if (mutations.pending()) return Promise.resolve();
            if (pending) return pending;
            const version = ++generation, mutation = mutations.revision();
            controller = new AbortController();
            const signal = controller.signal;
            state = { ...state, status: 'loading', error: '' }; publish();
            const current = () => !disposed && version === generation && actor === fingerprint() && mutation === mutations.revision();
            const request = Promise.resolve().then(() => load(state.query, signal)).then(data => {
                if (!current()) return;
                state = { ...state, data, status: 'ready', error: '', query: { ...state.query, page: data.pagination.page } };
                persist(state.query); publish();
            }).catch(error => {
                if (!current() || signal.aborted) return;
                state = { ...state, data: [401, 403].includes(error.status) ? null : state.data, status: 'error', error: error.message || 'Reports unavailable.' }; publish();
            }).finally(() => { if (pending === request) pending = null; });
            pending = request;
            return request;
        }
        return { snapshot, refresh, cancel,
            change(values) { cancel(); state = { ...state, query: { ...state.query, ...values }, error: '' }; persist(state.query); return refresh(); },
            pendingChanged() { cancel(); publish(); },
            destroy() { disposed = true; cancel(); state = { ...state, data: null, status: 'idle', error: '' }; publish(); } };
    }
    return { create };
});
