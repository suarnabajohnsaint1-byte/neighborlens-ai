(function () {
    'use strict';

    const instances = new WeakMap();

    function mount(root, { role = 'admin', store = window.AdminViewStore, endpoint = '/api/admin/analytics/reports', event = 'admin:reports-changed' } = {}) {
        if (instances.has(root)) return instances.get(root);
        if (getSession()?.role !== role || window.NEIGHBORLENS_ACCESS_GRANTED === false) return null;
        window.AnalyticsPanel.mount(root, role === 'admin' ? 'City-wide' : 'Assigned barangay');
        const controls = root.querySelector('[data-analytics-ranges]');
        const chartStyle = root.querySelector('[data-analytics-chart-style]');
        const categorySwitch = root.querySelector('[data-analytics-category-switch]');
        const categoryLayout = root.querySelector('[data-category-layout]');
        const categoryKey = root.querySelector('.analytics-category-key');
        const pieTotal = root.querySelector('.analytics-pie-total');
        const details = document.querySelector('[data-analytics-details]');
        const breakdown = root.querySelector('.analytics-data');
        breakdown.open = true;
        const totals = root.querySelector('[data-analytics-totals]');
        const feedback = root.querySelector('[data-analytics-message]');
        const retry = root.querySelector('[data-analytics-retry]');
        const period = root.querySelector('[data-analytics-period]');
        const history = root.querySelector('[data-analytics-history]');
        const daily = root.querySelector('[data-analytics-daily]');
        const pagination = root.querySelector('[data-analytics-pagination]');
        const dailySize = pagination.querySelector('select');
        const dailyScope = root.querySelector('[data-analytics-daily-scope]');
        const categories = root.querySelector('[data-analytics-categories]');
        const categoryScope = root.querySelector('[data-analytics-category-scope]');
        const areaFilter = root.querySelector('[data-analytics-barangay]');
        const areaPanel = root.querySelector('[data-analytics-area-panel]');
        const areaRows = root.querySelector('[data-analytics-area-rows]');
        const areaPagination = root.querySelector('[data-analytics-area-pagination]');
        const areaSize = areaPagination?.querySelector('select');
        const areaChart = root.querySelector('#analyticsBarangayChart');
        const escape = window.ReportPresentation.escape;
        const charts = [];
        let currentData = null;
        let dailyPage = 1;
        let areaPage = 1;
        let dirty = false;
        let active = null;
        function visibleHost() {
            return (role === 'barangay' ? !details.hidden : document.documentElement.dataset.adminSection === 'analyticsSection') ? details : null;
        }
        const fingerprint = () => { const user = getSession(); return JSON.stringify([user?.id, user?.role, user?.barangay, user?.apiToken]); };
        const actor = fingerprint();
        let disposed = false;

        function label(date) {
            return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        }

        function renderDaily() {
            const components = window.PortalComponents;
            const size = Number(dailySize.value);
            const scope = dailyScope?.value;
            const grouped = dailyScope && scope !== 'city' && Array.isArray(currentData?.dailyByBarangay);
            const rows = grouped ? currentData.dailyByBarangay.filter(row => scope === 'grouped' || String(row.barangayId) === scope)
                : currentData?.daily || [];
            const page = components.page(rows, dailyPage, size);
            dailyPage = page.page;
            pagination.hidden = !rows.length;
            const empty = currentData ? `<tr><td colspan="${dailyScope ? 5 : 4}">No report events for this selection.</td></tr>` : '';
            components.render(daily, page.items.map(day => `<tr><th scope="row">${escape(day.date)}</th>${dailyScope ? `<td>${escape(day.barangay || 'All barangays')}</td>` : ''}<td>${day.submitted}</td><td>${day.ongoing ?? 'Unavailable'}</td><td>${day.resolved ?? `Unavailable (${day.knownResolved} dated)`}</td></tr>`).join('') || empty);
            components.pagination(root.ownerDocument, 'analyticsDaily', page, size, grouped ? 'rows' : 'days');
        }

        function moveDailyPage(event) {
            const button = event.target.closest('[data-daily-page]');
            if (!button || button.disabled) return;
            dailyPage += Number(button.dataset.dailyPage);
            renderDaily();
        }

        function resizeDailyPage() {
            dailyPage = 1;
            renderDaily();
        }

        function renderCategories(data) {
            const rows = (data?.categories ?? []).map(category => ({
                label: `${window.ReportPresentation.categoryIcon(category.key)}${escape(category.label)}`,
                count: category.count,
                share: `${Math.round(category.percentage * 10) / 10}%`
            }));
            window.PortalComponents.render(categories, rows.map(({ label, count, share }) =>
                `<tr><th scope="row">${label}</th><td>${count}</td><td>${share}</td></tr>`).join(''));
            window.PortalComponents.render(categoryKey, rows.map(({ label, count, share }) =>
                `<li><span>${label}</span><span class="analytics-category-share">${count} · <strong>${share}</strong></span></li>`).join(''));
            categoryKey.hidden = pieTotal.hidden = !data;
            pieTotal.querySelector('strong').textContent = data?.totals.submitted ?? '';
        }

        function renderCategorySelection() {
            const area = currentData?.barangays?.find(row => String(row.id) === areaFilter?.value);
            categoryScope.textContent = area ? `Share of reports submitted in ${area.name} during the selected period.`
                : 'Share of reports submitted in the selected period.';
            const selected = area ? {
                ...currentData,
                totals: { submitted: area.submitted },
                categories: currentData.categories.map(category => {
                    const count = area.categoryCounts[category.key] || 0;
                    return { ...category, count, percentage: area.submitted ? count / area.submitted * 100 : 0 };
                })
            } : currentData;
            charts[1]?.update(selected);
            renderCategories(selected);
        }

        function renderAreaPage() {
            if (!areaPanel) return;
            const rows = currentData?.barangays || [];
            areaPanel.hidden = !rows.length;
            const size = Number(areaSize.value);
            const components = window.PortalComponents;
            const page = components.page(rows, areaPage, size);
            areaPage = page.page;
            if (rows.length) areaChart.style.height = `${Math.max(200, Math.min(size, rows.length) * 28 + 66)}px`;
            charts[2]?.update(rows.length ? page.items : null);
            components.render(areaRows, page.items.map(row => `<tr><th scope="row">${escape(row.name)}</th><td>${row.submitted}</td><td>${row.ongoing}</td><td>${row.resolved}</td></tr>`).join(''));
            components.pagination(root.ownerDocument, 'analyticsBarangay', page, size, 'barangays');
            areaPagination.hidden = !rows.length;
        }

        function moveAreaPage(event) {
            const button = event.target.closest('[data-area-page]');
            if (!button || button.disabled) return;
            areaPage += Number(button.dataset.areaPage);
            renderAreaPage();
        }

        function resizeAreaPage() {
            areaPage = 1;
            renderAreaPage();
        }

        function render(state) {
            if (disposed) return;
            root.dataset.state = state.status;
            root.setAttribute('aria-busy', String(state.status === 'loading'));
            totals.hidden = active !== details || !state.data;
            totals.querySelectorAll('[data-analytics-total]').forEach(cell => {
                cell.textContent = state.data?.totals[cell.dataset.analyticsTotal] ?? 'Unavailable';
            });
            store?.save({ analyticsDays: state.days });
            controls.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.analyticsDays) === state.days)));
            retry.hidden = state.status !== 'error';
            feedback.textContent = state.status === 'loading' ? 'Loading report analytics...'
                : state.status === 'error' ? `${state.error}${state.data ? ' Showing the last successful results.' : ''}`
                : state.data?.totals.submitted === 0 && state.data?.totals.knownResolved === 0 && state.data?.resolutionHistory.complete ? 'No reports in this period.' : '';
            feedback.parentElement.hidden = !feedback.textContent && retry.hidden;
            history.hidden = !state.data || state.data.resolutionHistory.complete;
            if (!history.hidden) history.textContent = `${state.data.resolutionHistory.missingReports} resolved reports have no dated resolution history. Historical resolved totals are unavailable; dated events appear in the data table.`;
            if (!state.data) {
                period.textContent = `${state.days} days - Asia/Manila`;
                charts.forEach(chart => chart.update(null));
                renderCategories(null);
                currentData = null;
                renderDaily();
                renderAreaPage();
                return;
            }
            const data = state.data;
            period.textContent = `${label(data.range.startDate)} - ${label(data.range.endDate)} | Asia/Manila`;
            if (!charts.length) {
                charts.push(window.PortalCharts.mount(root.querySelector('#reportTrendsChart'), {
                    engine: window.echarts,
                    options: (data, colors) => window.PortalAnalyticsCharts.trend(data, colors, chartStyle.value)
                }));
                charts.push(window.PortalCharts.mount(root.querySelector('#reportCategoriesChart'), {
                    engine: window.echarts,
                    options: (data, colors) => window.PortalAnalyticsCharts.categories(data, colors, categoryLayout.dataset.categoryLayout)
                }));
                if (areaChart) charts.push(window.PortalCharts.mount(areaChart, {
                    engine: window.echarts, options: window.PortalAnalyticsCharts.barangays
                }));
            }
            if (data !== currentData) {
                if (data.range.days !== currentData?.range.days) dailyPage = areaPage = 1;
                currentData = data;
                if (areaFilter) {
                    const selected = areaFilter.value;
                    areaFilter.replaceChildren(new Option('All Barangays', ''),
                        ...(data.barangays || []).map(row => new Option(row.name, String(row.id))));
                    if ([...areaFilter.options].some(option => option.value === selected)) areaFilter.value = selected;
                    const scope = dailyScope.value;
                    dailyScope.replaceChildren(new Option('By barangay', 'grouped'), new Option('City-wide totals', 'city'),
                        ...(data.barangays || []).map(row => new Option(row.name, String(row.id))));
                    if ([...dailyScope.options].some(option => option.value === scope)) dailyScope.value = scope;
                }
                charts[0].update(data);
                renderCategorySelection();
                renderDaily();
                renderAreaPage();
            }
        }

        const selection = window.PortalAnalyticsState.create({
            days: store?.read().analyticsDays || 30,
            changed: render,
            async load(days, signal) {
                const [data] = await Promise.all([window.PortalAnalyticsApi.load(days, signal, endpoint), window.PortalCharts.load()]);
                if (getSession()?.role !== role || fingerprint() !== actor) {
                    const error = new Error('Your session changed. Retry analytics for the current account.');
                    error.status = 403;
                    throw error;
                }
                return data;
            }
        });

        function select(event) {
            const button = event.target.closest('button[data-analytics-days]');
            if (button) selection.select(Number(button.dataset.analyticsDays));
        }
        function redrawTrend() { charts[0]?.resize(); }
        function selectCategoryStyle(event) {
            const button = event.target.closest('[data-category-style]');
            if (!button || button.dataset.categoryStyle === categoryLayout.dataset.categoryLayout) return;
            categoryLayout.dataset.categoryLayout = button.dataset.categoryStyle;
            categorySwitch.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(option === button)));
            charts[1]?.resize();
        }
        function refresh() {
            if (fingerprint() !== actor) { instance.destroy(); return; }
            dirty = false;
            return selection.refresh();
        }
        function invalidate(event) {
            if (event?.detail?.reason === 'reconnected' && selection.get().status === 'loading') return;
            dirty = true;
            if (active && document.visibilityState !== 'hidden') refresh();
        }
        function focus() { if (active && selection.get().status !== 'loading') refresh(); }
        function visibility() { if (document.visibilityState === 'visible') focus(); }
        function section() {
            const visible = visibleHost();
            if (active === visible) return;
            active = visible;
            if (!active) return;
            totals.hidden = !selection.get().data;
            charts.forEach(chart => chart.resize());
            if (dirty || ['idle', 'error'].includes(selection.get().status)) refresh();
        }
        const observer = new MutationObserver(section);
        if (role === 'admin') observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-admin-section'] });
        else observer.observe(details, { attributes: true, attributeFilter: ['hidden'] });
        controls.addEventListener('click', select);
        chartStyle.addEventListener('change', redrawTrend);
        categorySwitch.addEventListener('click', selectCategoryStyle);
        retry.addEventListener('click', refresh);
        pagination.addEventListener('click', moveDailyPage);
        dailySize.addEventListener('change', resizeDailyPage);
        dailyScope?.addEventListener('change', resizeDailyPage);
        areaSize?.addEventListener('change', resizeAreaPage);
        areaFilter?.addEventListener('change', renderCategorySelection);
        areaPagination?.addEventListener('click', moveAreaPage);
        window.addEventListener(event, invalidate);
        window.addEventListener('focus', focus);
        document.addEventListener('visibilitychange', visibility);

        const instance = {
            destroy() {
                if (disposed) return;
                disposed = true;
                selection.destroy(); charts.forEach(chart => chart.destroy()); observer.disconnect();
                daily.replaceChildren(); renderCategories(null); currentData = null;
                if (areaPanel) { areaRows.replaceChildren(); areaPanel.hidden = true; areaFilter.replaceChildren(); }
                pagination.hidden = true;
                totals.hidden = true;
                feedback.textContent = ''; history.textContent = ''; history.hidden = true;
                root.dataset.state = 'idle'; root.setAttribute('aria-busy', 'false');
                controls.removeEventListener('click', select); retry.removeEventListener('click', refresh);
                chartStyle.removeEventListener('change', redrawTrend);
                categorySwitch.removeEventListener('click', selectCategoryStyle);
                pagination.removeEventListener('click', moveDailyPage);
                dailySize.removeEventListener('change', resizeDailyPage);
                dailyScope?.removeEventListener('change', resizeDailyPage);
                areaSize?.removeEventListener('change', resizeAreaPage);
                areaFilter?.removeEventListener('change', renderCategorySelection);
                areaPagination?.removeEventListener('click', moveAreaPage);
                window.removeEventListener(event, invalidate); window.removeEventListener('focus', focus);
                window.removeEventListener('session:changed', instance.destroy);
                document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', instance.destroy);
                instances.delete(root);
            }
        };
        instances.set(root, instance);
        window.addEventListener('pagehide', instance.destroy);
        window.addEventListener('session:changed', instance.destroy);
        section();
        return instance;
    }

    function initialize() {
        const root = document.getElementById('adminAnalytics');
        if (root) mount(root);
        const barangay = document.getElementById('barangayAnalytics');
        if (barangay) mount(barangay, { role: 'barangay', store: window.BarangayViewStore, endpoint: '/api/reports/analytics', event: 'barangay:reports-changed' });
    }

    window.PortalAnalyticsDashboard = { mount };
    window.addEventListener('DOMContentLoaded', initialize);
    window.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
})();
