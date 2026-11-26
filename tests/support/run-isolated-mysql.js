const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { privateMysql } = require('./private-mysql');

function run(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, '../..'), env, stdio: 'inherit', windowsHide: true
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

(async () => {
  const database = await privateMysql({ diagnostic: value => console.log(value) });
  try {
    const options = database.pool.pool.config.connectionConfig;
    const env = {
      ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(options.port), DB_USER: 'root', DB_PASSWORD: '',
      DB_NAME: 'community_isolated', MYSQL_TEST_DB_NAME: 'neighborlens_runtime_test', DB_DRIVER: 'mysql',
      DB_TARGET: 'local', DB_SSL_MODE: 'DISABLED', DB_SSL_CA: '', STORAGE_DRIVER: 'local',
      SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', SUPABASE_STORAGE_BUCKET: '', JWT_SECRET: randomBytes(32).toString('hex')
    };
    if (process.argv.includes('--e2e')) {
      await database.pool.query('CREATE DATABASE neighborlens_runtime_test');
      Object.assign(env, { DB_NAME: 'neighborlens_runtime_test', UPLOAD_DIR: path.join(database.directory, 'uploads'),
        BOOTSTRAP_ADMIN_USERNAME: 'runtime.admin', BOOTSTRAP_ADMIN_PASSWORD: 'Qa12!' + randomBytes(24).toString('hex') });
      for (const args of [['server/infrastructure/database/mysql/migrate.js'],
        ['server/infrastructure/database/mysql/bootstrapAdmin.js'], ['--test', 'tests/e2e/mysql-runtime.e2e.test.js']]) {
        process.exitCode = await run(args, env);
        if (process.exitCode) break;
      }
    } else {
      const directory = path.resolve(__dirname, '../mysql');
      const files = fs.readdirSync(directory).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(directory, file));
      process.exitCode = await run(['--test', '--test-concurrency=1', ...files], env);
    }
  } finally { await database.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
