CREATE TABLE IF NOT EXISTS admin_access_requests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(190) NOT NULL,
  full_name VARCHAR(190) NULL,
  password_hash VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  reviewed_by INT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_user_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_requests_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_admin_requests_user FOREIGN KEY (created_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_admin_requests_status_created ON admin_access_requests(status, created_at);
CREATE INDEX idx_admin_requests_username ON admin_access_requests(username);
