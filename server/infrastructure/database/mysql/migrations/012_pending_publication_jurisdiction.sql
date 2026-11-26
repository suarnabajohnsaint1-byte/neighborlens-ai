ALTER TABLE community_publication_requests MODIFY barangay_id INT UNSIGNED NULL;
ALTER TABLE reports MODIFY jurisdiction_source ENUM('citizen_declared', 'geofence_resolved', 'admin_assigned') NOT NULL DEFAULT 'citizen_declared';
