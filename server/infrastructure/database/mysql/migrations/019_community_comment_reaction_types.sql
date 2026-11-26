ALTER TABLE community_comment_reactions
  ADD COLUMN reaction VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'like',
  ADD CONSTRAINT chk_community_comment_reaction_type CHECK (reaction IN ('like', 'heart'));
