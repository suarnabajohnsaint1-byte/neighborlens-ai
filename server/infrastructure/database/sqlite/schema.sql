CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('citizen', 'admin', 'barangay')),
  barangay TEXT NOT NULL,
  barangay_id INTEGER REFERENCES barangays(id) ON DELETE RESTRICT,
  full_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  enrollment_tier TEXT NOT NULL DEFAULT 'LEGACY' CHECK (enrollment_tier IN ('LEGACY', 'ACTIVE_LIMITED', 'FULLY_VERIFIED')),
  residency_confirmed_at DATETIME,
  residency_city_version TEXT,
  residency_barangay_version TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  account_version INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (role <> 'barangay' OR barangay_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS barangays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  city TEXT NOT NULL DEFAULT 'Bacolod City',
  province TEXT NOT NULL DEFAULT 'Negros Occidental',
  region TEXT NOT NULL DEFAULT 'Negros Island Region (NIR)',
  boundary_source TEXT,
  boundary_version TEXT,
  boundary_geojson TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS citizen_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  document_type TEXT,
  id_number TEXT,
  full_name TEXT,
  birth_date TEXT,
  address TEXT,
  expiry_date TEXT,
  ocr_confidence REAL,
  format_check_status TEXT,
  document_validation_status TEXT,
  is_expired INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS citizen_enrollment_keys (
  verification_key TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_citizen_enrollment_user ON citizen_enrollment_keys(user_id);

CREATE TABLE IF NOT EXISTS citizen_enrollment_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  token_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  boundary_version TEXT NOT NULL,
  screening TEXT NOT NULL,
  frame_keys TEXT NOT NULL,
  facts_key TEXT,
  subject_key TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollment_review_queue ON citizen_enrollment_reviews(state, expires_at, id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  location TEXT,
  barangay TEXT NOT NULL,
  barangay_id INTEGER,
  jurisdiction_source TEXT NOT NULL DEFAULT 'citizen_declared' CHECK (jurisdiction_source IN ('citizen_declared', 'geofence_resolved', 'admin_assigned')),
  boundary_check_status TEXT NOT NULL DEFAULT 'service_area_unknown' CHECK (boundary_check_status IN ('inside_service_area', 'outside_service_area', 'service_area_unknown')),
  latitude REAL,
  longitude REAL,
  gps_accuracy REAL,
  gps_fix_at INTEGER,
  image_path TEXT,
  ai_category TEXT DEFAULT 'Infrastructure',
  ai_classification TEXT DEFAULT 'MINOR',
  ai_priority TEXT DEFAULT 'Low',
  ai_confidence REAL DEFAULT 0,
  vision_detected INTEGER DEFAULT 0,
  submission_assessment TEXT CHECK (submission_assessment IS NULL OR json_valid(submission_assessment)),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ongoing', 'resolved', 'rejected')),
  submitted_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submitted_by) REFERENCES users(id),
  FOREIGN KEY (barangay_id) REFERENCES barangays(id)
);

CREATE TABLE IF NOT EXISTS report_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  image_order INTEGER NOT NULL CHECK (image_order IN (1, 2)),
  file_size INTEGER,
  mime_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, image_order)
);

CREATE TABLE IF NOT EXISTS damage_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  is_valid_match INTEGER NOT NULL,
  composite_similarity_score REAL NOT NULL,
  embedding_similarity REAL NOT NULL,
  homography_inlier_ratio REAL NOT NULL,
  perspective_aligned INTEGER NOT NULL,
  matched_damage_type TEXT,
  highest_severity TEXT,
  model TEXT NOT NULL,
  raw_payload TEXT,
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by INTEGER,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_submitted_by ON reports(submitted_by);
CREATE INDEX IF NOT EXISTS idx_reports_barangay ON reports(barangay);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_report_images_report_id ON report_images(report_id);
CREATE INDEX IF NOT EXISTS idx_status_history_report_id ON report_status_history(report_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_citizen_identities_user_id ON citizen_identities(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_report_id ON notifications(report_id);


CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('admin:create', 'report:assign-jurisdiction')),
  granted_by INTEGER,
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admin_access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at DATETIME,
  created_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_requests_pending_username ON admin_access_requests(username COLLATE NOCASE) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_status_history_resolution ON report_status_history(new_status, report_id, created_at);

CREATE TABLE IF NOT EXISTS report_coordination_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  sender_id INTEGER NULL,
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (report_id, sender_id, request_key)
);

CREATE TABLE IF NOT EXISTS report_coordination_reads (
  report_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, user_id),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_severity_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  reviewed_by INTEGER NULL,
  category TEXT NOT NULL,
  classification TEXT NULL,
  priority TEXT NULL,
  previous_classification TEXT NULL,
  previous_priority TEXT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  policy_version TEXT NOT NULL,
  recommendation TEXT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (report_id, request_key)
);
