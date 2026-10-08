-- scripts/059-t30-contract-freight-intake_rollback.sql
BEGIN;
DELETE FROM exception_classification_rules WHERE source_module = 'contract_intake';
ALTER TABLE exceptions DROP COLUMN IF EXISTS inbound_email_id;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS booked_via;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS source_type;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_status;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS created_pipeline_load_id;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS sender_authorized;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_type;
-- Dropped explicitly ahead of the table for symmetry with 059, even though
-- DROP TABLE would take it: the invariant it enforces (one ACTIVE shipper
-- authorization per email address, so one email maps to at most one tenant)
-- is what lets checkSenderAuthorization() safely read without a tenant filter.
DROP INDEX IF EXISTS uq_contract_shipper_auth_active_email;
DROP TABLE IF EXISTS contract_shipper_authorizations;
COMMIT;
