(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PortalCharts = api;
})(typeof window !== 'undefined' ? window : globalThis, function (environment) {
    'use strict';

    const instances = new WeakMap();
    let library = null;

    function load() {
        if (environment.echarts) return Promise.resolve(environment.echarts);
        if (library) return library;
        library = new Promise((resolve, reject) => {
            const script = environment.document.createElement('script');
            const timeout = environment.setTimeout(() => {
                script.remove();
                reject(new Error('The chart library took too long to load. Retry when connected.'));
            }, 20000);
            script.src = 'https://unpkg.com/echarts@6.1.0/dist/echarts.min.js';
            script.async = true;
            script.onload = () => { environment.clearTimeout(timeout); environment.echarts ? resolve(environment.echarts) : reject(new Error('Charts could not be initialized.')); };
            script.onerror = () => { environment.clearTimeout(timeout); script.remove(); reject(new Error('Charts could not be loaded. Check your connection and retry.')); };
            environment.document.head.append(script);
        }).catch(error => { library = null; throw error; });
        return library;
    }

    function palette(element, view) {
        const style = view.getComputedStyle(element);
        const token = name => style.getPropertyValue(name).trim();
        return { blue: token('--color-primary'), ongoing: token('--report-indicator-yellow'), resolved: token('--report-indicator-green'), text: token('--color-text-primary'),
            muted: token('--color-text-secondary'), border: token('--color-border'), surface: token('--color-surface'),
            track: token('--color-surface-raised'), font: style.fontFamily,
            category: icon => token(`--report-category-${icon}`) };
    }

    function mount(element, { engine, options, view = environment }) {
        if (instances.has(element)) return instances.get(element);
        let chart = null;
        let data = null;
        let frame = null;
        let disposed = false;
        const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
        function draw() {
            frame = null;
            if (disposed || !element.isConnected || !element.clientWidth || !element.clientHeight) return;
            if (!data) { chart?.clear(); return; }
            chart ||= engine.init(element, null, { renderer: 'canvas' });
            chart.resize();
            chart.setOption(options(data, { ...palette(element, view), motion: !motion.matches, width: element.clientWidth }), { notMerge: true });
        }
        function schedule() { if (frame === null && !disposed) frame = view.requestAnimationFrame(draw); }
        const observer = new view.ResizeObserver(schedule);
        observer.observe(element);
        const unsubscribe = view.PortalTheme?.subscribe(schedule);
        motion.addEventListener('change', schedule);
        const instance = {
            update(value) { data = value; schedule(); }, resize: schedule,
            destroy() {
                if (disposed) return;
                disposed = true;
                if (frame !== null) view.cancelAnimationFrame(frame);
                observer.disconnect(); unsubscribe?.(); motion.removeEventListener('change', schedule);
                chart?.dispose(); chart = null; instances.delete(element);
            }
        };
        instances.set(element, instance);
        return instance;
    }

    return { load, mount };
});
