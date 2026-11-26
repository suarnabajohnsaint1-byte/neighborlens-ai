const { getDatabase } = require('../database');
const { REPORT_CATEGORY_BY_CLASS, AI_REPORT_CATEGORIES } = require('../../domain/reports/damageCategories');

const columns = `p.*, b.name AS barangay,
  (SELECT COUNT(*) FROM community_reactions r WHERE r.post_id = p.id) AS reaction_total,
  (SELECT COUNT(*) FROM community_reactions r WHERE r.post_id = p.id AND r.reaction = 'like') AS like_total,
  (SELECT COUNT(*) FROM community_reactions r WHERE r.post_id = p.id AND r.reaction = 'heart') AS heart_total,
  (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_total,
  cp.display_name AS author_pseudonym,
  cp.avatar_variant AS author_avatar_variant`;
const from = "FROM community_posts p JOIN barangays b ON b.id = p.barangay_id AND b.city = 'Bacolod City' LEFT JOIN community_personas cp ON cp.post_id = p.id AND cp.user_id = p.author_id";
const published = `(p.is_official = 1 OR EXISTS (SELECT 1 FROM community_publication_requests approval WHERE approval.post_id = p.id AND approval.state = 'approved') OR EXISTS (SELECT 1 FROM community_publication_legacy legacy WHERE legacy.post_id = p.id))`;
const lock = () => getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
const eligibleComments = `WITH RECURSIVE eligible(id, parent_id) AS (
  SELECT id, parent_id FROM community_comments WHERE post_id = ? AND deleted_at IS NULL
  UNION SELECT p.id, p.parent_id FROM community_comments p JOIN eligible e ON e.parent_id = p.id WHERE p.post_id = ?
)`;

class CommunityRepository {
  async lockUser(id, db) { return (await db.query(`SELECT id, role, barangay_id, status, token_version FROM users WHERE id = ?${lock()}`, [id]))[0]; }
  async lockPost(id, db) { await db.query(`SELECT id FROM community_posts WHERE id = ?${lock()}`, [id]); }
  async find(id, scope = null, db = getDatabase()) {
    const scopeClause = scope && scope !== 'all' ? ' AND p.barangay_id = ?' : '';
    const params = scope && scope !== 'all' ? [id, scope] : [id];
    const rows = await db.query(`SELECT ${columns} ${from} WHERE p.id = ?${scopeClause} AND p.deleted_at IS NULL AND ${published}`, params);
    return rows[0] || null;
  }
  async byRequest(user, key, db = getDatabase()) {
    return (await db.query('SELECT id, barangay_id, request_hash, deleted_at FROM community_posts WHERE author_id = ? AND request_key = ?', [user, key]))[0] || null;
  }
  async byReportId(reportId, db = getDatabase()) {
    return (await db.query('SELECT id, author_id, barangay_id, report_id, request_key, request_hash, deleted_at FROM community_posts WHERE report_id = ? AND deleted_at IS NULL', [reportId]))[0] || null;
  }
  async sharedReportIds(scope, db = getDatabase()) {
    const rows = await db.query('SELECT report_id FROM community_posts WHERE barangay_id = ? AND report_id IS NOT NULL AND deleted_at IS NULL', [scope]);
    return rows.map(row => Number(row.report_id));
  }
  async barangayFilter(value, db = getDatabase()) {
    const numeric = /^\d+$/.test(String(value));
    return (await db.query(`SELECT id, name FROM barangays WHERE city = 'Bacolod City' AND ${numeric ? 'id = ?' : 'LOWER(name) = LOWER(?)'}`, [value]))[0] || null;
  }
  async list(query, db = getDatabase()) {
    const terms = ['p.deleted_at IS NULL', published];
    const params = [];
    if (query.barangay) { terms.push('p.barangay_id = ?'); params.push(query.barangay); }
    const incidentsReady = await require('./incident.repository').ready(db);
    if (incidentsReady) terms.push('NOT EXISTS (SELECT 1 FROM community_post_aliases alias_post WHERE alias_post.post_id = p.id)');
    if (query.status && query.status !== 'all') {
      const reportId = incidentsReady ? 'COALESCE((SELECT i.canonical_report_id FROM report_incident_members m JOIN report_incidents i ON i.id = m.incident_id WHERE m.report_id = p.report_id), p.report_id)' : 'p.report_id';
      terms.push(`EXISTS (SELECT 1 FROM reports linked WHERE linked.id = ${reportId} AND linked.barangay_id = p.barangay_id AND linked.status = ?)`);
      params.push(query.status);
    }
    if (query.search) {
      const extraction = field => getDatabase().driver === 'mysql' ? `JSON_UNQUOTE(JSON_EXTRACT(linked.submission_assessment, '$.${field}'))` : `json_extract(linked.submission_assessment, '$.${field}')`;
      const original = `NULLIF(${extraction('original_ai')}, 'null')`;
      const accepted = `CASE WHEN ${original} IS NOT NULL THEN CASE WHEN ${extraction('original_ai.status')} = 'DETECTED' THEN ${extraction('original_ai.canonical_class')} ELSE NULL END ELSE linked.ai_category END`;
      const value = `COALESCE(NULLIF(${extraction('citizen_category')}, 'null'), ${accepted})`;
      const categories = [...Object.entries(REPORT_CATEGORY_BY_CLASS), ...AI_REPORT_CATEGORIES.map(name => [name, name]), ['damaged_street_light', 'Street Light Damage']];
      const mapped = `CASE LOWER(${value}) ${categories.map(() => 'WHEN ? THEN ?').join(' ')} ELSE 'Uncategorized' END`;
      terms.push(`(LOWER(p.body) LIKE ? OR LOWER(b.name) LIKE ? OR EXISTS (SELECT 1 FROM reports linked WHERE linked.id = p.report_id AND linked.barangay_id = p.barangay_id AND (LOWER(${mapped}) LIKE ? OR CAST(linked.id AS CHAR) = ?)))`);
      params.push(`%${query.search.toLowerCase()}%`, `%${query.search.toLowerCase()}%`, ...categories.flatMap(([key, label]) => [key.toLowerCase(), label]), `%${query.search.toLowerCase()}%`, query.search.replace(/^#/, ''));
    }
    if (query.official) terms.push('p.is_official = 1');
    const where = `WHERE ${terms.join(' AND ')}`;
    const total = Number((await db.query(`SELECT COUNT(*) AS total ${from} ${where}`, params))[0].total);
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const order = `${query.sort === 'reacted' ? 'reaction_total DESC, ' : ''}p.created_at ${direction}, p.id ${direction}`;
    const rows = await db.query(`SELECT ${columns} ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, query.size, (query.page - 1) * query.size]);
    return { rows, total };
  }
  async create({ scope, user, official, body, report, key, hash }, db) {
    return db.execute('INSERT INTO community_posts (barangay_id, author_id, is_official, body, report_id, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?)', [scope, user, official ? 1 : 0, body, report, key, hash]);
  }
  async addMedia(post, reference, order, db) {
    return db.execute('INSERT INTO community_media (post_id, storage_reference, image_order) VALUES (?, ?, ?)', [post, reference, order]);
  }
  async media(post, db = getDatabase()) { return db.query('SELECT id, storage_reference, image_order FROM community_media WHERE post_id = ? ORDER BY image_order', [post]); }
  async mine(post, user, db = getDatabase()) { return (await db.query('SELECT reaction FROM community_reactions WHERE post_id = ? AND user_id = ?', [post, user]))[0]?.reaction || null; }
  async setReaction(post, user, value, db) {
    if (!value) await db.execute('DELETE FROM community_reactions WHERE post_id = ? AND user_id = ?', [post, user]);
    else {
      const upsert = getDatabase().driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE reaction = VALUES(reaction)' : 'ON CONFLICT(post_id, user_id) DO UPDATE SET reaction = excluded.reaction';
      await db.execute(`INSERT INTO community_reactions (post_id, user_id, reaction) VALUES (?, ?, ?) ${upsert}`, [post, user, value]);
    }
    await this.bump(post, db);
  }
  async bump(post, db) { await db.execute('UPDATE community_posts SET engagement_version = engagement_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [post]); }
  async edit(post, body, db) { await db.execute('UPDATE community_posts SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [body, post]); }
  async remove(post, db) { await db.execute('UPDATE community_posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [post]); }
  async supportsCommentReactionTypes(db) {
    if (getDatabase().driver !== 'mysql') return true;
    const rows = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'community_comment_reactions' AND column_name = 'reaction'");
    return rows.length > 0;
  }
  async comments(post, query, userId = null, db = getDatabase()) {
    const summary = await this.commentTotals(post, db);
    const supportsHeart = await this.supportsCommentReactionTypes(db);
    const parent = query.parent || null;
    const condition = parent ? 'c.parent_id = ?' : 'c.parent_id IS NULL';
    const params = [post, post, ...(parent ? [parent] : [])];
    const [count] = await db.query(`${eligibleComments} SELECT COUNT(*) AS total FROM community_comments c JOIN eligible e ON e.id = c.id WHERE ${condition}`, params);
    const pages = Math.max(1, Math.ceil(Number(count.total) / query.size));
    const page = Math.min(query.page, pages);
    const rows = await db.query(`${eligibleComments}, selected AS (
      SELECT c.id FROM community_comments c JOIN eligible e ON e.id = c.id WHERE ${condition}
      ORDER BY c.created_at, c.id LIMIT ? OFFSET ?
    ), branch(id, root_id, depth) AS (
      SELECT id, id, 0 FROM selected
      UNION ALL SELECT c.id, b.root_id, b.depth + 1 FROM community_comments c JOIN branch b ON c.parent_id = b.id
      JOIN eligible e ON e.id = c.id WHERE c.post_id = ? AND b.depth < 64
    ) SELECT c.*,
      author_barangay.name AS author_barangay,
      cp.display_name AS author_pseudonym,
      cp.avatar_variant AS author_avatar_variant,
      parent_c.author_id AS parent_author_id,
      parent_c.is_official AS parent_is_official,
      parent_barangay.name AS parent_author_barangay,
      parent_cp.display_name AS parent_author_pseudonym,
      parent_cp.avatar_variant AS parent_author_avatar_variant,
      (SELECT COUNT(*) FROM community_comment_reactions cr WHERE cr.comment_id = c.id) AS reaction_count,
      (SELECT ${supportsHeart ? 'cr.reaction' : "'like'"} FROM community_comment_reactions cr WHERE cr.comment_id = c.id AND cr.user_id = ?) AS user_reaction,
      (SELECT COUNT(*) FROM community_comments child WHERE child.post_id = c.post_id AND child.parent_id = c.id AND child.deleted_at IS NULL) AS direct_reply_count,
      (SELECT COUNT(*) FROM community_comments child JOIN eligible child_e ON child_e.id = child.id WHERE child.parent_id = c.id) AS visible_reply_count,
      (SELECT COUNT(*) FROM branch descendants JOIN community_comments d ON d.id = descendants.id WHERE descendants.root_id = c.id AND descendants.depth > 0 AND d.deleted_at IS NULL) AS thread_reply_count,
      c.deleted_at IS NOT NULL AS is_deleted
      FROM community_comments c
      JOIN branch current_branch ON current_branch.id = c.id
      LEFT JOIN users author_user ON author_user.id = c.author_id
      LEFT JOIN barangays author_barangay ON author_barangay.id = author_user.barangay_id
      LEFT JOIN community_personas cp ON cp.post_id = c.post_id AND cp.user_id = c.author_id
      LEFT JOIN community_comments parent_c ON parent_c.id = c.parent_id
      LEFT JOIN users parent_user ON parent_user.id = parent_c.author_id
      LEFT JOIN barangays parent_barangay ON parent_barangay.id = parent_user.barangay_id
      LEFT JOIN community_personas parent_cp ON parent_cp.post_id = parent_c.post_id AND parent_cp.user_id = parent_c.author_id
      ${parent ? 'WHERE current_branch.depth = 0' : ''}
      ORDER BY current_branch.depth, c.created_at, c.id LIMIT ?`, [...params, query.size, (page - 1) * query.size, post, userId || 0, parent ? query.size : 220]);
    return { rows, ...summary, supportsHeart, page, pages, childTotal: parent ? Number(count.total) : null };
  }
  async commentTotals(post, db = getDatabase()) {
    const [row] = await db.query(`${eligibleComments} SELECT
      (SELECT COUNT(*) FROM community_comments c JOIN eligible e ON e.id = c.id WHERE c.deleted_at IS NULL) AS total,
      (SELECT COUNT(*) FROM community_comments c JOIN eligible e ON e.id = c.id WHERE c.parent_id IS NULL) AS rootTotal`, [post, post]);
    return { total: Number(row.total), rootTotal: Number(row.rootTotal) };
  }
  async commentLineage(id, post, db) {
    return db.query(`WITH RECURSIVE lineage(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM community_comments WHERE id = ? AND post_id = ?
      UNION ALL SELECT c.id, c.parent_id, l.depth + 1 FROM community_comments c JOIN lineage l ON l.parent_id = c.id WHERE c.post_id = ? AND l.depth < 64
    ) SELECT * FROM lineage`, [id, post, post]);
  }
  async comment(id, post, db = getDatabase()) { return (await db.query('SELECT * FROM community_comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL', [id, post]))[0] || null; }
  async commentWithDeleted(id, post, db = getDatabase()) { return (await db.query('SELECT * FROM community_comments WHERE id = ? AND post_id = ?', [id, post]))[0] || null; }
  async commentByRequest(post, user, key, db = getDatabase()) { return (await db.query('SELECT * FROM community_comments WHERE post_id = ? AND author_id = ? AND request_key = ?', [post, user, key]))[0] || null; }
  async addComment(post, user, official, body, key, parentId = null, db = getDatabase()) {
    return db.execute('INSERT INTO community_comments (post_id, author_id, is_official, body, request_key, parent_id) VALUES (?, ?, ?, ?, ?, ?)', [post, user, official ? 1 : 0, body, key, parentId]);
  }
  async editComment(id, body, db = getDatabase()) { await db.execute('UPDATE community_comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [body, id]); }
  async removeComment(id, db = getDatabase()) { await db.execute('UPDATE community_comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]); }
  async getPersona(postId, userId, db = getDatabase()) {
    const rows = await db.query('SELECT display_name, avatar_variant FROM community_personas WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return rows[0] || null;
  }
  async createPersona(postId, userId, displayName, avatarVariant, db = getDatabase()) {
    await db.execute('INSERT INTO community_personas (post_id, user_id, display_name, avatar_variant) VALUES (?, ?, ?, ?)', [postId, userId, displayName, avatarVariant]);
  }
  async userCommentReaction(commentId, userId, db = getDatabase()) {
    return (await db.query('SELECT comment_id FROM community_comment_reactions WHERE comment_id = ? AND user_id = ?', [commentId, userId]))[0] || null;
  }
  async setCommentReaction(commentId, userId, value, supportsHeart, db) {
    if (!value) return db.execute('DELETE FROM community_comment_reactions WHERE comment_id = ? AND user_id = ?', [commentId, userId]);
    if (!supportsHeart) {
      return db.execute('INSERT INTO community_comment_reactions (comment_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE comment_id = community_comment_reactions.comment_id', [commentId, userId]);
    }
    const upsert = getDatabase().driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE reaction = VALUES(reaction)' : 'ON CONFLICT(comment_id, user_id) DO UPDATE SET reaction = excluded.reaction';
    return db.execute(`INSERT INTO community_comment_reactions (comment_id, user_id, reaction) VALUES (?, ?, ?) ${upsert}`, [commentId, userId, value]);
  }
  async commentReactionCount(commentId, db = getDatabase()) {
    return Number((await db.query('SELECT COUNT(*) AS total FROM community_comment_reactions WHERE comment_id = ?', [commentId]))[0].total);
  }
  async identity(post, db = getDatabase()) {
    return (await db.query('SELECT u.id, u.username, u.full_name, p.id AS post_id FROM community_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?', [post]))[0] || null;
  }
}

module.exports = new CommunityRepository();
