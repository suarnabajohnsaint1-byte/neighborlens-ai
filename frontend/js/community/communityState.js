(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CommunityState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function optimistic(base, desired) {
        const result = { ...base };
        if (result.mine) { result[result.mine]--; result.total--; }
        if (desired) { result[desired]++; result.total++; }
        result.mine = desired;
        return result;
    }
    function create(api, changed) {
        const initialPagination = { page: 1, pages: 1, total: 0 };
        let state = { posts: [], query: { page: 1, pageSize: 10, search: '', sort: 'latest', scope: 'local' }, pagination: initialPagination, status: 'idle', error: '', reactionError: '', barangay: '' };
        let generation = 0, controller = null, destroyed = false;
        const reactions = new Map();
        const commentCounts = new Map();
        const snapshot = () => ({ ...state, posts: state.posts.map(post => {
            const entry = reactions.get(post.id);
            const comments = commentCounts.get(post.id);
            return { ...post, ...(entry ? { reactions: optimistic(entry.base, entry.desired) } : {}), ...(comments ? { commentCount: comments.count } : {}) };
        }) });
        const notify = () => { if (!destroyed) changed(snapshot()); };
        async function load(query = {}, append = false) {
            controller?.abort(); controller = new AbortController();
            const revision = ++generation;
            const requestQuery = { ...state.query, ...query };
            if (requestQuery.scope !== state.query.scope) {
                state = { ...state, posts: [], barangay: '', pagination: initialPagination };
            }
            state = { ...state, query: append ? state.query : requestQuery, appending: append, status: 'loading', error: '', errorCode: '', reactionError: '' }; notify();
            try {
                const data = await api.list(requestQuery, controller.signal);
                if (destroyed || revision !== generation) return;
                for (const post of data.posts) {
                    const entry = reactions.get(post.id);
                    if (entry && !entry.running && post.engagementVersion >= entry.version) reactions.delete(post.id);
                    const comments = commentCounts.get(post.id);
                    if (comments && post.engagementVersion >= comments.version) commentCounts.delete(post.id);
                }
                const posts = append ? [...new Map([...state.posts, ...data.posts].map(post => [post.id, post])).values()] : data.posts;
                state = { ...state, ...data, posts, query: requestQuery, appending: false, status: 'ready', error: '' };
            } catch (error) {
                if (destroyed || revision !== generation || error.name === 'AbortError') return;
                const denied = [401, 403].includes(error.status);
                state = { ...state, appending: append && !denied, status: 'error', error: error.message, errorCode: error.code || '', ...(denied ? { posts: [], barangay: '' } : {}) };
            }
            notify();
        }
        function loadMore() {
            if (destroyed || state.status === 'loading' || !state.posts.length || state.pagination.page >= state.pagination.pages) return;
            return load({ page: state.pagination.page + 1 }, true);
        }
        function react(id, type) {
            const post = state.posts.find(post => post.id === id);
            if (!post) return Promise.resolve();
            state.reactionError = '';
            let entry = reactions.get(id);
            if (!entry) { entry = { base: { ...post.reactions }, desired: post.reactions.mine, version: post.engagementVersion, running: false }; reactions.set(id, entry); }
            entry.desired = entry.desired === type ? null : type;
            entry.dirty = true;
            notify();
            if (entry.running) return entry.promise;
            entry.running = true;
            entry.promise = (async () => {
                while (!destroyed && entry.dirty) {
                    const desired = entry.desired;
                    entry.dirty = false;
                    try {
                        const result = await api.react(id, desired);
                        if (destroyed) return;
                        entry.base = result.reactions; entry.version = result.engagementVersion;
                    } catch (error) {
                        if (!entry.dirty) entry.desired = entry.base.mine;
                        state.reactionError = error.message;
                        notify();
                    }
                    notify();
                }
            })().finally(() => { entry.running = false; notify(); });
            return entry.promise;
        }
        function commentCount(id, count, version) {
            const previous = commentCounts.get(id);
            if (!previous || version >= previous.version) commentCounts.set(id, { count, version });
            notify();
        }
        return { load, loadMore, react, snapshot, commentCount, destroy() { destroyed = true; generation++; controller?.abort(); reactions.clear(); commentCounts.clear(); state.posts = []; } };
    }
    return { create, optimistic };
});
