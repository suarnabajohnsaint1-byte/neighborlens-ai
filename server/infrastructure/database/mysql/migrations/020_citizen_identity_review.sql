ALTER TABLE users
  MODIFY COLUMN status ENUM('active', 'suspended', 'pending_identity_review') NOT NULL DEFAULT 'active';

ALTER TABLE citizen_identities
  ADD COLUMN location_match_status ENUM('matched', 'needs_review') NOT NULL DEFAULT 'needs_review' AFTER document_validation_status;

CREATE TABLE IF NOT EXISTS citizen_identity_documents (
  user_id INT UNSIGNED PRIMARY KEY,
  mime_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  encrypted_data LONGBLOB NOT NULL,
  iv VARBINARY(12) NOT NULL,
  auth_tag VARBINARY(16) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_citizen_identity_documents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_citizen_identity_documents_mime_type CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_citizen_identity_documents_created_at ON citizen_identity_documents(created_at);
