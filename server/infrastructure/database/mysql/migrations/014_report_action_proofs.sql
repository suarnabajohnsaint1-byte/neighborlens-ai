ALTER TABLE report_status_history
  ADD COLUMN request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN request_hash CHAR(64) CHARACTER SET ascii NULL,
  ADD UNIQUE KEY uq_report_action_request (report_id, request_key);

CREATE TABLE report_action_proofs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  history_id INT UNSIGNED NOT NULL,
  image_path VARCHAR(1024) NOT NULL,
  image_order INT UNSIGNED NOT NULL,
  mime_type VARCHAR(40) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  CONSTRAINT fk_action_proof_history FOREIGN KEY (history_id) REFERENCES report_status_history(id) ON DELETE CASCADE,
  UNIQUE KEY uq_action_proof_order (history_id, image_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
