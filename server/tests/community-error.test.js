const test = require('node:test');
const assert = require('node:assert/strict');
const communityError = require('../presentation/http/controllers/communityError');
const { ForbiddenError, ErrorKind } = require('../domain/errors');

test('missing publication tables return a safe actionable setup error', () => {
  for (const table of ['requests', 'media', 'reviews', 'legacy']) {
    const error = communityError({ code: 'ER_NO_SUCH_TABLE', sqlMessage: `Table 'private_schema.community_publication_${table}' doesn't exist` }, 'Retry');
    assert.equal(error.kind, ErrorKind.PROVIDER_UNAVAILABLE);
    assert.equal(error.code, 'COMMUNITY_SETUP_REQUIRED');
    assert.match(error.message, /administrator.*database setup/);
    assert.doesNotMatch(JSON.stringify(error), /private_schema|sqlMessage|SELECT/);
  }
});

test('authorization errors are unchanged and unrelated failures are not mislabeled as setup errors', () => {
  const denied = new ForbiddenError('Not authorized');
  assert.equal(communityError(denied, 'Retry'), denied);
  for (const error of [{ code: 'ER_NO_SUCH_TABLE', sqlMessage: "Table 'private.users' doesn't exist" }, { code: 'ECONNREFUSED' }, new Error('Sensitive SQL details')]) {
    const result = communityError(error, 'Operation unavailable.');
    assert.equal(result.kind, ErrorKind.PERSISTENCE_FAILURE);
    assert.equal(result.message, 'Operation unavailable.');
    assert.equal(result.code, undefined);
  }
});
