CREATE TABLE IF NOT EXISTS community_publication_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL UNIQUE REFERENCES reports(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  barangay_id INTEGER REFERENCES barangays(id),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval', 'approved', 'rejected')),
  body TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  assigned_admin_id INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  rejection_reason TEXT,
  post_id INTEGER UNIQUE REFERENCES community_posts(id),
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 1,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  UNIQUE(requested_by, request_key)
);
CREATE TABLE IF NOT EXISTS community_publication_media (
  request_id INTEGER NOT NULL REFERENCES community_publication_requests(id),
  image_order INTEGER NOT NULL,
  storage_reference TEXT NOT NULL,
  PRIMARY KEY(request_id, image_order)
);
CREATE TABLE IF NOT EXISTS community_publication_legacy (
  post_id INTEGER PRIMARY KEY REFERENCES community_posts(id),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS community_publication_reviews (
  request_id INTEGER NOT NULL REFERENCES community_publication_requests(id),
  version INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT,
  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, version)
);
