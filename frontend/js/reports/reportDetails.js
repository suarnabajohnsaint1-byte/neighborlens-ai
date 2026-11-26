(function () {
    'use strict';

    const details = window.ReportDetailsView;
    const client = window.ReportDetailsApi;
    const root = document.getElementById('reportDetails');
    const state = document.getElementById('reportState');
    const refresh = document.getElementById('refreshReport');
    const sidebar = document.getElementById('detailsSidebar');
    const sidebarView = window.PortalSidebar.get(sidebar);
    const id = new URLSearchParams(window.location.search).get('id');
    let revision = 0;
    let controller = null;
    let mounted = null;
    let sessionKey = null;
    let stamp = null;
    let reviewing = false;
    let pending = null;
    let refreshAgain = false;

    const api = path => window.neighborLensApiUrl(path);
    const fingerprint = () => {
        const session = getSession();
        return session?.apiToken && ['citizen', 'admin', 'barangay'].includes(session.role)
            ? JSON.stringify([session.id, session.role, session.barangay, session.apiToken]) : null;
    };

    function clear() {
        sidebarView.close(false);
        sidebarView.update(null);
        revision += 1;
        controller?.abort();
        controller = null;
        pending = null;
        refreshAgain = false;
        mounted?.destroy();
        mounted = null;
        document.body.style.overflow = '';
        root.replaceChildren();
        root.hidden = true;
    }

    function message(text) {
        clear();
        sidebarView.update(getSession());
        if (refresh) refresh.disabled = false;
        state.textContent = text;
        state.hidden = false;
    }

    function sessionChanged() {
        if (fingerprint() === sessionKey) return false;
        message('Your session changed. Refresh to view this report.');
        return true;
    }

    async function review(status, note, action) {
        if (sessionChanged()) return;
        revision++;
        controller?.abort();
        pending = null;
        reviewing = true;
        try { await window.ReportMutations.update(id, status, note, action); if (!sessionChanged()) await load(true); }
        finally { reviewing = false; }
    }

    async function load(quiet = false) {
        if (quiet && pending) { refreshAgain = true; return; }
        const previousState = mounted?.state();
        if (!quiet) clear();
        else { revision++; controller?.abort(); }
        sidebarView.update(getSession());
        const session = getSession();
        if (session?.role === 'admin') sidebarView.activate('reportsSection');
        sessionKey = fingerprint();
        const back = document.getElementById('backToReports');
        const adminReturn = window.AdminViewStore?.read().reportFilters.publication === 'pending' ? 'admin.html#reports?view=community-review' : 'admin.html#reports';
        back.href = session?.role === 'admin' ? adminReturn : session?.role === 'barangay' ? 'barangay.html' : 'citizen.html#my-reports';
        back.querySelector('span').textContent = session?.role === 'citizen' ? 'Back to My Reports' : session?.role === 'admin' ? 'Back to All Reports' : 'Back to Local Reports';
        if (!client.validId(id)) return message('Report not found. Use a valid report link.');
        if (!sessionKey) return message('Sign in with an authorized account to view this report.');
        const version = revision;
        const mutation = window.ReportMutations.revision();
        controller = new AbortController();
        if (!quiet) { state.hidden = false; state.textContent = 'Loading report details...'; }
        if (refresh) refresh.disabled = true;
        try {
            pending = client.load(id, { api, session, signal: controller.signal });
            const data = await pending;
            if (version !== revision || sessionChanged() || mutation !== window.ReportMutations.revision()) return;
            if (quiet && stamp === details.signature(data)) { state.hidden = true; await mounted?.refreshReview(); return; }
            mounted?.destroy();
            mounted = details.mount(root, data, {
                apiBase: api('/'),
                role: session.role,
                state: previousState,
                onReview: review,
                onSeveritySaved: () => load(true)
            });
            stamp = details.signature(data);
            root.hidden = false;
            const conversation = root.querySelector('.rd-conversation');
            if (conversation) {
                conversation.id = 'report-conversation';
                conversation.tabIndex = -1;
                if (!quiet && window.location.hash === '#report-conversation') conversation.focus();
            }
            state.hidden = true;
            document.title = `Report #${data.report.id} | NeighborLens AI`;
        } catch (error) {
            if (version === revision && error.name !== 'AbortError') {
                if (!quiet || [401, 403, 404].includes(error.status)) message(error.reportDetails ? error.message : 'Report details could not be loaded. Refresh to try again.');
                else { state.hidden = false; state.textContent = 'Details may be out of date. Updates will retry automatically.'; }
            }
        } finally {
            if (version === revision) {
                pending = null; if (refresh) refresh.disabled = false;
                if (refreshAgain) { refreshAgain = false; if (mounted && !reviewing) load(true); }
            }
        }
    }

    refresh?.addEventListener('click', () => load());
    sidebar.addEventListener('portal-sidebar:logout', clear);
    window.addEventListener('keydown', event => {
        if (!event.defaultPrevented && event.key === 'Escape' && !document.querySelector('.rd-dialog[open]') && mounted?.isMapExpanded()) mounted.collapseMap();
    });
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    window.addEventListener('focus', () => { if (mounted && fingerprint() !== sessionKey) message('Your session changed. Refresh to view this report.'); });
    window.addEventListener('reports:mutation', event => { if (!reviewing && event.detail.phase === 'saved' && event.detail.id === id) load(true); });
    window.addEventListener('publication:changed', event => { if (!reviewing && event.detail?.reportChanged && String(event.detail.reportId) === String(id)) load(true); });
    window.addEventListener('session:changed', clear);
    const refresher = window.PortalRefresh.create({ window, document, refresh: () => mounted && !reviewing && !sessionChanged() ? load(true) : Promise.resolve(),
        cancel: () => { revision++; controller?.abort(); pending = null; refreshAgain = false; } });
    refresher.start();
    load();
})();
