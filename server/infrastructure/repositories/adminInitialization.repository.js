class AdminInitializationRepository {
  async lock(client) {
    const rows = await client.query('SELECT initialized_at, initialized_by FROM admin_initialization WHERE id = 1 FOR UPDATE');
    if (!rows.length) throw new Error('Administrator initialization state is missing. Apply migration 013 before bootstrap.');
    return rows[0];
  }

  async complete(userId, source, client) {
    const result = await client.execute(
      'UPDATE admin_initialization SET initialized_at = CURRENT_TIMESTAMP, initialized_by = ?, source = ? WHERE id = 1 AND initialized_at IS NULL',
      [userId, source]
    );
    if (result.affectedRows !== 1) throw new Error('Administrator bootstrap is already initialized. Use operator recovery.');
  }
}

module.exports = new AdminInitializationRepository();
