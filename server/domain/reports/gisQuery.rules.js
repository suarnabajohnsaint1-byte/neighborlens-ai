const { ValidationError, ForbiddenError } = require('../errors');
const { reportQuery } = require('./reportQuery.rules');
function gisScope(user) {
  if (user?.role === 'admin') return null;
  if (user?.role === 'barangay' && Number.isSafeInteger(user.barangayId) && user.barangayId > 0) return user.barangayId;
  throw new ForbiddenError('Authorized staff access is required.');
}
function gisQuery(input = {}) {
  const { west, south, east, north, after = '0', through, extentOnly, ...filters } = input;
  const allowed = ['status', 'classification', 'category', 'priority', 'search', 'dateFrom', 'dateTo'];
  if (Object.keys(filters).some(key => !allowed.includes(key))) throw new ValidationError('Unsupported map filter.');
  function integer(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ValidationError('Invalid map cursor.');
    return Number(value);
  }
  const query = { ...reportQuery(filters), after: integer(after), through: through === undefined ? null : integer(through), extentOnly: extentOnly === '1' };
  if (extentOnly !== undefined && extentOnly !== '1') throw new ValidationError('Invalid map extent request.');
  if (query.extentOnly) return query;
  const values = [west, south, east, north];
  if (values.some(value => typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value)))) throw new ValidationError('A valid map viewport is required.');
  query.bounds = values.map(Number);
  if (Math.abs(query.bounds[0]) > 180 || Math.abs(query.bounds[2]) > 180 || Math.abs(query.bounds[1]) > 90 || Math.abs(query.bounds[3]) > 90 || query.bounds[0] >= query.bounds[2] || query.bounds[1] >= query.bounds[3]) throw new ValidationError('Invalid map viewport.');
  return query;
}
module.exports = { gisScope, gisQuery };
