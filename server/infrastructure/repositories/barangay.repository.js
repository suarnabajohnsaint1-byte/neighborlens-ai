const { getDatabase } = require('../database');

const CATALOG_COLUMNS = 'id, name, city, province, region';

class BarangayRepository {
  async findByName(name, client = getDatabase()) {
    const rows = await client.query('SELECT * FROM barangays WHERE name = ?', [name]);
    return rows[0] || null;
  }

  async findById(id, client = getDatabase()) {
    const rows = await client.query(`SELECT * FROM barangays WHERE id = ?${getDatabase().driver === 'mysql' && client !== getDatabase() ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] || null;
  }

  async findAll(client = getDatabase()) {
    return client.query('SELECT * FROM barangays ORDER BY name');
  }

  async findCatalog(client = getDatabase()) {
    return client.query(`SELECT ${CATALOG_COLUMNS} FROM barangays ORDER BY id`);
  }

  async create({
    name,
    city = 'Bacolod City',
    province = 'Negros Occidental',
    boundarySource = null,
    boundaryVersion = null,
    boundaryGeojson = null
  }, client = getDatabase()) {
    return client.execute(
      'INSERT INTO barangays (name, city, province, boundary_source, boundary_version, boundary_geojson) VALUES (?, ?, ?, ?, ?, ?)',
      [name, city, province, boundarySource, boundaryVersion, boundaryGeojson ? JSON.stringify(boundaryGeojson) : null]
    );
  }

  async findAllWithBoundary(client = getDatabase()) {
    return client.query(`SELECT * FROM barangays WHERE boundary_geojson IS NOT NULL${getDatabase().driver === 'mysql' && client !== getDatabase() ? ' FOR UPDATE' : ''}`);
  }
}

module.exports = new BarangayRepository();
