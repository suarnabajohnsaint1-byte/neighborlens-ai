(function (root, factory) {
    const components = factory();
    if (typeof module === 'object' && module.exports) module.exports = components;
    else root.PortalComponents = components;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const markup = new WeakMap();
    const pending = new Map();

    function page(rows, requestedPage, size) {
        const pages = Math.max(1, Math.ceil(rows.length / size));
        const current = Math.min(pages, Math.max(1, requestedPage));
        return { items: rows.slice((current - 1) * size, current * size), total: rows.length, page: current, pages };
    }

    function render(element, html) {
        if (!element || markup.get(element) === html) return false;
        element.innerHTML = html;
        markup.set(element, html);
        return true;
    }

    function pagination(document, prefix, data, size, noun, ids = {}) {
        const info = document.getElementById(ids.info || `${prefix}PageInfo`);
        const number = document.getElementById(`${prefix}PageNumber`);
        const previous = document.getElementById(ids.previous || `${prefix}Prev`);
        const next = document.getElementById(ids.next || `${prefix}Next`);
        if (info) info.textContent = `${data.total ? (data.page - 1) * size + 1 : 0}-${Math.min(data.page * size, data.total)} of ${data.total} ${noun}`;
        if (number) number.textContent = `Page ${data.page} of ${data.pages}`;
        if (previous) previous.disabled = data.page <= 1;
        if (next) next.disabled = data.page >= data.pages;
    }

    function load(key, operation) {
        if (pending.has(key)) return pending.get(key);
        const promise = Promise.resolve().then(operation).finally(() => {
            if (pending.get(key) === promise) pending.delete(key);
        });
        pending.set(key, promise);
        return promise;
    }

    function resolutionProgress(total, resolved) {
        const maximum = Number.isSafeInteger(total) && total > 0 ? total : 0;
        const completed = Number.isSafeInteger(resolved) ? Math.min(maximum, Math.max(0, resolved)) : 0;
        const percentage = maximum ? completed / maximum * 100 : 0;
        return { total: maximum, resolved: completed, percentage, label: maximum ? `${Math.round(percentage)}%` : 'No reports yet' };
    }

    function resolutionProgressMarkup(total, resolved) {
        const progress = resolutionProgress(total, resolved);
        const text = progress.total ? `${progress.resolved} / ${progress.total} resolved (${progress.label})` : progress.label;
        return `<div class="resolution-progress-caption"><span>Resolution progress</span><span>${text}</span></div>
            <div class="resolution-progress" role="progressbar" aria-label="Resolution progress" aria-valuemin="0" aria-valuemax="100"
                aria-valuenow="${progress.percentage}" aria-valuetext="${text}"><span style="width:${progress.percentage}%"></span></div>`;
    }

    const reportSummaryMetrics = {
        total: ['Total reports', 'copy-alt'], pending: ['Pending', 'time-five'], ongoing: ['Ongoing', 'refresh'],
        resolved: ['Resolved', 'check-circle'], major: ['Major issues', 'error'], minor: ['Minor issues', 'list-check'],
        pendingPosts: ['Pending posts', 'message-rounded-dots']
    };

    function mountReportSummary(container, actions = {}) {
        if (container.childElementCount) return;
        const keys = container.dataset.reportSummary === 'admin'
            ? ['total', 'pending', 'resolved', 'major', 'minor', 'pendingPosts']
            : ['total', 'pending', 'ongoing', 'resolved', 'major', 'minor'];
        container.innerHTML = keys.map(key => {
            const [label, icon] = reportSummaryMetrics[key];
            const id = `stat${key[0].toUpperCase()}${key.slice(1)}`;
            const pendingPosts = key === 'pendingPosts';
            const action = actions[key];
            const tag = action ? 'button' : 'div';
            const hintId = pendingPosts ? 'pendingPostsHint' : 'viewReportsHint';
            const attributes = action ? ` type="button" aria-describedby="${hintId}"${pendingPosts ? ' id="pendingPostsCard" aria-busy="true"' : ''}` : '';
            return `<${tag} class="portal-report-stat" data-metric="${key}"${attributes}>
                <i class="bx bx-${icon} portal-report-stat-icon" aria-hidden="true"></i>
                <span class="portal-report-stat-content"><span class="portal-report-stat-label">${label}</span>
                    <strong class="portal-report-stat-value" id="${id}"${pendingPosts ? ' aria-live="polite"' : ''}>...</strong></span>
                ${action ? `<i class="bx bx-chevron-right portal-report-stat-arrow" aria-hidden="true"></i>
                    <span id="${hintId}" hidden>${pendingPosts ? 'Awaiting review' : 'View all reports'}</span>` : ''}
            </${tag}>`;
        }).join('');
        for (const button of container.querySelectorAll('button')) button.addEventListener('click', actions[button.dataset.metric]);
    }

    function sheets(document, { onClear = {}, query = '(max-width: 900px)' } = {}) {
        const view = document.defaultView;
        const media = view.matchMedia(query);
        const backdrop = document.createElement('div');
        backdrop.className = 'portal-sheet-backdrop';
        backdrop.hidden = true;
        document.body.append(backdrop);
        let active = null;
        let opener = null;
        let previousOverflow = '';
        let hiddenBeforeOpen = false;

        const triggers = id => document.querySelectorAll(`[data-sheet-open="${id}"]`);
        const focusable = sheet => [...sheet.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]')]
            .filter(element => element.offsetParent !== null || element === document.activeElement);

        function open(sheet, trigger = null) {
            if (!sheet || !media.matches) return;
            if (active) close(false);
            active = sheet;
            hiddenBeforeOpen = sheet.hidden;
            sheet.hidden = false;
            opener = trigger;
            previousOverflow = document.body.style.overflow;
            sheet.classList.add('is-open');
            sheet.setAttribute('role', 'dialog');
            sheet.setAttribute('aria-modal', 'true');
            backdrop.hidden = false;
            document.body.style.overflow = 'hidden';
            triggers(sheet.id).forEach(button => button.setAttribute('aria-expanded', 'true'));
            (sheet.querySelector('[data-sheet-close]') || sheet).focus();
        }

        function close(restoreFocus = true) {
            if (!active) return;
            const sheet = active;
            active = null;
            sheet.hidden = hiddenBeforeOpen;
            sheet.classList.remove('is-open');
            sheet.removeAttribute('role');
            sheet.removeAttribute('aria-modal');
            backdrop.hidden = true;
            document.body.style.overflow = previousOverflow;
            triggers(sheet.id).forEach(button => button.setAttribute('aria-expanded', 'false'));
            if (restoreFocus && opener?.isConnected) opener.focus();
            opener = null;
        }

        function click(event) {
            const trigger = event.target.closest('[data-sheet-open]');
            if (trigger) {
                event.preventDefault();
                open(document.getElementById(trigger.dataset.sheetOpen), trigger);
                return;
            }
            const sheet = event.target.closest('[data-sheet]');
            if (!sheet) return;
            if (event.target.closest('[data-sheet-clear]')) onClear[sheet.id]?.();
            if (event.target.closest('[data-sheet-close], [data-sheet-apply]')) close();
        }

        function keydown(event) {
            if (!active) return;
            if (event.key === 'Escape') { event.preventDefault(); close(); return; }
            if (event.key !== 'Tab') return;
            const targets = focusable(active);
            if (!targets.length) return;
            const first = targets[0];
            const last = targets[targets.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }

        document.addEventListener('click', click);
        document.addEventListener('keydown', keydown);
        const dismiss = () => close();
        const resize = () => close(false);
        backdrop.addEventListener('click', dismiss);
        media.addEventListener('change', resize);

        function setCount(id, count) {
            triggers(id).forEach(button => {
                const badge = button.querySelector('.portal-filter-count');
                if (badge) { badge.hidden = !count; badge.textContent = count ? String(count) : ''; }
                button.setAttribute('aria-label', count ? `Filters, ${count} active` : 'Filters');
            });
        }

        return {
            open: (id, trigger) => open(document.getElementById(id), trigger), close, setCount, active: () => active?.id || null,
            destroy() {
                close(false);
                document.removeEventListener('click', click);
                document.removeEventListener('keydown', keydown);
                backdrop.removeEventListener('click', dismiss);
                media.removeEventListener('change', resize);
                backdrop.remove();
            }
        };
    }

    function viewLayout(storageKey = 'neighborlens_report_layout') {
        const get = () => {
            try { return localStorage.getItem(storageKey) || 'grid'; } catch { return 'grid'; }
        };
        const set = mode => {
            try { localStorage.setItem(storageKey, mode); } catch {}
        };
        return { get, set };
    }

    function bindViewToggle(container, targetList, { storageKey = 'neighborlens_report_layout', onToggle } = {}) {
        if (!container || !targetList || typeof container.addEventListener !== 'function') return null;
        const store = viewLayout(storageKey);
        let current = store.get();

        function apply(mode, triggerCallback = true) {
            const textAvailable = mode === 'text' && container.querySelector?.('[data-view-mode="text"]');
            current = ['row', 'split'].includes(mode) || textAvailable ? mode : 'grid';
            if (typeof targetList.setAttribute === 'function') {
                if (current !== 'grid') targetList.setAttribute('data-layout', current);
                else targetList.removeAttribute('data-layout');
            }
            const buttons = typeof container.querySelectorAll === 'function' ? container.querySelectorAll('[data-view-mode]') : [];
            buttons.forEach(btn => {
                const active = btn.dataset?.viewMode === current;
                btn.classList?.toggle('is-active', active);
                btn.setAttribute?.('aria-pressed', String(active));
            });
            store.set(current);
            if (triggerCallback && typeof onToggle === 'function') onToggle(current);
        }

        const click = event => {
            const btn = event.target?.closest?.('[data-view-mode]');
            if (btn && btn.dataset?.viewMode) {
                apply(btn.dataset.viewMode, true);
            }
        };
        container.addEventListener('click', click);

        apply(current, false);
        return { apply, current: () => current, destroy: () => container.removeEventListener('click', click) };
    }

    function confirmAction(document, { title, message, label }) {
        return new Promise(resolve => {
            const opener = document.activeElement;
            const parent = opener?.closest('dialog[open]');
            const dialog = document.createElement(parent ? 'section' : 'dialog'); dialog.className = parent ? 'portal-confirm portal-confirm-inline' : 'portal-confirm';
            const heading = document.createElement('h2'); heading.textContent = title;
            const description = document.createElement('p'); description.textContent = message;
            const actions = document.createElement('div'); actions.className = 'section-actions';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'portal-button-secondary'; cancel.textContent = 'Cancel';
            const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn-main'; approve.textContent = label;
            dialog.setAttribute('aria-label', title);
            actions.append(cancel, approve); dialog.append(heading, description, actions);
            if (parent) {
                const body = parent.querySelector('.report-dialog-body') || parent;
                const children = [...body.children].map(node => [node, node.hidden]);
                children.forEach(([node]) => { node.hidden = true; }); body.append(dialog);
                let finished = false;
                const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(false); } };
                const closed = () => finish(false);
                function finish(accepted) {
                    if (finished) return; finished = true;
                    dialog.remove(); children.forEach(([node, hidden]) => { node.hidden = hidden; });
                    parent.removeEventListener('keydown', escape, true); parent.removeEventListener('close', closed);
                    if (opener?.isConnected && parent.open) opener.focus(); resolve(accepted);
                }
                cancel.addEventListener('click', () => finish(false)); approve.addEventListener('click', () => finish(true));
                parent.addEventListener('keydown', escape, true); parent.addEventListener('close', closed);
                cancel.focus(); return;
            }
            document.body.append(dialog);
            let accepted = false;
            cancel.addEventListener('click', () => dialog.close());
            approve.addEventListener('click', () => { accepted = true; dialog.close(); });
            dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus(); resolve(accepted); }, { once: true });
            dialog.showModal(); cancel.focus();
        });
    }

    return { page, render, pagination, load, sheets, resolutionProgress, resolutionProgressMarkup, mountReportSummary, viewLayout, bindViewToggle, confirmAction, invalidate: element => markup.delete(element) };
});
