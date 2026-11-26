(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BarangayViewStore = api.create(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const defaults = Object.freeze({ status: 'all', search: '', category: 'all', classification: 'all', priority: 'all', dateFrom: '', dateTo: '', sort: 'newest', page: 1, pageSize: 3 });
    function create(environment) {
        let initialKey = null;
        function key() {
            const user = environment.getSession?.();
            const target = user?.role === 'barangay' ? `neighborlens:barangay-view:v1:${user.id}:${user.barangay}` : null;
            if (target) initialKey = target;
            return target;
        }
        function read() {
            let saved = {};
            try { saved = JSON.parse(environment.sessionStorage.getItem(key()) || '{}') || {}; } catch {}
            const query = { ...defaults };
            for (const field of Object.keys(query)) {
                const value = saved.query?.[field];
                if (typeof query[field] === 'number') query[field] = Number.isSafeInteger(value) && value > 0 && value <= (field === 'page' ? 1000000 : 100) ? value : query[field];
                else if (typeof value === 'string' && value.length <= 200) query[field] = value;
            }
            const route = environment.location.hash.slice(1);
            if (['reports', 'pending', 'ongoing', 'resolved', 'rejected'].includes(route)) query.status = route === 'reports' ? 'all' : route;
            return { query, analyticsDays: [7, 30, 90].includes(saved.analyticsDays) ? saved.analyticsDays : 30 };
        }
        function save(value) { try { const target = key(); if (target) environment.sessionStorage.setItem(target, JSON.stringify({ ...read(), ...value })); } catch {} }
        function navigate(status) {
            const hash = `#${status === 'all' ? 'reports' : status}`;
            if (environment.location.hash !== hash) environment.history.pushState(null, '', hash);
        }
        return { read, save, navigate, clear() { try { if (initialKey) environment.sessionStorage.removeItem(initialKey); } catch {} } };
    }
    return { create, defaults };
});
