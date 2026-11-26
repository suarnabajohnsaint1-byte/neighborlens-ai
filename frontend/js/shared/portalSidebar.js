(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.PortalSidebar = api;
        document.querySelectorAll('[data-portal-sidebar]').forEach(element => api.mount(element));
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const instances = new WeakMap();
    const roles = Object.freeze({ citizen: 'Citizen', admin: 'Admin', barangay: 'Barangay reviewer' });
    const brandMarkup = '<span class="neighborlens-emblem" aria-hidden="true"><img src="assets/logo/neighborlens-logo.png" alt=""></span><img class="portal-system-logo" src="assets/admin-assets-login/assets/brand/neighborlens-wordmark.svg" alt="NeighborLens AI">';
    const citizenItems = Object.freeze([
        Object.freeze({ href: 'citizen.html', icon: 'bxs-edit', label: 'Submit Report', section: 'submitSection' }),
        Object.freeze({ href: 'citizen.html#my-reports', icon: 'bxs-file-doc', label: 'My Reports', section: 'myReportsSection' }),
        Object.freeze({ href: 'citizen.html#community', icon: 'bx-group', label: 'Community Feed', section: 'communitySection' })
    ]);
    const adminItems = Object.freeze([
        Object.freeze({ href: 'admin.html#accounts', icon: 'bxs-user-account', label: 'Manage Accounts', section: 'accountsSection' }),
        Object.freeze({ href: 'admin.html#reports', icon: 'bxs-report', label: 'All Reports', section: 'reportsSection' }),
        Object.freeze({ href: 'admin.html#gis-map', icon: 'bxs-map-alt', label: 'GIS Map', section: 'gisMapSection' }),
        Object.freeze({ href: 'admin.html#logs', icon: 'bxs-terminal', label: 'System Logs', section: 'logsSection' }),
        Object.freeze({ href: 'admin.html#analytics', icon: 'bx-bar-chart-alt-2', label: 'Analytics', section: 'analyticsSection' })
    ]);

    const barangayItems = Object.freeze([
        Object.freeze({ href: 'barangay.html#reports', icon: 'bx-file', label: 'Local Reports', section: 'reports', status: 'all' }),
        Object.freeze({ href: 'barangay.html#community', icon: 'bx-group', label: 'Community Feed', section: 'community' }),
        Object.freeze({ href: 'barangay.html#gis-map', icon: 'bxs-map-alt', label: 'GIS Map', section: 'gis-map' }),
        Object.freeze({ href: 'barangay.html#activity', icon: 'bxs-terminal', label: 'Activity Logs', section: 'activity' }),
        Object.freeze({ href: 'barangay.html#analytics', icon: 'bx-bar-chart-alt-2', label: 'Analytics', section: 'analytics' })
    ]);

    function navigation(role, details = false) {
        if (role === 'citizen') return citizenItems;
        if (role === 'admin') return adminItems;
        if (role === 'barangay') return barangayItems;
        return [];
    }

    function home(role) {
        return Object.hasOwn(roles, role) ? `${role}.html` : 'login.html';
    }

    function navigationControl(item, label = item.label) {
        const control = document.createElement(item.disabled ? 'button' : 'a');
        control.setAttribute('aria-label', label);
        if (item.disabled) {
            control.type = 'button';
            control.disabled = true;
            control.title = 'Community Feed not available yet';
        } else control.href = item.href;
        if (item.section) control.dataset.section = item.section;
        if (item.status) control.dataset.status = item.status;
        const icon = document.createElement('i');
        icon.className = `bx ${item.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = label;
        control.append(icon, text);
        return control;
    }

    function mount(element) {
        if (instances.has(element)) return instances.get(element);
        const details = element.dataset.portalSidebar === 'details';
        const citizen = element.dataset.portalSidebar === 'citizen';
        const drawer = element.dataset.sidebarMode === 'drawer';
        const accountHeader = citizen || (details && window.getSession?.()?.role === 'citizen');
        let mobileHeader = null;
        let bottomNav = null;
        let accountButton = null;
        let accountMenu = null;
        if (citizen || details) {
            bottomNav = document.createElement('nav');
            bottomNav.className = 'portal-mobile-nav';
            bottomNav.setAttribute('aria-label', 'Citizen navigation');
            bottomNav.append(
                navigationControl(citizenItems[2], 'Community'),
                navigationControl(citizenItems[0], 'Submit report'),
                navigationControl(citizenItems[1], 'My Reports')
            );
            element.after(bottomNav);
            if (details) bottomNav.hidden = true;
        }
        if (accountHeader) {
            element.id ||= 'citizenSidebar';
            mobileHeader = document.createElement('div');
            mobileHeader.className = 'portal-mobile-header';
            mobileHeader.innerHTML = `
                <a href="citizen.html" class="portal-mobile-brand" aria-label="NeighborLens AI home">${brandMarkup}</a>
                <div class="notification-bell-container" data-notification-center>
                    <button id="mobileNotificationBell" class="portal-sidebar-control notification-bell-btn" type="button"
                        aria-label="Notifications" aria-expanded="false" aria-controls="notificationPopover"
                        title="Notifications">
                        <i class="bx bx-bell" aria-hidden="true"></i>
                        <span class="notification-badge" hidden aria-live="polite"></span>
                    </button>
                </div>
                <button class="portal-sidebar-control portal-account-toggle" type="button"
                    aria-label="Citizen account" title="Citizen"
                    aria-controls="citizenAccountMenu" aria-expanded="false">
                    <span class="portal-avatar" aria-hidden="true"><img src="assets/avatar/avatar1.png" alt=""></span>
                </button>
                <div id="citizenAccountMenu" class="portal-account-menu" hidden></div>`;
            element.before(mobileHeader);
            if (details) mobileHeader.querySelector('[data-notification-center]').remove();
            accountButton = mobileHeader.querySelector('.portal-account-toggle');
            accountMenu = mobileHeader.querySelector('.portal-account-menu');
        }
        const content = drawer ? document.getElementById(element.dataset.sidebarContent) : null;
        const toggle = drawer ? document.getElementById(element.dataset.sidebarToggle) : null;
        const backdrop = drawer ? document.getElementById(element.dataset.sidebarBackdrop) : null;
        const media = window.matchMedia('(max-width: 900px)');
        let menu = element.querySelector('.nav-links');
        const suppliedMenu = Boolean(menu) && menu.dataset.portalSidebarOwned !== 'true';
        if (!menu) { menu = document.createElement('ul'); menu.className = 'nav-links'; }
        if (!suppliedMenu) menu.dataset.portalSidebarOwned = 'true';
        element.classList.add('portal-sidebar');
        element.classList.toggle('portal-sidebar--drawer', drawer);
        element.classList.toggle('portal-sidebar--desktop-only', citizen);
        element.innerHTML = `<div class="portal-sidebar-heading">
            <a class="logo portal-brand" href="login.html" aria-label="NeighborLens AI home">${brandMarkup}</a>
            ${drawer ? '<button id="closeSidebar" class="portal-sidebar-control portal-sidebar-close" type="button" aria-label="Close navigation" title="Close navigation"><i class="bx bx-x" aria-hidden="true"></i></button>' : ''}
        </div><nav class="portal-sidebar-navigation" aria-label="Portal"></nav>
        <div class="sidebar-footer"><div class="portal-account">${accountHeader ? '<span class="portal-avatar" aria-hidden="true"><img src="assets/avatar/avatar1.png" alt=""></span>' : ''}<div><strong id="currentUser"></strong><span id="currentRole"></span><span id="currentBarangay"></span></div></div>
            <button id="${details ? 'detailsLogout' : 'portalLogout'}" class="btn-logout" type="button" aria-label="Log out"><i class="bx bx-log-out" aria-hidden="true"></i>Log out</button></div>`;
        if (details) menu.id = 'detailsNav';
        element.querySelector('.portal-sidebar-navigation').append(menu);
        const closeButton = element.querySelector('.portal-sidebar-close');
        const logoutButton = element.querySelector('.btn-logout');
        const footer = element.querySelector('.sidebar-footer');
        const appearanceHost = document.createElement('div');
        let appearanceControl = null;
        const brand = element.querySelector('.portal-brand');
        const userName = element.querySelector('#currentUser');
        const roleName = element.querySelector('#currentRole');
        const barangay = element.querySelector('#currentBarangay');
        let currentRole = null;
        let renderedRole;
        let previousOverflow = '';
        let opener = toggle;

        function setActive(item) {
            for (const entry of menu.children) {
                const active = entry === item;
                entry.classList.toggle('active', active);
                const link = entry.querySelector('a');
                if (active) link?.setAttribute('aria-current', 'location');
                else link?.removeAttribute('aria-current');
            }
            const section = item?.querySelector('a')?.dataset.section;
            bottomNav?.querySelectorAll('a').forEach(link => {
                if (link.dataset.section === section) link.setAttribute('aria-current', 'location');
                else link.removeAttribute('aria-current');
            });
        }

        function activate(section) {
            const link = [...menu.querySelectorAll('a[data-section]')].find(entry => entry.dataset.section === section);
            if (link) setActive(link.parentElement);
        }

        function syncAccountControls() {
            const mobileAccount = accountHeader && currentRole === 'citizen' && media.matches;
            const parent = mobileAccount ? accountMenu : footer;
            if (mobileAccount && barangay.parentElement !== accountMenu) accountMenu.prepend(barangay);
            else if (!mobileAccount && barangay.parentElement !== roleName.parentElement) roleName.after(barangay);
            if (logoutButton.parentElement !== parent) parent.append(logoutButton);
            if (!['citizen', 'admin', 'barangay'].includes(currentRole) || !window.PortalTheme?.getEffectiveTheme()) {
                appearanceControl?.destroy();
                appearanceControl = null;
                appearanceHost.remove();
                return;
            }
            appearanceControl ||= window.PortalAppearance?.mount(appearanceHost);
            if (!appearanceControl) return;
            if (appearanceHost.nextElementSibling !== logoutButton) parent.insertBefore(appearanceHost, logoutButton);
        }

        function update(session) {
            currentRole = details ? session?.role : element.dataset.portalSidebar;
            if (details && bottomNav) {
                bottomNav.hidden = currentRole !== 'citizen';
            }
            element.classList.toggle('portal-sidebar--desktop-only', citizen || (details && currentRole === 'citizen'));
            if (!suppliedMenu && renderedRole !== currentRole) {
                renderedRole = currentRole;
                menu.replaceChildren();
                for (const item of navigation(currentRole, details)) {
                    const entry = document.createElement('li');
                    entry.append(navigationControl(item));
                    menu.append(entry);
                }
                if (currentRole === 'citizen') activate(details || window.location.hash === '#my-reports' ? 'myReportsSection' : (window.location.hash === '#community' ? 'communitySection' : 'submitSection'));
                else if (currentRole === 'admin') activate(window.AdminViewStore?.read().section || 'reportsSection');
                else if (menu.firstElementChild) setActive(menu.firstElementChild);
            }
            brand.setAttribute('href', home(currentRole));
            userName.textContent = session?.username || '';
            roleName.textContent = session && Object.hasOwn(roles, session.role) ? roles[session.role] : '';
            barangay.textContent = ['citizen', 'barangay'].includes(session?.role) ? session.barangay || '' : '';
            barangay.hidden = !barangay.textContent;
            syncAccountControls();
        }

        function setOpen(open, restoreFocus = true) {
            if (!drawer || (details && currentRole === 'citizen')) return;
            const expanded = media.matches && open;
            const wasExpanded = element.classList.contains('is-open');
            if (expanded && !wasExpanded) previousOverflow = document.body.style.overflow;
            element.classList.toggle('is-open', expanded);
            element.inert = media.matches && !expanded;
            toggle?.setAttribute('aria-expanded', String(expanded));
            if (backdrop) backdrop.hidden = !expanded;
            if (content) content.inert = expanded;
            if (expanded) {
                element.setAttribute('role', 'dialog');
                element.setAttribute('aria-modal', 'true');
                document.body.style.overflow = 'hidden';
                closeButton.focus();
            } else {
                element.removeAttribute('role');
                element.removeAttribute('aria-modal');
                if (wasExpanded) document.body.style.overflow = previousOverflow;
                if (restoreFocus && wasExpanded && media.matches) opener?.focus();
            }
        }

        function keydown(event) {
            if (!element.classList.contains('is-open')) return;
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
            if (event.key !== 'Tab') return;
            const targets = [...element.querySelectorAll('a[href], button:not(:disabled)')];
            const first = targets[0];
            const last = targets[targets.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }

        function resize() {
            if (citizen || (details && currentRole === 'citizen')) {
                const focused = document.activeElement === logoutButton || element.contains(document.activeElement);
                setAccountOpen(false);
                syncAccountControls();
                element.inert = media.matches;
                if (focused) (accountHeader && media.matches ? accountButton : logoutButton).focus();
                return;
            }
            const focused = element.contains(document.activeElement);
            setOpen(false, false);
            if (focused && media.matches) toggle?.focus();
        }

        function setAccountOpen(open, restoreFocus = false) {
            if (!accountMenu) return;
            const expanded = media.matches && open;
            accountMenu.hidden = !expanded;
            accountButton.setAttribute('aria-expanded', String(expanded));
            if (expanded) logoutButton.focus();
            else if (restoreFocus && media.matches) accountButton.focus();
        }

        function toggleAccount() { setAccountOpen(accountMenu.hidden, true); }
        function accountKeydown(event) {
            if (event.key === 'Escape' && !accountMenu.hidden) {
                event.preventDefault();
                setAccountOpen(false, true);
            } else if (event.target === accountButton && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                setAccountOpen(true);
            }
        }
        function outsideAccount(event) {
            if (!mobileHeader.contains(event.target)) setAccountOpen(false);
        }
        function accountFocusout(event) {
            if (event.relatedTarget && !mobileHeader.contains(event.relatedTarget)) setAccountOpen(false);
        }

        function open(event) { opener = event?.currentTarget || toggle; setOpen(true); }
        function close() { setOpen(false); }
        function pagehide() { setOpen(false, false); setAccountOpen(false); update(null); }
        function pageshow(event) { if (event.persisted) update(window.getSession?.()); }
        function navigate(event) {
            if (details || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const link = event.target.closest('a[data-section]');
            if (link && currentRole === 'barangay') {
                event.preventDefault();
                element.dispatchEvent(new CustomEvent('portal-sidebar:navigate', { detail: { status: link.dataset.status, section: link.dataset.section } }));
                activate(link.dataset.section);
                setOpen(false);
                return;
            }
            const show = currentRole === 'admin' ? window.showAdminSection : currentRole === 'citizen' ? window.showSection : null;
            if (!link || typeof show !== 'function') return;
            event.preventDefault();
            show(link.dataset.section);
            activate(link.dataset.section);
            setOpen(false);
            setAccountOpen(false);
        }
        function logout() {
            element.dispatchEvent(new CustomEvent('portal-sidebar:logout'));
            pagehide();
            window.logout();
        }

        menu.addEventListener('click', navigate);
        bottomNav?.addEventListener('click', navigate);
        if (accountHeader) {
            accountButton.addEventListener('click', toggleAccount);
            mobileHeader.addEventListener('keydown', accountKeydown);
            mobileHeader.addEventListener('focusout', accountFocusout);
            document.addEventListener('pointerdown', outsideAccount);
        }
        logoutButton.addEventListener('click', logout);
        if (drawer) {
            toggle?.classList.add('portal-sidebar-control', 'portal-sidebar-toggle');
            backdrop?.classList.add('portal-sidebar-backdrop');
            toggle?.addEventListener('click', open);
            closeButton?.addEventListener('click', close);
            backdrop?.addEventListener('click', close);
            window.addEventListener('keydown', keydown);
        }
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);
        update(window.getSession?.());
        if (accountHeader || drawer) {
            media.addEventListener('change', resize);
            resize();
        }

        const instance = {
            update,
            activate,
            close: (restoreFocus = true) => { setOpen(false, restoreFocus); setAccountOpen(false, restoreFocus); },
            destroy() {
                setOpen(false, false);
                appearanceControl?.destroy();
                appearanceHost.remove();
                menu.removeEventListener('click', navigate);
                bottomNav?.removeEventListener('click', navigate);
                if (accountHeader) {
                    setAccountOpen(false);
                    footer.append(logoutButton);
                    element.inert = false;
                    accountButton.removeEventListener('click', toggleAccount);
                    mobileHeader.removeEventListener('keydown', accountKeydown);
                    mobileHeader.removeEventListener('focusout', accountFocusout);
                    document.removeEventListener('pointerdown', outsideAccount);
                }
                logoutButton.removeEventListener('click', logout);
                if (drawer) {
                    toggle.removeEventListener('click', open);
                    closeButton.removeEventListener('click', close);
                    backdrop.removeEventListener('click', close);
                    window.removeEventListener('keydown', keydown);
                }
                media.removeEventListener('change', resize);
                window.removeEventListener('pagehide', pagehide);
                window.removeEventListener('pageshow', pageshow);
                mobileHeader?.remove();
                bottomNav?.remove();
                instances.delete(element);
            }
        };
        instances.set(element, instance);
        return instance;
    }

    return { mount, get: element => instances.get(element), navigation, home };
});
