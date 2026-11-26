CREATE TABLE community_personas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  avatar_variant TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY community_persona_user (post_id, user_id),
  UNIQUE KEY community_persona_name (post_id, display_name),
  FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE community_comments ADD COLUMN parent_id INT UNSIGNED NULL AFTER post_id;

ALTER TABLE community_comments ADD CONSTRAINT fk_community_comments_parent FOREIGN KEY (parent_id) REFERENCES community_comments(id) ON DELETE SET NULL;

ALTER TABLE community_comments ADD KEY community_comment_parent (post_id, parent_id, deleted_at);

CREATE TABLE community_comment_reactions (
  comment_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES community_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
