const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const skip = /^(node_modules|\.git)([\\/]|$)/;

fs.watch(root, { recursive: true }, (type, name) => {
  if (!name || skip.test(name)) return;
  console.log(`${new Date().toISOString()} ${type} ${name}`);
});

console.log(`watching ${root}`);
