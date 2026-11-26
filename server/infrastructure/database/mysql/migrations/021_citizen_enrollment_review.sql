CREATE TABLE IF NOT EXISTS citizen_enrollment_reviews (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  token_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  state VARCHAR(12) NOT NULL,
  boundary_version VARCHAR(64) NOT NULL,
  screening VARCHAR(24) NOT NULL,
  frame_keys VARCHAR(150) NOT NULL,
  facts_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subject_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_enrollment_review_queue (state, expires_at, id),
  INDEX idx_enrollment_review_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
