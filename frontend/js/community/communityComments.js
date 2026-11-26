(function (root) {
    function create(container, postId, { api, manage, updated, beforeDraw }) {
        const { escape, icon, date, avatarSrc, reactionControl, updateReaction } = root.CommunityCards;
        let page = 1, totalPages = 1, generation = 0, busy = false, initialLoaded = false, loadingComments = false, pendingBody = null, requestKey = crypto.randomUUID(), alive = true;
        let replyTarget = null;
        let pendingParent = null;
        let supportsHeart = false;
        const rows = new Map();
        const pendingReactions = new Set();
        const replyPages = new Map();
        const collapsedThreads = new Set();
        const commentPrompt = root.getSession?.()?.role === 'barangay'
            ? 'Write a public comment as a barangay official...'
            : 'Write a public comment as Anonymous resident...';

        container.innerHTML = `<div class="cf-comment-list"></div>
            <div class="cf-comment-load-more" hidden>
                <button type="button" class="cf-view-more-btn" data-comment-more>View more comments</button>
            </div>
            <div class="cf-reply-banner-wrap" hidden></div>
            <form class="cf-comment-form">
                <span class="cf-comment-input-avatar">${icon('bxs-user-circle')}</span>
                <div class="cf-comment-input-wrap">
                    <input type="text" name="body" maxlength="1000" placeholder="${commentPrompt}" required autocomplete="off">
                </div>
                <button type="submit" class="cf-comment-submit-btn">Comment</button>
            </form>
            <p class="cf-comment-state" role="status" aria-live="polite"></p>
            <button type="button" class="cf-text-button" data-comment-retry hidden>Retry comments</button>`;
        const feedback = value => { container.querySelector('.cf-comment-state').textContent = value; };

        function updateReplyBanner() {
            const bannerWrap = container.querySelector('.cf-reply-banner-wrap');
            const input = container.querySelector('input[name="body"]');
            const submitBtn = container.querySelector('.cf-comment-submit-btn');
            if (!replyTarget) {
                bannerWrap.hidden = true;
                bannerWrap.innerHTML = '';
                if (input) input.placeholder = commentPrompt;
                if (submitBtn) submitBtn.textContent = 'Comment';
                return;
            }
            bannerWrap.hidden = false;
            bannerWrap.innerHTML = `<div class="cf-reply-context">
                <div class="cf-reply-context-info">
                    <span class="cf-reply-arrow">&#8627;</span>
                    <span>Replying to <strong>${escape(replyTarget.name)}</strong></span>
                </div>
                <button type="button" class="cf-reply-cancel-btn" data-cancel-reply aria-label="Cancel reply">&times;</button>
            </div>`;
            if (input) {
                input.placeholder = `Write your reply to ${replyTarget.name}...`;
                input.focus();
            }
            if (submitBtn) submitBtn.textContent = 'Reply';
        }

        function renderCommentItem(row, isReply = false, rootCommentId = null) {
            const isOfficial = Boolean(row.author?.official);
            const authorName = row.author?.pseudonym || (isOfficial ? row.author?.label : 'Anonymous resident');

            if (row.isDeleted) {
                return `<article class="cf-comment cf-comment-deleted" data-comment-id="${row.id}">
                    <div class="cf-comment-deleted-box">
                        <span class="cf-deleted-icon">${icon('bx-trash')}</span>
                        <p class="cf-comment-deleted-text">This comment has been deleted.</p>
                    </div>
                </article>`;
            }

            let replyTagHtml = '';
            if (isReply && row.parentId && rootCommentId && row.parentId !== rootCommentId) {
                const parentName = row.parentAuthor || rows.get(row.parentId)?.author?.pseudonym || 'Resident';
                replyTagHtml = `<div class="cf-replying-to-tag"><span class="cf-reply-arrow">&#8627;</span> Replying to <strong>${escape(parentName)}</strong></div>`;
            }

            return `<article class="cf-comment ${isReply ? 'cf-comment-reply' : ''}" data-comment-id="${row.id}">
                <span class="cf-avatar">
                    ${isOfficial ? icon('bxs-institution') : `<img src="${avatarSrc(row.author, row.id)}" alt="${escape(authorName)}" class="cf-avatar-img" width="32" height="32">`}
                </span>
                <div class="cf-comment-content">
                    <div class="cf-comment-header">
                        <strong class="cf-comment-author">${escape(authorName)}</strong>
                        ${isOfficial ? '<span class="cf-official">Official</span>' : ''}
                        <time datetime="${escape(row.createdAt)}" title="${escape(new Date(row.createdAt).toLocaleString())}">${escape(date(row.createdAt))}</time>
                    </div>
                    ${replyTagHtml}
                    <p class="cf-comment-body">${escape(row.body)}</p>
                    <div class="cf-comment-actions">
                        ${reactionControl('comment', row.reactions, { supportsHeart, pending: pendingReactions.has(row.id) })}
                        <button type="button" class="cf-comment-action" data-comment-reply="${row.id}" data-author-name="${escape(authorName)}">Reply</button>
                        ${row.canEdit ? `
                            <button type="button" class="cf-comment-action" data-comment-action="edit">Edit</button>
                            <button type="button" class="cf-comment-action" data-comment-action="delete">Delete</button>
                        ` : ''}
                    </div>
                </div>
            </article>`;
        }

        function renderThread(row, children, rootId = row.id, depth = 0) {
            if (depth >= 64) return '';
            const replies = children.get(row.id) || [];
            const count = Math.max(row.visibleReplyCount || 0, replies.length);
            const isCollapsed = collapsedThreads.has(row.id);
            const repliesHtml = replies.map(child => renderThread(child, children, rootId, depth + 1)).join('');
            return `<div class="cf-comment-node ${depth ? '' : 'cf-comment-thread'}" data-comment-node="${row.id}" data-depth="${Math.min(depth, 3)}" ${depth ? '' : `data-thread-id="${row.id}"`}>
                ${renderCommentItem(row, depth > 0, rootId)}
                ${count ? `
                <div class="cf-replies-wrap">
                    <button type="button" class="cf-toggle-replies-btn" data-toggle-thread="${row.id}" aria-expanded="${!isCollapsed}">
                        <span class="cf-toggle-replies-line"></span>
                        <span class="cf-toggle-replies-text">${isCollapsed ? `View ${count} replies` : 'Hide replies'}</span>
                    </button>
                    <div class="cf-replies-list" ${isCollapsed ? 'hidden' : ''}>${repliesHtml}
                    ${count > replies.length ? `<button type="button" class="cf-text-button" data-load-replies="${row.id}">View more replies</button>` : ''}</div>
                </div>` : ''}
            </div>`;
        }

        function draw() {
            beforeDraw?.();
            const children = new Map();
            for (const row of rows.values()) {
                if (!row.parentId) continue;
                if (!children.has(row.parentId)) children.set(row.parentId, []);
                children.get(row.parentId).push(row);
            }
            const order = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id;
            for (const items of children.values()) items.sort(order);
            const roots = [...rows.values()].filter(row => !row.parentId).sort(order);
            container.querySelector('.cf-comment-list').innerHTML = roots.map(row => renderThread(row, children)).join('');
        }

        function findRootId(c, map) {
            let curr = c;
            const visited = new Set();
            while (curr && curr.parentId && !visited.has(curr.id)) {
                visited.add(curr.id);
                const parent = map.get(curr.parentId);
                if (!parent) break;
                curr = parent;
            }
            return curr ? curr.id : c.id;
        }

        function updateLoadMore() {
            const wrap = container.querySelector('.cf-comment-load-more');
            const button = container.querySelector('[data-comment-more]');
            wrap.hidden = !initialLoaded || page > totalPages;
            button.disabled = loadingComments;
            button.textContent = loadingComments ? 'Loading comments...' : 'View more comments';
        }

        // API pages are retained for fetching, but no page-number navigation is shown.
        // Each subsequent request merges its rows instead of replacing the list.
        async function load({ reset = false } = {}) {
            if (!alive || loadingComments) return;
            const current = ++generation;
            const requestedPage = reset ? 1 : page;
            loadingComments = true;
            container.querySelector('[data-comment-retry]').hidden = true;
            feedback(requestedPage === 1 ? 'Loading comments...' : 'Loading more comments...');
            updateLoadMore();

            try {
                const data = await api.comments(postId, requestedPage);
                if (!alive || current !== generation) return;
                if (reset) {
                    rows.clear();
                    replyPages.clear();
                }
                for (const row of data.comments) rows.set(row.id, row);
                const loadedChildren = new Map();
                for (const row of rows.values()) {
                    if (row.parentId) loadedChildren.set(row.parentId, (loadedChildren.get(row.parentId) || 0) + 1);
                }
                for (const [parent, count] of loadedChildren) {
                    // Only seed a page counter if there isn't already one from an explicit reply fetch.
                    if (!replyPages.has(parent)) replyPages.set(parent, Math.floor(count / Number(data.pagination.pageSize || 5)) + 1);
                }

                supportsHeart = data.supportsHeart === true;
                page = Number(data.pagination.page || requestedPage) + 1;
                initialLoaded = true;
                totalPages = Math.max(1, Number(data.pagination.pages || 1));
                draw();
                updated(data.pagination.total, data.engagementVersion);
                feedback(rows.size ? '' : 'No comments yet.');
            } catch (error) {
                if (alive && current === generation) {
                    feedback(error.message || 'Could not load comments.');
                    container.querySelector('[data-comment-retry]').hidden = false;
                }
            } finally {
                if (alive && current === generation) {
                    loadingComments = false;
                    updateLoadMore();
                }
            }
        }

        async function submit(event) {
            event.preventDefault();
            if (busy) return;
            const form = event.target, body = pendingBody ?? form.elements.body.value.trim();
            if (!body) return;
            busy = true;
            if (pendingBody === null) pendingParent = replyTarget?.id || null;
            pendingBody = body;
            form.elements.body.disabled = true;
            form.querySelector('button').disabled = true;
            feedback(replyTarget ? 'Saving reply...' : 'Saving comment...');
            try {
                const payload = { body, requestKey, parentCommentId: pendingParent };
                const result = await api.comment(postId, payload);
                if (!alive) return;
                requestKey = crypto.randomUUID();
                pendingBody = null;
                const savedParent = pendingParent;
                pendingParent = null;
                if (replyTarget) {
                    const targetComment = rows.get(replyTarget.id);
                    if (targetComment) {
                        const rootId = findRootId(targetComment, rows);
                        collapsedThreads.delete(rootId);
                    }
                }
                replyTarget = null;
                updateReplyBanner();
                if (form.elements.body.value.trim() === body) form.reset();
                if (savedParent && result.comment && rows.has(savedParent)) {
                    const parent = rows.get(savedParent);
                    if (!rows.has(result.comment.id)) parent.visibleReplyCount = (parent.visibleReplyCount || 0) + 1;
                    rows.set(result.comment.id, result.comment);
                    collapsedThreads.delete(savedParent);
                    draw(); updated(result.total, result.engagementVersion); feedback('');
                } else if (result.comment) {
                    // Show the new root immediately; maintain the already-visible comments.
                    rows.set(result.comment.id, result.comment);
                    if (result.rootTotal != null) {
                        totalPages = Math.max(totalPages, Math.ceil(Number(result.rootTotal) / 10));
                    }
                    draw();
                    updateLoadMore();
                    updated(result.total, result.engagementVersion);
                    feedback('');
                } else {
                    // The API returned no new row; reload from the server as a fallback.
                    await load({ reset: true });
                }
            } catch (error) {
                if (error.status >= 400 && error.status < 500 && error.status !== 429) {
                    pendingBody = null;
                    requestKey = crypto.randomUUID();
                }
                if (alive) feedback(error.message + (pendingBody !== null ? ' Retry to confirm the same draft.' : ' Your draft is preserved.'));
            } finally {
                busy = false;
                if (alive) {
                    form.querySelector('button').disabled = false;
                    form.elements.body.disabled = pendingBody !== null;
                }
            }
        }

        async function react(button, selected) {
            const commentId = Number(button.closest('[data-comment-id]').dataset.commentId);
            const row = rows.get(commentId);
            if (!row || pendingReactions.has(commentId)) return;
            const previous = row.reactions || {};
            const current = previous.type || (previous.mine ? 'like' : null);
            const desired = selected ?? (current ? null : 'like');
            if (desired === current) return;
            pendingReactions.add(commentId);
            button.disabled = true;
            updateReaction(button, desired, Math.max(0, (previous.total || 0) - Number(Boolean(current)) + Number(Boolean(desired))));
            try {
                const res = await api.reactComment(postId, commentId, desired);
                if (!alive) return;
                const type = res.reaction ?? (res.reacted ? 'like' : null);
                const cached = rows.get(commentId);
                if (cached) cached.reactions = { total: res.total, mine: Boolean(type), type };
            } catch (error) {
                if (!alive) return;
                feedback(error.message || 'Failed to update reaction.');
            } finally {
                pendingReactions.delete(commentId);
                const liveButton = alive && container.querySelector(`[data-comment-id="${commentId}"] [data-reaction-target="comment"]`);
                if (liveButton) {
                    const latest = rows.get(commentId)?.reactions || previous;
                    updateReaction(liveButton, latest.type || (latest.mine ? 'like' : null), latest.total);
                    liveButton.disabled = false;
                }
            }
        }

        function click(event) {
            const loadReplies = event.target.closest('[data-load-replies]');
            if (loadReplies) {
                const parentId = Number(loadReplies.dataset.loadReplies);
                const current = generation;
                loadReplies.disabled = true;
                api.comments(postId, replyPages.get(parentId) || 1, parentId).then(data => {
                    if (!alive || current !== generation) return;
                    replyPages.set(parentId, data.pagination.page + 1);
                    const parent = rows.get(parentId);
                    if (parent) parent.visibleReplyCount = data.pagination.childTotal;
                    data.comments.forEach(row => rows.set(row.id, row)); draw();
                }).catch(error => { if (alive) feedback(error.message); }).finally(() => { if (alive) loadReplies.disabled = false; });
                return;
            }
            if (event.target.closest('[data-comment-retry]')) {
                load();
                return;
            }
            if (event.target.closest('[data-comment-more]')) {
                load();
                return;
            }

            const toggleThreadBtn = event.target.closest('[data-toggle-thread]');
            if (toggleThreadBtn) {
                const threadId = Number(toggleThreadBtn.dataset.toggleThread);
                const wrap = toggleThreadBtn.closest('.cf-replies-wrap');
                const list = wrap ? wrap.querySelector('.cf-replies-list') : null;
                const textSpan = toggleThreadBtn.querySelector('.cf-toggle-replies-text');
                const wasCollapsed = collapsedThreads.has(threadId);
                if (wasCollapsed) {
                    collapsedThreads.delete(threadId);
                    if (list) list.hidden = false;
                    toggleThreadBtn.setAttribute('aria-expanded', 'true');
                    if (textSpan) textSpan.textContent = 'Hide replies';
                } else {
                    collapsedThreads.add(threadId);
                    if (list) list.hidden = true;
                    toggleThreadBtn.setAttribute('aria-expanded', 'false');
                    const count = rows.get(threadId)?.visibleReplyCount || 0;
                    if (textSpan) textSpan.textContent = `View ${count} ${count === 1 ? 'reply' : 'replies'}`;
                }
                return;
            }

            const cancelReply = event.target.closest('[data-cancel-reply]');
            if (cancelReply) {
                if (busy || pendingBody !== null) return;
                replyTarget = null;
                updateReplyBanner();
                return;
            }

            const replyBtn = event.target.closest('[data-comment-reply]');
            if (replyBtn) {
                if (busy || pendingBody !== null) return;
                replyTarget = {
                    id: Number(replyBtn.dataset.commentReply),
                    name: replyBtn.dataset.authorName
                };
                updateReplyBanner();
                return;
            }

            const action = event.target.closest('[data-comment-action]');
            if (action) {
                const row = rows.get(Number(action.closest('[data-comment-id]').dataset.commentId));
                manage({
                    body: row.body,
                    deleting: action.dataset.commentAction === 'delete',
                    save: async body => {
                        if (action.dataset.commentAction === 'delete') {
                            await api.deleteComment(postId, row.id);
                            rows.set(row.id, { ...row, isDeleted: true, body: '' });
                        } else {
                            await api.editComment(postId, row.id, body);
                            rows.set(row.id, { ...row, body });
                        }
                        if (alive) draw();
                    }
                });
            }
        }

        container.addEventListener('submit', submit);
        container.addEventListener('click', click);
        load({ reset: true });

        return {
            react,
            destroy() {
                alive = false;
                generation++;
                rows.clear();
                replyPages.clear();
                container.removeEventListener('submit', submit);
                container.removeEventListener('click', click);
            }
        };
    }

    root.CommunityComments = { create };
})(window);
