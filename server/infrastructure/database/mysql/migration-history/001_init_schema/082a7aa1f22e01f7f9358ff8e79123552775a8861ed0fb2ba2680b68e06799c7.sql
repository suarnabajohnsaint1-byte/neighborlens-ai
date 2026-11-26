CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('citizen', 'admin', 'barangay') NOT NULL,
  barangay VARCHAR(150) NOT NULL,
  full_name VARCHAR(190),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS barangays (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  city VARCHAR(150) NOT NULL DEFAULT 'Bacolod City',
  province VARCHAR(150) NOT NULL DEFAULT 'Negros Occidental',
  boundary_source VARCHAR(255),
  boundary_version VARCHAR(50),
  boundary_geojson JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS citizen_identities (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL UNIQUE,
  document_type VARCHAR(50),
  id_number VARCHAR(100),
  full_name VARCHAR(190),
  birth_date DATE,
  address VARCHAR(255),
  expiry_date DATE,
  ocr_confidence DECIMAL(5,4),
  format_check_status VARCHAR(50),
  document_validation_status VARCHAR(50),
  is_expired TINYINT(1),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_citizen_identities_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reports (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  description TEXT NOT NULL,
  location VARCHAR(300),
  barangay VARCHAR(150) NOT NULL,
  barangay_id INT UNSIGNED,
  jurisdiction_source ENUM('citizen_declared', 'geofence_resolved') NOT NULL DEFAULT 'citizen_declared',
  boundary_check_status ENUM('inside_service_area', 'outside_service_area', 'service_area_unknown') NOT NULL DEFAULT 'service_area_unknown',
  latitude DECIMAL(10,7),
  longitude DECIMAL(10,7),
  gps_accuracy DECIMAL(10,2),
  image_path VARCHAR(500),
  ai_category VARCHAR(100) DEFAULT 'Infrastructure',
  ai_classification VARCHAR(20) DEFAULT 'MINOR',
  ai_priority VARCHAR(20) DEFAULT 'Low',
  ai_confidence DECIMAL(6,3) DEFAULT 0,
  vision_detected TINYINT(1) DEFAULT 0,
  status ENUM('pending', 'ongoing', 'resolved', 'rejected') NOT NULL DEFAULT 'pending',
  submitted_by INT UNSIGNED,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reports_user FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_reports_barangay FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_images (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  image_order TINYINT UNSIGNED NOT NULL,
  file_size INT UNSIGNED,
  mime_type VARCHAR(100),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_report_images_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  CONSTRAINT uq_report_images_order UNIQUE (report_id, image_order),
  CONSTRAINT chk_report_images_order CHECK (image_order IN (1, 2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS damage_verifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  is_valid_match TINYINT(1) NOT NULL,
  composite_similarity_score DECIMAL(6,4) NOT NULL,
  embedding_similarity DECIMAL(6,4) NOT NULL,
  homography_inlier_ratio DECIMAL(6,4) NOT NULL,
  perspective_aligned TINYINT(1) NOT NULL,
  matched_damage_type VARCHAR(100),
  highest_severity VARCHAR(20) NOT NULL,
  model VARCHAR(100) NOT NULL,
  raw_payload JSON,
  verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_damage_verifications_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_status_history (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  old_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  changed_by INT UNSIGNED,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_status_history_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  CONSTRAINT fk_status_history_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id INT UNSIGNED,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INT UNSIGNED,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_logs_user FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_reports_submitted_by ON reports(submitted_by);
CREATE INDEX idx_reports_barangay ON reports(barangay);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_report_images_report_id ON report_images(report_id);
CREATE INDEX idx_status_history_report_id ON report_status_history(report_id);
CREATE INDEX idx_audit_logs_actor_created ON audit_logs(actor_id, created_at);
CREATE INDEX idx_citizen_identities_user_id ON citizen_identities(user_id);
