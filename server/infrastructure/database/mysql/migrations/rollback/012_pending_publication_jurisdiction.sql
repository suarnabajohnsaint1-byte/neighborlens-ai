CREATE TEMPORARY TABLE migration012_guard (valid INT CHECK (valid = 1));
INSERT INTO migration012_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM community_publication_requests WHERE barangay_id IS NULL) OR EXISTS (SELECT 1 FROM reports WHERE jurisdiction_source = 'admin_assigned') THEN 0 ELSE 1 END;
DROP TEMPORARY TABLE migration012_guard;
ALTER TABLE community_publication_requests MODIFY barangay_id INT UNSIGNED NOT NULL;
ALTER TABLE reports MODIFY jurisdiction_source ENUM('citizen_declared', 'geofence_resolved') NOT NULL DEFAULT 'citizen_declared';
