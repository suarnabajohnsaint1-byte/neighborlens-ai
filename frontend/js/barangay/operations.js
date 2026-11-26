(function (root) {
    'use strict';
    function initialize() {
        if (root.NEIGHBORLENS_ACCESS_GRANTED === false || root.getSession()?.role !== 'barangay') return;
        const document = root.document;
        const sidebar = document.getElementById('barangaySidebar');
        const sections = { gis: document.getElementById('barangayGis'), activity: document.getElementById('barangayActivity'), community: document.getElementById('communitySection'), analytics: document.getElementById('barangayAnalyticsSection') };
        const reportSections = document.querySelectorAll('[data-report-summary="barangay"], .barangay-reports');
        const map = root.ReportGis.create({ container: document.getElementById('barangayGisMap'), openReport: (id, button) => root.BarangayPortal.openReport(id, button),
            filterForm: document.querySelector('[data-operation-filters="gis"]'), legend: document.getElementById('barangayGisLegend'), state: document.querySelector('[data-operation-state="gis"]') });
        const states = { activity: { page: 1 } };
        const listeners = [];
        let active = null;
        let destroyed = false;
        function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); }
        const actionPicker = document.querySelector('.activity-action-picker');
        listen(actionPicker, 'change', event => {
            if (!event.target.matches('input[name="action"]')) return;
            document.getElementById('activityActionValue').textContent = event.target.nextElementSibling.textContent;
            actionPicker.open = false;
            actionPicker.querySelector('summary').focus();
        });
        listen(actionPicker, 'keydown', event => {
            if (event.key === 'Escape') { actionPicker.open = false; actionPicker.querySelector('summary').focus(); }
        });
        listen(actionPicker, 'click', event => {
            if (event.target.matches('input[name="action"]:checked')) actionPicker.open = false;
        });
        listen(document, 'pointerdown', event => { if (!actionPicker.contains(event.target)) actionPicker.open = false; });
        async function load(kind) {
            const state = states[kind];
            state.controller?.abort();
            const controller = new AbortController(); state.controller = controller;
            const message = document.querySelector(`[data-operation-state="${kind}"]`);
            const previous = document.querySelector(`[data-operation-prev="${kind}"]`);
            const next = document.querySelector(`[data-operation-next="${kind}"]`);
            previous.disabled = next.disabled = true;
            message.textContent = 'Loading...';
            const query = new URLSearchParams(new FormData(document.querySelector(`[data-operation-filters="${kind}"]`)));
            query.set('page', state.page); query.set('pageSize', document.querySelector(`[data-operation-size="${kind}"]`).value);
            try {
                const data = await root.apiRequest(`/api/barangays/${kind}?${query}`, { signal: controller.signal });
                if (destroyed || state.controller !== controller || controller.signal.aborted) return;
                const labels = { create: 'Report created', status_update: 'Status changed', classification_update: 'Classification changed', assign: 'Report assigned', reassign: 'Report reassigned', review: 'Report reviewed' };
                document.getElementById('barangayActivityRows').innerHTML = root.ActivityLogView.markup(data.logs, {
                    describe: row => `${labels[row.action]} · Report #${row.reportId} · ${row.actor} · ${row.barangay}${row.status ? ` · ${root.ReportVocabulary.statuses[row.status]}` : ''}`,
                    date: value => root.ManilaDates.format(value)
                });
                message.textContent = `${data.pagination.total} authorized report activities.`;
                previous.disabled = state.page <= 1;
                next.disabled = state.page >= data.pagination.pages;
                document.querySelector(`[data-operation-page="${kind}"]`).textContent = `Page ${state.page} of ${Math.max(1, data.pagination.pages)}`;
            } catch (error) {
                if (!destroyed && !controller.signal.aborted && state.controller === controller) {
                    message.textContent = error.message || 'Could not load this view. Apply filters to retry.';
                    document.getElementById('barangayActivityRows').replaceChildren();
                }
            }
        }
        function show(section, push = false) {
            active = section === 'gis-map' ? 'gis' : Object.hasOwn(sections, section) ? section : null;
            const headings = { gis: ['GIS Map', 'Find assigned reports by location, status, and classification.'], activity: ['Activity Logs', 'Review changes made to reports in your Barangay.'], community: ['Community Feed', 'Browse approved community reports and join discussions.'], reports: ['Local Reports', 'Review and manage infrastructure reports assigned to your Barangay.'], analytics: ['Analytics', 'Track report trends and damage categories in your assigned Barangay.'] };
            const [title, description] = headings[active || 'reports'];
            document.getElementById('barangayPageTitle').textContent = title;
            document.getElementById('barangayPageDescription').textContent = description;
            for (const [kind, element] of Object.entries(sections)) element.hidden = kind !== active;
            for (const element of reportSections) element.hidden = Boolean(active);
            root.PortalSidebar.get(sidebar)?.activate(active === 'gis' ? 'gis-map' : active || 'reports');
            if (push && root.location.hash !== `#${section}`) root.history.pushState(null, '', `#${section}`);
            if (active === 'gis') map.start(); else map.suspend();
            if (active === 'activity') load(active);
            root.dispatchEvent(new CustomEvent('barangay:section-changed', { detail: { section: active } }));
        }
        listen(sidebar, 'portal-sidebar:navigate', event => show(event.detail.section, true));
        listen(root, 'hashchange', () => show(root.location.hash.slice(1)));
        listen(root, 'popstate', () => show(root.location.hash.slice(1)));
        listen(root, 'barangay:reports-changed', () => { if (active === 'gis') map.refresh(); else if (active === 'activity') load(active); });
        for (const kind of Object.keys(states)) {
            listen(document.querySelector(`[data-operation-size="${kind}"]`), 'change', () => { states[kind].page = 1; load(kind); });
            listen(document.querySelector(`[data-operation-filters="${kind}"]`), 'submit', event => { event.preventDefault(); states[kind].page = 1; load(kind); });
            for (const [action, delta] of [['prev', -1], ['next', 1]]) listen(document.querySelector(`[data-operation-${action}="${kind}"]`), 'click', () => { states[kind].page += delta; load(kind); });
        }
        function destroy() { destroyed = true; listeners.splice(0).forEach(remove => remove()); Object.values(states).forEach(state => state.controller?.abort()); map.destroy(); document.getElementById('barangayActivityRows').replaceChildren(); }
        listen(root, 'pagehide', destroy); listen(root, 'session:changed', destroy);
        show(root.location.hash.slice(1));
    }
    root.addEventListener('DOMContentLoaded', initialize);
    root.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
})(window);
