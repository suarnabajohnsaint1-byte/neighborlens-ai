DROP TEMPORARY TABLE IF EXISTS migration018_guard;
CREATE TEMPORARY TABLE migration018_guard (
  column_ready TINYINT NOT NULL CHECK (column_ready = 1),
  named_index_ready TINYINT NOT NULL CHECK (named_index_ready = 1),
  duplicate_groups BIGINT NOT NULL CHECK (duplicate_groups = 0)
);
INSERT INTO migration018_guard
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'community_posts'
     AND column_name = 'report_id' AND column_type = 'int unsigned' AND is_nullable = 'YES'),
  (SELECT IF(COUNT(*) = 0 OR (COUNT(*) = 1 AND SUM(
     NON_UNIQUE = 0 AND COLUMN_NAME = 'report_id' AND SEQ_IN_INDEX = 1
     AND SUB_PART IS NULL AND EXPRESSION IS NULL AND INDEX_TYPE = 'BTREE'
     AND IS_VISIBLE = 'YES' AND COLLATION = 'A') = 1), 1, 0)
   FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'community_posts' AND index_name = 'community_post_report'),
  (SELECT COUNT(*) FROM (
     SELECT report_id FROM community_posts WHERE report_id IS NOT NULL
     GROUP BY report_id HAVING COUNT(*) > 1
   ) duplicate_reports);
SET @migration018_has_unique = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'community_posts' AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'report_id' AND MAX(SEQ_IN_INDEX) = 1
      AND MAX(SUB_PART) IS NULL AND MAX(EXPRESSION) IS NULL AND MAX(INDEX_TYPE) = 'BTREE'
      AND MIN(IS_VISIBLE) = 'YES' AND MIN(COLLATION) = 'A'
  ) report_unique_indexes
);
SET @migration018_sql = IF(@migration018_has_unique > 0,
  'SELECT 1',
  'ALTER TABLE community_posts ADD UNIQUE KEY community_post_report (report_id)');
PREPARE migration018_statement FROM @migration018_sql;
EXECUTE migration018_statement;
DEALLOCATE PREPARE migration018_statement;
DROP TEMPORARY TABLE migration018_guard;
SET @migration018_sql = NULL, @migration018_has_unique = NULL;
