-- scripts/059-t30-contract-freight-intake_rollback.sql
BEGIN;
ALTER TABLE exceptions DROP COLUMN IF EXISTS inbound_email_id;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS booked_via;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS source_type;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_status;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS created_pipeline_load_id;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS sender_authorized;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_type;
DROP TABLE IF EXISTS contract_shipper_authorizations;
COMMIT;
