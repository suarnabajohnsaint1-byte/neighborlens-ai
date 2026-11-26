function assertLoopbackHost(host) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase())) {
    throw new Error('Database tests require a loopback host and must not target hosted services.');
  }
}

function assertTestDatabase(name) {
  if (!/^[a-zA-Z0-9_]+_test$/.test(String(name))) {
    throw new Error('Database tests require a dedicated database name ending in _test.');
  }
}

module.exports = { assertLoopbackHost, assertTestDatabase };
