const { getPool, closePool } = require('./pool');

function createClient(executor) {
  return {
    query: async (sql, params = []) => {
      const [rows] = await executor.execute(sql, params);
      return rows;
    },
    execute: async (sql, params = []) => {
      const [result] = await executor.execute(sql, params);
      return {
        insertId: Number(result.insertId || 0),
        affectedRows: Number(result.affectedRows || 0)
      };
    }
  };
}

function createMysqlAdapter(pool = getPool()) {
  const client = createClient(pool);

  async function withTransaction(fn) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(createClient(connection));
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // The original error is what the caller needs to see.
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function ping() {
    const connection = await pool.getConnection();
    try {
      await connection.ping();
      return true;
    } finally {
      connection.release();
    }
  }

  return {
    driver: 'mysql',
    pool,
    query: client.query,
    execute: client.execute,
    withTransaction,
    ping,
    close: closePool
  };
}

module.exports = createMysqlAdapter;
