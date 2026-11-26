const { getDatabase } = require('../database');

function parseDetails(row) {
  if (typeof row.details !== 'string') return row;
  try {
    return { ...row, details: JSON.parse(row.details) };
  } catch {
    return { ...row, details: null };
  }
}

function filterClause({ action, entityType }) {
  const filters = [];
  const values = [];
  if (action) {
    filters.push('a.action = ?');
    values.push(action);
  }
  if (entityType) {
    filters.push('a.entity_type = ?');
    values.push(entityType);
  }
  return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', values };
}

class AuditLogRepository {
  async findReportRequest(actorId, requestKey, client = getDatabase()) {
    const rows = await client.query("SELECT entity_id, details FROM audit_logs WHERE actor_id = ? AND action = 'create' AND entity_type = 'report' ORDER BY id DESC", [actorId]);
    return rows.map(parseDetails).find(row => row.details?.request_key === requestKey) || null;
  }

  async create({ actorId, action, entityType, entityId = null, details = null }, client = getDatabase()) {
    return client.execute(
      'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
      [actorId ?? null, action, entityType, entityId, details ? JSON.stringify(details) : null]
    );
  }

  async findRecent(limit = 100, client = getDatabase()) {
    return client.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
  }

  async findPage({ limit, offset, action = null, entityType = null }, client = getDatabase()) {
    const { where, values } = filterClause({ action, entityType });
    const rows = await client.query(
      `SELECT a.id, a.actor_id, u.username AS actor_username, u.role AS actor_role,
              a.action, a.entity_type, a.entity_id, a.details, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    return rows.map(parseDetails);
  }

  async count({ action = null, entityType = null } = {}, client = getDatabase()) {
    const { where, values } = filterClause({ action, entityType });
    const rows = await client.query(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`, values);
    return Number(rows[0]?.total || 0);
  }
}

module.exports = new AuditLogRepository();
