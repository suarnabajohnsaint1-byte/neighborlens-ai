(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PortalAnalyticsApi = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

    function normalize(value) {
        const range = value?.range;
        if (!range || ![7, 30, 90].includes(range.days) || range.timeZone !== 'Asia/Manila' || !date(range.startDate) || !date(range.endDate)
            || !Array.isArray(value.daily) || value.daily.length !== range.days || !Array.isArray(value.categories) || !value.categories.length
            || !integer(value.totals?.submitted) || !integer(value.totals?.knownResolved) || !integer(value.resolutionHistory?.missingReports)
            || typeof value.resolutionHistory.complete !== 'boolean') throw new Error('Invalid analytics response.');
        const complete = value.resolutionHistory.complete;
        if (complete ? !integer(value.totals.resolved) : value.totals.resolved !== null) throw new Error('Invalid resolution totals.');
        for (let index = 0; index < range.days; index++) {
            const day = value.daily[index];
            const expected = new Date(Date.parse(`${range.startDate}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
            if (day.date !== expected || !integer(day.submitted) || (day.ongoing !== undefined && !integer(day.ongoing)) || !integer(day.knownResolved) || (complete ? !integer(day.resolved) : day.resolved !== null)) {
                throw new Error('Invalid analytics daily series.');
            }
        }
        if (value.daily.at(-1).date !== range.endDate || value.categories.some(category => typeof category.key !== 'string'
            || typeof category.label !== 'string' || category.label.length > 100 || !integer(category.count)
            || !Number.isFinite(category.percentage) || category.percentage < 0 || category.percentage > 100)
            || value.categories.reduce((sum, category) => sum + category.count, 0) !== value.totals.submitted) throw new Error('Invalid category totals.');
        if (value.dailyByBarangay !== undefined) {
            if (!Array.isArray(value.dailyByBarangay) || !Array.isArray(value.barangays)) throw new Error('Invalid barangay analytics.');
            const names = new Map(value.barangays.map(area => [area.id, area.name]));
            const keys = new Set();
            for (const row of value.dailyByBarangay) {
                const key = `${row.date}/${row.barangayId}`;
                if (!date(row.date) || row.date < range.startDate || row.date > range.endDate || keys.has(key) ||
                    typeof row.barangay !== 'string' || row.barangay !== names.get(row.barangayId) ||
                    ![row.submitted, row.ongoing, row.knownResolved].every(integer) ||
                    (row.resolved !== null && row.resolved !== row.knownResolved)) throw new Error('Invalid barangay event counts.');
                keys.add(key);
            }
        }
        return value;
    }

    async function load(days, signal, endpoint = '/api/admin/analytics/reports') {
        return normalize(await window.apiRequest(`${endpoint}?days=${days}`, { signal, cache: 'no-store' }));
    }

    return { load, normalize };
});
