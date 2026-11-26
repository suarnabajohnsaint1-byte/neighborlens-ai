const { getDatabase } = require('../database');

class ReportImageRepository {
  async createMany(reportId, images, client = getDatabase()) {
    const created = [];
    for (const image of images) {
      const result = await client.execute(
        'INSERT INTO report_images (report_id, image_path, image_order, file_size, mime_type) VALUES (?, ?, ?, ?, ?)',
        [reportId, image.imagePath, image.imageOrder, image.fileSize || null, image.mimeType || null]
      );
      created.push({ id: result.insertId, reportId, ...image });
    }
    return created;
  }

  async findByReportId(reportId, client = getDatabase()) {
    return client.query(
      'SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order ASC',
      [reportId]
    );
  }

  async findByReportIds(reportIds, client = getDatabase()) {
    if (!reportIds.length) return new Map();
    const placeholders = reportIds.map(() => '?').join(', ');
    const rows = await client.query(
      `SELECT * FROM report_images WHERE report_id IN (${placeholders}) ORDER BY report_id ASC, image_order ASC`,
      reportIds
    );
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.report_id)) grouped.set(row.report_id, []);
      grouped.get(row.report_id).push(row);
    }
    return grouped;
  }
}

module.exports = new ReportImageRepository();
