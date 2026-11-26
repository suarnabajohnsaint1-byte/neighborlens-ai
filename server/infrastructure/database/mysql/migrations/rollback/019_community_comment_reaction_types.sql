ALTER TABLE community_comment_reactions
  DROP CHECK chk_community_comment_reaction_type,
  DROP COLUMN reaction;
