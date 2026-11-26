ALTER TABLE users
  ADD COLUMN residency_confirmed_at DATETIME(3) NULL,
  ADD COLUMN residency_city_version VARCHAR(255) NULL,
  ADD COLUMN residency_barangay_version VARCHAR(255) NULL;
