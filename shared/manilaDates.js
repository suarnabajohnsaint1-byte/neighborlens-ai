(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ManilaDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TIME_ZONE = 'Asia/Manila';
    const OFFSET_MINUTES = 480;
    const DAY_MS = 86400000;
    function isDay(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }
    function timestamp(value, wallOffsetMinutes = OFFSET_MINUTES) {
        if (value === null || value === undefined || value === '') return null;
        const wall = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
        const parsed = new Date(wall ? value.replace(' ', 'T') + 'Z' : value).getTime();
        return Number.isFinite(parsed) ? parsed - (wall ? wallOffsetMinutes * 60000 : 0) : null;
    }
    function dayStart(value) { return isDay(value) ? Date.parse(`${value}T00:00:00Z`) - OFFSET_MINUTES * 60000 : null; }
    function interval(from, to) { return { start: from ? dayStart(from) : null, end: to && isDay(to) ? dayStart(to) + DAY_MS : null }; }
    function day(value = new Date()) { return new Date(Number(value) + OFFSET_MINUTES * 60000).toISOString().slice(0, 10); }
    function format(value, { dateOnly = false } = {}) {
        const parsed = timestamp(value);
        return parsed === null ? null : new Date(parsed).toLocaleString('en-PH', { timeZone: TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric', ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }) });
    }
    return { TIME_ZONE, OFFSET_MINUTES, DAY_MS, isDay, timestamp, dayStart, interval, day, format };
});
