CREATE TABLE report_coordination_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  sender_id INT UNSIGNED NULL,
  sender_role VARCHAR(20) NOT NULL,
  body VARCHAR(500) NOT NULL,
  request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_report_message_request (report_id, sender_id, request_key),
  INDEX idx_report_message_order (report_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE report_coordination_reads (
  report_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  last_message_id INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, user_id),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE report_severity_reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  reviewed_by INT UNSIGNED NULL,
  category VARCHAR(40) NOT NULL,
  classification VARCHAR(20) NULL,
  priority VARCHAR(20) NULL,
  previous_classification VARCHAR(20) NULL,
  previous_priority VARCHAR(20) NULL,
  reason VARCHAR(500) NOT NULL,
  evidence JSON NOT NULL,
  policy_version VARCHAR(100) NOT NULL,
  recommendation VARCHAR(20) NULL,
  request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_report_severity_request (report_id, request_key),
  INDEX idx_report_severity_order (report_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
