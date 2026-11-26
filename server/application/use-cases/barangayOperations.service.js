const { ForbiddenError, ValidationError } = require('../../domain/errors');
const { reportQuery } = require('../../domain/reports/reportQuery.rules');
const vocabulary = require('../../domain/reports/damageCategories');
const dates = require('../../../shared/manilaDates');
function createBarangayOperationsService({ repository, clock, getDatabase }) {
  function scope(user) {
    if (user?.role !== 'barangay' || !Number.isSafeInteger(user.barangayId) || user.barangayId < 1) throw new ForbiddenError('An assigned barangay official is required.');
    return user.barangayId;
  }
  return {
    async gis(user, input = {}) {
      const id = scope(user);
      const allowed = ['status', 'category', 'classification', 'priority', 'search', 'sort', 'dateFrom', 'dateTo', 'page', 'pageSize'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new ValidationError('Unsupported GIS filter.');
      const query = reportQuery({ ...input, pageSize: input.pageSize || '100' });
      const offset = await clock.offsetMinutes(getDatabase());
      const rows = await repository.gis(id, query, offset);
      return { barangay: user.barangay, boundaryVerified: false, page: query.page, hasMore: rows.length > query.pageSize,
        reports: rows.slice(0, query.pageSize).map(row => {
          let snapshot = row.submission_assessment;
          if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; } }
          return { id: Number(row.id), barangay: row.barangay,
          latitude: row.latitude === null ? null : Number(row.latitude), longitude: row.longitude === null ? null : Number(row.longitude),
          status: row.status, classification: vocabulary.classification(row.ai_classification),
          category: vocabulary.categoryOf({ citizenCategory: snapshot?.citizen_category,
            originalAi: snapshot?.original_ai, ai_category: row.ai_category }) };
        }) };
    },
    async activity(user, input = {}) {
      const id = scope(user);
      if (Object.keys(input).some(key => !['page', 'pageSize', 'dateFrom', 'dateTo', 'action', 'search'].includes(key))) throw new ValidationError('Unsupported activity filter.');
      const { action = '', ...filters } = input;
      if (!['', 'create', 'status_update', 'classification_update', 'assign', 'reassign', 'review'].includes(action)) throw new ValidationError('Invalid activity action.');
      const query = reportQuery(filters);
      const offset = await clock.offsetMinutes(getDatabase());
      const range = dates.interval(query.dateFrom, query.dateTo);
      const result = await repository.activity(id, { ...query, action,
        start: range.start === null ? null : clock.wallTime(new Date(range.start).toISOString(), offset),
        end: range.end === null ? null : clock.wallTime(new Date(range.end).toISOString(), offset) }, offset);
      return { logs: result.rows.map(row => {
        let details = row.details;
        if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }
        return { id: Number(row.id), action: row.action, reportId: Number(row.report_id), barangay: user.barangay,
          actor: { citizen: 'Citizen', admin: 'Administrator', barangay: 'Barangay official' }[row.actor_role] || 'System',
          status: Object.hasOwn(vocabulary.statuses, details?.to) ? details.to : null, createdAt: clock.utc(row.created_at, offset) };
      }), pagination: { page: query.page, pages: Math.max(1, Math.ceil(result.total / query.pageSize)), total: result.total } };
    }
  };
}
module.exports = { createBarangayOperationsService };
