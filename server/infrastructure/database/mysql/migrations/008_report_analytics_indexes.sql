CREATE INDEX idx_reports_created_at ON reports(created_at);
CREATE INDEX idx_status_history_resolution ON report_status_history(new_status, report_id, created_at);
