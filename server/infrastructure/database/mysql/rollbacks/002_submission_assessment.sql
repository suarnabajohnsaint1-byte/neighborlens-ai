ALTER TABLE reports DROP COLUMN submission_assessment;
DELETE FROM schema_migrations WHERE filename = '002_submission_assessment.sql';
