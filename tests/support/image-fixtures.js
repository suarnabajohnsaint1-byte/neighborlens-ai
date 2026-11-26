const { readFileSync } = require('node:fs');
const path = require('node:path');

const evidenceFile = name => readFileSync(path.join(__dirname, '../fixtures/report-evidence', name));
const JPEG_BYTES = evidenceFile('road-angle-a.jpg');
const SECOND_JPEG_BYTES = evidenceFile('road-angle-b.jpg');
const PNG_BYTES = evidenceFile('road-other.png');
const WEBP_BYTES = evidenceFile('road-other.webp');

module.exports = { evidenceFile, JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES, WEBP_BYTES };
