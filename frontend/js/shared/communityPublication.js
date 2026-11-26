(function (root) {
    const labels = { unshared: 'Not shared', pending_approval: 'Pending Community Review', approved: 'Published to Community Feed', rejected: 'Publication Rejected' };
    function mount(container, report, role) {
        if (!['admin', 'citizen'].includes(role)) return () => {};
        const document = container.ownerDocument;
        const section = document.createElement('section');
        section.className = 'rd-section rd-publication';
        const heading = document.createElement('h2'); heading.textContent = 'Community Publication';
        const content = document.createElement('div'); content.className = 'rd-publication-content';
        const feedback = document.createElement('p'); feedback.className = 'rd-publication-feedback'; feedback.setAttribute('role', 'status');
        section.append(heading, content, feedback); container.append(section);
        let alive = true, saving = false, confirming = false, publication = null, revision = 0, controller = null, catalog = null;
        const paths = `/api/admin/community-publications/${report.id}`;
        const session = JSON.stringify(root.getSession?.());
        const current = () => alive && JSON.stringify(root.getSession?.()) === session;
        const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
        function button(label, action) {
            const control = text('button', label); control.className = 'rd-publication-button'; control.type = 'button'; control.addEventListener('click', action); return control;
        }
        function releaseImages() {
            content.querySelectorAll('img').forEach(image => root.ReportEvidence?.release(image));
        }
        async function load() {
            const version = ++revision;
            controller?.abort();
            controller = new AbortController();
            section.setAttribute('aria-busy', 'true');
            content.querySelectorAll('button, textarea, select').forEach(node => { node.disabled = true; });
            feedback.textContent = 'Loading publication status...';
            try {
                const data = await root.apiRequest(role === 'admin' ? paths : '/api/community/publication-requests', { signal: controller.signal });
                if (!current() || version !== revision) return;
                publication = role === 'admin' ? data.publication : data.requests.find(row => Number(row.reportId) === Number(report.id)) || { state: 'unshared' };
                draw(); feedback.textContent = '';
            } catch (error) {
                if (current() && version === revision && error.name !== 'AbortError') {
                    releaseImages();
                    const notice = text('div', 'Publication status unavailable'); notice.className = 'rd-publication-state';
                    content.replaceChildren(notice);
                    feedback.textContent = error.message;
                    if (error.code !== 'COMMUNITY_SETUP_REQUIRED') content.append(button('Retry publication status', load));
                }
            } finally { if (current() && version === revision) section.setAttribute('aria-busy', 'false'); }
        }
        async function save(operation, reportChanged = false) {
            if (saving || !current()) return;
            saving = true;
            feedback.textContent = 'Saving publication...';
            content.querySelectorAll('button, textarea, select').forEach(node => { node.disabled = true; });
            try {
                await operation();
                if (!current()) return;
                root.dispatchEvent(new CustomEvent('publication:changed', { detail: { reportId: report.id, reportChanged } }));
                await load();
            } catch (error) { if (current()) { if (error.status === 409) await load(); feedback.textContent = error.message; } }
            finally { saving = false; if (current()) content.querySelectorAll('button, textarea, select').forEach(node => { node.disabled = false; }); }
        }
        function draw() {
            releaseImages();
            const status = text('p', labels[publication.state] || 'Status unavailable'); status.className = 'rd-publication-state';
            content.replaceChildren(status);
            if (publication.reason) { const reason = text('p', `Reason: ${publication.reason}`); reason.className = 'rd-publication-reason'; content.append(reason); }
            if (role === 'admin' && publication.state !== 'unshared') {
                const facts = document.createElement('dl'); facts.className = 'rd-publication-facts';
                const fact = (label, value) => { const pair = document.createElement('div'); pair.append(text('dt', label), text('dd', value)); facts.append(pair); };
                fact('Report', `#${report.id}${report.barangay ? ` \u00b7 ${report.barangay}` : ''}`);
                fact('Reviewer', publication.assignedToMe ? 'Assigned to you' : publication.assigned ? 'Assigned to another Admin' : 'No active reviewer assigned');
                if (publication.requestedAt) fact('Requested', root.ReportPresentation.date(publication.requestedAt));
                if (publication.reviewedAt) fact('Reviewed', root.ReportPresentation.date(publication.reviewedAt));
                if (publication.reviewedBy) fact('Reviewed by', `Admin #${publication.reviewedBy}`);
                fact('Category', root.ReportPresentation.damage(report).title);
                fact('Incident location', report.location || report.barangay || 'Not recorded');
                const preview = text('p', publication.body || ''); preview.className = 'rd-publication-description';
                content.append(facts, text('h3', 'Publication preview'), preview);
                const gallery = document.createElement('div'); gallery.className = 'rd-publication-photos';
                for (const photo of publication.media || []) {
                    const image = document.createElement('img'); image.alt = `Public preview photo ${photo.order}`;
                    image.dataset.evidenceUrl = root.neighborLensApiUrl(photo.url); gallery.append(image);
                }
                if (gallery.childElementCount) { content.append(gallery); root.ReportEvidence?.hydrate(gallery); }
                if (publication.state === 'pending_approval') {
                    if (publication.assignedToMe) {
                        const label = text('label', 'Rejection reason');
                        const reason = document.createElement('textarea'); reason.maxLength = 500; reason.rows = 2; label.append(reason);
                        const actions = document.createElement('div'); actions.className = 'rd-review-actions';
                        if (!publication.barangayId) content.append(text('p', 'A designated routing administrator must verify and assign the incident jurisdiction from Report Details before publication.'));
                        const approve = button('Approve & Publish', async () => {
                            if (confirming || saving) return;
                            if (!publication.barangayId) { feedback.textContent = 'Assign the incident barangay before publishing.'; return; }
                            confirming = true;
                            const version = publication.version;
                            try {
                                const accepted = await root.PortalComponents.confirmAction(document, { title: 'Publish to Community Feed?', message: 'The sanitized report description and evidence will become visible in Community Feed.', label: 'Approve & Publish' });
                                if (accepted && current()) await save(() => root.apiRequest(`${paths}/decision`, { method: 'POST', body: { state: 'approved', version } }));
                            } finally { confirming = false; }
                        });
                        approve.classList.add('rd-publication-button-primary');
                        actions.append(approve, button('Reject Publication', () => {
                                if (reason.value.trim().length < 5) { feedback.textContent = 'Enter a meaningful rejection reason (at least 5 characters).'; reason.focus(); return; }
                                save(() => root.apiRequest(`${paths}/decision`, { method: 'POST', body: { state: 'rejected', reason: reason.value.trim(), version: publication.version } }));
                            }));
                        content.append(label, actions);
                    } else if (publication.canAssign) content.append(button('Assign available reviewer', () => save(() => root.apiRequest(`${paths}/assign`, { method: 'POST' }))));
                }
                if (publication.history?.length) {
                    const history = document.createElement('details'); history.append(text('summary', 'Publication review history'));
                    const list = document.createElement('ol');
                    for (const row of publication.history) list.append(text('li', `${labels[row.state]} \u00b7 Admin #${row.reviewerId} \u00b7 ${root.ReportPresentation.date(row.reviewedAt)}${row.reason ? ` \u00b7 ${row.reason}` : ''}`));
                    history.append(list); content.append(history);
                }
            } else if (role === 'admin' && publication.state === 'unshared') {
                content.append(text('p', 'This report has no publication review record.'));
            } else if (role === 'citizen' && ['unshared', 'rejected'].includes(publication.state) && (publication.attempts || 0) < 3) {
                content.append(text('p', 'Publication requires Admin approval. Your report description and submitted photos will be reviewed for public sharing.'));
                const label = text('label', 'Public description');
                const body = document.createElement('textarea'); body.maxLength = 2000; body.rows = 3;
                body.value = publication.body ?? report.description ?? ''; label.append(body); content.append(label);
                const key = root.crypto.randomUUID();
                const share = button(publication.state === 'rejected' ? 'Resubmit for Community Review' : 'Share to Community', () => {
                    if (!body.value.trim() || body.value.length > 2000) { feedback.textContent = 'Enter a public description within 2000 characters.'; body.focus(); return; }
                    save(() => root.apiRequest('/api/community/posts', { method: 'POST', body: { reportId: report.id, body: body.value.trim(), requestKey: key, ...(publication.version ? { version: publication.version } : {}) } }));
                });
                share.classList.add('rd-publication-button-primary'); content.append(share);
            }
        }
        const updated = () => { if (!saving && current()) load(); };
        if (role === 'admin') root.addEventListener('admin:reports-changed', updated);
        load();
        return () => { alive = false; revision++; controller?.abort(); root.removeEventListener('admin:reports-changed', updated); section.querySelectorAll('img').forEach(image => root.ReportEvidence?.release(image)); section.remove(); };
    }
    const view = {
        signature: data => root.ReportDetailsView.signature(data),
        mount(container, data) {
            container.replaceChildren();
            const wrapper = container.ownerDocument.createElement('div'); wrapper.className = 'rd-view rd-moderation'; container.append(wrapper);
            const release = mount(wrapper, data.report, 'admin');
            return { report: data.report, destroy() { release(); wrapper.remove(); }, state: () => ({}), isMapExpanded: () => false, collapseMap() {} };
        }
    };
    root.CommunityPublication = { mount, labels, view };
})(window);
