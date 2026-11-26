const mysql = require('mysql2/promise');

function numericPaths(value, path = '$', result = []) {
  if (typeof value === 'number') result.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => numericPaths(item, `${path}[${index}]`, result));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) numericPaths(item, `${path}.${JSON.stringify(key)}`, result);
  return result;
}

function numericExpression(type, value) {
  if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) throw new Error('Unexpected native JSON number representation.');
  if (type === 'DOUBLE') return `CAST(${mysql.escape(value)} AS DOUBLE)`;
  if (type === 'INTEGER' || type === 'UNSIGNED INTEGER') return `CAST(${mysql.escape(value)} AS ${value.startsWith('-') ? 'SIGNED' : 'UNSIGNED'})`;
  if (type === 'DECIMAL') {
    const scale = (value.split('.')[1] || '').length;
    if (scale > 30 || /e/i.test(value)) throw new Error('Unsupported native JSON decimal precision.');
    return `CAST(${mysql.escape(value)} AS DECIMAL(65,${scale}))`;
  }
  throw new Error(`Unsupported native JSON numeric type: ${type}`);
}

async function captureJsonNumbers(connection) {
  const [columns] = await connection.query("SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.columns WHERE table_schema = DATABASE() AND DATA_TYPE = 'json' ORDER BY TABLE_NAME, ORDINAL_POSITION");
  if (columns.length) {
    const names = [...new Set(columns.map(column => column.tableName))];
    const [[triggers]] = await connection.execute(`SELECT COUNT(*) AS total FROM information_schema.triggers WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN (${names.map(() => '?').join(', ')})`, names);
    if (Number(triggers.total)) throw new Error('Native JSON backup requires separately reviewed handling of table triggers.');
  }
  const statements = [];
  let numericValues = 0;
  for (const column of columns) {
    const [keys] = await connection.query("SELECT COLUMN_NAME AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY' ORDER BY SEQ_IN_INDEX", [column.tableName]);
    if (!keys.length) throw new Error('JSON backup requires a stable primary key.');
    const [automatic] = await connection.query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND EXTRA LIKE '%on update%'", [column.tableName]);
    const table = mysql.escapeId(column.tableName), field = mysql.escapeId(column.columnName);
    const [rows] = await connection.query(`SELECT ${keys.map((key, i) => `CAST(${mysql.escapeId(key.name)} AS CHAR) AS pk${i}`).join(', ')}, CAST(${field} AS CHAR) AS document FROM ${table} WHERE ${field} IS NOT NULL`);
    for (const row of rows) {
      const paths = numericPaths(JSON.parse(row.document));
      const where = keys.map((key, i) => `${mysql.escapeId(key.name)} = ${mysql.escape(row[`pk${i}`])}`).join(' AND ');
      const keyCondition = keys.map(key => `${mysql.escapeId(key.name)} = ?`).join(' AND ');
      for (let offset = 0; offset < paths.length; offset += 64) {
        const batch = paths.slice(offset, offset + 64);
        const selections = batch.flatMap((p, i) => [`JSON_TYPE(JSON_EXTRACT(${field}, ?)) AS t${i}`, `JSON_UNQUOTE(JSON_EXTRACT(${field}, ?)) AS v${i}`]);
        const [[values]] = await connection.execute(`SELECT ${selections.join(', ')} FROM ${table} WHERE ${keyCondition}`, [...batch.flatMap(p => [p, p]), ...keys.map((key, i) => row[`pk${i}`])]);
        const argumentsSql = batch.flatMap((p, i) => [mysql.escape(p), numericExpression(values[`t${i}`], values[`v${i}`])]);
        statements.push(`UPDATE ${table} SET ${field} = JSON_SET(${field}, ${argumentsSql.join(', ')})${automatic.map(item => `, ${mysql.escapeId(item.name)} = ${mysql.escapeId(item.name)}`).join('')} WHERE ${where};`);
        numericValues += batch.length;
      }
    }
  }
  return { sql: "SET @neighborlens_backup_sql_mode = @@SESSION.sql_mode;\nSET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\n" + statements.join('\n') + '\nSET SESSION sql_mode = @neighborlens_backup_sql_mode;\nSET @neighborlens_backup_sql_mode = NULL;\n', statements: statements.length, numericValues };
}

module.exports = { numericPaths, numericExpression, captureJsonNumbers };
