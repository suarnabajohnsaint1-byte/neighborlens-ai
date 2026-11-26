(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PortalAnalyticsState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function create({ load, changed, days = 30 }) {
        let selected = days;
        let generation = 0;
        let abort = null;
        let pending = null;
        let queued = false;
        let disposed = false;
        let state = { status: 'idle', days: selected, data: null, error: null };

        function select(days = selected, refresh = false) {
            if (disposed || ![7, 30, 90].includes(days)) return Promise.resolve();
            if (pending && days === selected) { queued ||= refresh; return pending; }
            if (!refresh && days === selected && state.status === 'ready') return Promise.resolve(state.data);
            const previous = days === selected ? state.data : null;
            selected = days;
            queued = false;
            abort?.abort();
            abort = new AbortController();
            const signal = abort.signal;
            const run = ++generation;
            state = { status: 'loading', days, data: previous, error: null };
            changed(state);
            pending = Promise.resolve().then(() => load(days, signal)).then(data => {
                if (disposed || run !== generation) return;
                state = { status: 'ready', days, data, error: null };
                changed(state);
                return data;
            }).catch(error => {
                if (disposed || run !== generation) return;
                state = { status: 'error', days, data: [401, 403].includes(error.status) ? null : previous, error: error.message || 'Analytics could not be loaded.' };
                changed(state);
            }).finally(() => {
                if (disposed || run !== generation) return;
                pending = null;
                if (queued) { queued = false; select(selected, true); }
            });
            return pending;
        }

        return {
            select, refresh: () => select(selected, true), get: () => state,
            destroy() { disposed = true; generation += 1; abort?.abort(); pending = null; queued = false; }
        };
    }

    return { create };
});
