(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.AdminViewStore = api.create(root);
        if (root.location.pathname.endsWith('/admin.html')) root.document.documentElement.dataset.adminSection = root.AdminViewStore.read().section;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const routes = Object.freeze({ accounts: 'accountsSection', reports: 'reportsSection', 'gis-map': 'gisMapSection', logs: 'logsSection', analytics: 'analyticsSection' });
    const validSection = section => Object.values(routes).includes(section);
    const page = value => Number.isInteger(value) && value > 0 && value <= 10000 ? value : 1;
    const query = value => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item.length <= 200 || Number.isInteger(item))) : {};

    function create(environment) {
        function key() {
            try {
                const user = JSON.parse(environment.sessionStorage.getItem('up_session'));
                return user?.role === 'admin' && user.id != null ? `neighborlens:admin-view:v1:${user.id}` : null;
            } catch { return null; }
        }

        function sectionFromHash() {
            const route = String(environment.location.hash || '').slice(1).split('?')[0];
            return route === 'overview' ? routes.analytics : Object.hasOwn(routes, route) ? routes[route] : null;
        }

        function read() {
            let saved = {};
            try { saved = JSON.parse(environment.sessionStorage.getItem(key()) || '{}') || {}; } catch {}
            return {
                section: sectionFromHash() || (validSection(saved.section) ? saved.section : 'analyticsSection'),
                reportsPage: page(saved.reportsPage), reportsPageSize: [3, 5, 10, 20, 50].includes(saved.reportsPageSize) ? saved.reportsPageSize : 5, reportFilters: { ...query(saved.reportFilters), ...(sectionFromHash() === 'reportsSection' ? { publication: new URLSearchParams(String(environment.location.hash).split('?')[1] || '').get('view') === 'community-review' ? 'pending' : 'all' } : {}) },
                accountTab: saved.accountTab === 'admin' ? 'admin' : 'barangay',
                accountPage: page(saved.accountPage), accountQuery: query(saved.accountQuery),
                analyticsDays: [7, 30, 90].includes(saved.analyticsDays) ? saved.analyticsDays : 30
            };
        }

        function save(state) {
            try { const target = key(); if (target) environment.sessionStorage.setItem(target, JSON.stringify({ ...read(), ...state })); } catch {}
        }

        function navigate(section, replace = false, publication = read().reportFilters.publication) {
            const route = Object.keys(routes).find(route => routes[route] === section);
            const suffix = section === 'reportsSection' && publication === 'pending' ? '?view=community-review' : '';
            if (!route || environment.location.hash === `#${route}${suffix}`) return;
            environment.history[replace ? 'replaceState' : 'pushState'](null, '', `#${route}${suffix}`);
        }

        return { read, save, navigate, sectionFromHash, validSection };
    }

    return { create };
});
