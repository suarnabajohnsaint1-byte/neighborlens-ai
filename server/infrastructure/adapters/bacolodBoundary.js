const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { inspect } = require('../../../shared/geoContainment');
const { BACOLOD_BARANGAY_CATALOG } = require('../database/barangayCatalog');

const assets = path.resolve(__dirname, '../../../frontend/assets');

async function readDataset(entry, file, directory) {
  if (entry?.file !== file || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid Bacolod boundary manifest.');
  const text = (await readFile(path.join(directory, file), 'utf8')).replace(/\r\n/g, '\n');
  if (createHash('sha256').update(text).digest('hex') !== entry.sha256) throw new Error('Bacolod boundary integrity check failed.');
  return JSON.parse(text);
}

async function loadBacolodBoundary(directory = assets) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'bacolod-boundary-version.json'), 'utf8'));
  if (!/^bacolod-map-reference-v\d+$/.test(manifest.version)) throw new Error('Invalid Bacolod boundary version.');
  const [city, barangays] = await Promise.all([
    readDataset(manifest.city, 'bacolod-city-boundary.json', directory),
    readDataset(manifest.barangays, 'bacolod-barangay-boundaries.json', directory)
  ]);
  const officialNames = new Set(BACOLOD_BARANGAY_CATALOG.map(row => row.name));
  if (city.type !== 'Feature' || !inspect(0, 0, city) ||
      barangays.type !== 'FeatureCollection' || barangays.features?.length !== officialNames.size ||
      new Set(barangays.features.map(feature => feature?.properties?.code)).size !== officialNames.size ||
      barangays.features.some(feature => !officialNames.delete(feature?.properties?.name) ||
        typeof feature?.properties?.code !== 'string' || !feature.properties.code || !inspect(0, 0, feature))) {
    throw new Error('Bacolod boundary geometry is incomplete or invalid.');
  }
  return { version: manifest.version, city, barangays };
}

module.exports = { loadBacolodBoundary };
