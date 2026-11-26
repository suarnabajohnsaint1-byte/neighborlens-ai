(function (root) {
    const escape = value => root.ReportPresentation.escape(String(value ?? ''));
    const icon = name => `<i class="bx ${name}" aria-hidden="true"></i>`;

    function relativeTime(dateString) {
        if (!dateString) return 'Just now';
        const past = new Date(dateString).getTime();
        if (Number.isNaN(past)) return 'Just now';
        const now = Date.now();
        const diffSec = Math.floor((now - past) / 1000);
        if (diffSec < 10) return 'Just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;
        const diffWeeks = Math.floor(diffDays / 7);
        if (diffDays < 28) return `${diffWeeks}w ago`;
        const d = new Date(past);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const currentYear = new Date(now).getFullYear();
        if (d.getFullYear() === currentYear) {
            return `${months[d.getMonth()]} ${d.getDate()}`;
        }
        return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    }

    function avatarSrc(author, postId) {
        if (author?.avatarVariant !== undefined && author?.avatarVariant !== null) {
            const index = (Math.abs(Number(author.avatarVariant)) % 4) + 1;
            return `assets/avatar/avatar${index}.png`;
        }
        const numeric = Math.abs(Number(postId) || 1);
        const index = ((numeric - 1) % 4) + 1;
        return `assets/avatar/avatar${index}.png`;
    }

    function media(items) {
        const photos = (items || []).filter(item => /^\/api\/community\/posts\/[1-9]\d*\/media\/[1-9]\d*$/.test(item.url));
        if (!photos.length) return '';
        if (photos.length === 1) {
            return `<div class="cf-single-photo"><img data-evidence-url="${escape(photos[0].url)}" alt="Shared community photo" loading="lazy" referrerpolicy="no-referrer"></div>`;
        }
        return `<div class="cf-carousel" data-carousel>
            <div class="cf-carousel-track" tabindex="0" role="region" aria-label="Attached images">
                ${photos.map((p, idx) => `<div class="cf-carousel-slide"><img data-evidence-url="${escape(p.url)}" alt="Shared photo ${idx + 1}" loading="lazy" referrerpolicy="no-referrer"></div>`).join('')}
            </div>
            <div class="cf-carousel-dots" role="tablist" aria-label="Image pagination">
                ${photos.map((_, idx) => `<button type="button" class="cf-carousel-dot" aria-pressed="${idx === 0}" aria-label="Go to photo ${idx + 1}"></button>`).join('')}
            </div>
        </div>`;
    }

    function postActions(post) {
        const actions = [['edit', 'Edit post', post.canEdit], ['delete', 'Delete post', post.canDelete]].filter(([, , allowed]) => allowed === true);
        if (!actions.length) return '';
        const id = `post-actions-${Number(post.id)}`;
        return `<button type="button" class="cf-icon-button" data-action="post-options" aria-label="Manage your post" aria-haspopup="menu" aria-controls="${id}" aria-expanded="false">${icon('bx-dots-horizontal-rounded')}</button><div id="${id}" class="cf-post-options" role="menu" aria-label="Post actions" hidden>${actions.map(([action, label]) => `<button type="button" role="menuitem" data-action="${action}">${label}</button>`).join('')}</div>`;
    }

    function reactionControl(kind, reactions = {}, { supportsHeart = true, pending = false } = {}) {
        const value = reactions.type || (reactions.mine === true ? 'like' : reactions.mine);
        const active = value === 'heart' ? 'heart' : 'like';
        const buttonClass = kind === 'comment' ? 'cf-comment-action' : 'cf-react';
        const label = `${active === 'heart' ? 'Heart' : 'Like'} ${kind === 'comment' ? 'comment' : 'reaction'}`;
        return `<div class="cf-react-wrap">
            <button type="button" class="${buttonClass}" data-action="react" data-reaction-target="${kind}" data-selected="${Boolean(value)}" aria-label="${label}" aria-pressed="${Boolean(value)}" aria-haspopup="menu" aria-expanded="false" aria-description="Press and hold or press Down Arrow to choose a reaction." title="Press and hold to choose a reaction"${pending ? ' disabled' : ''}>
                <i class="bx bx-${active} cf-action-icon" aria-hidden="true"></i>
                <span class="cf-reaction-total">${Number(reactions.total || 0) || (kind === 'comment' ? '' : '0')}</span>
            </button>
            <div class="cf-reaction-picker" role="menu" aria-label="Choose a reaction" aria-orientation="horizontal" hidden>
                ${(supportsHeart ? ['like', 'heart'] : ['like']).map(type => `<button type="button" role="menuitemradio" aria-label="${type === 'like' ? 'Like' : 'Heart'}" aria-checked="${value === type}" data-reaction="${type}">${icon(`bx-${type}`)}</button>`).join('')}
            </div>
        </div>`;
    }

    function updateReaction(button, value, total) {
        const heart = value === 'heart';
        button.setAttribute('data-selected', String(Boolean(value)));
        button.setAttribute('aria-pressed', String(Boolean(value)));
        button.setAttribute('aria-label', `${heart ? 'Heart' : 'Like'} ${button.dataset.reactionTarget === 'comment' ? 'comment' : 'reaction'}`);
        button.querySelector('.cf-action-icon').classList.toggle('bx-heart', heart);
        button.querySelector('.cf-action-icon').classList.toggle('bx-like', !heart);
        button.querySelector('.cf-reaction-total').textContent = total || (button.dataset.reactionTarget === 'comment' ? '' : '0');
        button.nextElementSibling.querySelectorAll('[data-reaction]').forEach(option => {
            option.setAttribute('aria-checked', String(option.dataset.reaction === value));
        });
    }

    function render(post) {
        const report = post.linkedReport;
        const author = post.author || {};
        const isOfficial = Boolean(author.official);
        const username = author.pseudonym || (isOfficial ? author.label : 'Anonymous resident');
        const statusKey = report?.status || 'pending';
        const statusLabel = root.ReportVocabulary?.statuses?.[statusKey] || (statusKey.charAt(0).toUpperCase() + statusKey.slice(1));
        const categoryName = report?.category || 'Community Report';
        let cardTitle = post.title;
        if (!cardTitle) {
            const cat = String(categoryName).toLowerCase();
            if (cat.includes('pothole') || cat.includes('road')) cardTitle = 'Pothole on residential road';
            else if (cat.includes('street') || cat.includes('light') || cat.includes('lamp')) cardTitle = 'Streetlight not working';
            else if (cat.includes('flood') || cat.includes('drain')) cardTitle = 'Flooding on residential road';
            else if (cat.includes('tree')) cardTitle = 'Fallen tree blocking path';
            else if (cat.includes('garbage') || cat.includes('waste')) cardTitle = 'Garbage overflow in area';
            else cardTitle = `${categoryName} on residential road`;
        }

        return `<article class="cf-post" data-post-id="${post.id}" aria-label="Community update">
            <div class="cf-author">
                <span class="cf-avatar">${isOfficial ? icon('bxs-institution') : `<img src="${avatarSrc(author, post.id)}" alt="${escape(username)}" class="cf-avatar-img" width="44" height="44">`}</span>
                <div class="cf-author-info">
                    <strong>${escape(username)}</strong>
                    ${isOfficial ? '<span class="cf-official">Official</span>' : ''}
                    <p>${escape(post.barangay)} <span aria-hidden="true">&middot;</span> <time datetime="${escape(post.createdAt)}" title="${escape(new Date(post.createdAt).toLocaleString())}">${escape(relativeTime(post.createdAt))}</time></p>
                </div>
                ${report ? `<span class="cf-status cf-status-pill cf-status-${escape(statusKey)}" data-status="${escape(statusKey)}">${escape(statusLabel)}</span>` : ''}
                ${postActions(post)}
            </div>
            <h3 class="cf-post-title">${escape(cardTitle)}</h3>
            ${post.body ? `<p class="cf-post-text ${post.body.length > 280 ? 'is-collapsed' : ''}">${escape(post.body)}</p>${post.body.length > 280 ? '<button type="button" class="cf-text-button" data-action="expand" aria-expanded="false">See more</button>' : ''}` : ''}
            ${media(post.media)}
            ${report ? `<div class="cf-card-meta">
                <span class="cf-meta-tag">${icon('bx-map-pin')} <span>${escape(categoryName)} &middot; ${escape(report.barangay)}</span></span>
            </div>` : ''}
            <div class="cf-toolbar">
                ${reactionControl('post', post.reactions)}
                <button type="button" data-action="comments" class="cf-comments-toggle" aria-expanded="false">
                    <i class="bx bx-comment-detail cf-action-icon" aria-hidden="true"></i>
                    <span>${post.commentCount || 0}</span>
                </button>
            </div>
            <div class="cf-comments" hidden></div>
        </article>`;
    }

    function update(node, post) {
        updateReaction(node.querySelector('.cf-react'), post.reactions.mine, post.reactions.total);
        const commentSpan = node.querySelector('.cf-comments-toggle span');
        if (commentSpan) commentSpan.textContent = String(post.commentCount || 0);
    }

    function mount(node) {
        root.ReportEvidence.hydrate(node);
        let carousel = null;
        const carouselElement = node.querySelector('[data-carousel]');
        if (carouselElement && root.MediaCarousel) {
            const track = carouselElement.querySelector('.cf-carousel-track');
            const slides = [...carouselElement.querySelectorAll('.cf-carousel-slide')];
            const dots = [...carouselElement.querySelectorAll('.cf-carousel-dot')];
            carousel = root.MediaCarousel.mount({ track, slides, dots });
        }
        return {
            destroy() {
                carousel?.destroy();
                node.querySelectorAll('img[data-evidence-url]').forEach(image => root.ReportEvidence.release(image));
            }
        };
    }

    function updateTimestamps(container = document) {
        container.querySelectorAll('time[datetime]').forEach(el => {
            const dt = el.getAttribute('datetime');
            if (dt) el.textContent = relativeTime(dt);
        });
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') updateTimestamps();
        });
        setInterval(() => {
            if (document.visibilityState === 'visible') updateTimestamps();
        }, 15000);
    }

    root.CommunityCards = { render, postActions, reactionControl, updateReaction, update, mount, escape, icon, date: relativeTime, relativeTime, updateTimestamps, avatarSrc };
})(window);
