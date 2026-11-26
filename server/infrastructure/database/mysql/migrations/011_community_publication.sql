CREATE TABLE community_publication_requests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  barangay_id INT UNSIGNED NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending_approval',
  body TEXT NOT NULL,
  request_key VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  assigned_admin_id INT UNSIGNED NULL,
  reviewed_by INT UNSIGNED NULL,
  rejection_reason VARCHAR(500) NULL,
  post_id INT UNSIGNED NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  UNIQUE KEY publication_report (report_id),
  UNIQUE KEY publication_request_key (requested_by, request_key),
  UNIQUE KEY publication_post (post_id),
  KEY publication_queue (state, assigned_admin_id, requested_at),
  CONSTRAINT publication_state CHECK (state IN ('pending_approval', 'approved', 'rejected')),
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (barangay_id) REFERENCES barangays(id),
  FOREIGN KEY (assigned_admin_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id),
  FOREIGN KEY (post_id) REFERENCES community_posts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_publication_media (
  request_id INT UNSIGNED NOT NULL,
  image_order INT UNSIGNED NOT NULL,
  storage_reference VARCHAR(512) NOT NULL,
  PRIMARY KEY (request_id, image_order),
  FOREIGN KEY (request_id) REFERENCES community_publication_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_publication_legacy (
  post_id INT UNSIGNED PRIMARY KEY,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES community_posts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE community_publication_reviews (
  request_id INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  reviewer_id INT UNSIGNED NOT NULL,
  decision VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, version),
  FOREIGN KEY (request_id) REFERENCES community_publication_requests(id),
  FOREIGN KEY (reviewer_id) REFERENCES users(id),
  CONSTRAINT publication_review_decision CHECK (decision IN ('approved', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO community_publication_legacy (post_id) SELECT id FROM community_posts WHERE is_official = 0;
