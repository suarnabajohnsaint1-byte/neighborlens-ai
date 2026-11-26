(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReportEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const records = new Map();
    let observer = null;
    const fingerprint = () => {
        const user = root.getSession?.();
        return JSON.stringify([user?.id, user?.role, user?.barangay, user?.apiToken]);
    };

    function normalize(value) {
        try {
            const url = new URL(value, root.neighborLensApiUrl('/'));
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch { return null; }
    }

    async function request(record, url, reader = 'blob') {
        const controller = new AbortController();
        record.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), root.NEIGHBORLENS_REQUEST_TIMEOUT_MS || 20000);
        try {
            const response = await root.fetch(url, { signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${root.getSession?.()?.apiToken || ''}` } });
            if (response.status === 401) root.handleSessionExpired?.();
            if (!response.ok) throw new Error('Evidence unavailable.');
            return await response[reader]();
        } finally { clearTimeout(timer); record.controllers.delete(controller); }
    }

    function getMediaContainer(image) {
        return image.closest?.('.cf-single-photo, .cf-carousel-slide, .mr-photo, .rm-thumbnail, .admin-report-thumbnail, .rd-action-photo, .rd-photo-item, .rm-print-photo-frame, .citizen-preview-frame') || image.parentElement;
    }

    function release(image, sensitive = false) {
        const record = records.get(image);
        if (!record) return;
        record.alive = false;
        record.controllers.forEach(controller => controller.abort());
        image.removeEventListener('error', record.error);
        image.removeEventListener('load', record.loaded);
        if (record.objectUrl) root.URL.revokeObjectURL(record.objectUrl);
        image.removeAttribute('src');
        if (sensitive) image.removeAttribute('data-evidence-url');
        record.placeholder?.remove();
        const container = getMediaContainer(image);
        container?.classList?.remove('nl-image-loading', 'nl-image-loaded', 'nl-refreshing');
        image.classList?.remove('nl-img-loading', 'nl-img-loaded');
        records.delete(image);
    }

    function hydrate(container = root.document) {
        if (!container?.querySelectorAll) return;
        for (const image of container.querySelectorAll('img[data-evidence-url]:not([data-evidence-deferred])')) {
            if (records.has(image)) continue;
            const url = normalize(image.dataset.evidenceUrl);
            const containerEl = getMediaContainer(image);
            const record = { alive: true, context: fingerprint(), controllers: new Set(), renewed: false, objectUrl: null, placeholder: null, container: containerEl };
            const current = () => record.alive && image.isConnected && record.context === fingerprint();
            if (image.complete && image.naturalWidth > 0) {
                containerEl?.classList?.remove('nl-image-loading', 'nl-refreshing');
                containerEl?.classList?.add('nl-image-loaded');
                image.classList?.remove('nl-img-loading');
                image.classList?.add('nl-img-loaded');
            } else {
                containerEl?.classList?.remove('nl-image-loaded');
                containerEl?.classList?.add('nl-image-loading');
                image.classList?.remove('nl-img-loaded');
                image.classList?.add('nl-img-loading');
            }
            function unavailable() {
                if (!record.alive) return;
                image.hidden = true;
                containerEl?.classList?.remove('nl-image-loading', 'nl-refreshing');
                image.classList?.remove('nl-img-loading');
                image.closest('.rm-thumbnail, .admin-report-thumbnail')?.setAttribute('aria-label', 'Evidence photo unavailable');
                if (!record.placeholder) {
                    record.placeholder = image.ownerDocument.createElement('span');
                    record.placeholder.className = 'evidence-unavailable';
                    record.placeholder.textContent = 'Photo unavailable';
                    record.placeholder.setAttribute('role', 'status');
                    image.after(record.placeholder);
                }
                record.onSettled?.();
            }
            async function load(source) {
                if (!current() || !source) return unavailable();
                const parsed = new URL(source);
                const api = new URL(root.neighborLensApiUrl('/'));
                try {
                    if (parsed.origin === api.origin && (/^\/api\/reports\/[1-9]\d*\/images\/(?:[1-9]\d*|legacy-[12]|action-[1-9]\d*)$/.test(parsed.pathname)
                        || /^\/api\/community\/posts\/[1-9]\d*\/media\/[1-9]\d*$/.test(parsed.pathname)
                        || /^\/api\/admin\/community-publications\/[1-9]\d*\/media\/[1-3]$/.test(parsed.pathname))) {
                        record.private = true;
                        const blob = await request(record, source);
                        if (!current()) return;
                        if (record.objectUrl) root.URL.revokeObjectURL(record.objectUrl);
                        record.objectUrl = root.URL.createObjectURL(blob);
                        image.src = record.objectUrl;
                    } else image.src = source;
                } catch { unavailable(); }
            }
            record.loaded = () => {
                if (!current()) { release(image, true); return; }
                record.placeholder?.remove(); record.placeholder = null; image.hidden = false;
                containerEl?.classList?.remove('nl-image-loading', 'nl-refreshing');
                containerEl?.classList?.add('nl-image-loaded');
                image.classList?.remove('nl-img-loading');
                image.classList?.add('nl-img-loaded');
                record.onSettled?.();
            };
            record.error = async () => {
                if (!current() || record.private || record.renewed || !/^[1-9]\d*$/.test(image.dataset.evidenceReport || '')) return unavailable();
                record.renewed = true;
                try {
                    const report = await request(record, root.neighborLensApiUrl(`/api/reports/${image.dataset.evidenceReport}`), 'json');
                    const photo = report.images?.find(item => Number(item.imageOrder) === Number(image.dataset.evidenceOrder));
                    const replacement = normalize(photo?.imagePath);
                    if (!current() || !replacement || replacement === url) return unavailable();
                    await load(replacement);
                } catch { unavailable(); }
            };
            image.addEventListener('error', record.error);
            image.addEventListener('load', record.loaded);
            record.unavailable = unavailable;
            records.set(image, record);
            load(url);
        }
        for (const image of records.keys()) if (!image.isConnected) release(image);
    }

    async function ready(container, signal) {
        const images = [...container.querySelectorAll('img[data-evidence-deferred]')];
        async function load(image) {
            if (signal?.aborted) return;
            image.removeAttribute('data-evidence-deferred');
            hydrate(image.parentElement);
            const record = records.get(image);
            if (!record || record.placeholder || image.complete && image.naturalWidth) return;
            await new Promise(resolve => {
                const finish = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', finish);
                    record.onSettled = null;
                    resolve();
                };
                const timer = setTimeout(() => {
                    record.controllers.forEach(controller => controller.abort());
                    image.removeAttribute('src');
                    record.unavailable();
                }, root.NEIGHBORLENS_REQUEST_TIMEOUT_MS || 20000);
                record.onSettled = finish;
                signal?.addEventListener('abort', finish, { once: true });
            });
        }
        for (let index = 0; index < images.length && !signal?.aborted; index += 8) {
            await Promise.all(images.slice(index, index + 8).map(load));
        }
    }

    function clear(sensitive = false) { for (const image of records.keys()) release(image, sensitive); }
    function sessionChanged() { for (const [image, record] of records) if (record.context !== fingerprint()) release(image, true); }
    function start() {
        if (!root.document || observer) return;
        observer = new root.MutationObserver(() => hydrate());
        observer.observe(root.document.body, { childList: true, subtree: true });
        hydrate();
    }
    if (root.document) {
        root.document.addEventListener('DOMContentLoaded', start);
        root.addEventListener('pagehide', () => { observer?.disconnect(); observer = null; clear(); });
        root.addEventListener('pageshow', event => { if (event.persisted) start(); });
        root.addEventListener('session:changed', sessionChanged);
        root.addEventListener('storage', sessionChanged);
        root.addEventListener('focus', sessionChanged);
    }
    return { hydrate, ready, release, clear, normalize, renew: image => records.get(image)?.error() };
});
