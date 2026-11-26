(function () {
    'use strict';

    let _session = null;
    let _notifications = [];
    let _unreadCount = 0;
    let _eventSource = null;
    let _reconnectTimer = null;
    let _activeBell = null;

    function getSession() {
        if (typeof window.getSession === 'function') return window.getSession();
        try {
            return JSON.parse(sessionStorage.getItem('up_session'));
        } catch {
            return null;
        }
    }

    function apiUrl(path) {
        if (typeof window.neighborLensApiUrl === 'function') {
            return window.neighborLensApiUrl(path);
        }
        const hostname = window.location.hostname || '127.0.0.1';
        const origin = window.location.protocol === 'https:'
            ? window.location.origin
            : `http://${hostname}:3000`;
        return `${origin}${path.startsWith('/') ? path : '/' + path}`;
    }

    function authHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_session?.apiToken || ''}`
        };
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatRelativeTime(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        const now = new Date();
        const diffSeconds = Math.floor((now - date) / 1000);

        if (isNaN(diffSeconds) || diffSeconds < 0) return 'Just now';
        if (diffSeconds < 60) return 'Just now';
        const diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) return `${diffMinutes}m ago`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
        });
    }

    function updateBadgeElements() {
        const badges = document.querySelectorAll('.notification-badge');
        badges.forEach(badge => {
            if (_unreadCount <= 0) {
                badge.hidden = true;
                badge.textContent = '';
            } else {
                badge.hidden = false;
                badge.textContent = _unreadCount > 99 ? '99+' : String(_unreadCount);
            }
        });

        const markAllBtn = document.getElementById('notificationMarkAllBtn');
        if (markAllBtn) {
            markAllBtn.disabled = _unreadCount <= 0;
        }
    }

    function renderNotificationsList() {
        const list = document.getElementById('notificationList');
        if (!list) return;

        list.replaceChildren();

        if (!_notifications.length) {
            const emptyLi = document.createElement('li');
            emptyLi.className = 'notification-empty';
            emptyLi.textContent = 'No notifications yet';
            list.appendChild(emptyLi);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const item of _notifications) {
            const isUnread = !item.readAt;
            const li = document.createElement('li');
            li.className = `notification-item ${isUnread ? 'unread' : ''}`.trim();
            li.dataset.id = String(item.id);
            if (item.reportId) {
                li.dataset.reportId = String(item.reportId);
            }
            li.setAttribute('role', 'listitem');
            li.tabIndex = 0;

            const header = document.createElement('div');
            header.className = 'notification-item-header';

            const title = document.createElement('span');
            title.className = 'notification-item-title';

            if (isUnread) {
                const dot = document.createElement('span');
                dot.className = 'notification-unread-dot';
                dot.setAttribute('aria-label', 'Unread');
                title.appendChild(dot);
            }

            const titleText = document.createTextNode(item.title || '');
            title.appendChild(titleText);

            const time = document.createElement('span');
            time.className = 'notification-item-time';
            time.textContent = formatRelativeTime(item.createdAt);

            header.appendChild(title);
            header.appendChild(time);

            const desc = document.createElement('p');
            desc.className = 'notification-item-desc';
            desc.textContent = item.message || '';

            li.appendChild(header);
            li.appendChild(desc);

            fragment.appendChild(li);
        }

        list.appendChild(fragment);
    }

    async function fetchNotifications() {
        if (!_session?.apiToken) return;
        try {
            const res = await fetch(apiUrl('/api/notifications?limit=50'), {
                headers: authHeaders(),
                cache: 'no-store'
            });
            if (res.status === 401 && typeof window.handleSessionExpired === 'function') return window.handleSessionExpired();
            if (!res.ok) return;
            const data = await res.json();
            _notifications = Array.isArray(data.notifications) ? data.notifications : [];
            _unreadCount = typeof data.unreadCount === 'number' ? data.unreadCount : 0;
            updateBadgeElements();
            if (isPopoverOpen()) {
                renderNotificationsList();
            }
        } catch (err) {
            console.warn('Failed to load notifications:', err.message);
        }
    }

    async function markSingleAsRead(id, reportId) {
        if (!_session?.apiToken || !id) return;
        const item = _notifications.find(n => String(n.id) === String(id));
        if (item && !item.readAt) {
            item.readAt = new Date().toISOString();
            _unreadCount = Math.max(0, _unreadCount - 1);
            updateBadgeElements();
            renderNotificationsList();
        }

        try {
            await fetch(apiUrl(`/api/notifications/${encodeURIComponent(id)}/read`), {
                method: 'PATCH',
                headers: authHeaders()
            });
        } catch (err) {
            console.warn('Failed to mark notification as read:', err.message);
        }

        if (reportId) {
            window.location.href = `report-details.html?id=${encodeURIComponent(reportId)}`;
        }
    }

    async function markAllAsRead() {
        if (!_session?.apiToken || _unreadCount <= 0) return;
        const now = new Date().toISOString();
        _notifications.forEach(n => {
            if (!n.readAt) n.readAt = now;
        });
        _unreadCount = 0;
        updateBadgeElements();
        renderNotificationsList();

        try {
            await fetch(apiUrl('/api/notifications/mark-all-read'), {
                method: 'POST',
                headers: authHeaders()
            });
        } catch (err) {
            console.warn('Failed to mark all as read:', err.message);
        }
    }

    function isPopoverOpen() {
        const popover = document.getElementById('notificationPopover');
        return popover && !popover.hidden;
    }

    function closePopover() {
        const popover = document.getElementById('notificationPopover');
        if (!popover) return;
        popover.hidden = true;
        document.querySelectorAll('.notification-bell-btn').forEach(btn => {
            btn.setAttribute('aria-expanded', 'false');
        });
        _activeBell = null;
    }

    function openPopover(bellBtn) {
        const popover = document.getElementById('notificationPopover');
        if (!popover || !bellBtn) return;

        closePopover();

        const container = bellBtn.closest('.notification-bell-container') || bellBtn.parentElement;
        if (container && popover.parentElement !== container) {
            container.appendChild(popover);
        }

        renderNotificationsList();
        popover.hidden = false;
        bellBtn.setAttribute('aria-expanded', 'true');
        _activeBell = bellBtn;
    }

    function togglePopover(bellBtn) {
        if (isPopoverOpen() && _activeBell === bellBtn) {
            closePopover();
        } else {
            openPopover(bellBtn);
        }
    }

    function scheduleReconnect() {
        if (_reconnectTimer) clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(connectSSE, 5000);
    }

    async function requestStreamTicket() {
        const res = await fetch(apiUrl('/api/notifications/stream-ticket'), {
            method: 'POST',
            headers: authHeaders(),
            cache: 'no-store'
        });
        if (res.status === 401) {
            if (typeof window.handleSessionExpired === 'function') window.handleSessionExpired();
            return null;
        }
        if (!res.ok) throw new Error(`Stream ticket request failed (${res.status})`);
        const data = await res.json();
        return typeof data.ticket === 'string' ? data.ticket : null;
    }

    async function connectSSE() {
        if (!_session?.apiToken) return;
        if (_eventSource) {
            try { _eventSource.close(); } catch {}
            _eventSource = null;
        }

        let ticket;
        try {
            ticket = await requestStreamTicket();
        } catch (err) {
            console.warn('Notification stream unavailable:', err.message);
            scheduleReconnect();
            return;
        }
        if (!ticket) return;

        const streamUrl = apiUrl(`/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`);
        _eventSource = new EventSource(streamUrl);

        _eventSource.onmessage = function (event) {
            if (!event.data) return;
            try {
                const payload = JSON.parse(event.data);
                if (payload?.event === 'community_changed') {
                    window.dispatchEvent(new CustomEvent('community:changed', { detail: { postId: payload.postId, kind: payload.kind } }));
                    return;
                }
                if (payload && payload.event === 'session_revoked') {
                    _eventSource.close();
                    _eventSource = null;
                    if (typeof window.handleSessionExpired === 'function') window.handleSessionExpired();
                    return;
                }
                if (payload && payload.event === 'read_sync') {
                    if (payload.allRead) {
                        if (payload.unreadCount > 0) {
                            fetchNotifications();
                            return;
                        }
                        const now = new Date().toISOString();
                        _notifications.forEach(n => { if (!n.readAt) n.readAt = now; });
                        _unreadCount = 0;
                    } else if (payload.id) {
                        const target = _notifications.find(n => String(n.id) === String(payload.id));
                        if (target && !target.readAt) {
                            target.readAt = new Date().toISOString();
                        }
                        if (typeof payload.unreadCount === 'number') {
                            _unreadCount = payload.unreadCount;
                        } else {
                            _unreadCount = Math.max(0, _unreadCount - 1);
                        }
                    }
                    updateBadgeElements();
                    if (isPopoverOpen()) {
                        renderNotificationsList();
                    }
                    return;
                }

                if (payload && payload.id) {
                    const existingIndex = _notifications.findIndex(n => String(n.id) === String(payload.id));
                    if (existingIndex >= 0) {
                        _notifications[existingIndex] = payload;
                    } else {
                        _notifications.unshift(payload);
                        if (!payload.readAt) {
                            _unreadCount += 1;
                        }
                    }
                    updateBadgeElements();
                    if (isPopoverOpen()) {
                        renderNotificationsList();
                    }
                }
            } catch (err) {
                console.warn('Error parsing incoming notification:', err);
            }
        };

        _eventSource.onerror = function () {
            if (_eventSource) {
                _eventSource.close();
                _eventSource = null;
            }
            scheduleReconnect();
        };
    }

    function init() {
        _session = getSession();
        if (!_session || _session.role !== 'citizen') return;

        fetchNotifications();
        connectSSE();

        document.addEventListener('click', function (e) {
            const bellBtn = e.target.closest('.notification-bell-btn');
            if (bellBtn) {
                e.stopPropagation();
                togglePopover(bellBtn);
                return;
            }

            const markAllBtn = e.target.closest('#notificationMarkAllBtn');
            if (markAllBtn) {
                e.stopPropagation();
                markAllAsRead();
                return;
            }

            const notifItem = e.target.closest('.notification-item');
            if (notifItem) {
                e.stopPropagation();
                const id = notifItem.dataset.id;
                const reportId = notifItem.dataset.reportId;
                markSingleAsRead(id, reportId);
                return;
            }

            const popover = document.getElementById('notificationPopover');
            if (popover && !popover.hidden && !e.target.closest('#notificationPopover')) {
                closePopover();
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isPopoverOpen()) {
                closePopover();
            }
            if (e.key === 'Enter' || e.key === ' ') {
                const item = document.activeElement?.closest('.notification-item');
                if (item) {
                    e.preventDefault();
                    markSingleAsRead(item.dataset.id, item.dataset.reportId);
                }
            }
        });

        window.addEventListener('focus', function () {
            fetchNotifications();
        });

        window.addEventListener('online', function () {
            fetchNotifications();
            connectSSE();
        });

        window.addEventListener('storage', function (e) {
            if (e.key === 'up_session' && !e.newValue) {
                if (_eventSource) _eventSource.close();
            }
        });
    }

    function openDefaultPopover() {
        const bell = Array.from(document.querySelectorAll('.notification-bell-btn')).find(button =>
            button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden');
        if (bell) openPopover(bell);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CitizenNotificationCenter = {
        refresh: fetchNotifications,
        markAllAsRead,
        close: closePopover,
        open: openDefaultPopover
    };
})();
