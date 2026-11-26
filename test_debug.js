const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['-e', "require('./server/infrastructure/config/env')", { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'this-is-a-jwt-secret-that-is-definitely-not-secure-and-everyone-knows-it' }, encoding: 'utf8' }]);
console.log('status:', result.status);
console.log('stderr:', result.stderr);