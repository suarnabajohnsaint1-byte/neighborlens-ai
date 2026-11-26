CREATE TABLE IF NOT EXISTS report_feedback_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id INT UNSIGNED NOT NULL,
  sender_id INT UNSIGNED NOT NULL,
  message TEXT NOT NULL,
  action_type ENUM('action_required', 'clarification', 'status_update', 'information') NOT NULL DEFAULT 'information',
  requires_immediate_action TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_feedback_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_feedback_report_created (report_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_feedback_reads (
  message_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id),
  CONSTRAINT fk_feedback_read_message FOREIGN KEY (message_id) REFERENCES report_feedback_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;