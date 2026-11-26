const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { normalizeFrame } = require('../server/infrastructure/adapters/registrationVerifier');

async function main(files) {
  if (!files.length) throw new Error();
  const digests = new Set();
  for (const file of files) {
    const bytes = await normalizeFrame(await readFile(file));
    digests.add(createHash('sha256').update(bytes).digest('hex'));
  }
  process.stdout.write([...digests].join('\n') + '\n');
}

main(process.argv.slice(2)).catch(() => {
  console.error('Supply readable, authorized JPEG replay samples that meet capture dimensions.');
  process.exitCode = 1;
});
