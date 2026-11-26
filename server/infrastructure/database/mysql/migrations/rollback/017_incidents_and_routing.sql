CREATE TEMPORARY TABLE migration017_guard (records_present INT NOT NULL CHECK (records_present = 0));
INSERT INTO migration017_guard SELECT
  (SELECT COUNT(*) FROM report_coordination_events) +
  (SELECT COUNT(*) FROM report_incident_members) +
  (SELECT COUNT(*) FROM report_routing_versions) +
  (SELECT COUNT(*) FROM community_post_aliases) +
  (SELECT COUNT(*) FROM report_incidents) +
  (SELECT COUNT(*) FROM community_publication_requests WHERE discussion_post_id IS NOT NULL) +
  (SELECT COUNT(*) FROM user_permissions WHERE permission = 'report:assign-jurisdiction');
DROP TEMPORARY TABLE migration017_guard;
ALTER TABLE user_permissions DROP CHECK chk_user_permissions_name;
DELETE FROM user_permissions WHERE permission = 'report:assign-jurisdiction';
ALTER TABLE user_permissions ADD CONSTRAINT chk_user_permissions_name CHECK (permission IN ('admin:create'));
ALTER TABLE community_publication_requests DROP FOREIGN KEY fk_publication_discussion;
ALTER TABLE community_publication_requests DROP COLUMN discussion_post_id;
DROP TABLE community_post_aliases;
DROP TABLE report_coordination_events;
DROP TABLE report_routing_versions;
DROP TABLE report_incident_members;
DROP TABLE report_incidents;
DROP TABLE report_incident_lock;
