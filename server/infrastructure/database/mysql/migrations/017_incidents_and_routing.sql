CREATE TABLE report_incidents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  canonical_report_id INT UNSIGNED NOT NULL UNIQUE,
  canonical_post_id INT UNSIGNED NULL,
  barangay_id INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (canonical_report_id) REFERENCES reports(id),
  FOREIGN KEY (canonical_post_id) REFERENCES community_posts(id),
  FOREIGN KEY (barangay_id) REFERENCES barangays(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE report_incident_members (
  report_id INT UNSIGNED PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (incident_id) REFERENCES report_incidents(id),
  INDEX idx_incident_members (incident_id, report_id)
) ENGINE=InnoDB;
CREATE TABLE report_routing_versions (
  report_id INT UNSIGNED PRIMARY KEY,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  FOREIGN KEY (report_id) REFERENCES reports(id)
) ENGINE=InnoDB;
CREATE TABLE report_coordination_events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NULL,
  kind VARCHAR(30) NOT NULL,
  request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  reason VARCHAR(500) NOT NULL,
  details JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_coordination_request (report_id, request_key),
  INDEX idx_coordination_events (report_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE community_post_aliases (
  post_id INT UNSIGNED PRIMARY KEY,
  canonical_post_id INT UNSIGNED NOT NULL,
  incident_id INT UNSIGNED NOT NULL,
  FOREIGN KEY (post_id) REFERENCES community_posts(id),
  FOREIGN KEY (canonical_post_id) REFERENCES community_posts(id),
  FOREIGN KEY (incident_id) REFERENCES report_incidents(id),
  CHECK (post_id <> canonical_post_id)
) ENGINE=InnoDB;
ALTER TABLE community_publication_requests ADD COLUMN discussion_post_id INT UNSIGNED NULL;
ALTER TABLE community_publication_requests ADD CONSTRAINT fk_publication_discussion FOREIGN KEY (discussion_post_id) REFERENCES community_posts(id);
ALTER TABLE user_permissions DROP CHECK chk_user_permissions_name;
ALTER TABLE user_permissions ADD CONSTRAINT chk_user_permissions_name CHECK (permission IN ('admin:create', 'report:assign-jurisdiction'));
CREATE TABLE report_incident_lock (
  id INT UNSIGNED PRIMARY KEY
) ENGINE=InnoDB;
INSERT INTO report_incident_lock (id) VALUES (1);
