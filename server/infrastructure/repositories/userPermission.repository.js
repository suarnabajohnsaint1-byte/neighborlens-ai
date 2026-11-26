const { getDatabase } = require('../database');

class UserPermissionRepository {
  async findByUserIds(userIds, client = getDatabase()) {
    const ids = [...new Set(userIds.map(Number).filter(Number.isSafeInteger))];
    if (!ids.length) return new Map();
    const rows = await client.query(
      `SELECT user_id, permission FROM user_permissions WHERE user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY permission`,
      ids
    );
    const byUser = new Map(ids.map(id => [id, []]));
    for (const row of rows) byUser.get(Number(row.user_id))?.push(row.permission);
    return byUser;
  }

  async holdsActiveAdminPermission(userId, permission, client = getDatabase()) {
    const rows = await client.query(
      `SELECT 1 AS granted
       FROM user_permissions p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ? AND p.permission = ? AND u.role = 'admin' AND u.status = 'active'${getDatabase().driver === 'mysql' && client !== getDatabase() ? ' FOR UPDATE' : ''}`,
      [userId, permission]
    );
    return rows.length > 0;
  }

  async grant(userId, permission, grantedBy = null, client = getDatabase()) {
    return client.execute(
      `INSERT INTO user_permissions (user_id, permission, granted_by)
       SELECT id, ?, ? FROM users
       WHERE id = ? AND role = 'admin'
         AND NOT EXISTS (SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?)`,
      [permission, grantedBy, userId, userId, permission]
    );
  }
}

module.exports = new UserPermissionRepository();
