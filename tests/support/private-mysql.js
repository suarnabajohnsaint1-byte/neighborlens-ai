const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

function waitExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Private MySQL process timed out.')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function privateMysql(t, { executable = process.env.PRIVATE_MYSQL_EXECUTABLE, database = 'community_isolated' } = {}) {
  const windows = process.platform === 'win32';
  executable ||= windows
    ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe'
    : '/usr/sbin/mysqld';
  await fs.access(executable);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neighborlens-community-mysql-'));
  let daemon, pool, closed = false;
  let diagnostics = '';
  let daemonError;

  function launch(args) {
    const child = spawn(executable, ['--no-defaults', `--datadir=${directory}`, ...args, ...(windows ? ['--console'] : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    return child;
  }

  async function close() {
    if (closed) return; closed = true;
    if (pool) { try { await pool.query('SHUTDOWN'); } catch {} await pool.end(); }
    if (daemon && daemon.exitCode === null) await waitExit(daemon, 10000).catch(() => {});
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('neighborlens-community-mysql-'));
    try { await fs.rm(directory, { recursive: true, force: false }); }
    catch (error) { t.diagnostic(`Private temporary directory retained without force: ${directory}; ${error.code}`); }
  }
  try {
    const initializer = launch(['--initialize-insecure']);
    assert.equal(await waitExit(initializer, 60000), 0, 'Private MySQL data directory initialization failed.');
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const unixOptions = windows ? [] : [
      `--socket=${path.join(directory, 'mysql.sock')}`, `--pid-file=${path.join(directory, 'mysql.pid')}`, '--secure-file-priv=NULL'
    ];
    daemon = launch(['--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=OFF', ...unixOptions]);
    daemon.once('error', error => { daemonError = error; });
    let connection;
    for (let attempt = 0; attempt < 160; attempt++) {
      if (daemonError) throw daemonError;
      assert.ok(daemon.exitCode === null && daemon.signalCode === null,
        `Private MySQL exited before startup (status ${daemon.exitCode ?? daemon.signalCode}).`);
      try { connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 1000 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(connection, 'Private MySQL did not start.');
    const [identity] = await connection.query('SELECT @@datadir AS directory, VERSION() AS version');
    assert.equal(path.resolve(identity[0].directory).toLowerCase(), path.resolve(directory).toLowerCase());
    t.diagnostic(`Private MySQL ${identity[0].version}, verified temporary data directory and random loopback port.`);
    await connection.query(`CREATE DATABASE ${mysql.escapeId(database)}`); await connection.end();
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', database, dateStrings: true, connectionLimit: 10 });
    const client = executor => ({ query: async (sql, params = []) => (await executor.execute(sql, params))[0], execute: async (sql, params = []) => (await executor.execute(sql, params))[0] });
    const adapter = { ...client(pool), driver: 'mysql', withTransaction: async operation => {
      const connection = await pool.getConnection();
      try { await connection.beginTransaction(); const result = await operation(client(connection)); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    } };
    return { pool, adapter, directory, close, port, database };
  } catch (error) {
    if (diagnostics.trim()) t.diagnostic(diagnostics.trim());
    await close();
    throw error;
  }
}

module.exports = { privateMysql, waitExit };
