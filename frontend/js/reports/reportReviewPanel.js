(function (root) {
    'use strict';
    function mount(container, report, { state = {}, role = root.getSession?.()?.role, onSeverityData } = {}) {
        const document = container.ownerDocument;
        const section = document.createElement('div'); section.className = 'rd-workflow-grid';
        const recipient = role === 'barangay' ? 'Admin' : 'Barangay';
        section.innerHTML = `<section class="rd-section rd-citizen-comments"><h2><i class="bx bx-comment-detail" aria-hidden="true"></i>Citizen Comments</h2><p class="rd-comment-notice">These are comments from citizens. Staff can view but cannot modify or delete comments.</p><div class="rd-citizen-comment-list" aria-live="polite"></div><button type="button" data-comments-earlier hidden>Load earlier comments</button><p data-comments-feedback role="status"></p></section>
        <div class="rd-coordination"><section class="rd-section rd-message-compose"><h2><i class="bx bx-envelope" aria-hidden="true"></i>Message ${recipient}</h2><p class="rd-note">Send a message to the responsible ${recipient === 'Barangay' ? 'Barangay official' : 'Admin'} for follow-up or additional information about this report.</p><form class="rd-message-form"><label><span class="rd-visually-hidden">Message</span><textarea name="body" maxlength="500" rows="3" placeholder="Write a message..." required></textarea></label><div class="rd-form-actions"><span data-message-count>0 / 500</span><button type="submit">Send message</button></div></form><p data-review-feedback role="status" aria-live="polite"></p></section><section class="rd-section rd-conversation"><h2><i class="bx bx-message-rounded-dots" aria-hidden="true"></i>Conversation with ${recipient} <span data-unread></span></h2><div class="rd-coordination-messages" aria-label="Internal report messages"></div><div class="rd-conversation-controls"><button type="button" data-earlier hidden>Load earlier messages</button></div></section></div>`;
        container.append(section);
        const thread = section.querySelector('.rd-coordination-messages'), feedback = section.querySelector('[data-review-feedback]');
        const messageForm = section.querySelector('.rd-message-form'), earlier = section.querySelector('[data-earlier]');
        const base = `/api/reports/${report.id}`, listeners = [];
        const commentList = section.querySelector('.rd-citizen-comment-list'), commentFeedback = section.querySelector('[data-comments-feedback]'), commentsEarlier = section.querySelector('[data-comments-earlier]');
        let commentsLoading = false, commentsReloadAfter = false, comments = new Map(), discussionId = null;
        const discussionChoice = document.createElement('select'); discussionChoice.setAttribute('aria-label', 'Citizen discussion history'); discussionChoice.hidden = true; commentList.before(discussionChoice);
        let alive = true, controller = null, loading = false, reloadAfter = false, sending = false, messages = new Map();
        let messageRequest = state.messageRequest || null;
        let messagesLoaded = false, commentsLoaded = false, discussionStamp = null;
        const rows = new WeakMap();
        messageForm.elements.body.value = state.message || '';
        section.querySelector('[data-message-count]').textContent = `${messageForm.elements.body.value.length} / 500`;
        function listen(target, event, callback) { if (!target) return; target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback)); }
        function reconcile(host, items, emptyText, build) {
            let cached = rows.get(host);
            if (!cached) { cached = new Map(); rows.set(host, cached); }
            const scroll = host.scrollTop;
            const ids = new Set(items.map(item => item.id));
            for (const [id, entry] of cached) if (!ids.has(id)) { entry.node.remove(); cached.delete(id); }
            if (!items.length) { if (host.textContent !== emptyText) host.textContent = emptyText; return; }
            if (!cached.size) host.replaceChildren();
            items.forEach((item, index) => {
                const signature = JSON.stringify(item);
                let entry = cached.get(item.id);
                if (!entry || entry.signature !== signature) {
                    const node = build(item);
                    entry?.node.replaceWith(node);
                    entry = { node, signature }; cached.set(item.id, entry);
                }
                if (host.children[index] !== entry.node) host.insertBefore(entry.node, host.children[index] || null);
            });
            host.scrollTop = scroll;
        }
        function renderMessages() {
            reconcile(thread, [...messages.values()].sort((a, b) => a.id - b.id), 'No internal messages yet.', message => {
                const item = document.createElement('article'); item.className = `rd-coordination-message${message.mine ? ' is-mine' : ''}`; item.dataset.messageId = message.id;
                const heading = document.createElement('strong'); heading.textContent = `${message.sender}${message.mine ? ' (You)' : ''}`;
                const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = root.ReportPresentation.date(message.createdAt);
                const body = document.createElement('p'); body.textContent = message.body;
                const avatar = document.createElement('span'); avatar.className = 'rd-person-initial'; avatar.textContent = message.sender.slice(0, 1).toUpperCase(); avatar.setAttribute('aria-hidden', 'true');
                const content = document.createElement('div'); content.className = 'rd-message-content'; content.append(heading, time, body);
                item.append(avatar, content); return item;
            });
        }
        async function load(older = false) {
            if (!alive) return;
            if (loading) { reloadAfter = true; return; }
            loading = true; controller = new AbortController(); if (!messagesLoaded) feedback.textContent = 'Loading internal review...';
            try {
                const before = older && messages.size ? Math.min(...messages.keys()) : null;
                const data = await root.apiRequest(base + '/review' + (before ? `?before=${before}` : ''), { signal: controller.signal });
                if (!alive) return;
                onSeverityData?.(data);
                const initial = !messages.size;
                for (const message of data.messages) messages.set(message.id, message);
                renderMessages(); messagesLoaded = true; if (older || initial) earlier.hidden = !data.hasMore;
                section.querySelector('[data-unread]').textContent = data.unreadCount ? `(${data.unreadCount} unread)` : '';
                feedback.textContent = '';
                if (!older && data.unreadCount > 0 && data.messages.length && !document.hidden) {
                    await root.apiRequest(base + '/messages/read', { method: 'POST', body: { lastMessageId: data.messages[data.messages.length - 1].id }, signal: controller.signal });
                    if (alive) section.querySelector('[data-unread]').textContent = '';
                }
            } catch (error) { if (alive && error.name !== 'AbortError') feedback.textContent = error.message || 'Internal review could not be loaded. Updates will retry automatically.'; }
            finally { loading = false; if (reloadAfter && alive) { reloadAfter = false; load(); } }
        }
        async function loadComments(older = false) {
            if (!alive) return;
            if (commentsLoading) { commentsReloadAfter = true; return; }
            commentsLoading = true; if (!commentsLoaded) commentFeedback.textContent = 'Loading citizen comments...';
            try {
                const before = older && comments.size ? Math.min(...comments.keys()) : null;
                const query = new URLSearchParams(); if (before) query.set('before', before); if (discussionId) query.set('discussion', discussionId);
                const data = await root.apiRequest(base + '/citizen-comments' + (query.size ? `?${query}` : ''));
                if (!alive) return;
                const nextDiscussionStamp = JSON.stringify([data.discussions, data.discussionId]);
                if (discussionStamp !== nextDiscussionStamp) {
                    discussionChoice.replaceChildren();
                    for (const item of data.discussions || []) { const option = document.createElement('option'); option.value = item.postId; option.textContent = item.archived ? `Previous discussion #${item.postId} (history preserved)` : `Current incident discussion #${item.postId}`; option.selected = Number(item.postId) === Number(data.discussionId); discussionChoice.append(option); }
                    discussionStamp = nextDiscussionStamp;
                }
                discussionChoice.hidden = discussionChoice.options.length < 2;
                if (!alive) return;
                if (!older) comments.clear();
                for (const item of data.comments) comments.set(item.id, item);
                reconcile(commentList, [...comments.values()].sort((a, b) => a.id - b.id), data.published ? 'No citizen comments yet.' : 'This report has no published community discussion yet.', item => {
                    const row = document.createElement('article'); row.className = 'rd-citizen-comment';
                    const avatar = document.createElement('img'); avatar.src = `assets/avatar/avatar${Math.abs(item.avatarVariant) % 4 + 1}.png`; avatar.alt = ''; avatar.width = 36; avatar.height = 36;
                    const content = document.createElement('div'), name = document.createElement('strong'), time = document.createElement('time'), body = document.createElement('p');
                    name.textContent = item.author; time.dateTime = item.createdAt; time.textContent = root.ReportPresentation.date(item.createdAt); body.textContent = item.body;
                    const meta = document.createElement('div'); meta.className = 'rd-comment-meta';
                    if (item.parentId) { row.classList.add('is-reply'); const reply = document.createElement('span'); reply.className = 'rd-reply-label'; reply.textContent = 'Reply'; meta.append(reply, document.createTextNode(' ')); }
                    meta.append(name, document.createTextNode(' '), time);
                    content.append(meta, body); row.append(avatar, content); return row;
                });
                commentsLoaded = true;
                commentsEarlier.hidden = !data.hasMore;
                commentFeedback.textContent = '';
            } catch (error) { if (alive) commentFeedback.textContent = error.message || 'Citizen comments could not be loaded. Updates will retry automatically.'; }
            finally { commentsLoading = false; if (commentsReloadAfter && alive) { commentsReloadAfter = false; loadComments(); } }
        }
        listen(discussionChoice, 'change', () => { discussionId = Number(discussionChoice.value); loadComments(); });
        listen(commentsEarlier, 'click', () => loadComments(true));
        listen(earlier, 'click', () => load(true));
        listen(messageForm.elements.body, 'input', () => { messageRequest = null; section.querySelector('[data-message-count]').textContent = `${messageForm.elements.body.value.length} / 500`; });
        listen(messageForm, 'submit', async event => {
            event.preventDefault(); if (sending || !messageForm.reportValidity()) return;
            sending = true; const button = messageForm.querySelector('[type="submit"]'); button.disabled = true; messageForm.elements.body.disabled = true;
            messageRequest ||= { body: messageForm.elements.body.value.trim(), requestKey: root.crypto.randomUUID() };
            try {
                await root.apiRequest(base + '/messages', { method: 'POST', body: messageRequest });
                if (alive) { messageForm.reset(); messageRequest = null; section.querySelector('[data-message-count]').textContent = '0 / 500'; await load(); }
            } catch (error) { if (alive) feedback.textContent = error.message; }
            finally { sending = false; if (alive) { button.disabled = false; messageForm.elements.body.disabled = false; } }
        });
        load(); loadComments();
        return { refresh: () => Promise.all([load(), loadComments()]), state: () => ({ message: messageForm.elements.body.value, messageRequest }),
        destroy() { alive = false; controller?.abort(); listeners.splice(0).forEach(remove => remove()); section.remove(); } };
    }
    root.ReportReviewPanel = { mount };
})(window);
