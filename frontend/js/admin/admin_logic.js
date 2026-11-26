let _sharedAdminTable = null, _adminManagement = null;
// ============================================================
// ADMIN_LOGIC.JS — Admin Dashboard + Barangay Account Manager
// Only admin can create / edit / suspend barangay accounts
// ============================================================

const ADMIN_REPORT_FILTERS = Object.freeze({
    status: 'all', barangay: 'all', classification: 'all',
    priority: 'all', category: 'all', dateFrom: '', dateTo: '',
    search: '', sort: 'newest', publication: 'all'
});
let adminFilters = { ...ADMIN_REPORT_FILTERS };

const LEGACY_ACCOUNTS_KEY = 'up_users';
const AUDIT_LOG_REFRESH_MS = 30000;

let _editingUserId = null;
let _statusTarget = null;
let _accountSaving = false;
let _statusSaving = false;
let _officials = [];
let _officialsLoad = { status: 'idle', message: '' };
let _admins = [];
let _adminsLoad = { status: 'idle', message: '' };
let _canCreateAdmins = false;
let _adminRequests = [];
let _ownAccount = null;
let _accountMode = 'create-official';
let _accountTab = 'barangay';
let _accountPage = 1;
let _accountQuery = { search: '', status: 'all', sort: 'username' };
let _barangayCatalog = [];
let _auditLogTimer = null;
let _adminInitialized = false;
let _reportsPage = 1;
let _activeAdminSection = 'analyticsSection';
let _adminSectionShown = false;
let _adminSheets = null;
let _adminReportDialog = null;
let _publicationRequests = new Map();
let _publicationReload = false;
let _publicationLoading = false;
let _publicationReady = false;
let _reviewReports = [];
let _reviewLoad = { status: 'idle', message: '' };
let _reviewController = null;
let _reviewRevision = 0;
let _reviewNeedsLoad = false;
let _operationalFilters = null;
let _lastReportTab = null;
let REPORTS_PAGE_SIZE = 5;

function saveAdminView() {
    window.AdminViewStore?.save({
        section: _activeAdminSection, reportsPage: _reportsPage, reportsPageSize: REPORTS_PAGE_SIZE, reportFilters: adminFilters,
        accountTab: _accountTab, accountPage: _accountPage, accountQuery: _accountQuery
    });
}

function restoreAdminView() {
    const saved = window.AdminViewStore?.read();
    if (!saved) return;
    const merge = (defaults, value) => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof value[key] === typeof fallback ? value[key] : fallback]));
    _activeAdminSection = saved.section;
    _reportsPage = saved.reportsPage;
    REPORTS_PAGE_SIZE = saved.reportsPageSize;
    document.querySelector('#reportsSection [data-query="pageSize"]').value = String(REPORTS_PAGE_SIZE);
    adminFilters = merge(adminFilters, saved.reportFilters);
    if (adminFilters.publication === 'pending' && !saved.reportFilters.sort) adminFilters.sort = 'oldest';
    _accountTab = saved.accountTab;
    _accountPage = saved.accountPage;
    _accountQuery = merge(_accountQuery, saved.accountQuery);
    const controls = {
        accountSearch: _accountQuery.search, accountStatusFilter: _accountQuery.status, accountSort: _accountQuery.sort,
        adminSearch: adminFilters.search, adminFilterBarangay: adminFilters.barangay,
        adminFilterClassification: adminFilters.classification, adminFilterPriority: adminFilters.priority,
        adminFilterCategory: adminFilters.category, adminFilterSort: adminFilters.sort,
        adminFilterDateFrom: adminFilters.dateFrom, adminFilterDateTo: adminFilters.dateTo
    };
    for (const [id, value] of Object.entries(controls)) {
        const control = document.getElementById(id);
        if (control) control.value = value;
    }
    document.querySelectorAll('[data-admin-filter]').forEach(button => button.classList.toggle('active', button.dataset.adminFilter === adminFilters.status));
    window.setAccountTab(_accountTab, true);
}

function setupReportsPresentation() {
    _adminManagement = window.ReportManagement.mount({ section: document.querySelector('#reportsSection > .section-card'), role: 'admin' });
    const table = document.querySelector('#adminReportsBody').closest('.rm-report-table, .portal-table-wrap'); table.classList.add('rm-report-table');
    let cards = document.getElementById('adminReportCards');
    if (!cards) { cards = document.createElement('div'); cards.id = 'adminReportCards'; cards.className = 'rm-report-cards'; cards.hidden = true; table.after(cards); }
    try { if (!localStorage.getItem('neighborlens_admin_report_layout')) localStorage.setItem('neighborlens_admin_report_layout', 'row'); } catch { }
    _sharedAdminTable = window.ReportManagement.createTable({
        section: document.getElementById('reportsSection'), list: cards,
        table: table.querySelector('table'), columns: window.ReportManagement.portalColumns.admin, views: document.getElementById('adminViewToggle'),
        storageKey: 'neighborlens_admin_report_layout', apiBase: window.neighborLensApiUrl('/'),
        onOpen: (id, trigger, review) => review ? _adminReportDialog?.open(id, trigger, { review: true }) : window.location.assign(`report-details.html?id=${encodeURIComponent(id)}`)
    });
    window.addEventListener('pagehide', () => { _sharedAdminTable?.destroy(); _adminManagement?.destroy(); }, { once: true });
    const split = window.ReportManagement.split({ section: document.getElementById('reportsSection'), list: cards, review: () => adminFilters.publication === 'pending', refresh: () => refreshReports(true) });
    window.addEventListener('pagehide', () => split.destroy(), { once: true });
}
window.addEventListener('pageshow', event => { if (event.persisted) { setupReportsPresentation(); setupAdminFilters(); renderAdminReports(); } });

window.addEventListener('DOMContentLoaded', () => {
    if (_adminInitialized || window.NEIGHBORLENS_ACCESS_GRANTED === false) return;
    _adminInitialized = true;
    window.PortalComponents.mountReportSummary(document.querySelector('[data-report-summary="admin"]'), {
        total: () => showAdminSection('reportsSection'), pendingPosts: window.openPendingPosts
    });
    setupReportsPresentation();
    window.ReportExport?.bind(document.getElementById('adminExportReports'), () => { const { publication, ...filters } = adminFilters; return { ...filters, ...(publication === 'pending' ? { publication: 'pending_approval', status: 'all' } : {}) }; });
    restoreAdminView();
    renderAdminStats();
    renderAdminReports();
    loadBarangayCatalog();
    loadAccounts();
    loadAuditLogs();
    renderLegacyAccountsNotice();
    setupAdminFilters();
    window.StaffNotifications.setPublicationLabel(reportId => window.CommunityPublication.labels[_publicationRequests.get(reportId)?.state] || 'Open latest review');
    setupAdminSheets();
    setupAdminReportDialog();
    loadPublicationQueue();
    window.addEventListener('publication:changed', loadPublicationQueue);
    window.addEventListener('session:changed', () => {
        _reviewController?.abort(); ++_reviewRevision; _reviewReports = []; _publicationRequests.clear(); _publicationReady = false;
        _reviewLoad = { status: 'error', message: 'The session changed.' };
        document.getElementById('adminReportsBody').replaceChildren(); document.getElementById('adminReportCards').replaceChildren();
        window.PortalComponents.invalidate(document.getElementById('adminReportsBody')); window.PortalComponents.invalidate(document.getElementById('adminReportCards'));
        _adminReportDialog?.close();
    });
    window.addEventListener('admin:reports-changed', loadPublicationQueue);
    setupAdminGisResize();
    setupAccountFieldValidation();
    showAdminSection(_activeAdminSection, null, true);
    const restoreRoute = () => {
        const saved = window.AdminViewStore.read();
        if (saved.section === 'reportsSection' && saved.reportFilters.publication !== adminFilters.publication) setAdminReportMode(saved.reportFilters.publication, false);
        showAdminSection(saved.section, null, true);
    };
    window.addEventListener('hashchange', restoreRoute);
    window.addEventListener('popstate', restoreRoute);
    window.addEventListener('pagehide', saveAdminView);
    _auditLogTimer = setInterval(loadAuditLogs, AUDIT_LOG_REFRESH_MS);

    onReportsChanged(() => {
        loadPublicationQueue();
        renderAdminStats();
        renderAdminReports();
        renderBrgyAccounts();
        if (_activeAdminSection === 'gisMapSection') adminGisView?.refresh();
    });
});

// ── SECTION SWITCHER ──
window.showAdminSection = function (sectionId, liEl, restore = false) {
    if (window.AdminViewStore && !window.AdminViewStore.validSection(sectionId)) return;
    if (!document.getElementById(sectionId)) return;
    if (restore && _adminSectionShown && _activeAdminSection === sectionId) return;
    _activeAdminSection = sectionId;
    _adminSectionShown = true;
    if (document.documentElement) document.documentElement.dataset.adminSection = sectionId;
    const headings = { accountsSection: ['Barangay Management', 'Manage Barangay official accounts and administrator access.'], reportsSection: ['All Reports', 'Review operational progress and community publication requests.'], gisMapSection: ['GIS Map', 'Find reports by location, operational status, and damage classification.'], logsSection: ['System Activity Logs', 'Review recent account and system activity.'], analyticsSection: ['Analytics', 'Track report trends and damage categories across Bacolod City.'] };
    const [title, description] = headings[sectionId];
    setEl('adminPageTitle', title);
    setEl('adminPageDescription', description);
    if (!restore) window.AdminViewStore?.navigate(sectionId, false, adminFilters.publication);
    window.PortalSidebar?.get(document.querySelector('[data-portal-sidebar="admin"]'))?.activate(sectionId);
    if (sectionId === 'accountsSection') loadAccounts();
    if (sectionId === 'reportsSection') renderAdminReports();
    if (sectionId === 'gisMapSection') renderAdminGisMap();
    else adminGisView?.suspend();
    if (sectionId === 'logsSection') loadAuditLogs();
    saveAdminView();
};

// ── STATS ──

function getReportClassification(report) {
    const value = String(report?.aiClassification || report?.suggestedClassification || '')
        .trim()
        .toUpperCase();

    return value === 'MAJOR' || value === 'MINOR'
        ? value
        : 'UNCLASSIFIED';
}


function renderAdminStats() {
    const reports = getAllReports();
    const resolved = reports.filter(report => report.status === 'resolved').length;
    const load = typeof getReportLoadState === 'function' ? getReportLoadState() : { status: 'ready' };
    if (!reports.length && load.status !== 'ready') {
        for (const id of ['statTotal', 'statPending', 'statResolved', 'statMajor', 'statMinor']) setEl(id, '...');
        return;
    }
    setEl('statTotal', reports.length);
    setEl('statPending', reports.filter(r => r.status === 'pending').length);
    setEl('statResolved', resolved);

    setEl('statMajor', reports.filter(r =>
        getReportClassification(r) === 'MAJOR'
    ).length);

    setEl('statMinor', reports.filter(r =>
        getReportClassification(r) === 'MINOR'
    ).length);
}
function adminPage(rows, page, size) {
    return window.PortalComponents.page(rows, page, size);
}

function renderAdminPagination(prefix, page, size, noun) {
    window.PortalComponents.pagination(document, prefix, page, size, noun);
}

window.changeReportsPage = function (delta) { _reportsPage += delta; renderAdminReports(); };

function visionBadge(report) {
    return report.visionDetected && !report.originalAi
        ? `<span title="Detected by Vision AI" style="font-size:0.62rem; background:var(--color-accent-subtle); color:var(--accent-blue); padding:1px 5px; border-radius:6px;">AI</span>`
        : '';
}

// ─────────────────────────────────────────────────────────────
// BARANGAY ACCOUNT MANAGER
// ─────────────────────────────────────────────────────────────

async function loadBarangayCatalog() {
    const select = document.getElementById('accBarangay');
    try {
        const data = await window.apiRequest('/api/barangays', { auth: false });
        _barangayCatalog = Array.isArray(data.barangays) ? data.barangays : [];
        if (select) {
            select.innerHTML = '<option value="">Select barangay</option>' + _barangayCatalog
                .map(b => `<option value="${Number(b.id)}">${escapeAdminMapText(b.name)}</option>`)
                .join('');
        }
    } catch (error) {
        if (select) select.innerHTML = '<option value="">Barangay list unavailable. Reload to retry.</option>';
    }
}


function accountLoadState(tab) {
    return tab === 'admin' ? _adminsLoad : _officialsLoad;
}

function loadOfficials() {
    return window.PortalComponents.load(`officials:${getSession()?.apiToken}`, fetchOfficials);
}

async function fetchOfficials() {
    _officialsLoad = { status: 'loading', message: '' };
    if (!_officials.length) renderBrgyAccounts();
    try {
        const data = await window.apiRequest('/api/admin/barangay-users');
        _officials = Array.isArray(data.users) ? data.users : [];
        _officialsLoad = { status: 'ready', message: '' };
    } catch (error) {
        _officialsLoad = { status: 'error', message: error.message };
    }
    renderBrgyAccounts();
}

function loadAdministrators() {
    return window.PortalComponents.load(`administrators:${getSession()?.apiToken}`, fetchAdministrators);
}

async function fetchAdministrators() {
    _adminsLoad = { status: 'loading', message: '' };
    if (_accountTab === 'admin' && !_admins.length) renderBrgyAccounts();
    try {
        const data = await window.apiRequest('/api/admin/admins');
        _admins = Array.isArray(data.users) ? data.users : [];
        _canCreateAdmins = data.canCreateAdmins === true;
        _adminsLoad = { status: 'ready', message: '' };
    } catch (error) {
        _adminsLoad = { status: 'error', message: error.message };
    }
    const addAdminBtn = document.getElementById('addAdminBtn');
    if (addAdminBtn) addAdminBtn.hidden = !_canCreateAdmins;
    renderBrgyAccounts();
    loadAdminRequests();
}

async function loadAdminRequests() {
    const panel = document.getElementById('adminRequestsPanel');
    const list = document.getElementById('adminRequestsList');
    if (!panel || !list) return;
    if (!_canCreateAdmins) {
        _adminRequests = [];
        panel.style.display = 'none';
        return;
    }
    try {
        const data = await window.apiRequest('/api/admin/admin-access-requests');
        _adminRequests = Array.isArray(data.requests) ? data.requests : [];
    } catch (error) {
        panel.style.display = 'block';
        list.innerHTML = `<p style="font-size:0.82rem; color:var(--accent-pink);">${escapeAdminMapText(error.message || 'Requests could not be loaded.')}</p>`;
        return;
    }
    panel.style.display = _adminRequests.length ? 'block' : 'none';
    list.innerHTML = _adminRequests.map(request => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 0;">
            <div>
                <div style="font-weight:600; font-size:0.88rem;">${escapeAdminMapText(request.username)}
                    <span style="font-weight:400; color:var(--text-dim);">${escapeAdminMapText(request.fullName || '')}</span></div>
                <div style="font-size:0.75rem; color:var(--text-dim);">Requested ${escapeAdminMapText(formatDate(String(request.createdAt).replace(' ', 'T')))}${request.reason ? ` &middot; ${escapeAdminMapText(request.reason)}` : ''}</div>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="action-btn view-btn" onclick="openRequestDecisionModal(${Number(request.id)}, 'approve')">Approve</button>
                <button class="action-btn" style="background:var(--color-danger-subtle); color:var(--text-primary);" onclick="openRequestDecisionModal(${Number(request.id)}, 'reject')">Reject</button>
            </div>
        </div>`).join('');
}

window.openRequestDecisionModal = function (requestId, decision) {
    const request = _adminRequests.find(r => Number(r.id) === Number(requestId));
    if (!request) return;
    const approving = decision === 'approve';
    _statusTarget = { kind: 'request', id: request.id, decision };
    document.getElementById('statusModalTitle').textContent = approving ? 'Approve Administrator' : 'Reject Request';
    document.getElementById('statusModalTitle').style.color = approving ? 'var(--accent-blue)' : 'var(--accent-pink)';
    document.getElementById('deleteModalMsg').textContent = approving
        ? `Create administrator "${request.username}"? They will be able to sign in immediately with the password they chose, without permission to provision other administrators.`
        : `Reject the access request for "${request.username}"? No account will be created.`;
    const confirmBtn = document.getElementById('statusConfirmBtn');
    confirmBtn.textContent = approving ? 'Approve' : 'Reject';
    confirmBtn.style.background = approving ? 'var(--color-primary)' : 'var(--accent-pink)';
    confirmBtn.style.color = '#ffffff';
    document.getElementById('deleteModal').style.display = 'flex';
};

function loadAccounts() {
    loadOfficials();
    loadAdministrators();
}

window.setAccountTab = function (tab, preservePage = false) {
    _accountTab = tab === 'admin' ? 'admin' : 'barangay';
    if (!preservePage) _accountPage = 1;
    document.querySelectorAll('[data-account-tab]').forEach(button => {
        const active = button.dataset.accountTab === _accountTab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    setEl('accountsHeading', _accountTab === 'admin' ? 'Administrator Accounts' : 'Barangay Accounts');
    setEl('accountsSubheading', _accountTab === 'admin'
        ? 'Each administrator manages only their own account. Other administrators are shown read only.'
        : 'Only admin can create, edit, suspend, or reactivate barangay official accounts.');
    setEl('accountScopeColumn', _accountTab === 'admin' ? 'Permissions' : 'Assigned Barangay');
    renderBrgyAccounts();
    saveAdminView();
};

window.setAccountQuery = function (key, value) {
    _accountQuery = { ..._accountQuery, [key]: String(value || '') };
    _accountPage = 1;
    renderBrgyAccounts();
    saveAdminView();
    updateFilterCounts();
};

window.changeAccountPage = function (delta) {
    _accountPage = delta ? _accountPage + delta : 1;
    renderBrgyAccounts();
    saveAdminView();
};

function accountTime(value) {
    return Date.parse(String(value || '').replace(' ', 'T')) || 0;
}

function visibleAccounts() {
    const rows = _accountTab === 'admin' ? _admins : _officials;
    const search = _accountQuery.search.trim().toLowerCase();
    const filtered = rows.filter(u => {
        if (_accountQuery.status !== 'all' && u.status !== _accountQuery.status) return false;
        if (!search) return true;
        return [u.username, u.fullName, u.barangay].some(value => String(value || '').toLowerCase().includes(search));
    });
    const byText = key => (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''));
    const sorters = {
        username: byText('username'),
        barangay: (a, b) => byText('barangay')(a, b) || byText('username')(a, b),
        newest: (a, b) => accountTime(b.createdAt) - accountTime(a.createdAt),
        oldest: (a, b) => accountTime(a.createdAt) - accountTime(b.createdAt)
    };
    return filtered.sort(sorters[_accountQuery.sort] || sorters.username);
}

function officialStatusBadge(status) {
    const active = status === 'active';
    return `<span style="color:${active ? 'var(--accent-green)' : 'var(--accent-pink)'}; background:${active ? 'var(--color-success-subtle)' : 'var(--color-danger-subtle)'};
                 padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600;">${active ? 'Active' : 'Suspended'}</span>`;
}

function accountIdentityCell(u, badge = '') {
    return `
            <td data-label="Account">
                <div class="portal-cell-content" style="display:flex; align-items:center; gap:8px;">
                    <div style="width:32px; height:32px; border-radius:8px; display:flex; align-items:center;
                                justify-content:center; font-size:1rem;
                                background:var(--color-accent-subtle);">
                        <i class='bx ${u.role === 'admin' ? 'bxs-shield' : 'bxs-user'}' aria-hidden="true"></i>
                    </div>
                    <div style="min-width:0; overflow-wrap:anywhere;">
                        <div style="font-weight:600; font-size:0.88rem;">${escapeAdminMapText(u.username)}${badge}</div>
                        <div style="font-size:0.72rem; color:var(--text-dim);">${escapeAdminMapText(u.fullName || `ID ${u.id}`)}</div>
                    </div>
                </div>
            </td>`;
}

function officialRow(u, reports) {
    const reportCount = reports.filter(r => r.barangay === u.barangay).length;
    const suspended = u.status !== 'active';
    return `
        <tr>
            ${accountIdentityCell(u)}
            <td data-label="Barangay">
                <div class="portal-cell-content">
                <span style="color:${'var(--accent-blue)'}; font-weight:600; font-size:0.85rem;">
                    ${escapeAdminMapText(u.barangay || '')}
                </span>
                <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">${reportCount} reports</div>
                </div>
            </td>
            <td data-label="Created" style="font-size:0.78rem; color:var(--text-dim);">${formatDate(String(u.createdAt).replace(" ", "T"))}</td>
            <td data-label="Status">${officialStatusBadge(u.status)}</td>
            <td data-label="Actions">
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="action-btn view-btn" onclick="viewAccountDetails('barangay', ${Number(u.id)})">View</button>
                    <button class="action-btn view-btn" onclick="openEditAccountModal(${Number(u.id)})">
                        Edit
                    </button>
                    <button class="action-btn" style="background:${suspended ? 'var(--color-danger-subtle)' : 'var(--surface)'}; color:${suspended ? 'var(--color-status-rejected)' : 'var(--text-primary)'};"
                            onclick="openAccountStatusModal(${Number(u.id)})">
                        ${suspended ? 'Reactivate' : 'Suspend'}
                    </button>
                </div>
            </td>
        </tr>`;
}

function permissionSummary(u) {
    return Array.isArray(u.permissions) && u.permissions.length
        ? u.permissions.map(p => p === 'admin:create' ? 'Can provision administrators' : escapeAdminMapText(p)).join(', ')
        : 'Standard administrator';
}

function adminRow(u) {
    const youBadge = u.isSelf
        ? ' <span style="font-size:0.65rem; color:var(--accent-blue); background:var(--color-accent-subtle); padding:1px 6px; border-radius:8px;">You</span>'
        : '';
    return `
        <tr>
            ${accountIdentityCell(u, youBadge)}
            <td data-label="Permissions" style="font-size:0.8rem;">${permissionSummary(u)}</td>
            <td data-label="Created" style="font-size:0.78rem; color:var(--text-dim);">${formatDate(String(u.createdAt).replace(" ", "T"))}</td>
            <td data-label="Status">${officialStatusBadge(u.status)}</td>
            <td data-label="Actions">
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="action-btn view-btn" onclick="viewAccountDetails('admin', ${Number(u.id)})">View</button>
                    ${u.isSelf
            ? `<button class="action-btn view-btn" onclick="openOwnAccountModal()">Manage my account</button>`
            : `<span style="font-size:0.72rem; color:var(--text-dim); align-self:center;">Read only</span>`}
                </div>
            </td>
        </tr>`;
}

function renderAccountPagination(rows = []) {
    const size = Number(document.getElementById('accountPageSize').value);
    const page = adminPage(rows, _accountPage, size);
    window.PortalComponents.pagination(document, 'account', page, size, 'accounts', { previous: 'accountPrevPage', next: 'accountNextPage' });
    return page;
}

function renderBrgyAccounts() {
    const tbody = document.getElementById('brgyAccountsBody');
    if (!tbody) return;
    const load = accountLoadState(_accountTab);
    const retry = _accountTab === 'admin' ? 'loadAdministrators()' : 'loadOfficials()';
    const sourceRows = _accountTab === 'admin' ? _admins : _officials;

    if (load.status === 'error') {
        window.PortalComponents.render(tbody, `
            <tr><td colspan="5" class="portal-table-state" data-tone="error">
                ${escapeAdminMapText(load.message || 'Accounts could not be loaded.')}
                <div><button type="button" class="portal-text-button" onclick="${retry}">Retry</button></div>
            </td></tr>`);
        renderAccountPagination();
        return;
    }

    if (!sourceRows.length) {
        window.PortalComponents.render(tbody, load.status === 'ready'
            ? `<tr><td colspan="5" class="portal-table-state">
                ${_accountTab === 'admin' ? 'No administrator accounts found.' : 'No barangay accounts yet. Click <strong>Add Barangay Account</strong> to create one.'}
            </td></tr>`
            : `<tr><td colspan="5" class="portal-table-state" role="status">Loading…</td></tr>`);
        renderAccountPagination();
        return;
    }

    const rows = visibleAccounts();
    const page = renderAccountPagination(rows);
    _accountPage = page.page;
    saveAdminView();
    const pageRows = page.items;

    if (!rows.length) {
        window.PortalComponents.render(tbody, `<tr><td colspan="5" class="portal-table-state">No accounts match the current search or filters.</td></tr>`);
        return;
    }

    const reports = getAllReports();
    window.PortalComponents.render(tbody, pageRows.map(u => _accountTab === 'admin' ? adminRow(u) : officialRow(u, reports)).join(''));
}

window.viewAccountDetails = function (kind, userId) {
    const user = (kind === 'admin' ? _admins : _officials).find(u => Number(u.id) === Number(userId));
    const modal = document.getElementById('dataModal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!user || !modal || !body || !title) return;
    const field = (label, value) => `<div><span style="color:var(--text-dim); font-size:0.72rem; text-transform:uppercase;">${label}</span><br>${value}</div>`;
    title.textContent = `${user.role === 'admin' ? 'Administrator' : 'Barangay Official'}: ${user.username}`;
    body.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; font-size:0.87rem;">
            ${field('User ID', `<code>${Number(user.id)}</code>`)}
            ${field('Username', escapeAdminMapText(user.username))}
            ${field('Full name', escapeAdminMapText(user.fullName || 'Not set'))}
            ${field('Status', officialStatusBadge(user.status))}
            ${user.role === 'admin'
            ? field('Permissions', permissionSummary(user))
            : field('Assigned barangay', escapeAdminMapText(user.barangay || 'Not assigned'))}
            ${field('Created', escapeAdminMapText(formatDate(String(user.createdAt).replace(' ', 'T'))))}
            ${field('Last updated', escapeAdminMapText(user.updatedAt ? formatDate(String(user.updatedAt).replace(' ', 'T')) : 'Never'))}
            ${field('Record version', Number(user.version))}
        </div>
        ${user.role === 'admin' && !user.isSelf
            ? '<p style="margin-top:14px; font-size:0.8rem; color:var(--text-dim);">Administrator accounts can only be changed by their own owner. Lost access is handled through the audited recovery procedure.</p>'
            : ''}`;
    modal.style.display = 'flex';
};

function legacyAccounts() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LEGACY_ACCOUNTS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(u => u && u.role === 'barangay') : [];
    } catch {
        return [];
    }
}

function renderLegacyAccountsNotice() {
    const notice = document.getElementById('legacyAccountsNotice');
    if (!notice) return;
    const legacy = legacyAccounts();
    if (!legacy.length) {
        notice.style.display = 'none';
        notice.innerHTML = '';
        return;
    }
    notice.style.display = 'block';
    notice.style.cssText += 'padding:12px 14px; border-radius:8px; font-size:0.82rem; background:var(--color-warning-subtle); color:var(--text-primary);';
    notice.innerHTML = `
        <strong>${legacy.length} browser-only account${legacy.length === 1 ? '' : 's'} found from the old account manager.</strong>
        They were never saved to the server and cannot sign in:
        ${legacy.map(u => `${escapeAdminMapText(u.username)} (${escapeAdminMapText(u.barangay || 'no barangay')})`).join(', ')}.
        Recreate each one with <strong>Add Barangay Account</strong> and a new password, then clear this list.
        <div style="margin-top:8px;"><button class="action-btn view-btn" onclick="clearLegacyAccounts()">Clear browser-only list</button></div>`;
}

window.clearLegacyAccounts = function () {
    try { localStorage.removeItem(LEGACY_ACCOUNTS_KEY); } catch { }
    renderLegacyAccountsNotice();
};

function findOfficial(userId) {
    return _officials.find(u => Number(u.id) === Number(userId)) || null;
}

// ── ACCOUNT MODAL ──
function setAccountModalLayout({ title, mode, username = '', usernameLocked = false, fullName = '', barangayId = '', showBarangay, showCurrentPassword, passwordLabel, passwordHint, passwordPlaceholder }) {
    _accountMode = mode;
    document.getElementById('accountModalTitle').textContent = title;
    const usernameInput = document.getElementById('accUsername');
    usernameInput.value = username;
    usernameInput.disabled = usernameLocked;
    document.getElementById('accFullName').value = fullName;
    document.getElementById('accBarangay').value = barangayId;
    document.getElementById('accBarangayGroup').style.display = showBarangay ? '' : 'none';
    document.getElementById('accCurrentPassGroup').style.display = showCurrentPassword ? '' : 'none';
    document.getElementById('accCurrentPassword').value = '';
    document.getElementById('accPassword').value = '';
    document.getElementById('accPasswordConfirm').value = '';
    document.getElementById('accPassword').placeholder = passwordPlaceholder;
    document.getElementById('accPassLabel').textContent = passwordLabel;
    const hint = document.getElementById('accPassHint');
    hint.textContent = passwordHint || '';
    hint.style.display = passwordHint ? 'block' : 'none';
    showAccountMsg('', 'clear');
    showAccountFieldErrors();
    document.getElementById('accountModal').style.display = 'flex';
}

window.openCreateAccountModal = function () {
    _editingUserId = null;
    setAccountModalLayout({
        title: 'Add Barangay Account', mode: 'create-official', showBarangay: true, showCurrentPassword: false,
        passwordLabel: 'Password', passwordHint: '', passwordPlaceholder: 'Min. 8 characters with letters and numbers'
    });
};

window.openEditAccountModal = function (userId) {
    const user = findOfficial(userId);
    if (!user) return;
    _editingUserId = user.id;
    setAccountModalLayout({
        title: 'Edit Barangay Account', mode: 'edit-official', username: user.username, usernameLocked: true,
        fullName: user.fullName || '', barangayId: user.barangayId ? String(user.barangayId) : '',
        showBarangay: true, showCurrentPassword: false, passwordLabel: 'New Password',
        passwordHint: 'Leave blank to keep the current password. Entering a new one resets it and signs the official out.',
        passwordPlaceholder: 'Min. 8 characters with letters and numbers'
    });
};

window.openCreateAdminModal = function () {
    if (!_canCreateAdmins) return;
    _editingUserId = null;
    setAccountModalLayout({
        title: 'Add Administrator', mode: 'create-admin', showBarangay: false, showCurrentPassword: false,
        passwordLabel: 'Password',
        passwordHint: 'The new administrator manages only their own account and cannot provision other administrators.',
        passwordPlaceholder: 'Min. 12 characters with letters and numbers'
    });
};

window.openOwnAccountModal = async function () {
    _editingUserId = null;
    try {
        const { user } = await window.apiRequest('/api/auth/me/account');
        _ownAccount = user;
        setAccountModalLayout({
            title: 'My Account', mode: 'self', username: user.username, usernameLocked: true, fullName: user.fullName || '',
            showBarangay: false, showCurrentPassword: true, passwordLabel: 'New Password',
            passwordHint: 'Leave the password fields blank to keep your password. Changing it signs out your other sessions.',
            passwordPlaceholder: 'Min. 12 characters with letters and numbers'
        });
    } catch (error) {
        showAccountsBanner(error.message || 'Your account could not be loaded.');
    }
};

function showAccountsBanner(message) {
    const notice = document.getElementById('legacyAccountsNotice');
    if (!notice) return;
    notice.style.display = 'block';
    notice.dataset.tone = 'error';
    notice.textContent = message;
}

function checkPasswordPolicy(password, minLength) {
    if (password.length < minLength) return `Password must be at least ${minLength} characters.`;
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number.';
    return null;
}

function accountFormErrors({ mode, username, barangayId, password, currentPassword, confirmation }) {
    const creating = mode === 'create-official' || mode === 'create-admin';
    const errors = {};
    if (creating && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) {
        errors.accUsername = 'Username must be 3 to 64 characters using letters, numbers, dots, dashes, or underscores.';
    }
    if ((mode === 'create-official' || mode === 'edit-official') && !barangayId) errors.accBarangay = 'Please assign a barangay.';
    if (mode === 'self' && password && !currentPassword) errors.accCurrentPassword = 'Enter your current password to set a new one.';
    const minimum = mode === 'create-admin' || mode === 'self' ? 12 : 8;
    const passwordError = (mode === 'create-admin' || creating || password) ? checkPasswordPolicy(password, minimum) : null;
    if (passwordError) errors.accPassword = passwordError;
    if ((password || confirmation) && password !== (confirmation ?? '')) errors.accPasswordConfirm = 'Passwords do not match.';
    return errors;
}

function validateAccountForm(fields) {
    return Object.values(accountFormErrors(fields))[0] || null;
}

const ACCOUNT_FIELD_IDS = Object.freeze(['accUsername', 'accBarangay', 'accCurrentPassword', 'accPassword', 'accPasswordConfirm']);

function showAccountFieldErrors(errors = {}) {
    ACCOUNT_FIELD_IDS.forEach(id => {
        const field = document.getElementById(id);
        const message = document.getElementById(`${id}Error`);
        const text = errors[id] || '';
        if (field && text) field.setAttribute?.('aria-invalid', 'true');
        else field?.removeAttribute?.('aria-invalid');
        if (message) { message.textContent = text; message.hidden = !text; }
    });
    const first = ACCOUNT_FIELD_IDS.find(id => errors[id]);
    if (first) document.getElementById(first)?.focus?.();
}

function replaceStoredToken(result) {
    if (!result?.token) return;
    try {
        const stored = JSON.parse(sessionStorage.getItem('up_session'));
        sessionStorage.setItem('up_session', JSON.stringify({ ...stored, apiToken: result.token }));
    } catch { }
}

async function saveOwnAccount({ fullName, password, currentPassword }) {
    let version = _ownAccount.version;
    const changes = [];
    if (fullName !== (_ownAccount.fullName || '')) {
        const { user } = await window.apiRequest('/api/auth/me/account', { method: 'PATCH', body: { fullName, version } });
        version = user.version;
        changes.push('name');
    }
    if (password) {
        replaceStoredToken(await window.apiRequest('/api/auth/me/password', {
            method: 'POST',
            body: { currentPassword, newPassword: password, version }
        }));
        changes.push('password');
    }
    return changes;
}

// ── SAVE ACCOUNT ──
window.saveBarangayAccount = async function () {
    if (_accountSaving) return;
    const mode = _accountMode;
    const username = document.getElementById('accUsername').value.trim();
    const fullName = document.getElementById('accFullName').value.trim();
    const barangayId = document.getElementById('accBarangay').value;
    const password = document.getElementById('accPassword').value;
    const currentPassword = document.getElementById('accCurrentPassword').value;

    const confirmation = document.getElementById('accPasswordConfirm').value;
    const errors = accountFormErrors({ mode, username, barangayId, password, currentPassword, confirmation });
    showAccountFieldErrors(errors);
    const invalid = Object.values(errors)[0];
    if (invalid) { showAccountMsg(invalid, 'error'); return; }

    const saveBtn = document.getElementById('accSaveBtn');
    _accountSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    showAccountMsg('Saving…', 'success');

    try {
        if (mode === 'create-official') {
            await window.apiRequest('/api/admin/barangay-users', {
                method: 'POST',
                body: { username, password, fullName, barangayId: Number(barangayId) }
            });
            showAccountMsg('Barangay account created.', 'success');
        } else if (mode === 'create-admin') {
            await window.apiRequest('/api/admin/admins', { method: 'POST', body: { username, password, fullName } });
            showAccountMsg('Administrator account created.', 'success');
        } else if (mode === 'self') {
            const changes = await saveOwnAccount({ fullName, password, currentPassword });
            showAccountMsg(changes.length ? `Your ${changes.join(' and ')} ${changes.length > 1 ? 'were' : 'was'} updated.` : 'No changes to save.', 'success');
        } else {
            const id = _editingUserId;
            const current = findOfficial(id);
            const { user } = await window.apiRequest(`/api/admin/barangay-users/${id}`, {
                method: 'PATCH',
                body: { fullName, barangayId: Number(barangayId), version: current.version }
            });
            if (password) {
                await window.apiRequest(`/api/admin/barangay-users/${id}/password`, {
                    method: 'POST',
                    body: { password, version: user.version }
                });
            }
            showAccountMsg(password ? 'Account updated and password reset.' : 'Account updated.', 'success');
        }
        document.getElementById('accPassword').value = '';
        document.getElementById('accPasswordConfirm').value = '';
        document.getElementById('accCurrentPassword').value = '';
        loadAdministrators();
        await loadOfficials();
        loadAuditLogs();
        setTimeout(() => window.closeAccountModal(), 900);
    } catch (error) {
        const hint = error.status === 409 ? ' The list has been reloaded.' : '';
        showAccountMsg(`${error.message || 'The account could not be saved.'}${hint}`, 'error');
        if (error.status === 409 || error.status === 404) loadAccounts();
    } finally {
        _accountSaving = false;
        if (saveBtn) saveBtn.disabled = false;
    }
};

// ── SUSPEND / REACTIVATE MODAL ──
window.openAccountStatusModal = function (userId) {
    const user = findOfficial(userId);
    if (!user) return;
    const nextStatus = user.status === 'active' ? 'suspended' : 'active';
    _statusTarget = { id: user.id, nextStatus, version: user.version };
    const suspending = nextStatus === 'suspended';

    document.getElementById('statusModalTitle').textContent = suspending ? 'Suspend Account' : 'Reactivate Account';
    document.getElementById('deleteModalMsg').textContent = suspending
        ? `Suspend "${user.username}" (${user.barangay})? The official is signed out immediately and cannot sign in until reactivated. Reports and history are kept.`
        : `Reactivate "${user.username}" (${user.barangay})? The official will be able to sign in again.`;
    const confirmBtn = document.getElementById('statusConfirmBtn');
    confirmBtn.textContent = suspending ? 'Suspend' : 'Reactivate';
    document.getElementById('deleteModal').style.display = 'flex';
};

window.confirmAccountStatus = async function () {
    if (!_statusTarget || _statusSaving) return;
    const { id, nextStatus, version, kind, decision } = _statusTarget;
    const confirmBtn = document.getElementById('statusConfirmBtn');
    _statusSaving = true;
    if (confirmBtn) confirmBtn.disabled = true;
    if (kind === 'request') {
        try {
            await window.apiRequest(`/api/admin/admin-access-requests/${id}/${decision}`, { method: 'POST', body: {} });
            window.closeDeleteModal();
            await loadAdministrators();
            loadAuditLogs();
        } catch (error) {
            document.getElementById('deleteModalMsg').textContent = error.message || 'The request could not be updated.';
            if (error.status === 409 || error.status === 404) loadAdminRequests();
        } finally {
            _statusSaving = false;
            if (confirmBtn) confirmBtn.disabled = false;
        }
        return;
    }
    try {
        await window.apiRequest(`/api/admin/barangay-users/${id}/status`, {
            method: 'PATCH',
            body: { status: nextStatus, version }
        });
        window.closeDeleteModal();
        await loadOfficials();
        loadAuditLogs();
    } catch (error) {
        document.getElementById('deleteModalMsg').textContent = error.message || 'The account status could not be changed.';
        if (error.status === 409 || error.status === 404) loadOfficials();
    } finally {
        _statusSaving = false;
        if (confirmBtn) confirmBtn.disabled = false;
    }
};

window.closeAccountModal = function () {
    document.getElementById('accountModal').style.display = 'none';
    _editingUserId = null;
};
window.closeDeleteModal = function () {
    document.getElementById('deleteModal').style.display = 'none';
    _statusTarget = null;
};

function showAccountMsg(msg, type) {
    const el = document.getElementById('accountFormMsg');
    if (!el) return;
    if (type === 'clear' || !msg) { el.style.display = 'none'; el.dataset.tone = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
    el.dataset.tone = type === 'error' ? 'error' : 'success';
}

// ── ALL REPORTS TABLE ──
function adminReportThumbnail(report) {
    const source = report.images?.[0] || report.image;
    const image = source && window.ReportPresentation?.imageUrl(source, window.neighborLensApiUrl ? window.neighborLensApiUrl('/') : '/');
    return `<span class="admin-report-thumbnail" role="img" aria-label="${image ? 'Submitted report evidence' : 'Evidence photo unavailable'}"><i class="bx bx-image-alt" aria-hidden="true"></i>${image ? `<img data-evidence-url="${escapeAdminMapText(image)}" data-evidence-report="${escapeAdminMapText(report.backendId)}" data-evidence-order="1" alt="" loading="lazy" width="72" height="54" referrerpolicy="no-referrer">` : ''}</span>`;
}

function hasActiveAdminFilters() {
    return adminFilters.status !== 'all' ||
        adminFilters.barangay !== 'all' ||
        adminFilters.classification !== 'all' ||
        adminFilters.priority !== 'all' ||
        adminFilters.category !== 'all' ||
        adminFilters.publication === 'pending' ||
        Boolean(adminFilters.dateFrom) ||
        Boolean(adminFilters.dateTo) ||
        Boolean(adminFilters.search?.trim()) ||
        adminFilters.sort !== 'newest';
}

function syncAdminClearFiltersButton() {
    const btn = document.getElementById('adminClearFiltersBtn');
    if (btn) btn.disabled = !hasActiveAdminFilters();
}

function renderAdminReports() {
    const reviewOnly = adminFilters.publication === 'pending';
    const base = reviewOnly ? _reviewReports : getAllReports();
    const timed = reviewOnly ? base.map(report => { const requested = _publicationRequests.get(Number(report.backendId ?? report.id))?.requestedAt || report.createdAt; return { ...report, createdAt: requested, created_at: requested }; }) : base;
    const reports = filterReports(timed, reviewOnly ? { ...adminFilters, status: 'all' } : adminFilters);
    if (reviewOnly) reports.sort((a, b) => {
        const direction = adminFilters.sort === 'newest' ? -1 : 1;
        const priority = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        return (adminFilters.sort === 'priority' ? (priority[a.aiPriority] ?? 4) - (priority[b.aiPriority] ?? 4) : 0) || direction * (new Date(a.createdAt) - new Date(b.createdAt) || Number(a.backendId) - Number(b.backendId));
    });
    const tbody = document.getElementById('adminReportsBody');
    if (!tbody) return;
    setEl('adminReportsTitle', reviewOnly ? 'Community Publication Review' : 'All Reports');
    setEl('adminReportsSubtitle', reviewOnly ? 'Awaiting Admin publication approval' : 'Infrastructure reports');
    const dateHeading = document.querySelector('#reportsSection th[data-column="date"]'); if (dateHeading) dateHeading.textContent = reviewOnly ? 'Requested' : 'Date';
    const counts = getAllReports().reduce((counts, report) => { counts[report.status] = (counts[report.status] || 0) + 1; return counts; }, {});
    document.querySelectorAll('[data-admin-filter]').forEach(button => {
        const key = button.dataset.adminFilter, active = reviewOnly ? key === 'community-review' : key === adminFilters.status;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
        const labels = { all: 'All Reports', pending: 'Pending', ongoing: 'Ongoing', resolved: 'Resolved', rejected: 'Rejected', 'community-review': 'Community Review' };
        const count = key === 'all' ? getAllReports().length : key === 'community-review' ? [..._publicationRequests.values()].filter(row => row.state === 'pending_approval').length : counts[key] || 0;
        button.textContent = `${labels[key]} (${count})`;
        if (active && _lastReportTab !== key) {
            _lastReportTab = key;
            requestAnimationFrame(() => { const tabs = button.parentElement; tabs.scrollLeft += button.getBoundingClientRect().left - tabs.getBoundingClientRect().left; });
        }
    });
    syncAdminClearFiltersButton();
    const load = reviewOnly ? _reviewLoad : typeof getReportLoadState === 'function' ? getReportLoadState() : { status: 'ready' };
    const feedback = document.getElementById('adminReportsFeedback');
    if (feedback) {
        feedback.hidden = load.status !== 'error';
        window.PortalComponents.render(feedback, load.status === 'error' ? `${escapeAdminMapText(load.message || 'Reports could not be loaded.')}${base.length ? ' Showing the last successfully loaded data.' : ''}<button type="button" class="portal-text-button" onclick="refreshReports()">Retry</button>` : '');
    }
    if ((reviewOnly && load.status !== 'ready' && !base.length) || (!base.length && ['idle', 'loading'].includes(load.status))) {
        setEl('adminReportCount', 'Loading reports...');
        ['reportsPrev', 'reportsNext'].forEach(id => { const button = document.getElementById(id); if (button) button.disabled = true; });
        const message = load.status === 'error' ? 'Pending posts could not be loaded. Retry the Pending Posts card.' : 'Loading reports...';
        if (_sharedAdminTable) {
            _sharedAdminTable.render({ reports: [], status: load.status, message });
        } else if (tbody) {
            window.PortalComponents.render(tbody, `<tr><td colspan="9" class="portal-table-state" role="status">${message}</td></tr>`);
        }
        return;
    }
    if (reviewOnly && !_publicationReady && !base.length) {
        setEl('adminReportCount', _publicationLoading ? 'Loading pending posts...' : 'Pending posts unavailable');
        const msg = _publicationLoading ? 'Loading pending posts...' : 'Pending posts could not be loaded. Retry the Pending Posts card.';
        if (_sharedAdminTable) {
            _sharedAdminTable.render({ reports: [], status: 'loading', message: msg });
        } else if (tbody) {
            window.PortalComponents.render(tbody, `<tr><td colspan="9" class="portal-table-state" role="status">${msg}</td></tr>`);
        }
        ['reportsPrev', 'reportsNext'].forEach(id => { document.getElementById(id).disabled = true; });
        return;
    }
    const page = adminPage(reports, _reportsPage, REPORTS_PAGE_SIZE);
    if (load.status === 'ready' || base.length) _reportsPage = page.page;
    renderAdminPagination('reports', page, REPORTS_PAGE_SIZE, 'reports');

    const countEl = document.getElementById('adminReportCount');
    if (countEl) countEl.textContent = reviewOnly ? `${reports.length}${reports.length === base.length ? '' : ` of ${base.length}`} pending posts` : reports.length === base.length ? `${base.length} reports` : `${reports.length} of ${base.length}`;

    if (_sharedAdminTable) {
        _sharedAdminTable.render({
            reports: page.items, matchingReports: reports, status: load.status, review: reviewOnly,
            publicationLabel: report => window.CommunityPublication?.labels?.[_publicationRequests.get(Number(report.backendId ?? report.id))?.state || 'unshared'] || 'Not shared',
            ...(!reports.length && reviewOnly ? { message: 'No pending posts awaiting review.' } : {})
        });
    } else if (tbody) {
        if (reports.length === 0) {
            const message = load.status === 'error'
                ? escapeAdminMapText(load.message || 'Reports could not be loaded.')
                : base.length === 0 && load.status !== 'ready' ? 'Loading reports…' : reviewOnly ? 'No pending posts awaiting review.' : 'No reports match filters.';
            window.PortalComponents.render(tbody, `<tr><td colspan="9" class="portal-table-state"${load.status === 'error' ? ' data-tone="error"' : ''}>${message}</td></tr>`);
        } else {
            window.PortalComponents.render(tbody, page.items.map(r => `
                <tr>
                    <td data-label="Date" class="report-cell-date">${formatDate(r.createdAt)}</td>
                    <td data-label="Photo" class="report-cell-photo">${reportDetailsUrl(r) ? `<a href="${reportDetailsUrl(r)}" aria-label="View evidence for report ${escapeAdminMapText(r.id)}">${adminReportThumbnail(r)}</a>` : adminReportThumbnail(r)}</td>
                    <td data-label="Issue" class="report-cell-issue"><div class="portal-cell-content">
                        <div class="report-issue-title">
                            <strong>${window.ReportCard ? window.ReportCard.categoryIcon(r) : ''}${escapeAdminMapText(r.citizenCategory || (window.ReportCard ? window.ReportCard.displayTitle(r) : r.title || ''))}</strong><small>#${Number(r.backendId ?? r.id)}</small>
                            ${visionBadge(r)}
                        </div>
                        ${reportCategoryOriginMarkup(r)}
                        <p class="report-issue-description">${escapeAdminMapText(r.description || '')}</p>
                    </div></td>
                    <td data-label="Barangay" class="report-cell-barangay">${escapeAdminMapText(r.barangay)}</td>
                    <td data-label="Class" class="report-cell-class">${classificationBadge(r.aiClassification)}</td>
                    <td data-label="Priority" class="report-cell-priority">${priorityBadge(r.aiPriority)}</td>
                    <td data-label="Operational status" class="report-cell-status">${statusBadge(r.status)}</td>
                    <td data-label="Publication status">${escapeAdminMapText(window.CommunityPublication?.labels?.[_publicationRequests.get(Number(r.backendId ?? r.id))?.state || 'unshared'] || 'Not shared')}</td>
                    <td data-label="Actions" class="report-cell-actions"><div class="rm-row-actions">${reportDetailsUrl(r) ? `<a class="action-btn view-btn" href="${reportDetailsUrl(r)}" title="View Details" aria-label="View report ${escapeAdminMapText(r.id)}">${reviewOnly ? '<i class="bx bx-show" aria-hidden="true"></i>' : 'View Details'}</a>${reviewOnly ? `<button type="button" class="portal-button-secondary rm-review-action" data-review-post="${Number(r.backendId ?? r.id)}"><i class="bx bxs-file" aria-hidden="true"></i>Review Post</button>` : ''}` : 'Saving'}</div></td>
                </tr>`).join(''));
        }
    }
    saveAdminView();
}

function adminViewReport(id, trigger = null) {
    const report = getAuthorizedReport(id, 'admin');
    const url = report && reportDetailsUrl(report);
    if (!url) return;
    const backendId = window.ReportDialog?.reportIdFromLink({ getAttribute: () => url });
    if (!_adminReportDialog?.open(backendId, trigger)) window.location.href = url;
}

async function loadPublicationQueue() {
    if (getSession()?.role !== 'admin') return;
    if (_publicationLoading) { _publicationReload = true; return; }
    _publicationLoading = true;
    document.getElementById('pendingPostsCard')?.setAttribute('aria-busy', 'true');
    const actor = getSession()?.apiToken;
    try {
        const result = await window.apiRequest('/api/admin/community-publications');
        if (getSession()?.apiToken !== actor) return;
        _publicationRequests = new Map(result.requests.map(row => [row.reportId, row]));
        _publicationReady = true;
        setEl('statPendingPosts', result.pendingCount);
        setEl('pendingPostsHint', 'Awaiting review');
        if (adminFilters.publication === 'pending') { _reviewNeedsLoad = false; loadAdminReviewReports(); }
    } catch (error) {
        if (getSession()?.apiToken === actor) { _publicationReady = false; _reviewLoad = { status: 'error', message: error.message }; setEl('statPendingPosts', 'Unavailable'); setEl('pendingPostsHint', 'Retry review queue'); }
    } finally {
        _publicationLoading = false;
        if (adminFilters.publication === 'pending' && _reviewNeedsLoad && _publicationReady) { _reviewNeedsLoad = false; loadAdminReviewReports(); }
        document.getElementById('pendingPostsCard')?.setAttribute('aria-busy', 'false');
        renderAdminReports();
        window.StaffNotifications.render();
        if (_publicationReload) { _publicationReload = false; loadPublicationQueue(); }
    }
}

async function loadAdminReviewReports() {
    const revision = ++_reviewRevision, actor = getSession()?.apiToken;
    _reviewController?.abort(); _reviewController = new AbortController();
    _reviewLoad = { status: 'loading', message: '' }; renderAdminReports();
    try {
        const result = await window.apiRequest('/api/reports?publication=pending_approval', { signal: _reviewController.signal });
        if (revision !== _reviewRevision || adminFilters.publication !== 'pending' || getSession()?.apiToken !== actor) return;
        _reviewReports = result.reports.map(window.ReportManagement.adapt); _reviewLoad = { status: 'ready', message: '' };
    } catch (error) { if (revision === _reviewRevision && error.name !== 'AbortError') { _reviewLoad = { status: 'error', message: error.message }; } }
    finally { if (revision === _reviewRevision) renderAdminReports(); }
}
function setAdminReportMode(mode, navigate = true) {
    const pending = mode === 'pending';
    if (pending && adminFilters.publication !== 'pending') _operationalFilters = { ...adminFilters };
    if (pending) adminFilters = { ...ADMIN_REPORT_FILTERS, publication: 'pending', sort: 'oldest' };
    else { adminFilters = { ...(_operationalFilters || ADMIN_REPORT_FILTERS), publication: 'all' }; _reviewNeedsLoad = false; _reviewController?.abort(); ++_reviewRevision; }
    _reportsPage = 1;
    window.dispatchEvent(new CustomEvent('report-list:mode-changed'));
    restoreAdminReportControls(); saveAdminView();
    if (navigate) showAdminSection('reportsSection');
    if (pending) {
        _reviewController?.abort(); ++_reviewRevision; _reviewReports = []; _reviewLoad = { status: 'loading', message: '' }; _reviewNeedsLoad = true;
        loadPublicationQueue();
    }
    renderAdminReports();
}
function restoreAdminReportControls() {
    for (const [id, field] of [['adminSearch', 'search'], ['adminFilterBarangay', 'barangay'], ['adminFilterClassification', 'classification'], ['adminFilterPriority', 'priority'], ['adminFilterCategory', 'category'], ['adminFilterSort', 'sort'], ['adminFilterDateFrom', 'dateFrom'], ['adminFilterDateTo', 'dateTo']]) document.getElementById(id).value = adminFilters[field];
}
window.openPendingPosts = () => setAdminReportMode('pending');

function setupAdminReportDialog() {
    const dialog = document.getElementById('adminReportDialog');
    if (!dialog || !window.ReportDialog || !window.ReportDetailsView) return;
    _adminReportDialog = window.ReportDialog.create({
        dialog,
        client: window.ReportDetailsApi,
        view: window.ReportDetailsView,
        reviewView: window.CommunityPublication?.view,
        mutate: (...args) => window.ReportMutations.update(...args),
        api: path => window.neighborLensApiUrl(path),
        session: () => getSession(),
        onReviewed: () => refreshReports(true)
    });
    window.StaffNotifications?.setPublicationOpen((link, trigger) =>
        _adminReportDialog.open(window.ReportDialog.reportIdFromLink(link), trigger, { review: true })
    );
    document.addEventListener('click', event => {
        const review = event.target.closest('[data-review-post]');
        if (event.target.closest('#adminReportCards, #adminReportsBody')) return;
        if (review) { event.preventDefault(); _adminReportDialog.open(String(review.dataset.reviewPost), review, { review: true }); return; }
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href^="report-details.html?"]');
        if (!link || dialog.contains(link) || link.dataset.publicationReview !== 'true') return;
        const id = window.ReportDialog.reportIdFromLink(link);
        const trigger = link.closest('.notification-popover') ? document.getElementById('adminActivityBell') : link;
        if (!_adminReportDialog.open(id, trigger, { review: link.dataset.publicationReview === 'true' })) return;
        event.preventDefault();
        window.StaffNotifications?.closePopover();
    });
}

function activeFilterCount(values, defaults) {
    return Object.entries(defaults).filter(([key, fallback]) => String(values[key] ?? '') !== String(fallback)).length;
}

function updateFilterCounts() {
    if (!_adminSheets) return;
    _adminSheets.setCount('reportFilters', activeFilterCount(adminFilters,
        { barangay: 'all', classification: 'all', priority: 'all', category: 'all', dateFrom: '', dateTo: '' }));
    _adminSheets.setCount('accountFilters', activeFilterCount(_accountQuery, { status: 'all', sort: 'username' }));
}

function setupAdminSheets() {
    if (!window.PortalComponents?.sheets) return;
    _adminSheets = window.PortalComponents.sheets(document, {
        onClear: {
            reportFilters: () => window.clearAdminFilters(),
            accountFilters: () => { window.setAccountQuery('status', 'all'); window.setAccountQuery('sort', 'username'); syncAccountFilterControls(); }
        }
    });
    updateFilterCounts();
}

function syncAccountFilterControls() {
    const status = document.getElementById('accountStatusFilter');
    const sort = document.getElementById('accountSort');
    if (status) status.value = _accountQuery.status;
    if (sort) sort.value = _accountQuery.sort;
}

function setupAccountFieldValidation() {
    const clear = event => {
        if (!ACCOUNT_FIELD_IDS.includes(event.target.id)) return;
        const message = document.getElementById(`${event.target.id}Error`);
        if (message) { message.textContent = ''; message.hidden = true; }
        event.target.removeAttribute('aria-invalid');
    };
    const form = document.getElementById('accountModalBody');
    form?.addEventListener('input', clear);
    form?.addEventListener('change', clear);
}

function setupAdminGisResize() {
    const container = document.getElementById('adminGisMapCanvas');
    const refresh = () => { if (adminGisMap && container?.offsetParent !== null) adminGisMap.invalidateSize(); };
    if (container && typeof ResizeObserver === 'function') new ResizeObserver(refresh).observe(container);
    window.addEventListener('orientationchange', refresh);
    document.getElementById('adminSidebar')?.addEventListener('transitionend', refresh);
}

let adminGisMap = null;
let adminGisView = null;

function renderAdminGisMap() {
    const container = document.getElementById('adminGisMapCanvas');
    if (!container || !window.L) return;

    if (!adminGisView) adminGisView = window.ReportGis.create({
        container, openReport: (id, trigger) => {
            window.location.href = `report-details.html?id=${encodeURIComponent(id)}`;
        },
        filterForm: document.getElementById('adminGisFilters'), legend: document.getElementById('adminGisLegend'), state: document.getElementById('gisMapReportCount')
    });
    adminGisView.start();
    adminGisMap = adminGisView.map;
}
window.renderAdminGisMap = renderAdminGisMap;

function escapeAdminMapText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
window.escapeAdminMapText = escapeAdminMapText;

function buildGisMarkerPopupHtml(report) {
    return `
            <strong>${escapeAdminMapText(report.citizenCategory || (report.originalAi ? 'Report' : report.aiCategory) || 'Report')}</strong><br>
            Barangay: ${escapeAdminMapText(report.barangay || 'Unknown')}<br>
            Status: ${escapeAdminMapText(report.status)}<br>
            Priority: ${escapeAdminMapText(report.aiPriority || '')}
        `;
}
window.buildGisMarkerPopupHtml = buildGisMarkerPopupHtml;

// ── FILTERS ──
function setupAdminFilters() {
    _adminManagement.bind({
        query(values) {
            const { pageSize, ...filters } = values;
            if (pageSize) REPORTS_PAGE_SIZE = pageSize;
            Object.assign(adminFilters, filters); _reportsPage = 1;
            saveAdminView(); renderAdminReports(); updateFilterCounts();
        },
        status: value => window.setFilter(value), clear: () => window.clearAdminFilters(),
        page: delta => { _reportsPage += delta; renderAdminReports(); }
    });
}

window.setFilter = function (filter) {
    if (filter === 'community-review') return setAdminReportMode('pending');
    if (adminFilters.publication === 'pending') setAdminReportMode('all');
    _reportsPage = 1;
    adminFilters.status = filter;
    document.querySelectorAll('[data-admin-filter]').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-admin-filter="${filter}"]`)?.classList.add('active');
    renderAdminReports();
    saveAdminView();
};

window.clearAdminFilters = function () {
    const publication = adminFilters.publication;
    _reportsPage = 1;
    adminFilters = { ...ADMIN_REPORT_FILTERS, publication, sort: publication === 'pending' ? 'oldest' : 'newest' };
    document.querySelectorAll('[data-admin-filter]').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-admin-filter="all"]')?.classList.add('active');
    ['adminFilterBarangay', 'adminFilterClassification', 'adminFilterPriority',
        'adminFilterCategory', 'adminFilterSort'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.selectedIndex = 0;
        });
    ['adminFilterDateFrom', 'adminFilterDateTo', 'adminSearch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    restoreAdminReportControls();
    renderAdminReports();
    saveAdminView();
    updateFilterCounts();
};

// ── MODALS ──
window.closeModal = function () { document.getElementById('dataModal').style.display = 'none'; };

// ── SYSTEM LOGS ──
const AUDIT_ACTION_LABELS = Object.freeze({
    login: 'signed in',
    login_failed: 'failed sign-in for',
    login_blocked: 'blocked sign-in (suspended) for',
    logout: 'signed out',
    register: 'registered',
    create: 'created',
    save: 'saved',
    status_update: 'changed status of',
    official_create: 'created official account',
    official_update: 'updated official account',
    official_reassign: 'reassigned official account',
    official_suspend: 'suspended official account',
    official_activate: 'reactivated official account',
    official_password_reset: 'reset password of official account',
    admin_create: 'created administrator account',
    admin_request_submit: 'submitted an administrator access request',
    admin_request_approve: 'approved administrator access request',
    admin_request_reject: 'rejected administrator access request',
    profile_update: 'updated their profile',
    password_change: 'changed their password',
    admin_bootstrap: 'bootstrapped administrator'
});

function describeAuditLog(log) {
    const actor = log.actor_username || (log.actor_id ? `user #${log.actor_id}` : 'system');
    const verb = AUDIT_ACTION_LABELS[log.action] || String(log.action || '').replace(/_/g, ' ');
    const target = `${String(log.entity_type || '').replace(/_/g, ' ')}${log.entity_id ? ` #${log.entity_id}` : ''}`;
    const details = log.details && log.details.from && log.details.to ? ` (${log.details.from} → ${log.details.to})` : '';
    return `${actor} ${verb} ${target}${details}`;
}

let auditPage = 1;
let auditRequest = 0;
window.changeAuditPage = function (delta) {
    auditPage = delta ? Math.max(1, auditPage + delta) : 1;
    loadAuditLogs();
};
function loadAuditLogs() {
    if (_activeAdminSection !== 'logsSection') return;
    const size = Number(document.getElementById('auditPageSize').value);
    return fetchAuditLogs(auditPage, size);
}

async function fetchAuditLogs(page, size) {
    const box = document.getElementById('logBox');
    if (!box || typeof window.apiRequest !== 'function') return;
    const request = ++auditRequest;
    try {
        const data = await window.apiRequest(`/api/admin/audit-logs?limit=${size}&offset=${(page - 1) * size}`);
        if (request !== auditRequest) return;
        const pages = Math.max(1, Math.ceil(data.total / size));
        if (page > pages) { auditPage = pages; return loadAuditLogs(); }
        window.PortalComponents.pagination(document, 'audit', { page, pages, total: data.total }, size, 'entries');
        const logs = Array.isArray(data.logs) ? data.logs : [];
        if (!logs.length) {
            window.PortalComponents.render(box, '<div class="log-entry">No audit entries recorded yet.</div>');
            return;
        }
        window.PortalComponents.render(box, window.ActivityLogView.markup(logs, { describe: describeAuditLog, date: value => formatDate(String(value).replace(' ', 'T')) }));
    } catch (error) {
        if (request !== auditRequest) return;
        window.PortalComponents.render(box, `<div class="log-entry" style="color:var(--accent-pink);">Audit log unavailable: ${escapeAdminMapText(error.message)}</div>`);
    }
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
