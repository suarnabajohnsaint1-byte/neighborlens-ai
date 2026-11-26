CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INT UNSIGNED NOT NULL,
  permission VARCHAR(50) NOT NULL,
  granted_by INT UNSIGNED NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, permission),
  CONSTRAINT fk_user_permissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_permissions_granted_by FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_user_permissions_name CHECK (permission IN ('admin:create'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users ADD COLUMN account_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER token_version;

INSERT INTO user_permissions (user_id, permission, granted_by)
  SELECT first_admin.id, 'admin:create', NULL
  FROM (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1) AS first_admin
  WHERE NOT EXISTS (SELECT 1 FROM user_permissions WHERE permission = 'admin:create');
