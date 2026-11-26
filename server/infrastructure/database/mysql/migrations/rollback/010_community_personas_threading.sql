DROP TABLE IF EXISTS community_comment_reactions;

ALTER TABLE community_comments DROP FOREIGN KEY fk_community_comments_parent;

ALTER TABLE community_comments DROP KEY community_comment_parent;

ALTER TABLE community_comments DROP COLUMN parent_id;

DROP TABLE IF EXISTS community_personas;
