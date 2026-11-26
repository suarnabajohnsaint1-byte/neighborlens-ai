'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const target = path.join(root, 'server/application/use-cases/citizenEnrollment.service.js');
const policy = path.join(root, 'server/domain/identity/ocrPrefillPolicy.js');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(target) || !fs.existsSync(policy)) {
  process.stderr.write('Expected NeighborLens project root and OCR policy file. No changes made.\n');
  process.exit(1);
}

const original = fs.readFileSync(target, 'utf8');
const importLine = "const { canAutofillIdFields } = require('../../domain/identity/ocrPrefillPolicy');";
const pattern = /ocrPrefillAllowed\s*:\s*fraud\.cleared\s*===\s*true\s*&&\s*screening\?\.classification\s*===\s*['"]LOW_RISK['"]/g;
const matches = [...original.matchAll(pattern)];
const alreadyInstalled = original.includes(importLine) && original.includes('ocrPrefillAllowed: canAutofillIdFields(screening)');

if (alreadyInstalled && matches.length === 0) {
  process.stdout.write('Patch already installed. No changes needed.\n');
  process.exit(0);
}
if (matches.length !== 1 || original.includes(importLine)) {
  process.stderr.write(`Expected one exact OCR prefill gate (found ${matches.length}). No changes made.\n`);
  process.exit(1);
}

let updated = original.replace(pattern, 'ocrPrefillAllowed: canAutofillIdFields(screening)');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
const useStrict = /^(?:\uFEFF)?(['\"])use strict\1;?\r?\n/.exec(updated);
if (useStrict) {
  updated = updated.slice(0, useStrict[0].length) + importLine + newline + updated.slice(useStrict[0].length);
} else {
  updated = importLine + newline + updated;
}

if (!apply) {
  process.stdout.write('Patch compatible. Preview only; run with --apply to modify the file.\n');
} else {
  fs.writeFileSync(target, updated, 'utf8');
  process.stdout.write('Updated citizenEnrollment.service.js. Only OCR prefill permission changed.\n');
}
