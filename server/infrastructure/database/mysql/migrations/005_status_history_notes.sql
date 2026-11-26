ALTER TABLE report_status_history ADD COLUMN note VARCHAR(500) NULL AFTER changed_by;

CREATE INDEX idx_reports_barangay_status ON reports(barangay_id, status);
