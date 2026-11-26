CREATE TABLE community_posts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  barangay_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  is_official TINYINT(1) NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  report_id INT UNSIGNED NULL,
  request_key VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  engagement_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  UNIQUE KEY community_post_request (author_id, request_key),
  KEY community_feed_scope (barangay_id, deleted_at, created_at, id),
  FOREIGN KEY (barangay_id) REFERENCES barangays(id),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_media (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id INT UNSIGNED NOT NULL,
  storage_reference VARCHAR(512) NOT NULL,
  image_order INT UNSIGNED NOT NULL,
  UNIQUE KEY community_media_order (post_id, image_order),
  FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_comments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  is_official TINYINT(1) NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  request_key VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  UNIQUE KEY community_comment_request (post_id, author_id, request_key),
  KEY community_comment_page (post_id, deleted_at, created_at, id),
  FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_reactions (
  post_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  reaction VARCHAR(5) NOT NULL,
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT community_reaction_type CHECK (reaction IN ('like', 'heart')),
  FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
