const { ValidationError } = require('../errors');
const { ANALYTICS_DAMAGE_CATEGORIES } = require('./damageCategories');

const PERIODS = Object.freeze([7, 30, 90]);
const { TIME_ZONE, OFFSET_MINUTES: MANILA_OFFSET_MINUTES, DAY_MS, day } = require('../../../shared/manilaDates');

function analyticsRange(value = '30', now = new Date()) {
  if (!['string', 'number'].includes(typeof value) || !PERIODS.some(days => String(days) === String(value))) {
    throw new ValidationError('Choose a period of 7, 30, or 90 days.');
  }
  const days = Number(value);
  const today = day(now);
  const endLocal = Date.parse(`${today}T00:00:00Z`) + DAY_MS;
  const startLocal = endLocal - days * DAY_MS;
  return {
    days, timeZone: TIME_ZONE,
    startDate: new Date(startLocal).toISOString().slice(0, 10), endDate: today,
    startUtc: new Date(startLocal - MANILA_OFFSET_MINUTES * 60000).toISOString(),
    endExclusiveUtc: new Date(endLocal - MANILA_OFFSET_MINUTES * 60000).toISOString(),
    asOf: now.toISOString()
  };
}

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid analytics count.');
  return number;
}

function summarizeAnalytics(range, aggregates) {
  const daily = Array.from({ length: range.days }, (_, index) => ({
    date: new Date(Date.parse(`${range.startDate}T00:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10),
    submitted: 0, ongoing: 0, resolved: 0, knownResolved: 0
  }));
  const byDate = new Map(daily.map(day => [day.date, day]));
  const categories = [...ANALYTICS_DAMAGE_CATEGORIES.map(({ key, label }) => ({ key, label, count: 0 })),
    { key: 'uncategorized', label: 'Uncategorized', count: 0 }];
  const byCategory = new Map(categories.map(category => [category.key, category]));
  const byBarangay = new Map((aggregates.catalog || []).map(({ id, name }) => [Number(id), {
    id: Number(id), name, submitted: 0, ongoing: 0, resolved: 0, categoryCounts: {}
  }]));
  const areaEvents = new Map();
  const missingByArea = new Set((aggregates.missingResolutionByBarangay || []).map(row => Number(row.barangayId) || 0));
  const sortBarangay = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  function areaFor(bucket) {
    const id = Number(bucket.barangayId) || 0;
    if (!byBarangay.has(id)) byBarangay.set(id, { id, name: 'Unassigned', submitted: 0, ongoing: 0, resolved: 0, categoryCounts: {} });
    return byBarangay.get(id);
  }
  function dailyArea(date, area) {
    const key = `${date}/${area.id}`;
    if (!areaEvents.has(key)) areaEvents.set(key, {
      date, barangayId: area.id, barangay: area.name, submitted: 0, ongoing: 0, knownResolved: 0
    });
    return areaEvents.get(key);
  }
  for (const bucket of aggregates.submissions) {
    const day = byDate.get(String(bucket.day));
    if (!day) continue;
    const total = count(bucket.total);
    day.submitted += total;
    const category = byCategory.get(bucket.category) || byCategory.get('uncategorized');
    category.count += total;
    if (aggregates.catalog) {
      const area = areaFor(bucket);
      area.submitted += total;
      area.ongoing += count(bucket.currentOngoing);
      area.resolved += count(bucket.currentResolved);
      area.categoryCounts[category.key] = (area.categoryCounts[category.key] || 0) + total;
      dailyArea(day.date, area).submitted += total;
    }
  }
  for (const bucket of aggregates.resolutions) {
    const day = byDate.get(String(bucket.day));
    if (day) {
      const total = count(bucket.total);
      day.knownResolved += total;
      if (aggregates.catalog) dailyArea(day.date, areaFor(bucket)).knownResolved += total;
    }
  }
  for (const bucket of aggregates.ongoing || []) {
    const day = byDate.get(String(bucket.day));
    if (day) {
      const total = count(bucket.total);
      day.ongoing += total;
      if (aggregates.catalog) dailyArea(day.date, areaFor(bucket)).ongoing += total;
    }
  }
  const missingReports = count(aggregates.missingResolutionHistory);
  for (const day of daily) day.resolved = missingReports ? null : day.knownResolved;
  const submitted = daily.reduce((sum, day) => sum + day.submitted, 0);
  const knownResolved = daily.reduce((sum, day) => sum + day.knownResolved, 0);
  return {
    range,
    daily,
    ...(aggregates.catalog ? {
      barangays: [...byBarangay.values()].sort((a, b) => sortBarangay(a.name, b.name)),
      dailyByBarangay: [...areaEvents.values()].sort((a, b) => a.date.localeCompare(b.date) || sortBarangay(a.barangay, b.barangay))
        .map(row => ({ ...row, resolved: missingByArea.has(row.barangayId) ? null : row.knownResolved }))
    } : {}),
    categories: categories.filter(category => category.key !== 'uncategorized' || category.count > 0)
      .map(category => ({ ...category, percentage: submitted ? category.count / submitted * 100 : 0 })),
    totals: { submitted, ongoing: daily.reduce((sum, day) => sum + day.ongoing, 0), resolved: missingReports ? null : knownResolved, knownResolved },
    ongoingRule: 'first_recorded_ongoing_per_report',
    resolutionHistory: { complete: missingReports === 0, missingReports, rule: 'first_resolution_per_report' },
    categoryRule: 'one_primary_category_per_report',
    timestampOffsetMinutes: aggregates.timestampOffsetMinutes
  };
}

module.exports = { PERIODS, TIME_ZONE, MANILA_OFFSET_MINUTES, analyticsRange, summarizeAnalytics };
