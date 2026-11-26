(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReportDialog = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const instances = new WeakMap();
    function create({ dialog, client, view, reviewView, api, session, fetchImpl, mutate, onReviewed = () => {}, publication = false }) {
        if (instances.has(dialog)) return instances.get(dialog);
        const document = dialog.ownerDocument;
        const title = dialog.querySelector('[data-report-dialog-title]');
        const state = dialog.querySelector('[data-report-dialog-state]');
        const content = dialog.querySelector('[data-report-dialog-content]');
        const closeButton = dialog.querySelector('[data-report-dialog-close]');
        let mounted = null;
        let controller = null;
        let opener = null;
        let currentId = null;
        let revision = 0;
        let previousOverflow = '';
        let active = false;
        let scrollPosition = 0;
        let stamp = null;
        let reviewing = false;
        let actor = null;
        let loading = null;
        let activeView = view;
        const fingerprint = () => { const user = session(); return JSON.stringify([user?.id, user?.role, user?.barangay, user?.apiToken]); };

        function reset() {
            revision += 1;
            controller?.abort();
            controller = null;
            loading = null;
            mounted?.destroy();
            mounted = null;
            content.replaceChildren();
        }

        function show(text) {
            state.textContent = text;
            state.hidden = !text;
        }

        async function render(id, quiet = false) {
            if (quiet && loading) return loading;
            if (!quiet) reset();
            else { revision++; controller?.abort(); }
            const version = revision;
            controller = new AbortController();
            if (!quiet) show('Loading report details...');
            title.textContent = activeView === reviewView ? `Review Community Post #${id}` : publication ? 'Published report' : `Report #${id}`;
            try {
                loading = client.load(id, { api, session: session(), signal: controller.signal, fetchImpl });
                const data = await loading;
                if (version !== revision || !active) return;
                if (actor !== fingerprint()) { close(); return; }
                const nextStamp = activeView.signature(data);
                if (quiet && stamp === nextStamp) return;
                const previousState = mounted?.state?.();
                mounted?.destroy();
                mounted = activeView.mount(content, data, {
                    apiBase: api('/'),
                    role: session()?.role,
                    state: previousState,
                    idPrefix: 'dialogReport',
                    showTitle: false,
                    publication,
                    onReview: review
                });
                root.ReportEvidence?.hydrate(content);
                stamp = nextStamp;
                show('');
            } catch (error) {
                if (version !== revision || error.name === 'AbortError') return;
                if ([401, 403, 404].includes(error.status)) reset();
                show(error.reportDetails ? error.message : 'Report details could not be loaded. Try again.');
            } finally { if (version === revision) loading = null; }
        }

        async function review(status, note, action) {
            revision++;
            controller?.abort();
            loading = null;
            const version = revision;
            reviewing = true;
            try {
                await mutate(currentId, status, note, action);
                if (version !== revision || actor !== fingerprint()) return;
                await onReviewed(currentId);
                await render(currentId, true);
            } catch (error) {
                if ([401, 403, 404].includes(error.status)) { reset(); show(client.accessMessage(error.status)); return; }
                throw error;
            } finally { reviewing = false; }
        }

        function changed(event) {
            if (!active || reviewing) return;
            if (actor !== fingerprint()) { close(); return; }
            if (event.type === 'publication:changed') {
                if (event.detail?.reportChanged && String(event.detail.reportId) === currentId) render(currentId, true);
                return;
            }
            if (event.type === 'reports:mutation') {
                if (event.detail.phase === 'started' && event.detail.id === currentId) {
                    revision++;
                    controller?.abort();
                    loading = null;
                }
                if (event.detail.phase === 'saved' && event.detail.id === currentId) render(currentId, true);
                return;
            }
            const cached = root.getAllReports?.().find(report => String(report.backendId) === currentId);
            if (cached && mounted?.report.status !== cached.status) render(currentId, true);
        }

        function open(id, trigger = null, { review = false } = {}) {
            if (!client.validId(id)) return false;
            if (review && (!reviewView || session()?.role !== 'admin')) return false;
            activeView = review ? reviewView : view;
            root.dispatchEvent?.(new root.CustomEvent('report-dialog:opening'));
            currentId = String(id);
            actor = fingerprint();
            stamp = null;
            if (!active) {
                active = true;
                opener = trigger || document.activeElement;
                scrollPosition = document.defaultView?.scrollY || 0;
                previousOverflow = document.body.style.overflow;
                document.body.style.overflow = 'hidden';
            }
            if (!dialog.open) dialog.showModal();
            closeButton.focus();
            render(currentId);
            return true;
        }

        function close() {
            if (dialog.open) dialog.close();
            closed();
        }

        function closed() {
            if (!active) return;
            active = false;
            const target = opener?.isConnected ? opener : document.querySelector?.(`[data-report-id="${currentId}"][data-action="view"], [data-report-id="${currentId}"] [data-action="view"], a[href="report-details.html?id=${currentId}"]`) || document.getElementById?.('reportSearch');
            reset();
            currentId = null;
            show('');
            document.body.style.overflow = previousOverflow;
            document.defaultView?.scrollTo?.(0, scrollPosition);
            target?.focus({ preventScroll: true });
            opener = null;
        }

        function cancel(event) {
            event.preventDefault();
            if (mounted?.isMapExpanded()) mounted.collapseMap();
            else close();
        }

        function backdrop(event) {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }

        closeButton.addEventListener('click', close);
        dialog.addEventListener('cancel', cancel);
        dialog.addEventListener('close', closed);
        dialog.addEventListener('click', backdrop);

        root.addEventListener?.('reports_updated', changed);
        root.addEventListener?.('reports:mutation', changed);
        root.addEventListener?.('publication:changed', changed);
        root.addEventListener?.('session:changed', close);
        const instance = {
            open,
            close,
            isOpen: () => active,
            current: () => currentId,
            refresh: () => active && !reviewing ? render(currentId, true) : Promise.resolve(),
            destroy() {
                close();
                reset();
                closeButton.removeEventListener('click', close);
                dialog.removeEventListener('cancel', cancel);
                dialog.removeEventListener('close', closed);
                dialog.removeEventListener('click', backdrop);
                root.removeEventListener?.('reports_updated', changed);
                root.removeEventListener?.('reports:mutation', changed);
                root.removeEventListener?.('publication:changed', changed);
                root.removeEventListener?.('session:changed', close);
                instances.delete(dialog);
            }
        };
        instances.set(dialog, instance);
        return instance;
    }

    function reportIdFromLink(link) {
        if (!link?.getAttribute) return null;
        const href = link.getAttribute('href') || '';
        if (!/^report-details\.html\?/.test(href)) return null;
        return new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('id');
    }

    return { create, reportIdFromLink };
});
