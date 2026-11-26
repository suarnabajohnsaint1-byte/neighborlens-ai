(function (root) {
    'use strict';
    async function load(query, signal) {
        const data = await root.apiRequest(`/api/reports?${new URLSearchParams(query)}`, { signal, cache: 'no-store' });
        const page = data.pagination;
        if (!Array.isArray(data.reports) || !page || !['page', 'pages', 'pageSize', 'total'].every(key => Number.isSafeInteger(page[key]) && page[key] >= (key === 'total' ? 0 : 1)) || !data.stats) throw new Error('Invalid report response. Retry to refresh.');
        return data;
    }
    root.BarangayReportsApi = { load };
})(window);
