CREATE TABLE IF NOT EXISTS citizen_enrollment_keys (
  verification_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  CONSTRAINT fk_enrollment_key_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
