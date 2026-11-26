(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.ReportMutations = api.create({ request: (...args) => root.apiRequest(...args), session: () => root.getSession(),
            changed: detail => root.dispatchEvent(new CustomEvent('reports:mutation', { detail })) });
        root.addEventListener('session:changed', () => root.ReportMutations.clear());
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    function create({ request, session, changed = () => {} }) {
        const pending = new Map();
        let revision = 0;
        const context = () => { const user = session(); return JSON.stringify([user?.id, user?.role, user?.barangay, user?.apiToken]); };
        function update(id, status, note = null, action = null) {
            if (!/^[1-9]\d*$/.test(String(id))) return Promise.reject(new Error('Invalid report identifier.'));
            const actor = context();
            const key = `${actor}:${id}`;
            if (pending.has(key)) return pending.get(key).promise;
            const controller = new AbortController();
            const item = { id: String(id), controller, promise: null };
            revision++;
            let body = note ? { status, note } : { status };
            if (action) {
                body = new FormData();
                body.append('status', status);
                body.append('note', note || '');
                body.append('requestKey', action.requestKey);
                for (const file of action.files || []) body.append('images', file);
            }
            const promise = Promise.resolve().then(() => request(`/api/reports/${id}/status`, {
                method: 'PATCH', signal: controller.signal, body
            })).then(report => {
                if (actor !== context() || controller.signal.aborted) throw new DOMException('Report session changed.', 'AbortError');
                return report;
            }).finally(() => {
                if (pending.get(key) === item) pending.delete(key);
                revision++;
            });
            item.promise = promise;
            pending.set(key, item);
            changed({ phase: 'started', id: String(id) });
            promise.then(report => { if (actor === context()) changed({ phase: 'saved', id: String(id), report }); },
                error => { if (actor === context()) changed({ phase: 'failed', id: String(id), error }); });
            return promise;
        }
        return { update, revision: () => revision, pending: id => [...pending.values()].some(item => id === undefined || item.id === String(id)),
            clear() { revision++; pending.forEach(item => item.controller.abort()); pending.clear(); } };
    }
    return { create };
});
