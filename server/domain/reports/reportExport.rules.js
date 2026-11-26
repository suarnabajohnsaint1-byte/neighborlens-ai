const { reportQuery } = require('./reportQuery.rules');
const { gisScope } = require('./gisQuery.rules');
const { ValidationError, ForbiddenError } = require('../errors');

function exportQuery(user, input = {}) {
  const scope = gisScope(user);
  const { barangay = 'all', publication, ...filters } = input;
  if (publication !== undefined) {
    if (user.role !== 'admin') throw new ForbiddenError('Only Admin may export the publication review queue.');
    if (publication !== 'pending_approval') throw new ValidationError('Invalid publication filter.');
  }
  const allowed = ['status', 'classification', 'category', 'priority', 'search', 'dateFrom', 'dateTo', 'sort'];
  if (Object.keys(filters).some(key => !allowed.includes(key))) throw new ValidationError('Unsupported export filter.');
  if (typeof barangay !== 'string' || barangay.length > 150) throw new ValidationError('Invalid barangay filter.');
  if (scope !== null && barangay !== 'all') throw new ForbiddenError('Barangay export scope is assigned by the server.');
  const legacy = ['Electrical', 'Fallen Tree', 'Sanitation', 'Structural', 'Infrastructure'];
  const legacyCategory = user.role === 'admin' && legacy.includes(filters.category);
  const query = reportQuery(legacyCategory ? { ...filters, category: 'all' } : filters);
  if (legacyCategory) query.category = filters.category;
  return { scope, query, barangay, publication };
}

module.exports = { exportQuery, MAX_REPORTS: 5000 };
