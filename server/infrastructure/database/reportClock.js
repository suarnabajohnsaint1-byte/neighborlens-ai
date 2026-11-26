const dates = require('../../../shared/manilaDates');

async function offsetMinutes(database, client = database) {
  if (database.driver !== 'mysql') return 0;
  const rows = await client.query('SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CURRENT_TIMESTAMP) AS offset_minutes');
  const offset = Number(rows[0].offset_minutes);
  if (!Number.isInteger(offset) || Math.abs(offset) > 840) throw new Error('Unsupported database timestamp offset.');
  return offset;
}

function wallTime(utc, offset) { return new Date(Date.parse(utc) + offset * 60000).toISOString().slice(0, 19).replace('T', ' '); }
function utc(value, offset) {
  const timestamp = dates.timestamp(value, offset);
  return timestamp === null ? value : new Date(timestamp).toISOString();
}

module.exports = { offsetMinutes, wallTime, utc };
