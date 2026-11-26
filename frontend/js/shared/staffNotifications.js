(function () {
    'use strict';

    const host = document.querySelector('[data-staff-notifications]');
    if (!host) return;
    const role = host.dataset.staffNotifications;
    const prefix = role + 'Activity';
    host.innerHTML = `
        <button id="${prefix}Bell" class="notification-bell-btn" type="button"
                aria-label="Report notifications" aria-expanded="false" aria-controls="${prefix}Popover">
            <i class="bx bx-bell" aria-hidden="true"></i>
            <span id="${prefix}Badge" class="notification-badge" hidden></span>
        </button>
        <div id="${prefix}Popover" class="notification-popover" hidden role="region" aria-label="Report notifications">
            <div class="notification-popover-header">
                <h2 class="notification-popover-title">Report activity</h2>
                <button id="${prefix}MarkAll" class="notification-mark-all-btn" type="button" disabled>Mark all as read</button>
            </div>
            <ul id="${prefix}List" class="notification-list"></ul>
        </div>`;

    const bell = host.querySelector('button');
    const badge = host.querySelector('.notification-badge');
    const popover = host.querySelector('.notification-popover');
    const markAll = host.querySelector('.notification-mark-all-btn');
    const list = host.querySelector('.notification-list');
    const publicationTitles = ['New post awaiting approval', 'Community publication review'];
    let publicationLabel = () => '';
    let openPublication = () => false;
    let notifications = [];
    let unread = 0;
    let loaded = false;
    let error = '';
    let token = null;
    let generation = 0;
    let source = null;
    let retry = null;
    let connecting = false;
    let connectedBefore = false;
    let loading = false;
    let reload = false;
    let reading = false;
    let readRevision = 0;

    function render() {
        badge.hidden = !unread;
        badge.textContent = unread > 99 ? '99+' : String(unread);
        bell.setAttribute('aria-label', unread ? `Report notifications, ${unread} unread` : 'Report notifications');
        markAll.disabled = reading || !unread;
        const focused = list.contains(document.activeElement) ? document.activeElement.dataset.readReport : null;
        const fragment = document.createDocumentFragment();
        if (error || !notifications.length || retry) {
            const status = document.createElement('li');
            status.className = 'notification-empty';
            status.setAttribute('role', 'status');
            status.textContent = error || (retry ? 'Reconnecting to live updates…' : loaded ? 'No notifications yet' : 'Loading notifications…');
            if (error) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Retry';
                button.addEventListener('click', refresh);
                status.append(' ', button);
            }
            fragment.append(status);
        }
        for (const notice of notifications) {
            const row = document.createElement('li');
            row.className = notice.readAt ? 'notification-item' : 'notification-item unread';
            const link = document.createElement('a');
            const review = role === 'admin' && publicationTitles.includes(notice.title);
            const message = notice.type === 'coordination_message' || notice.title === 'New internal report message';
            link.href = `report-details.html?id=${Number(notice.reportId)}${message ? '#report-conversation' : ''}`;
            link.dataset.publicationReview = String(review);
            link.dataset.readReport = `notification:${notice.id}`;
            const header = document.createElement('div');
            header.className = 'notification-item-header';
            const title = document.createElement('strong');
            title.className = 'notification-item-title';
            title.textContent = notice.title;
            const time = document.createElement('span');
            time.className = 'notification-item-time';
            time.textContent = review ? publicationLabel(Number(notice.reportId)) : window.ManilaDates.format(notice.createdAt);
            const description = document.createElement('p');
            description.className = 'notification-item-desc';
            description.textContent = notice.message;
            header.append(title, time);
            link.append(header, description);
            row.append(link);
            fragment.append(row);
        }
        const scroll = list.scrollTop;
        list.replaceChildren(fragment);
        list.scrollTop = scroll;
        if (focused) {
            const target = Array.from(list.querySelectorAll('[data-read-report]')).find(item => item.dataset.readReport === focused);
            (target || bell).focus({ preventScroll: true });
        }
    }

    function current(run) {
        return run === generation && token && getSession()?.apiToken === token;
    }

    async function refresh() {
        if (!current(generation)) return;
        if (loading || reading) { reload = true; return; }
        const run = generation;
        const revision = readRevision;
        reload = false;
        loading = true;
        try {
            const result = await window.apiRequest('/api/notifications?limit=100');
            if (!current(run) || revision !== readRevision) return;
            notifications = result.notifications;
            unread = result.unreadCount;
            loaded = true;
            error = '';
        } catch {
            if (current(run) && revision === readRevision) error = 'Notifications could not be refreshed.';
        } finally {
            if (current(run)) {
                loading = false;
                if (revision === readRevision) render();
                if (reload && !reading && !error) refresh();
            }
        }
    }

    async function read(id) {
        const run = generation;
        if (!current(run) || reading) return false;
        reading = true;
        readRevision++;
        markAll.disabled = true;
        try {
            const result = await window.apiRequest(id ? `/api/notifications/${id}/read` : '/api/notifications/mark-all-read', {
                method: id ? 'PATCH' : 'POST'
            });
            if (!current(run)) return false;
            unread = result.unreadCount;
            const now = new Date().toISOString();
            for (const notice of notifications) {
                if (!id || Number(notice.id) === id) notice.readAt ||= now;
            }
            error = '';
            reload = true;
            return true;
        } catch {
            if (current(run)) error = 'Notifications could not be marked as read.';
            return false;
        } finally {
            if (current(run)) {
                reading = false;
                render();
                if (reload && !error) refresh();
            }
        }
    }

    function closePopover() {
        popover.hidden = true;
        bell.setAttribute('aria-expanded', 'false');
    }

    function stop() {
        generation += 1;
        clearTimeout(retry);
        retry = null;
        source?.close();
        source = null;
        token = null;
        connecting = loading = reload = connectedBefore = loaded = reading = false;
        notifications = [];
        unread = 0;
        error = '';
        closePopover();
        render();
    }

    function reconnect(run) {
        if (!current(run)) return;
        retry = setTimeout(() => { retry = null; connect(); }, 5000);
        render();
    }

    async function connect() {
        if (!current(generation) || connecting || source || retry || typeof EventSource === 'undefined') return;
        const run = generation;
        connecting = true;
        try {
            const ticket = await window.apiRequest('/api/notifications/stream-ticket', { method: 'POST' });
            if (!current(run)) return;
            source = new EventSource(window.neighborLensApiUrl(`/api/notifications/stream?ticket=${encodeURIComponent(ticket.ticket)}`));
            source.onopen = () => {
                if (!current(run)) return;
                refresh();
                if (role === 'admin') {
                    window.refreshReports(true);
                    if (connectedBefore) window.dispatchEvent(new CustomEvent('admin:reports-changed', { detail: { reason: 'reconnected' } }));
                }
                connectedBefore = true;
            };
            source.onmessage = event => {
                if (!current(run)) return;
                let payload;
                try { payload = JSON.parse(event.data); } catch { return; }
                if (payload.event === 'session_revoked') {
                    stop();
                    window.handleSessionExpired?.();
                } else if (role === 'admin' && payload.event === 'reports_changed') {
                    window.refreshReports(true);
                    window.dispatchEvent(new Event('admin:reports-changed'));
                } else if (payload.event === 'read_sync' || payload.reportId) {
                    refresh();
                    if (role === 'admin' && publicationTitles.includes(payload.title)) {
                        window.dispatchEvent(new Event('admin:reports-changed'));
                    }
                }
            };
            source.onerror = () => {
                if (!current(run)) return;
                source.close();
                source = null;
                reconnect(run);
            };
        } catch {
            reconnect(run);
        } finally {
            if (current(run)) connecting = false;
        }
    }

    function resume() {
        const session = getSession();
        if (session?.apiToken !== token) stop();
        if (session?.role !== role || !session.apiToken || window.NEIGHBORLENS_ACCESS_GRANTED === false) return;
        token = session.apiToken;
        if (role === 'admin') window.refreshReports();
        refresh();
        connect();
    }

    window.StaffNotifications = {
        closePopover,
        setPublicationLabel(format) { publicationLabel = format; },
        setPublicationOpen(open) { openPublication = open; },
        render
    };
    bell.addEventListener('click', () => {
        if (!popover.hidden) return closePopover();
        popover.hidden = false;
        bell.setAttribute('aria-expanded', 'true');
        refresh();
    });
    markAll.addEventListener('click', () => read());
    host.addEventListener('click', async event => {
        const link = event.target.closest('[data-read-report]');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (reading) return;
        const id = Number(link.dataset.readReport.slice(13));
        const notice = notifications.find(row => Number(row.id) === id);
        if (!notice || (!notice.readAt && !await read(id))) return;
        if (link.dataset.publicationReview === 'true' && openPublication(link, bell)) {
            closePopover();
            return;
        }
        window.location.assign(link.href);
    });
    document.addEventListener('click', event => { if (!host.contains(event.target)) closePopover(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !popover.hidden) { closePopover(); bell.focus(); }
    });
    window.addEventListener('DOMContentLoaded', resume, { once: true });
    window.addEventListener('pagehide', stop);
    window.addEventListener('session:changed', resume);
    window.addEventListener('pageshow', event => { if (event.persisted) resume(); });
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
})();
