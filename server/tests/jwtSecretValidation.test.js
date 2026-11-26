const test = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

test('production rejects whitespace-only JWT secret', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/infrastructure/config/env')"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '   ' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'Expected whitespace-only JWT_SECRET to be rejected');
  assert.match(result.stderr, /JWT_SECRET/, 'Error should mention JWT_SECRET');
});

test('production rejects trimmed insecure secret with surrounding spaces', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/infrastructure/config/env')"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: ' secret ' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'Expected trimmed insecure JWT_SECRET to be rejected');
  assert.match(result.stderr, /JWT_SECRET/);
});

test('production accepts trimmed secure secret with spaces', () => {
  const secret = '   a'.repeat(20) + '   '; // length >32 after trim
  const result = spawnSync(process.execPath, ['-e', "require('./server/infrastructure/config/env')"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'Expected trimmed secure JWT_SECRET to be accepted');
});
