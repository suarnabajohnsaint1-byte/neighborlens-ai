const test = require('node:test');
const assert = require('node:assert/strict');
const { numericPaths, numericExpression } = require('../../tests/support/mysql-json-numbers');

test('JSON number snapshots retain paths without using parsed JavaScript values as numeric evidence', () => {
  assert.deepEqual(numericPaths({ 'quoted"key': [1, true, null, '2', { value: -1e-20 }] }), ['$.' + JSON.stringify('quoted"key') + '[0]', '$.' + JSON.stringify('quoted"key') + '[4]."value"']);
  assert.equal(numericExpression('DOUBLE', '1.2383761108049694e-18'), "CAST('1.2383761108049694e-18' AS DOUBLE)");
  assert.equal(numericExpression('INTEGER', '18446744073709551615'), "CAST('18446744073709551615' AS UNSIGNED)");
  assert.equal(numericExpression('UNSIGNED INTEGER', '18446744073709551615'), "CAST('18446744073709551615' AS UNSIGNED)");
  assert.equal(numericExpression('INTEGER', '-9223372036854775808'), "CAST('-9223372036854775808' AS SIGNED)");
  assert.equal(numericExpression('DECIMAL', '123.4500'), "CAST('123.4500' AS DECIMAL(65,4))");
});

test('JSON numeric SQL construction rejects unsupported types, non-numeric strings and excessive scale', () => {
  for (const value of ['1); DROP TABLE reports', 'NaN', 'Infinity', '']) assert.throws(() => numericExpression('DOUBLE', value));
  assert.throws(() => numericExpression('STRING', '2'));
  assert.throws(() => numericExpression('DECIMAL', '0.' + '1'.repeat(31)));
});
