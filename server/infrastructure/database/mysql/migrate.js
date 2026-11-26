const { getPool, closePool } = require('./pool');
const { runMigrations } = require('./migrationRunner');

async function main() {
  try {
    const { applied, skipped } = await runMigrations(getPool());
    skipped.forEach(filename => console.log(`skipped ${filename}`));
    applied.forEach(filename => console.log(`applied ${filename}`));

  } catch (error) {
    console.error(`migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
