// ============================================================
// SECURITY.JS — Route Protection & Session Guard
// Uses sessionStorage (cleared on tab close), not localStorage
// ============================================================

const PORTAL_BY_ROLE = Object.freeze({
    admin: 'admin.html',
    barangay: 'barangay.html',
    citizen: 'citizen.html'
});

const PROTECTED_PAGE_ROLES = Object.freeze({
    'admin.html': 'admin',
    'barangay.html': 'barangay',
    'citizen.html': 'citizen'
});

const LOGIN_PAGE_BY_ROLE = Object.freeze({
    admin: 'admin-login.html',
    barangay: 'barangay-login.html',
    citizen: 'login.html'
});

const PUBLIC_PAGES = Object.freeze(['login.html', 'admin-login.html', 'admin-signup.html', 'barangay-login.html', 'index.html', '']);
const LOGIN_PAGE = 'login.html';

let navigationPending = false;

function portalForRole(role) {
    return Object.prototype.hasOwnProperty.call(PORTAL_BY_ROLE, role) ? PORTAL_BY_ROLE[role] : null;
}

function currentPage() {
    return window.location.pathname.split('/').pop() || 'index.html';
}

function loginPageForRole(role) {
    return Object.prototype.hasOwnProperty.call(LOGIN_PAGE_BY_ROLE, role) ? LOGIN_PAGE_BY_ROLE[role] : LOGIN_PAGE;
}

function loginPageForCurrentPage() {
    return loginPageForRole(PROTECTED_PAGE_ROLES[currentPage()]);
}

function readStoredSession() {
    try {
        const session = JSON.parse(sessionStorage.getItem('up_session'));
        return session && typeof session === 'object' ? session : null;
    } catch {
        sessionStorage.removeItem('up_session');
        return null;
    }
}

function isUsableSession(session) {
    return Boolean(session && typeof session.apiToken === 'string' && session.apiToken && portalForRole(session.role));
}

function clearLocalSession() {
    sessionStorage.removeItem('up_session');
    window.dispatchEvent(new CustomEvent('session:changed'));
    if (typeof window.clearReportCache === 'function') window.clearReportCache();
    else {
        sessionStorage.removeItem('up_reports');
        sessionStorage.removeItem('up_reports_context');
        try {
            localStorage.removeItem('up_reports');
            localStorage.removeItem('up_reports_context');
        } catch {}
    }
}

function navigateOnce(target) {
    if (navigationPending) return false;
    navigationPending = true;
    if (typeof window.location.replace === 'function') window.location.replace(target);
    else window.location.href = target;
    return true;
}

function decidePageAccess(page, session) {
    if (PUBLIC_PAGES.includes(page)) return { granted: true };
    const loginPage = loginPageForRole(PROTECTED_PAGE_ROLES[page]);
    if (!session) return { granted: false, redirect: loginPage };
    if (!isUsableSession(session)) return { granted: false, redirect: loginPage, clear: true };
    const requiredRole = PROTECTED_PAGE_ROLES[page];
    if (requiredRole && session.role !== requiredRole) {
        return { granted: false, redirect: portalForRole(session.role) };
    }
    return { granted: true };
}

function enforcePageAccess() {
    const decision = decidePageAccess(currentPage(), readStoredSession());
    window.NEIGHBORLENS_ACCESS_GRANTED = decision.granted;
    if (!decision.granted) {
        if (decision.clear) clearLocalSession();
        navigateOnce(decision.redirect);
    }
    return decision.granted;
}

function verifyStoredSession(session, requiredRole) {
    if (typeof window.neighborLensApiUrl !== 'function' || typeof fetch !== 'function') return;
    fetch(window.neighborLensApiUrl('/api/me'), { headers: { Authorization: `Bearer ${session.apiToken}` } })
        .then(response => {
            if (response.status === 401) return window.handleSessionExpired();
            if (!response.ok) return null;
            return response.json().then(data => {
                const role = data?.user?.role;
                if (role !== session.role) return window.handleSessionExpired();
                if (requiredRole && role !== requiredRole) navigateOnce(portalForRole(role) || loginPageForCurrentPage());
            });
        })
        .catch(() => {});
}

window.portalForRole = portalForRole;
window.loginPageForRole = loginPageForRole;
window.redirectToLogin = function () {
    navigateOnce(loginPageForCurrentPage());
};
window.handleSessionExpired = function () {
    if (navigationPending) return;
    const role = readStoredSession()?.role || PROTECTED_PAGE_ROLES[currentPage()];
    clearLocalSession();
    navigateOnce(`${loginPageForRole(role)}?session=expired`);
};

const pageAccessGranted = enforcePageAccess();

document.addEventListener('DOMContentLoaded', function () {
    if (!pageAccessGranted) return;
    const page = currentPage();
    const session = readStoredSession();
    if (!session) return;

    if (!PUBLIC_PAGES.includes(page)) verifyStoredSession(session, PROTECTED_PAGE_ROLES[page]);

    // Inject username/role/barangay into header
    const userEl = document.getElementById('currentUser');
    if (userEl) userEl.textContent = session.username;

    const roleEl = document.getElementById('currentRole');
    if (roleEl) roleEl.textContent = session.role.charAt(0).toUpperCase() + session.role.slice(1);

    const barangayEl = document.getElementById('currentBarangay');
    if (barangayEl && session.barangay) barangayEl.textContent = session.barangay;
});

// Global logout function
window.logout = function () {
    const stored = readStoredSession();
    const token = stored?.apiToken || null;
    const loginPage = loginPageForRole(stored?.role || PROTECTED_PAGE_ROLES[currentPage()]);
    clearLocalSession();
    if (token && typeof window.neighborLensApiUrl === 'function' && typeof fetch === 'function') {
        try {
            fetch(window.neighborLensApiUrl('/api/auth/logout'), {
                method: 'POST',
                keepalive: true,
                headers: { Authorization: `Bearer ${token}` }
            }).catch(() => {});
        } catch {}
    }
    navigationPending = false;
    navigateOnce(loginPage);
}

// Get current session anywhere
window.getSession = function () {
    return readStoredSession();
}
