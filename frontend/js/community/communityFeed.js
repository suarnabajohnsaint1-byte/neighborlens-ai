(function (root) {
    let initialized = false;
    function initialize() {
        const container = document.getElementById('communitySection');
        if (initialized || !container || root.NEIGHBORLENS_ACCESS_GRANTED === false) return;
        initialized = true;
        const listeners = [];
        const ownedDialogs = [];
        function ensureDialog(id, className, html, label) {
            if (document.getElementById(id)) return;
            const dialog = document.createElement('dialog'); dialog.id = id; dialog.className = className;
            dialog.setAttribute('aria-label', label); dialog.innerHTML = html;
            document.body.append(dialog); ownedDialogs.push(dialog);
        }
        ensureDialog('communityEditDialog', 'cf-dialog', '<form><h2>Edit community content</h2><p class="cf-dialog-desc" hidden>Delete this content?</p><label>Community content<textarea maxlength="2000" rows="5" required></textarea></label><p role="status" aria-live="polite"></p><div class="cf-dialog-actions"><button type="button" data-close>Cancel</button><button type="submit">Save</button></div></form>', 'Edit community content');
        ensureDialog('communityReportDialog', 'report-dialog', '<div class="report-dialog-header"><h2 data-report-dialog-title>Published report</h2><button type="button" data-report-dialog-close aria-label="Close published report"><i class="bx bx-x" aria-hidden="true"></i></button></div><div class="report-dialog-body"><p data-report-dialog-state role="status" hidden></p><div data-report-dialog-content></div></div>', 'Published report');
        function listen(target, name, handler, options) {
            target.addEventListener(name, handler, options);
            listeners.push(() => target.removeEventListener(name, handler, options));
        }
        const api = root.CommunityApi;
        const scrollFeed = root.getSession()?.role === 'citizen' ? root.matchMedia('(max-width: 900px)') : null;
        let state, active = false, loaded = false, disposed = false, searchTimer = null;
        const editor = document.getElementById('communityEditDialog'), picker = document.getElementById('communityReportPicker');
        let editorAction = null, opener = null, editing = false, sharing = false;

        function manage({ body = '', deleting = false, save }) {
            editorAction = save;
            opener = document.activeElement;
            editor.querySelector('h2').textContent = deleting ? 'Delete this community content?' : 'Edit community content';
            const desc = editor.querySelector('.cf-dialog-desc');
            if (desc) desc.hidden = !deleting;
            const textarea = editor.querySelector('textarea');
            textarea.value = body;
            textarea.hidden = deleting;
            textarea.required = !deleting;
            const label = textarea.closest('label');
            if (label) label.hidden = deleting;
            const submitBtn = editor.querySelector('[type="submit"]');
            submitBtn.textContent = deleting ? 'Delete' : 'Save';
            submitBtn.classList.toggle('is-danger', deleting);
            editor.querySelector('[role="status"]').textContent = '';
            editor.showModal();
        }

        const publicClient = {
            validId: id => /^[1-9]\d*$/.test(String(id)),
            accessMessage: () => 'Published report unavailable.',
            async load(id) {
                const data = await api.report(id);
                return {
                    report: {
                        id: data.report.id,
                        citizenCategory: data.report.category,
                        status: data.report.status,
                        barangay: data.report.barangay,
                        description: data.body,
                        created_at: data.report.createdAt
                    },
                    publicMedia: data.media.map((image, index) => ({ order: index + 1, url: root.neighborLensApiUrl(image.url) })),
                    history: [],
                    historyAvailable: true
                };
            }
        };

        const reportDialog = root.ReportDialog.create({
            dialog: document.getElementById('communityReportDialog'),
            client: publicClient,
            view: root.ReportDetailsView,
            api: root.neighborLensApiUrl,
            session: root.getSession,
            publication: true
        });

        async function refresh() {
            if (disposed) return;
            const updateBtn = container.querySelector('.cf-updates');
            if (updateBtn) updateBtn.hidden = true;
            const main = document.querySelector('main'), scroll = main?.scrollTop || 0, windowScroll = root.scrollY;
            await state.load(scrollFeed?.matches ? { page: 1 } : {});
            if (main) main.scrollTop = scroll;
            root.scrollTo(0, windowScroll);
        }

        async function chooseReport() {
            if (!picker) return;
            opener = document.activeElement;
            const statusEl = picker.querySelector('#communitySelectorStatus');
            const listEl = picker.querySelector('#communitySelectorList');
            if (statusEl) statusEl.textContent = 'Loading your eligible reports...';
            if (listEl) listEl.replaceChildren();
            picker.showModal();
            try {
                const [result, owned] = await Promise.all([api.eligibleReports(), root.apiRequest('/api/community/publication-requests')]);
                if (disposed) return;
                const reports = result.reports || [];
                if (statusEl) statusEl.textContent = owned.requests.length
                    ? owned.requests.map(row => `Report #${row.reportId}: ${root.CommunityPublication.labels[row.state] || 'Status unavailable'}${row.reason ? `: ${row.reason}` : ''}`).join(' | ')
                    : reports.length ? '' : 'No eligible unshared reports found in your barangay.';
                for (const report of reports) {
                    const card = document.createElement('div');
                    card.className = 'cf-selector-item';
                    const category = root.ReportVocabulary?.categoryOf(report) || report.citizen_category || report.ai_category || 'Infrastructure Report';
                    const status = report.status || 'pending';
                    const statusLabel = root.ReportVocabulary?.statuses?.[status] || (status.charAt(0).toUpperCase() + status.slice(1));
                    const dateStr = report.created_at ? root.CommunityCards.date(report.created_at) : '';
                    const desc = report.description || 'No description provided.';
                    card.innerHTML = `<div class="cf-selector-item-content">
                        <div class="cf-selector-item-meta">
                            <span class="cf-selector-item-id">#${root.CommunityCards.escape(report.id)}</span>
                            <span class="cf-status cf-status-pill cf-status-${root.CommunityCards.escape(status)}" data-status="${root.CommunityCards.escape(status)}">${root.CommunityCards.escape(statusLabel)}</span>
                            <strong class="cf-selector-item-category">${root.CommunityCards.escape(category)}</strong>
                            ${dateStr ? `<span class="cf-selector-item-date">${root.CommunityCards.escape(dateStr)}</span>` : ''}
                        </div>
                        <p class="cf-selector-item-desc">${root.CommunityCards.escape(desc)}</p>
                    </div>
                    <button type="button" class="cf-button-primary cf-share-action-btn" data-share-report-id="${root.CommunityCards.escape(report.id)}" data-publication-version="${Number(report.publication?.version || 0)}">
                        ${report.publication?.state === 'rejected' ? 'Resubmit for Review' : 'Share to Community'}
                    </button>`;
                    listEl.appendChild(card);
                }
            } catch (error) {
                if (!disposed && statusEl) statusEl.textContent = error.message;
            }
        }

        const selectorList = picker?.querySelector('#communitySelectorList');
        if (selectorList) {
            listen(selectorList, 'click', async event => {
                const button = event.target.closest('[data-share-report-id]');
                if (!button || sharing) return;
                const reportId = Number(button.dataset.shareReportId);
                if (!reportId) return;
                sharing = true;
                const originalText = button.textContent;
                button.textContent = 'Requesting review...';
                button.disabled = true;
                const statusEl = picker.querySelector('#communitySelectorStatus');
                if (statusEl) statusEl.textContent = '';
                try {
                    await api.publish({ reportId, requestKey: button.dataset.requestKey ||= crypto.randomUUID(), ...(Number(button.dataset.publicationVersion) ? { version: Number(button.dataset.publicationVersion) } : {}) });
                    if (!disposed) {
                        if (statusEl) statusEl.textContent = `Report #${reportId}: Pending Community Review. It is not public yet.`;
                        button.textContent = 'Pending Community Review';
                    }
                } catch (error) {
                    if (!disposed) {
                        if (statusEl) statusEl.textContent = error.message;
                        button.disabled = false;
                        button.textContent = originalText;
                    }
                } finally {
                    sharing = false;
                }
            });
        }

        const view = root.CommunityView.create(container, {
            commentCount: (id, count, version) => state.commentCount(id, count, version),
            api,
            react: (id, type) => state.react(id, type),
            report: (post, trigger) => reportDialog.open(post.id, trigger),
            edit: manage,
            manage: (post, deleting) => manage({
                body: post.body,
                deleting,
                save: async body => {
                    if (deleting) await api.remove(post.id);
                    else await api.edit(post.id, body);
                    await refresh();
                }
            }),
            openShareModal: () => chooseReport(),
            sort: sort => state.load({ sort, page: 1 }),
            changeScope: scope => {
                clearTimeout(searchTimer);
                container.querySelector('.cf-updates').hidden = true;
                return state.load({ scope, search: searchInputs[0].value.trim(), page: 1 });
            },
            ...(root.getSession()?.role === 'barangay' ? { filterStatus: status => state.load({ status, page: 1 }) } : {}),
            setPageSize: pageSize => state.load({ pageSize, page: 1 }),
            changePage: offset => state.load({ page: state.snapshot().query.page + offset }),
            scrollFeed,
            loadMore: () => { if (active && scrollFeed?.matches) state.loadMore(); },
            refresh
        });

        state = root.CommunityState.create(api, view.draw);

        const searchInputs = container.querySelectorAll('.cf-search-wrap input');
        searchInputs.forEach(input => {
            listen(input, 'input', event => {
                const query = event.target.value;
                searchInputs.forEach(other => { if (other !== event.target) other.value = query; });
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => state.load({ search: query.trim(), page: 1 }), 300);
            });
        });

        for (const dialog of [picker, editor].filter(Boolean)) {
            const closeButtons = dialog.querySelectorAll('[data-close]');
            closeButtons.forEach(btn => listen(btn, 'click', () => dialog.close()));
            listen(dialog, 'close', () => { if (opener?.isConnected) opener.focus(); });
        }

        listen(editor.querySelector('form'), 'submit', async event => {
            event.preventDefault();
            if (editing) return;
            editing = true;
            editor.querySelector('[type="submit"]').disabled = true;
            try {
                await editorAction(editor.querySelector('textarea').value.trim());
                if (!disposed) editor.close();
            } catch (error) {
                if (!disposed) editor.querySelector('[role="status"]').textContent = error.message;
            } finally {
                editing = false;
                if (!disposed) editor.querySelector('[type="submit"]').disabled = false;
            }
        });

        function activate() {
            active = root.getSession()?.role === 'barangay' ? !container.hidden : document.body.dataset.citizenSection === 'communitySection';
            if (active && !loaded) {
                loaded = true;
                refresh();
            }
        }

        function incoming() {
            if (loaded) {
                const updateBtn = container.querySelector('.cf-updates');
                if (updateBtn) updateBtn.hidden = false;
            }
        }

        function destroy() {
            if (disposed) return;
            disposed = true;
            initialized = false;
            active = false;
            clearTimeout(searchTimer);
            listeners.splice(0).forEach(remove => remove());
            state.destroy();
            view.destroy();
            reportDialog.destroy?.();
            for (const dialog of [picker, editor].filter(Boolean)) {
                if (dialog.open) dialog.close();
            }
            editor.querySelector('textarea').value = '';
            ownedDialogs.forEach(dialog => dialog.remove());
        }

        listen(root, 'citizen:section-changed', activate);
        listen(root, 'barangay:section-changed', activate);
        listen(root, 'community:changed', incoming);
        if (scrollFeed) listen(scrollFeed, 'change', () => {
            if (loaded) state.load({ page: 1 });
        });
        listen(root, 'session:changed', destroy, { once: true });
        listen(root, 'pagehide', destroy, { once: true });

        if (root.location.hash === '#community' && root.getSession()?.role === 'citizen') root.showSection('communitySection');
        activate();
        root.CommunityFeed = { snapshot: state.snapshot, refresh, chooseReport };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
    root.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
})(window);
