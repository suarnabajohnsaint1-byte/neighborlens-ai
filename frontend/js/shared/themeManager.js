(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.PortalTheme = api.create(root);
        if (root.document.documentElement.hasAttribute('data-theme-enabled')) root.PortalTheme.initialize();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const storageKey = 'neighborlens:theme-preference:v1';
    const defaultPreference = 'light';
    const valid = value => ['auto', 'light', 'dark'].includes(value);

    function create(environment) {
        let preference = defaultPreference;
        let effective = null;
        let initialized = false;
        let query = null;
        let published = '';
        let volatilePreference = false;
        const subscribers = new Set();

        function readPreference() {
            try {
                const stored = environment.localStorage.getItem(storageKey);
                return { available: true, preference: valid(stored) ? stored : defaultPreference };
            } catch {
                return { available: false };
            }
        }

        function apply() {
            effective = preference === 'auto' ? (query ? query.matches ? 'dark' : 'light' : defaultPreference) : preference;
            const element = environment.document.documentElement;
            if (element.dataset.theme !== effective) element.dataset.theme = effective;
            const state = `${preference}:${effective}`;
            if (state === published) return;
            published = state;
            for (const callback of subscribers) callback({ preference, effective });
        }

        function refresh() {
            const stored = readPreference();
            if (stored.available && !volatilePreference) preference = stored.preference;
            apply();
        }

        function visibility() {
            if (environment.document.visibilityState === 'visible') refresh();
        }

        function storage(event) {
            if (event.key !== storageKey && event.key !== null) return;
            try {
                if (event.storageArea && event.storageArea !== environment.localStorage) return;
            } catch { return; }
            preference = valid(event.newValue) ? event.newValue : defaultPreference;
            volatilePreference = false;
            apply();
        }

        function initialize() {
            if (initialized) return;
            initialized = true;
            try { query = environment.matchMedia('(prefers-color-scheme: dark)'); } catch { query = null; }
            query?.addEventListener('change', apply);
            environment.addEventListener('storage', storage);
            environment.addEventListener('pageshow', refresh);
            environment.document.addEventListener('visibilitychange', visibility);
            refresh();
        }

        function setPreference(value) {
            if (!valid(value)) return false;
            initialize();
            if (preference === value) return true;
            preference = value;
            try {
                environment.localStorage.setItem(storageKey, value);
                volatilePreference = false;
            } catch { volatilePreference = true; }
            apply();
            return true;
        }

        return {
            initialize,
            setPreference,
            getPreference: () => preference,
            getEffectiveTheme: () => effective,
            subscribe(callback) {
                subscribers.add(callback);
                return () => subscribers.delete(callback);
            },
            destroy() {
                query?.removeEventListener('change', apply);
                environment.removeEventListener('storage', storage);
                environment.removeEventListener('pageshow', refresh);
                environment.document.removeEventListener('visibilitychange', visibility);
                subscribers.clear();
                initialized = false;
                effective = null;
                published = '';
            }
        };
    }

    return { create, storageKey };
});
