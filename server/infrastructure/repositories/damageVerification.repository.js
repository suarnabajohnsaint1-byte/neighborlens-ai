const { getDatabase } = require('../database');

class DamageVerificationRepository {
  async create({
    reportId, isValidMatch, compositeSimilarityScore, embeddingSimilarity,
    homographyInlierRatio, perspectiveAligned, matchedDamageType, highestSeverity,
    model, rawPayload
  }, client = getDatabase()) {
    return client.execute(
      `INSERT INTO damage_verifications (
        report_id, is_valid_match, composite_similarity_score,
        embedding_similarity, homography_inlier_ratio, perspective_aligned,
        matched_damage_type, highest_severity, model, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        isValidMatch ? 1 : 0,
        Number(compositeSimilarityScore || 0),
        Number(embeddingSimilarity || 0),
        Number(homographyInlierRatio || 0),
        perspectiveAligned ? 1 : 0,
        matchedDamageType || null,
        highestSeverity ?? null,
        String(model || 'yolov8-neighborlens'),
        typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload)
      ]
    );
  }

  async findByReportId(reportId, client = getDatabase()) {
    return client.query('SELECT * FROM damage_verifications WHERE report_id = ? ORDER BY id DESC', [reportId]);
  }
}

module.exports = new DamageVerificationRepository();
