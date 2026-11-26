const { ValidationError } = require('../errors');
const vocabulary = require('../../../shared/reportVocabulary');
const dates = require('../../../shared/manilaDates');

function reportQuery(query = {}) {
  if (['barangayId', 'barangay_id', 'barangay', 'userId', 'submittedBy', 'role'].some(field => Object.hasOwn(query, field))) throw new ValidationError('Report scope is assigned by the server.');
  const read = (key, fallback = '') => {
    if (query[key] === undefined || query[key] === '') return fallback;
    if (typeof query[key] !== 'string') throw new ValidationError(`Invalid ${key}.`);
    return query[key].trim();
  };
  function choice(key, values, fallback = 'all') {
    const value = read(key, fallback);
    if (!values.includes(value)) throw new ValidationError(`Invalid ${key}.`);
    return value;
  }
  function integer(key, fallback, maximum) {
    const value = read(key, String(fallback));
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new ValidationError(`Invalid ${key}.`);
    return Number(value);
  }
  const dateFrom = read('dateFrom'), dateTo = read('dateTo');
  if ((dateFrom && !dates.isDay(dateFrom)) || (dateTo && !dates.isDay(dateTo)) || (dateFrom && dateTo && dateFrom > dateTo)) throw new ValidationError('Choose a valid Manila date range.');
  const search = read('search');
  if (search.length > 200) throw new ValidationError('Search must be at most 200 characters.');
  return {
    page: integer('page', 1, 1000000), pageSize: integer('pageSize', 12, 100), search, dateFrom, dateTo,
    status: choice('status', ['all', ...Object.keys(vocabulary.statuses)]),
    category: choice('category', ['all', ...vocabulary.AI_REPORT_CATEGORIES, 'Uncategorized']),
    classification: choice('classification', ['all', 'MAJOR', 'MINOR', 'UNCLASSIFIED']),
    priority: choice('priority', ['all', ...vocabulary.priorities, 'Unprioritized']),
    sort: choice('sort', ['newest', 'oldest', 'priority'], 'newest')
  };
}

module.exports = { reportQuery };
