ALTER TABLE reports
  ADD COLUMN gps_fix_at BIGINT UNSIGNED NULL,
  ADD UNIQUE INDEX uq_reports_citizen_gps_fix (submitted_by, gps_fix_at);
