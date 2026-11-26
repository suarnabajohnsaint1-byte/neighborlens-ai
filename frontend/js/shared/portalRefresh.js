(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PortalRefresh = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    function create({ window, document, refresh, cancel = () => {}, interval = 10000 }) {
        let timer = null, running = null, stopped = false, active = false;
        function clear() { window.clearTimeout(timer); timer = null; }
        function tick() {
            if (stopped || !active || document.visibilityState === 'hidden') return Promise.resolve();
            if (running) return running;
            clear();
            running = Promise.resolve().then(refresh).catch(() => {}).finally(() => {
                running = null;
                if (!stopped && active && document.visibilityState !== 'hidden') timer = window.setTimeout(tick, interval);
            });
            return running;
        }
        function visibility() { if (document.visibilityState === 'hidden') { clear(); cancel(); } else tick(); }
        function pause() { active = false; clear(); cancel(); }
        function resume() { if (!stopped && !active) { active = true; tick(); } }
        window.addEventListener('focus', tick);
        window.addEventListener('pagehide', pause);
        window.addEventListener('pageshow', resume);
        document.addEventListener('visibilitychange', visibility);
        return { start: resume, refresh: tick, pause,
            destroy() { stopped = true; pause(); window.removeEventListener('focus', tick); window.removeEventListener('pagehide', pause); window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', visibility); } };
    }
    return { create };
});
