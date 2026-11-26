CREATE TABLE IF NOT EXISTS admin_initialization (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  initialized_at DATETIME NULL,
  initialized_by INT UNSIGNED NULL,
  source ENUM('bootstrap', 'legacy') NULL,
  CONSTRAINT chk_admin_initialization_singleton CHECK (id = 1),
  CONSTRAINT fk_admin_initialization_user FOREIGN KEY (initialized_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO admin_initialization (id) VALUES (1)
ON DUPLICATE KEY UPDATE id = 1;

UPDATE admin_initialization
SET initialized_at = CURRENT_TIMESTAMP, source = 'legacy',
    initialized_by = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
WHERE id = 1 AND initialized_at IS NULL
  AND (EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    OR EXISTS (SELECT 1 FROM audit_logs WHERE action IN ('admin_bootstrap', 'admin_create', 'admin_request_approve')));

ALTER TABLE admin_access_requests
  ADD COLUMN pending_username VARCHAR(190) GENERATED ALWAYS AS
    (CASE WHEN status = 'pending' THEN username ELSE NULL END) STORED,
  ADD CONSTRAINT uq_admin_requests_pending_username UNIQUE (pending_username);
