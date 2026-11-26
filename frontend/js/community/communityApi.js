(function (root) {
    const path = id => `/api/community/posts/${id}`;
    const query = values => {
        const clean = {};
        for (const [k, v] of Object.entries(values || {})) {
            if (v !== undefined && v !== null && v !== '') {
                if (k === 'barangay' || k === 'barangayId') continue;
                clean[k] = v;
            }
        }
        return new URLSearchParams(clean).toString();
    };
    root.CommunityApi = {
        list: (values, signal) => root.apiRequest(`/api/community/posts?${query(values)}`, { signal }),
        publish: body => root.apiRequest('/api/community/posts', { method: 'POST', body }),
        edit: (id, body) => root.apiRequest(path(id), { method: 'PATCH', body: { body } }),
        remove: id => root.apiRequest(path(id), { method: 'DELETE' }),
        react: (id, reaction) => root.apiRequest(`${path(id)}/reaction`, { method: 'PUT', body: { reaction } }),
        comments: (id, page, parentCommentId = null) => root.apiRequest(`${path(id)}/comments?${query({ page, pageSize: 5, ...(parentCommentId ? { parentCommentId } : {}) })}`),
        comment: (id, body) => root.apiRequest(`${path(id)}/comments`, { method: 'POST', body }),
        editComment: (id, comment, body) => root.apiRequest(`${path(id)}/comments/${comment}`, { method: 'PATCH', body: { body } }),
        deleteComment: (id, comment) => root.apiRequest(`${path(id)}/comments/${comment}`, { method: 'DELETE' }),
        reactComment: (id, comment, reaction) => root.apiRequest(`${path(id)}/comments/${comment}/reaction`, { method: 'PUT', body: reaction === 'heart' ? { reaction } : { reacted: Boolean(reaction) } }),
        ownedReports: () => root.apiRequest('/api/reports'),
        eligibleReports: () => root.apiRequest('/api/community/eligible-reports'),
        report: id => root.apiRequest(`${path(id)}/report`),
        official: signal => root.apiRequest('/api/community/posts?official=true&pageSize=3', { signal })
    };
})(window);
