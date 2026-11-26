const auditLogRepository = require('../../infrastructure/repositories/auditLog.repository');
const { ValidationError } = require('../../domain/errors');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const FILTER_PATTERN = /^[a-z_]{1,50}$/;

function parseInteger(value, { fallback, min, max, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text)) throw new ValidationError(`Invalid ${name} parameter.`);
  const number = Number(text);
  if (number < min || number > max) throw new ValidationError(`Invalid ${name} parameter.`);
  return number;
}

function parseFilter(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!FILTER_PATTERN.test(text)) throw new ValidationError(`Invalid ${name} filter.`);
  return text;
}

class AuditService {
  async findReportRequest(actorId, requestKey, client) {
    return auditLogRepository.findReportRequest(actorId, requestKey, client);
  }

  writeAudit(actorId, action, entityType, entityId = null, client, details = null) {
    return auditLogRepository.create({ actorId, action, entityType, entityId, details }, client);
  }

  getRecentLogs(limit = 100) {
    return auditLogRepository.findRecent(limit);
  }

  async listLogs(query = {}) {
    const limit = parseInteger(query.limit, { fallback: DEFAULT_PAGE_SIZE, min: 1, max: MAX_PAGE_SIZE, name: 'limit' });
    const offset = parseInteger(query.offset, { fallback: 0, min: 0, max: 100000000, name: 'offset' });
    const filters = {
      action: parseFilter(query.action, 'action'),
      entityType: parseFilter(query.entityType, 'entity type')
    };
    const [logs, total] = await Promise.all([
      auditLogRepository.findPage({ limit, offset, ...filters }),
      auditLogRepository.count(filters)
    ]);
    return { logs, total, limit, offset };
  }
}

module.exports = new AuditService();
