CREATE TABLE report_incident_lock (
  id INTEGER PRIMARY KEY
);
INSERT INTO report_incident_lock (id) VALUES (1);
CREATE TABLE report_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_report_id INTEGER NOT NULL UNIQUE,
  canonical_post_id INTEGER NULL,
  barangay_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (canonical_report_id) REFERENCES reports(id),
  FOREIGN KEY (canonical_post_id) REFERENCES community_posts(id),
  FOREIGN KEY (barangay_id) REFERENCES barangays(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE report_incident_members (
  report_id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (incident_id) REFERENCES report_incidents(id)
);
CREATE TABLE report_routing_versions (
  report_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (report_id) REFERENCES reports(id)
);
CREATE TABLE report_coordination_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  actor_id INTEGER NULL,
  kind VARCHAR(30) NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (report_id, request_key)
);
CREATE TABLE community_post_aliases (
  post_id INTEGER PRIMARY KEY,
  canonical_post_id INTEGER NOT NULL,
  incident_id INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES community_posts(id),
  FOREIGN KEY (canonical_post_id) REFERENCES community_posts(id),
  FOREIGN KEY (incident_id) REFERENCES report_incidents(id),
  CHECK (post_id <> canonical_post_id)
);
