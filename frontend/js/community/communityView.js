(function (root) {
    const REACTION_HOLD_MS = 500;
    const REACTION_MOVE_LIMIT = 10;

    function create(container, handlers) {
        const { escape, icon, date } = root.CommunityCards;
        const cards = new Map();

        container.innerHTML = `<div class="cf-container">
            <header class="cf-header">
                <div class="cf-hero-banner">
                    <div class="cf-hero-text">
                        <h1 class="cf-header-title">Community</h1>
                        <div class="cf-membership">
                            ${icon('bx-map-pin')}
                            <span data-community-barangay aria-live="polite">My barangay</span>
                        </div>
                        <p class="cf-hero-desc">Report issues, view community reports<span data-community-barangay-inline></span> a cleaner, safer, and more livable place.</p>
                    </div>
                    <div class="cf-hero-search">
                        <div class="cf-search-wrap">
                            ${icon('bx-search')}
                            <input type="search" maxlength="120" aria-label="Search community reports" placeholder="Search community reports...">
                        </div>
                    </div>
                    <img src="assets/illustrations/community-feed-header.png" alt="" class="cf-hero-illustration" aria-hidden="true">
                    <img src="assets/illustrations/community-feed-header.png" alt="" class="cf-mobile-illustration" aria-hidden="true">
                </div>
            </header>
            <div class="cf-mobile-search-area">
                <div class="cf-search-wrap">
                    ${icon('bx-search')}
                    <input type="search" maxlength="120" aria-label="Search community reports" placeholder="Search community reports...">
                </div>
            </div>
            <div class="cf-tabs-bar">
                <div class="cf-order-tabs" role="tablist" aria-label="Feed order">
                    <button type="button" role="tab" class="cf-tab active" data-sort="latest" aria-selected="true">${icon('bx-file-blank')}<span>Latest</span></button>
                    ${handlers.filterStatus ? `<button type="button" role="tab" class="cf-tab" data-sort="oldest" aria-selected="false">${icon('bx-calendar')}<span>Oldest</span></button>` : ''}
                    <button type="button" role="tab" class="cf-tab" data-sort="reacted" aria-selected="false">${icon('bxs-flame')}<span>Most reacted</span></button>
                </div>
                <button type="button" class="cf-area-filter" aria-label="Filter community by area" aria-haspopup="menu" aria-expanded="false" aria-controls="communityAreaMenu">
                    ${icon('bx-filter')}<span aria-hidden="true">Filter</span>
                </button>
                <div class="cf-area-menu" id="communityAreaMenu" role="menu" aria-label="Community area" hidden>
                    <button type="button" role="menuitemradio" data-scope="local" aria-checked="true" tabindex="-1">My barangay${icon('bx-check')}</button>
                    <button type="button" role="menuitemradio" data-scope="citywide" aria-checked="false" tabindex="-1">Bacolod City${icon('bx-check')}</button>
                </div>
            </div>
            ${handlers.filterStatus ? `<label class="cf-status-filter">Report status
                <select data-community-status aria-label="Report status"><option value="all">All statuses</option>${Object.entries(root.ReportVocabulary.statuses).map(([key, label]) => `<option value="${key}">${escape(label)}</option>`).join('')}</select>
            </label>` : ''}
            <div class="cf-feed-notice">
                <div class="cf-feed-state" role="status" aria-live="polite"></div>
                <button type="button" class="cf-retry" hidden>${icon('bx-refresh')}<span>Retry</span></button>
            </div>
            <button type="button" class="cf-updates" hidden>New posts available</button>
            <div class="cf-content-area">
                <div class="cf-posts" role="feed" aria-label="Community reports feed"></div>
            </div>
            <nav class="cf-pages portal-pagination" aria-label="Community pages" hidden>
                <label class="portal-page-size">Per page<select data-community-page-size aria-label="Posts per page"><option>3</option><option>5</option><option selected>10</option><option>20</option></select></label>
                <div class="portal-page-buttons"><button type="button" class="portal-icon-button" data-page="-1" aria-label="Previous posts">${icon('bx-chevron-left')}</button>
                <span class="portal-page-number" aria-live="polite"></span>
                <button type="button" class="portal-icon-button" data-page="1" aria-label="Next posts">${icon('bx-chevron-right')}</button></div>
            </nav>
            ${handlers.scrollFeed ? '<div class="cf-scroll-end" hidden><p role="status"></p><button type="button" class="cf-retry" data-feed-more>Load more posts</button></div>' : ''}
        </div>`;

        const scrollEnd = container.querySelector('.cf-scroll-end');
        const scopeTrigger = container.querySelector('.cf-area-filter');
        const scopeMenu = container.querySelector('.cf-area-menu');
        const scopeOptions = scopeMenu.querySelectorAll('[data-scope]');
        const observer = scrollEnd && root.IntersectionObserver ? new root.IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) handlers.loadMore();
        }, { rootMargin: '0px 0px 240px' }) : null;
        let selectedMenu = null, menuTrigger = null;
        let reactionPress = null, suppressReactionClick = null;

        function closeMenu(focus = false) {
            if (!selectedMenu) return;
            selectedMenu.hidden = true;
            menuTrigger?.setAttribute('aria-expanded', 'false');
            if (focus && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
            selectedMenu = null;
            menuTrigger = null;
        }

        function positionMenu(menu, trigger, above = false) {
            const anchor = trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
            const left = above ? anchor.left : anchor.right - bounds.width;
            const gap = above ? 8 : 4;
            const top = anchor.top - bounds.height - gap;
            const bottom = anchor.bottom + gap;
            const placeAbove = (above && top >= 8) || bottom + bounds.height > root.innerHeight - 8;
            menu.style.left = `${Math.max(8, Math.min(left, root.innerWidth - bounds.width - 8))}px`;
            menu.style.top = `${Math.max(8, placeAbove ? top : bottom)}px`;
        }

        function openMenu(menu, trigger, { above = false, last = false } = {}) {
            if (!menu || !trigger) return;
            const already = selectedMenu === menu;
            closeMenu();
            if (already) return;
            selectedMenu = menu;
            menuTrigger = trigger;
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            positionMenu(menu, trigger, above);
            const options = menu.querySelectorAll('button:not(:disabled)');
            options[last ? options.length - 1 : 0]?.focus({ preventScroll: true });
        }

        function openReactions(trigger, last = false) {
            openMenu(trigger.nextElementSibling, trigger, { above: true, last });
        }

        function clearReactionPress() {
            root.clearTimeout(reactionPress?.timer);
            reactionPress = null;
        }

        function startReactionPress(event) {
            if (!event.isPrimary || event.button !== 0) return;
            clearReactionPress();
            suppressReactionClick = null;
            const trigger = event.target.closest('[data-reaction-target]');
            if (!trigger || trigger.disabled) return;
            const press = { trigger, id: event.pointerId, x: event.clientX, y: event.clientY };
            press.timer = root.setTimeout(() => {
                if (reactionPress !== press || !trigger.isConnected) return;
                suppressReactionClick = trigger;
                if (menuTrigger !== trigger) openReactions(trigger);
            }, REACTION_HOLD_MS);
            reactionPress = press;
        }

        function moveReactionPress(event) {
            if (!reactionPress || reactionPress.id !== event.pointerId || suppressReactionClick === reactionPress.trigger) return;
            if (Math.hypot(event.clientX - reactionPress.x, event.clientY - reactionPress.y) < REACTION_MOVE_LIMIT) return;
            suppressReactionClick = reactionPress.trigger;
            clearReactionPress();
        }

        function endReactionPress(event) {
            if (reactionPress?.id === event.pointerId) clearReactionPress();
        }

        function reactionContextMenu(event) {
            if (event.target.closest('[data-reaction-target]')) event.preventDefault();
        }

        function isMembershipError(errorText) {
            if (!errorText) return false;
            const text = String(errorText).toLowerCase();
            return text.includes('membership') || text.includes('barangay membership') || text.includes('active barangay');
        }

        function draw(state) {
            const citywide = state.query.scope === 'citywide';
            const missingBarangay = !citywide && state.barangay === null;
            const locationName = citywide ? 'Bacolod City' : missingBarangay ? 'Barangay unavailable' : state.barangay || 'My barangay';
            scopeOptions.forEach(option => option.setAttribute('aria-checked', String(option.dataset.scope === state.query.scope)));
            container.querySelectorAll('[data-community-barangay]').forEach(el => {
                if (el.textContent !== locationName) el.textContent = locationName;
            });
            const inlineSpan = container.querySelector('[data-community-barangay-inline]');
            if (inlineSpan) inlineSpan.textContent = locationName;

            const stateNotice = container.querySelector('.cf-feed-state');
            const retryButton = container.querySelector('.cf-retry');
            const pagesNav = container.querySelector('.cf-pages');
            const postsList = container.querySelector('.cf-posts');

            const membershipError = isMembershipError(state.error);
            container.querySelector('.cf-feed-notice').classList.toggle('has-error', Boolean(state.error) && !membershipError && !state.appending);
            if (membershipError) {
                closeMenu();
                stateNotice.innerHTML = `<div class="cf-membership-alert" role="alert">
                    ${icon('bx-info-circle')}
                    <div>
                        <h3>An active barangay membership is required</h3>
                        <p>Your citizen account must be verified with a recognized barangay in Bacolod City to view community infrastructure reports. Please contact your barangay office or update your profile.</p>
                    </div>
                </div>`;
                retryButton.hidden = true;
                pagesNav.hidden = true;
                if (scrollEnd) scrollEnd.hidden = true;
                observer?.disconnect();
                postsList.setAttribute('aria-busy', 'false');
                cards.forEach(card => { card.comments?.destroy(); card.mounted.destroy(); card.node.remove(); });
                cards.clear();
                return;
            }

            if (state.appending) {
                stateNotice.textContent = '';
                retryButton.hidden = true;
                postsList.classList.remove('nl-feed-refreshing');
            } else if (state.status === 'loading') {
                stateNotice.innerHTML = state.posts.length
                    ? `<div class="nl-refresh-banner" role="status" aria-live="polite"><div class="nl-refresh-pulse-bar"></div><span class="nl-refresh-text"><i class="bx bx-loader-alt bx-spin" aria-hidden="true"></i> Updating community reports...</span></div>`
                    : `<div class="cf-skeleton-feed" aria-hidden="true">
                        <div class="cf-skeleton-card">
                            <div class="cf-skeleton-header">
                                <div class="cf-skeleton-avatar nl-skeleton-loading"></div>
                                <div class="cf-skeleton-user-meta">
                                    <div class="cf-skeleton-line short nl-skeleton-loading"></div>
                                    <div class="cf-skeleton-line tiny nl-skeleton-loading"></div>
                                </div>
                            </div>
                            <div class="cf-skeleton-line full nl-skeleton-loading"></div>
                            <div class="cf-skeleton-line mid nl-skeleton-loading"></div>
                            <div class="cf-skeleton-media nl-image-loading"></div>
                        </div>
                    </div>`;
                retryButton.hidden = true;
                pagesNav.hidden = true;
                postsList.classList.add('nl-feed-refreshing');
            } else {
                postsList.classList.remove('nl-feed-refreshing');
                if (state.error) {
                    stateNotice.innerHTML = `<div class="cf-request-error">${icon('bx-info-circle')}<div><h2>Community reports unavailable</h2><p>${escape(state.error)}${state.posts.length ? ' Showing previous reports.' : ''}</p></div></div>`;
                    retryButton.hidden = state.errorCode === 'COMMUNITY_SETUP_REQUIRED';
                    pagesNav.hidden = !state.posts.length;
                } else if (!state.posts.length) {
                    stateNotice.innerHTML = `<div class="cf-empty-box">
                        ${icon('bx-news')}
                        <h3>No community reports yet</h3>
                        <p>${missingBarangay
                            ? 'Select Bacolod City in the area filter to see citywide reports.'
                            : `Community infrastructure reports for ${escape(locationName)} will appear here.`}</p>
                    </div>`;
                    retryButton.hidden = true;
                    pagesNav.hidden = true;
                } else {
                    stateNotice.textContent = state.reactionError || '';
                    retryButton.hidden = !state.reactionError;
                    pagesNav.hidden = true;
                }
            }

            postsList.setAttribute('aria-busy', String(state.status === 'loading'));
            const ids = new Set(state.posts.map(post => post.id));
            for (const [id, card] of cards) {
                if (!ids.has(id)) {
                    if (card.node.contains(menuTrigger)) closeMenu();
                    card.comments?.destroy();
                    card.mounted.destroy();
                    card.node.remove();
                    cards.delete(id);
                }
            }

            for (const [index, post] of state.posts.entries()) {
                const signature = JSON.stringify([post.body, post.media, post.linkedReport, post.canEdit, post.canDelete]);
                let card = cards.get(post.id);
                if (!card || card.signature !== signature) {
                    if (card?.node.contains(menuTrigger)) closeMenu();
                    card?.comments?.destroy();
                    card?.mounted?.destroy();
                    card?.node.remove();
                    const template = container.ownerDocument.createElement('template');
                    template.innerHTML = root.CommunityCards.render(post);
                    const node = template.content.firstElementChild;
                    card = { node, signature, mounted: null, post };
                    cards.set(post.id, card);
                }
                card.post = post;
                if (postsList.children[index] !== card.node) {
                    postsList.insertBefore(card.node, postsList.children[index] || null);
                }
                if (!card.mounted) card.mounted = root.CommunityCards.mount(card.node);
                root.CommunityCards.update(card.node, post);
            }

            root.ReportEvidence.hydrate(postsList);

            container.querySelectorAll('[data-sort]').forEach(button => {
                const isSelected = button.dataset.sort === state.query.sort;
                button.classList.toggle('active', isSelected);
                button.setAttribute('aria-selected', String(isSelected));
            });

            const pageSpan = container.querySelector('.cf-pages .portal-page-number');
            pagesNav.hidden = Boolean(handlers.scrollFeed?.matches) || !state.posts.length && !state.pagination.total;
            if (pageSpan) pageSpan.textContent = `Page ${state.pagination.page} of ${state.pagination.pages}`;
            const prevPageBtn = container.querySelector('[data-page="-1"]');
            if (prevPageBtn) prevPageBtn.disabled = state.pagination.page <= 1 || state.status === 'loading';
            const nextPageBtn = container.querySelector('[data-page="1"]');
            if (nextPageBtn) nextPageBtn.disabled = state.pagination.page >= state.pagination.pages || state.status === 'loading';

            if (scrollEnd) {
                observer?.disconnect();
                const more = state.pagination.page < state.pagination.pages;
                const loading = state.appending && state.status === 'loading';
                const failed = state.appending && state.status === 'error';
                scrollEnd.hidden = !handlers.scrollFeed.matches || !state.posts.length || !(state.appending || state.status === 'ready');
                const status = scrollEnd.querySelector('[role="status"]');
                const message = loading ? 'Loading more posts…' : failed ? state.error : more ? '' : 'You’re all caught up.';
                if (status.textContent !== message) status.textContent = message;
                const moreButton = scrollEnd.querySelector('[data-feed-more]');
                moreButton.hidden = !more;
                moreButton.disabled = loading;
                moreButton.textContent = failed ? 'Retry loading posts' : 'Load more posts';
                if (!scrollEnd.hidden && more && state.status === 'ready') observer?.observe(scrollEnd);
            }
        }

        function click(event) {
            if (scopeTrigger.contains(event.target)) {
                openMenu(scopeMenu, scopeTrigger);
                return;
            }
            const scopeOption = event.target.closest('[data-scope]');
            if (scopeOption && scopeMenu.contains(scopeOption)) {
                closeMenu(true);
                if (scopeOption.getAttribute('aria-checked') !== 'true') handlers.changeScope(scopeOption.dataset.scope);
                return;
            }
            if (event.target.closest('[data-feed-more]')) {
                handlers.loadMore();
                return;
            }
            const sortTab = event.target.closest('[data-sort]');
            if (sortTab) {
                container.querySelectorAll('.cf-tab').forEach(t => t.classList.remove('active'));
                sortTab.classList.add('active');
                container.querySelector('.cf-posts').hidden = false;
                handlers.sort(sortTab.dataset.sort);
                return;
            }

            const pageOffset = event.target.closest('[data-page]');
            if (pageOffset) {
                handlers.changePage(Number(pageOffset.dataset.page));
                return;
            }

            const retryBtn = event.target.closest('.cf-retry, .cf-updates');
            if (retryBtn) {
                handlers.refresh();
                return;
            }

            const node = event.target.closest('[data-post-id]');
            const card = node && cards.get(Number(node.dataset.postId));
            if (!card) return;
            const post = card.post;

            const reaction = event.target.closest('[data-reaction]');
            const trigger = reaction ? reaction.closest('.cf-reaction-picker').previousElementSibling :
                event.target.closest('[data-reaction-target]');
            if (trigger) {
                if (trigger.disabled) return;
                if (!reaction && event.detail > 0 && suppressReactionClick === trigger) {
                    suppressReactionClick = null;
                    return;
                }
                closeMenu(true);
                if (trigger.dataset.reactionTarget === 'comment') {
                    card.comments?.react(trigger, reaction?.dataset.reaction);
                } else if (!reaction || reaction.dataset.reaction !== post.reactions.mine) {
                    handlers.react(post.id, reaction?.dataset.reaction || post.reactions.mine || 'like');
                }
                return;
            }

            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'post-options') openMenu(node.querySelector('.cf-post-options'), event.target.closest('button'));
            if (action === 'expand') {
                const paragraph = node.querySelector('.cf-post-text');
                const button = event.target.closest('button');
                const expanded = paragraph.classList.toggle('is-collapsed') === false;
                button.textContent = expanded ? 'See less' : 'See more';
                button.setAttribute('aria-expanded', String(expanded));
            }
            if (action === 'report') handlers.report(post, event.target.closest('button'));
            if (action === 'edit' || action === 'delete') {
                if (action === 'edit' ? !post.canEdit : !post.canDelete) return;
                closeMenu(true);
                handlers.manage(post, action === 'delete');
            }
            if (action === 'comments') {
                const panel = node.querySelector('.cf-comments');
                const button = node.querySelector('.cf-comments-toggle');
                panel.hidden = !panel.hidden;
                button.setAttribute('aria-expanded', String(!panel.hidden));
                if (!card.comments && !panel.hidden) {
                    card.comments = root.CommunityComments.create(panel, post.id, {
                        api: handlers.api,
                        manage: handlers.edit,
                        beforeDraw: () => { if (panel.contains(menuTrigger)) closeMenu(); },
                        updated: (count, version) => handlers.commentCount(post.id, count, version)
                    });
                }
            }
        }

        function outside(event) {
            if (selectedMenu && !selectedMenu.contains(event.target) && !menuTrigger.contains(event.target)) closeMenu();
        }

        function keydown(event) {
            if (event.target === scopeTrigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                openMenu(scopeMenu, scopeTrigger, { last: event.key === 'ArrowUp' });
                return;
            }
            const trigger = event.target.closest?.('[data-reaction-target]');
            if (trigger && container.contains(trigger) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                openReactions(trigger, event.key === 'ArrowUp');
                return;
            }
            if (!selectedMenu) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu(true);
            } else if (event.key === 'Tab') {
                closeMenu(true);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                (selectedMenu.classList.contains('cf-reaction-picker') && ['ArrowLeft', 'ArrowRight'].includes(event.key))) {
                event.preventDefault();
                const options = [...selectedMenu.querySelectorAll('button:not(:disabled)')];
                const index = options.indexOf(container.ownerDocument.activeElement);
                const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
                options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + step + options.length) % options.length]?.focus({ preventScroll: true });
            }
        }

        function change(event) {
            if (event.target.hasAttribute('data-community-page-size')) handlers.setPageSize(Number(event.target.value));
            if (event.target.hasAttribute('data-community-status')) handlers.filterStatus(event.target.value);
        }
        container.addEventListener('click', click);
        container.addEventListener('change', change);
        container.addEventListener('pointerdown', startReactionPress);
        container.addEventListener('contextmenu', reactionContextMenu);
        container.ownerDocument.addEventListener('pointerdown', outside);
        container.ownerDocument.addEventListener('keydown', keydown);
        root.addEventListener('pointermove', moveReactionPress, { passive: true });
        root.addEventListener('pointerup', endReactionPress);
        root.addEventListener('pointercancel', endReactionPress);
        const reposition = () => {
            if (selectedMenu === scopeMenu) {
                const anchor = scopeTrigger.getBoundingClientRect();
                if (anchor.bottom > 0 && anchor.top < root.innerHeight) {
                    positionMenu(scopeMenu, scopeTrigger);
                    return;
                }
            }
            closeMenu();
        };
        const dismiss = () => {
            clearReactionPress();
            closeMenu();
        };
        root.addEventListener('resize', dismiss);
        root.addEventListener('scroll', reposition, true);
        root.addEventListener('citizen:section-changed', dismiss);
        root.addEventListener('barangay:section-changed', dismiss);

        return {
            draw,
            official(posts) { },
            destroy() {
                observer?.disconnect();
                clearReactionPress();
                closeMenu();
                cards.forEach(card => { card.comments?.destroy(); card.mounted.destroy(); });
                cards.clear();
                container.removeEventListener('click', click);
                container.removeEventListener('change', change);
                container.removeEventListener('pointerdown', startReactionPress);
                container.removeEventListener('contextmenu', reactionContextMenu);
                container.ownerDocument.removeEventListener('pointerdown', outside);
                container.ownerDocument.removeEventListener('keydown', keydown);
                root.removeEventListener('pointermove', moveReactionPress);
                root.removeEventListener('pointerup', endReactionPress);
                root.removeEventListener('pointercancel', endReactionPress);
                root.removeEventListener('resize', dismiss);
                root.removeEventListener('scroll', reposition, true);
                root.removeEventListener('citizen:section-changed', dismiss);
                root.removeEventListener('barangay:section-changed', dismiss);
                container.replaceChildren();
            }
        };
    }

    root.CommunityView = { create };
})(window);
