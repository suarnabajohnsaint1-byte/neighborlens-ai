-- Export proof references/history and archive private media before rollback.
-- Deploy the previous application only after writes have been paused.
DROP TABLE report_action_proofs;
ALTER TABLE report_status_history DROP INDEX uq_report_action_request,
  DROP COLUMN request_hash, DROP COLUMN request_key;
