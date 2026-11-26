(function (root) {
    const mounted = new WeakMap();
    const tables = new WeakMap();
    const COLUMNS = Object.freeze({
        date: { label: 'Date', width: 112 }, photo: { label: 'Photo', width: 72 }, issue: { label: 'Issue', width: 220, flexible: true },
        barangay: { label: 'Barangay', width: 104 }, classification: { label: 'Severity', width: 100 }, priority: { label: 'Priority', width: 100 },
        status: { label: 'Operational status', width: 112 }, publication: { label: 'Publication status', width: 128 }, actions: { label: 'Actions', width: 140 }
    });
    Object.values(COLUMNS).forEach(Object.freeze);
    const PORTAL_COLUMNS = Object.freeze({ admin: Object.freeze(Object.keys(COLUMNS)), barangay: Object.freeze(['date', 'photo', 'issue', 'classification', 'priority', 'status', 'actions']) });
    const controlLabel = (label, compact = label) => `<span class="rm-label-full">${label}</span><span class="rm-label-compact" aria-hidden="true">${compact}</span>`;
    function viewSwitcher(document, id) {
        const group = document.createElement('div'); group.id = id; group.className = 'portal-view-toggle'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'View layout');
        group.innerHTML = [['grid', 'grid-alt', 'Cards'], ['row', 'list-ul', 'List'], ['split', 'columns', 'Split Detail', 'Split'], ['text', 'image-alt', 'Compact']].map(([mode, icon, label, compact]) => `<button type="button" class="portal-view-btn" data-view-mode="${mode}" aria-pressed="false" title="${label}" aria-label="${label} view"><i class="bx bx-${icon}" aria-hidden="true"></i>${controlLabel(label, compact)}</button>`).join('');
        return group;
    }
    function mount({ section, role }) {
        if (mounted.has(section)) { const existing = mounted.get(section); existing.activate(); return existing; }
        const document = section.ownerDocument, admin = role === 'admin';
        const get = id => document.getElementById(id);
        const field = (label, node) => { const wrapper = document.createElement('label'); wrapper.className = 'rm-field'; const text = document.createElement('span'); text.textContent = label; wrapper.append(text, node); return wrapper; };
        const header = document.createElement('div'); header.className = 'rm-heading';
        const titles = document.createElement('div');
        const title = section.querySelector('h2'); title.id = admin ? 'adminReportsTitle' : title.id;
        titles.append(title, get(admin ? 'adminReportCount' : 'filterCount'));
        const subtitle = document.createElement('p'); subtitle.className = 'section-caption'; subtitle.id = admin ? 'adminReportsSubtitle' : 'barangayReportsSubtitle'; titles.append(subtitle);
        const actions = document.createElement('div'); actions.className = 'rm-actions portal-action-grid';
        const exportButton = get(admin ? 'adminExportReports' : 'barangayExportReports');
        const printButton = document.createElement('button');
        printButton.type = 'button'; printButton.className = 'portal-button-secondary';
        printButton.dataset.printReports = '';
        printButton.disabled = true;
        const clearButton = get(admin ? 'adminClearFiltersBtn' : 'clearFilters');
        for (const [button, icon, label, compact] of [
            [exportButton, 'spreadsheet', 'Export Excel', 'Export'],
            [printButton, 'printer', 'Print all', 'Print all'],
            [clearButton, 'filter-alt', 'Clear filters', 'Clear']
        ]) {
            button.setAttribute('aria-label', label);
            button.innerHTML = `<i class="bx bx-${icon}" aria-hidden="true"></i>${controlLabel(label, compact)}`;
            actions.append(button);
        }
        const views = viewSwitcher(document, admin ? 'adminViewToggle' : 'barangayViewToggle');
        if (!admin) get('barangayViewToggle')?.remove();
        actions.append(views); header.append(titles, actions);
        const tabs = admin ? section.querySelector('[data-admin-filter]').parentElement : section.querySelector('.barangay-statuses'); tabs.className = 'rm-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Report list mode');
        if (admin) {
            for (const [key, label] of [['rejected', 'Rejected'], ['community-review', 'Community Review']]) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-btn'; button.dataset.adminFilter = key; button.textContent = label; tabs.append(button);
            }
        }
        const toolbar = document.createElement('div'); toolbar.className = 'rm-toolbar';
        const search = get(admin ? 'adminSearch' : 'reportSearch').closest('.portal-search');
        const searchInput = search.querySelector('input');
        const searchPlaceholder = searchInput.placeholder;
        const sort = get(admin ? 'adminFilterSort' : 'filterSort');
        const dates = document.createElement('div'); dates.className = 'rm-dates';
        const dateFrom = get(admin ? 'adminFilterDateFrom' : 'filterDateFrom');
        const dateTo = get(admin ? 'adminFilterDateTo' : 'filterDateTo');
        dateFrom.setAttribute('aria-label', 'Date from'); dateTo.setAttribute('aria-label', 'Date to');
        dates.append(dateFrom, dateTo);
        const sheet = get(admin ? 'reportFilters' : 'barangayFilters');
        const more = section.querySelector(`[data-sheet-open="${sheet.id}"]`); more.className = 'portal-button-secondary rm-more';
        more.innerHTML = `<i class="bx bx-filter" aria-hidden="true"></i><span>More filters</span><span${admin ? '' : ' id="moreFiltersCount"'} class="portal-filter-count" hidden></span>`;
        const dateField = field('Date range', dates);
        toolbar.append(search, field('Sort by', sort), dateField, more);
        const advanced = document.createElement('div'); advanced.className = 'rm-advanced-fields';
        for (const [label, id] of admin ? [['Barangay', 'adminFilterBarangay'], ['Classification', 'adminFilterClassification'], ['Priority', 'adminFilterPriority'], ['Category', 'adminFilterCategory']] : [['Classification', 'filterClassification'], ['Priority', 'filterPriority'], ['Category', 'filterCategory']]) advanced.append(field(label, get(id)));
        sheet.querySelector('.portal-sheet-body').replaceWith(advanced); advanced.classList.add('portal-sheet-body'); sheet.classList.add('rm-advanced'); sheet.hidden = true;
        const host = document.createElement('div'); host.className = 'report-management'; host.dataset.role = role; host.append(header, tabs, toolbar, sheet);
        section.querySelectorAll(admin ? '.section-heading, .filter-bar, .portal-toolbar' : '.barangay-reports-heading, .barangay-statuses-row, .barangay-toolbar').forEach(node => node.remove());
        section.prepend(host);
        const fields = admin ? { adminSearch: 'search', adminFilterSort: 'sort', adminFilterDateFrom: 'dateFrom', adminFilterDateTo: 'dateTo', adminFilterBarangay: 'barangay', adminFilterClassification: 'classification', adminFilterPriority: 'priority', adminFilterCategory: 'category' } : {};
        for (const [id, key] of Object.entries(fields)) get(id).dataset.query = key;
        tabs.querySelectorAll('button').forEach(button => { button.removeAttribute('onclick'); button.dataset.reportStatus = button.dataset.adminFilter || button.dataset.statusFilter; });
        actions.querySelectorAll('[onclick]').forEach(button => button.removeAttribute('onclick'));
        const pagination = section.querySelector('nav[aria-label*="pagination"]');
        let size = pagination.querySelector('[data-query="pageSize"]');
        if (!size) { size = document.createElement('select'); size.dataset.query = 'pageSize'; size.setAttribute('aria-label', 'Reports per page'); size.innerHTML = [3, 5, 10, 20, 50].map(value => `<option>${value}</option>`).join(''); size.value = '5'; }
        pagination.className = 'portal-pagination';
        pagination.innerHTML = '<span id="reportsPageInfo" class="portal-page-info" role="status" aria-live="polite"></span><label class="portal-page-size">Per page </label><div class="portal-page-buttons"><button id="reportsPrev" class="portal-icon-button" type="button" aria-label="Previous page"><i class="bx bx-chevron-left" aria-hidden="true"></i></button><span id="reportsPageNumber" class="portal-page-number"></span><button id="reportsNext" class="portal-icon-button" type="button" aria-label="Next page"><i class="bx bx-chevron-right" aria-hidden="true"></i></button></div>';
        pagination.querySelector('label').append(size);
        let handlers = {}, searchTimer = null, pendingSearch = null;
        function commitSearch() {
            if (pendingSearch === null) return;
            clearTimeout(searchTimer);
            const search = pendingSearch; pendingSearch = null;
            handlers.query?.({ search });
        }
        function queryChanged(event) {
            const control = event.target.closest('[data-query]');
            if (!control || control.closest('[data-sheet]') && root.matchMedia('(max-width: 900px)').matches) return;
            const key = control.dataset.query;
            if (key === 'search') {
                if (event.type !== 'input') return;
                pendingSearch = control.value.trim();
                clearTimeout(searchTimer); searchTimer = setTimeout(commitSearch, 250);
            } else if (event.type === 'change') handlers.query?.({ [key]: key === 'pageSize' ? Number(control.value) : control.value });
        }
        function beforeExport(event) {
            const button = event.target.closest('button');
            if (button === exportButton || button === printButton) commitSearch();
        }
        function click(event) {
            const button = event.target.closest('button'); if (!button) return;
            if (button.dataset.reportStatus || button.dataset.viewMode || ['reportsPrev', 'reportsNext'].includes(button.id)) commitSearch();
            if (button.dataset.reportStatus) handlers.status?.(button.dataset.reportStatus);
            if (button.id === (admin ? 'adminClearFiltersBtn' : 'clearFilters')) { clearTimeout(searchTimer); pendingSearch = null; handlers.clear?.(); }
            if (button.id === 'reportsPrev' || button.id === 'reportsNext') handlers.page?.(button.id === 'reportsPrev' ? -1 : 1);
            if (button.closest(`#${sheet.id}`) && button.hasAttribute('data-sheet-apply')) handlers.query?.(Object.fromEntries([...sheet.querySelectorAll('[data-query]')].map(control => [control.dataset.query, control.value])));
            if (button === more && !root.matchMedia('(max-width: 900px)').matches) { sheet.hidden = !sheet.hidden; more.setAttribute('aria-expanded', String(!sheet.hidden)); }
        }
        function syncTabs() {
            const active = tabs.querySelector('[aria-pressed="true"]'); if (!active) return;
            const bounds = tabs.getBoundingClientRect(), selected = active.getBoundingClientRect();
            if (selected.right > bounds.right + 1) {
                tabs.scrollLeft += Math.ceil(selected.right - bounds.right + 4);
            } else if (selected.left < bounds.left - 1) {
                tabs.scrollLeft += Math.floor(selected.left - bounds.left - 4);
            }
        }
        const pageHeader = document.querySelector('.admin-header, .barangay-header');
        const observer = new ResizeObserver(() => {
            host.style.setProperty('--rm-heading-height', `${header.offsetHeight + parseFloat(getComputedStyle(header).marginBottom || 0)}px`);
            host.style.setProperty('--staff-header-height', `${pageHeader?.offsetHeight || 0}px`);
            syncTabs();
        });
        const tabMutations = new MutationObserver(syncTabs);
        let active = false;
        const phone = root.matchMedia('(max-width: 600px)');
        function updatePhoneLayout() {
            searchInput.placeholder = phone.matches ? 'Search reports' : searchPlaceholder;
            if (phone.matches) advanced.prepend(dateField);
            else toolbar.insertBefore(dateField, more);
        }
        function activate() {
            if (active) return;
            active = true;
            updatePhoneLayout(); phone.addEventListener('change', updatePhoneLayout);
            observer.observe(tabs); tabMutations.observe(tabs, { attributes: true, subtree: true, attributeFilter: ['aria-pressed', 'class'] });
            observer.observe(header);
            if (pageHeader) observer.observe(pageHeader);
            tabs.querySelectorAll('button').forEach(button => observer.observe(button));
            root.addEventListener('resize', syncTabs);
            section.addEventListener('click', beforeExport, true);
            section.addEventListener('click', click); section.addEventListener('input', queryChanged); section.addEventListener('change', queryChanged);
        }
        const api = {
            title, subtitle, tabs, views, activate, bind(value) { handlers = value; }, destroy() {
                active = false;
                phone.removeEventListener('change', updatePhoneLayout);
                clearTimeout(searchTimer); pendingSearch = null; observer.disconnect(); tabMutations.disconnect(); root.removeEventListener('resize', syncTabs); handlers = {};
                section.removeEventListener('click', click); section.removeEventListener('input', queryChanged); section.removeEventListener('change', queryChanged);
                section.removeEventListener('click', beforeExport, true);
            }
        };
        activate();
        mounted.set(section, api); return api;
    }
    function adapt(report) {
        return {
            ...report, backendId: report.backendId ?? report.id, createdAt: report.createdAt ?? report.created_at,
            aiCategory: report.aiCategory ?? report.ai_category, aiClassification: report.aiClassification ?? report.ai_classification,
            aiPriority: report.aiPriority ?? report.ai_priority, submittedBy: report.submittedBy ?? report.submitted_by_username
        };
    }
    function createTable({ section, list, table, columns, views, storageKey, apiBase, printPreview, onOpen, onMode = () => { } }) {
        if (tables.has(list)) return tables.get(list);
        const document = section.ownerDocument;
        const escape = root.ReportPresentation.escape;
        const definitions = columns.map(id => { if (!COLUMNS[id]) throw new Error('Unknown report column.'); return [id, COLUMNS[id]]; });
        const generated = !table;
        let wrapper = table?.parentElement;
        if (!table) {
            wrapper = document.createElement('div'); table = document.createElement('table'); wrapper.append(table); list.before(wrapper);
            table.append(document.createElement('tbody'));
        }
        wrapper.className = 'rm-report-table'; table.className = 'rm-table report-table';
        const body = table.querySelector('tbody');
        release(body);
        body.replaceChildren();
        table.querySelector('thead')?.remove(); table.querySelector('colgroup')?.remove();
        table.insertAdjacentHTML('afterbegin', `<colgroup>${definitions.map(([id, column]) => `<col data-column="${id}" class="report-col-${id}" style="width:${column.flexible ? 'auto' : column.width + 'px'}">`).join('')}</colgroup><thead><tr>${definitions.map(([id, column]) => `<th scope="col" data-column="${id}" class="report-col-${id}">${column.label}</th>`).join('')}</tr></thead>`);
        table.style.minWidth = `${definitions.reduce((sum, [, column]) => sum + column.width, 0)}px`;
        list.classList.add('rm-report-cards');
        const rowEntries = new Map(), cardEntries = new Map(), media = root.matchMedia('(max-width: 900px)');
        const printButton = section.querySelector('[data-print-reports]');
        const management = section.querySelector('.report-management');
        const printFeedback = document.createElement('p');
        printFeedback.className = 'rm-print-feedback';
        printFeedback.setAttribute('role', 'status');
        management?.querySelector('.rm-toolbar').after(printFeedback);
        const printer = root.ReportPrint.create(printFeedback, apiBase);
        let latest = null, mode = 'grid';
        function printEntry(report) {
            return {
                id: report.backendId ?? report.id,
                submittedBy: columns.includes('publication') ? report.submittedBy ?? report.submitted_by_username : null,
                publication: latest.publicationLabel?.(report),
                requestedAt: latest.review ? report.created_at : null
            };
        }
        function printAll() {
            if (printPreview && latest?.query && ['loading', 'ready'].includes(latest.status)) {
                const query = root.ReportExport.filterParams(latest.query);
                printer.print(async signal => {
                    const result = await root.apiRequest(`${printPreview}?${query}`, { signal, cache: 'no-store' });
                    return { entries: result.reports, title: 'Barangay reports', summary: summaryMarkup(result) };
                }, printButton);
                return;
            }
            const reports = latest?.matchingReports || latest?.reports;
            if (latest?.status !== 'ready' || !reports?.length) return;
            const title = section.querySelector('.rm-heading h2').textContent;
            printer.print(() => ({ entries: reports.map(printEntry), title, intro: `${reports.length} matching ${reports.length === 1 ? 'report' : 'reports'}` }), printButton);
        }
        function summaryMarkup(result) {
            const { filters, reports, categories, puroks, scope } = result;
            const labels = { status: 'Status', category: 'Category', classification: 'Severity', priority: 'Priority', search: 'Search', dateFrom: 'From', dateTo: 'To', sort: 'Sort' };
            const values = { ...root.ReportVocabulary.statuses, MAJOR: 'Major', MINOR: 'Minor', UNCLASSIFIED: 'Unclassified', newest: 'Newest first', oldest: 'Oldest first', priority: 'Highest priority first' };
            const activeFilters = Object.entries(labels).filter(([key]) => filters[key] && filters[key] !== 'all')
                .map(([key, label]) => {
                    const value = filters[key];
                    return `${label} · ${escape(key !== 'search' && Object.hasOwn(values, value) ? values[value] : value)}`;
                });
            const ranking = (title, rows, showPercentage = false) => `<div><h4>${title}</h4><ul>${rows.map(({ label, count, percentage }) =>
                `<li><span>${escape(label)}</span><strong>${escape(count)}${showPercentage ? ` (${escape(percentage.toFixed(1))}%)` : ''}</strong></li>`).join('')}</ul></div>`;
            return `<p><strong>${escape(scope)}</strong> · ${reports.length} matching ${reports.length === 1 ? 'report' : 'reports'}</p><p>${activeFilters.join(' · ')}</p>
                ${reports.length ? `<div class="rm-breakdown">${ranking('Categories by report count', categories)}${ranking('Purok share of matching reports', puroks, true)}</div>
                    <p class="section-caption">Purok labels come from recorded report addresses. Missing or unclear labels count as Unknown Purok.</p>` : ''}`;
        }
        printButton?.addEventListener('click', printAll);
        function thumbnail(report) {
            const id = report.backendId ?? report.id;
            const photo = { url: root.ReportCard.photoUrl(report, id, 1, apiBase) };
            const thumb = `<span class="rm-thumbnail" role="img" aria-label="${photo?.url ? 'Submitted report evidence' : 'Evidence photo unavailable'}">${photo?.url ? `<img data-evidence-url="${escape(photo.url)}" data-evidence-report="${escape(id)}" data-evidence-order="1" alt="" loading="lazy">` : 'No photo'}</span>`;
            const detailsUrl = root.reportDetailsUrl?.(report) || (id ? `report-details.html?id=${id}` : null);
            return detailsUrl ? `<a href="${escape(detailsUrl)}" data-action="evidence" aria-label="View evidence for report ${escape(id)}">${thumb}</a>` : thumb;
        }
        function cells(input, review, publicationLabel) {
            const report = root.ReportCard.adapt(input), id = report.backendId ?? report.id, summary = root.ReportCard.summary(report);
            const vision = !report.originalAi && report.visionDetected ? '<span class="rm-label" title="Detected by Vision AI">AI</span>' : '';
            const origin = `<p>${escape(summary.correction || (report.citizenCategory ? `Citizen category: ${report.citizenCategory}` : summary.detail))}</p>`;
            const suggested = !report.ai_classification && ['MINOR', 'MAJOR'].includes(report.suggestedClassification);
            const classKey = root.ReportVocabulary.classification(report.ai_classification || report.suggestedClassification);
            const classification = `<span class="rm-label">${escape(`${suggested ? 'AI suggested ' : ''}${{ MAJOR: 'Major', MINOR: 'Minor', UNCLASSIFIED: 'Unclassified' }[classKey]}`)}</span>`;
            const priority = `<span class="rm-label">${escape(root.ReportVocabulary.priority(report.ai_priority) || 'Unprioritized')}</span>`;
            const status = `<span class="mr-status" data-status="${escape(report.status)}">${escape(root.ReportVocabulary.statuses[report.status] || 'Unknown status')}</span>`;
            const detailsUrl = root.reportDetailsUrl?.(report) || (id ? `report-details.html?id=${id}` : null);
            const viewAction = detailsUrl
                ? `<a class="portal-button-secondary action-btn view-btn" href="${escape(detailsUrl)}" data-action="view" aria-label="View details for report ${escape(id)}" title="View Details"><i class="bx bx-show" aria-hidden="true"></i>View Details</a>`
                : `<button type="button" class="portal-button-secondary action-btn view-btn" data-action="view" aria-label="View details for report ${escape(id)}">View Details</button>`;
            return {
                date: escape(root.ReportPresentation.date(report.created_at) || 'Date not recorded'),
                photo: thumbnail(report),
                issue: `<div class="portal-cell-content"><div class="report-issue-title"><strong class="rm-issue-title">${root.ReportCard.categoryIcon(report)}${escape(report.citizenCategory || root.ReportCard.displayTitle(report))}</strong><small>#${escape(id)}</small>${vision}</div>${origin}<p class="rm-description">${escape(report.description || '')}</p></div>`,
                barangay: escape(report.barangay || 'Not recorded'),
                classification,
                priority,
                status,
                publication: escape(publicationLabel?.(report) || 'Not shared'),
                actions: `<div class="rm-row-actions">${viewAction}${review ? `<button type="button" class="portal-button-secondary rm-review-action" data-action="review" data-review-post="${escape(id)}"><i class="bx bxs-file" aria-hidden="true"></i>Review Post</button>` : ''}${root.ReportPrint.action(id)}</div>`
            };
        }
        function release(node) { node?.querySelectorAll('img[data-evidence-url]').forEach(image => root.ReportEvidence?.release(image)); }
        function reconcile(target, reports, asRows, options) {
            const cache = asRows ? rowEntries : cardEntries;
            const ids = new Set(reports.map(report => String(report.backendId ?? report.id)));
            for (const [key, entry] of cache) if (!ids.has(key) || entry.node.parentElement !== target) { release(entry.node); entry.node.remove(); cache.delete(key); }
            target.querySelector('[data-list-message]')?.remove();
            for (const [index, report] of reports.entries()) {
                const id = String(report.backendId ?? report.id), values = asRows ? cells(report, options.review, options.publicationLabel) : null;
                const compact = mode === 'text' ? { submittedBy: columns.includes('publication') && report.submittedBy, publication: options.publicationLabel?.(report) } : undefined;
                const html = asRows ? `<tr data-report-id="${escape(id)}">${definitions.map(([key, column]) => `<td data-column="${key}" data-label="${column.label}" class="report-cell-${key}">${values[key]}</td>`).join('')}</tr>` : root.ReportCard.render(report, { apiBase, staff: true, compact, printAction: root.ReportPrint.action(id) });
                let entry = cache.get(id);
                if (entry?.html !== html) {
                    const template = document.createElement('template'); template.innerHTML = asRows ? `<table><tbody>${html}</tbody></table>` : html;
                    const node = asRows ? template.content.querySelector('tr') : template.content.firstElementChild;
                    const photos = JSON.stringify([report.images, report.image]);
                    const oldMedia = entry?.node.querySelector(asRows ? '.rm-thumbnail' : '.mr-photos');
                    if (oldMedia && entry.photos === photos) node.querySelector(asRows ? '.rm-thumbnail' : '.mr-photos')?.replaceWith(oldMedia);
                    if (entry) { release(entry.node); entry.node.remove(); }
                    entry = { node, html, photos }; cache.set(id, entry);
                }
                if (!asRows) {
                    const action = entry.node.querySelector('[data-action]');
                    if (action) {
                        action.dataset.action = options.review ? 'review' : 'view';
                        const label = options.review ? 'Review Post' : 'View Details';
                        action.classList.toggle('rm-review-action', Boolean(options.review));
                        action.setAttribute('aria-label', `${label} for report ${id}`);
                        const content = options.review ? `<i class="bx bxs-file" aria-hidden="true"></i>${label}` : `${label}<i class="bx bx-right-arrow-alt" aria-hidden="true"></i>`;
                        if (action.innerHTML !== content) action.innerHTML = content;
                        if (options.review) action.dataset.reviewPost = id;
                        else delete action.dataset.reviewPost;
                    }
                }
                if (target.children[index] !== entry.node) target.insertBefore(entry.node, target.children[index] || null);
            }
        }
        function render(value = latest) {
            if (!value) return;
            latest = value;
            management?.toggleAttribute('data-review', Boolean(value.review));
            if (printButton) printButton.disabled = value.status !== 'ready' || !value.reports?.length;
            const asRows = mode === 'row' && !media.matches;
            const active = asRows ? body : list, inactive = asRows ? list : body;
            wrapper.hidden = !asRows; list.hidden = asRows;
            active.setAttribute('aria-busy', String(value.status === 'loading'));
            (asRows ? cardEntries : rowEntries).forEach(entry => release(entry.node));
            (asRows ? cardEntries : rowEntries).clear();
            inactive.replaceChildren();
            reconcile(active, value.reports || [], asRows, value);
            if (!value.reports?.length) {
                const message = value.message || (['loading', 'idle'].includes(value.status) ? 'Loading reports...' : value.status === 'error' ? 'Report data unavailable. Retry to refresh.' : 'No reports match these filters.');
                active.insertAdjacentHTML('beforeend', asRows ? `<tr data-list-message><td colspan="${columns.length}" class="portal-empty-state" role="status">${escape(message)}</td></tr>` : `<p data-list-message class="portal-empty-state" role="status">${escape(message)}</p>`);
            }
            root.ReportEvidence?.hydrate(active);
        }
        const toggle = root.PortalComponents.bindViewToggle(views, list, { storageKey, onToggle(value) { mode = value; render(); onMode(value); } });
        mode = toggle.current();
        const resize = () => render(); media.addEventListener('change', resize);
        function click(event) {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const row = event.target.closest('[data-report-id]');
            if (!row || ![body, list].some(element => element.contains(row))) return;
            const action = event.target.closest('[data-action], [data-review-post], [data-print-report]')
                || (list.contains(row) && !event.target.closest('a, button, input, select, textarea') && root.getSelection()?.isCollapsed
                    ? row.querySelector('.report-card-open') : null);
            if (!action) return;
            if (action.hasAttribute('data-print-report')) {
                const report = latest?.reports?.find(item => String(item.backendId ?? item.id) === row.dataset.reportId);
                if (report) printer.print(() => ({ entries: [printEntry(report)], title: 'Report details' }), action);
                return;
            }
            if (list.dataset.layout === 'split' && list.contains(row) && action.dataset.action !== 'view') return;
            if (action && action.tagName === 'A') {
                event.preventDefault();
            }
            onOpen(row.dataset.reportId, action, action.dataset.action === 'review' || action.dataset.reviewPost !== undefined);
        }
        section.addEventListener('click', click);
        const api = { render, mode: () => mode, destroy() { printer.destroy(); printFeedback.remove(); printButton?.removeEventListener('click', printAll); toggle.destroy(); media.removeEventListener('change', resize); section.removeEventListener('click', click); rowEntries.forEach(entry => release(entry.node)); rowEntries.clear(); cardEntries.forEach(entry => release(entry.node)); cardEntries.clear(); body.replaceChildren(); list.replaceChildren(); if (generated) wrapper.remove(); latest = null; tables.delete(list); } };
        tables.set(list, api); return api;
    }
    function split({ section, list, review = () => false, refresh = () => { } }) {
        const document = section.ownerDocument;
        let host = list.parentElement;
        if (!host.classList.contains('rm-split-host')) { host = document.createElement('div'); host.className = 'rm-split-host'; list.before(host); host.append(list); }
        let pane = host.querySelector('.rm-detail-pane');
        if (!pane) { pane = document.createElement('section'); pane.className = 'rm-detail-pane'; pane.setAttribute('aria-label', 'Selected report'); host.append(pane); }
        let controller = null, revision = 0, mounted = null, selected = null;
        function clear() { revision++; controller?.abort(); mounted?.destroy(); mounted = null; selected = null; pane.textContent = 'No report selected.'; }
        function synchronize() { const active = list.dataset.layout === 'split'; host.classList.toggle('is-split', active); pane.hidden = !active; if (!active || selected && ![...list.querySelectorAll('[data-report-id]')].some(node => node.dataset.reportId === selected)) clear(); }
        async function open(id) {
            clear(); selected = String(id); const version = revision;
            controller = new AbortController(); pane.textContent = 'Loading report details...';
            try {
                const data = await root.ReportDetailsApi.load(id, { api: root.neighborLensApiUrl, session: root.getSession(), signal: controller.signal });
                if (version !== revision) return;
                const view = review() ? root.CommunityPublication.view : root.ReportDetailsView;
                mounted = view.mount(pane, data, { role: root.getSession().role, apiBase: root.neighborLensApiUrl('/'), idPrefix: 'splitReport', onReview: async (status, note, action) => { await root.ReportMutations.update(id, status, note, action); await refresh(); if (version === revision) open(id); } });
                root.ReportEvidence?.hydrate(pane);
            } catch (error) { if (version === revision && error.name !== 'AbortError') pane.textContent = error.reportDetails ? error.message : 'Report details could not be loaded. Select the report to retry.'; }
        }
        function select(event) {
            if (list.dataset.layout !== 'split') return;
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const row = event.target.closest('[data-report-id]'); if (!row || !list.contains(row)) return;
            const action = event.target.closest('[data-action]');
            if (action?.dataset.action === 'view' || !action && event.target.closest('a, button, input, select, textarea')) return;
            event.preventDefault(); event.stopImmediatePropagation(); open(row.dataset.reportId);
        }
        const changed = event => { if (['report-dialog:opening', 'report-list:mode-changed', 'session:changed'].includes(event.type)) clear(); else if (selected && (!event.detail?.reportId || String(event.detail.reportId) === selected)) open(selected); };
        const events = ['report-dialog:opening', 'publication:changed', 'report-list:mode-changed', 'session:changed', 'reports_updated'];
        const observer = new MutationObserver(synchronize); observer.observe(list, { attributes: true, attributeFilter: ['data-layout'], childList: true });
        list.addEventListener('click', select, true); events.forEach(name => root.addEventListener(name, changed));
        synchronize();
        return { clear, destroy() { clear(); observer.disconnect(); list.removeEventListener('click', select, true); events.forEach(name => root.removeEventListener(name, changed)); } };
    }
    root.ReportManagement = { mount, adapt, split, createTable, columns: COLUMNS, portalColumns: PORTAL_COLUMNS };
})(window);
