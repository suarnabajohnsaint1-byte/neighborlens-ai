const { ForbiddenError, ValidationError } = require('../../domain/errors');
const { analyticsRange, summarizeAnalytics } = require('../../domain/reports/reportAnalytics.rules');

function createReportAnalyticsService({ reportAnalyticsRepository, clock = () => new Date() }) {
  return {
    async getAnalytics(query = {}, user = {}) {
      if (!['admin', 'barangay'].includes(user.role)) throw new ForbiddenError('Staff access is required.');
      const scope = user.role === 'barangay' ? Number(user.barangay_id ?? user.barangayId) : null;
      if (scope !== null && (!Number.isSafeInteger(scope) || scope <= 0)) throw new ForbiddenError('A valid barangay assignment is required.');
      if (Object.keys(query).some(key => key !== 'days')) throw new ValidationError('Only the days filter is supported.');
      const range = analyticsRange(query.days, clock());
      return summarizeAnalytics(range, await reportAnalyticsRepository.aggregate(range, scope));
    }
  };
}

module.exports = { createReportAnalyticsService };
