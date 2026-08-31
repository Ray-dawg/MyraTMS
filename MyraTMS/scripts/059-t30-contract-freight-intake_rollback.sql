-- ============================================================================
-- 059 ROLLBACK: T-30 CONTRACT FREIGHT INTAKE
-- Reverses migration 059-t30-contract-freight-intake.sql
-- ============================================================================

BEGIN;

-- Drop indexes on inbound_emails
DROP INDEX IF EXISTS idx_inbound_emails_intake_status;

-- Drop columns added to inbound_emails
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_type CASCADE;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS sender_authorized CASCADE;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS created_pipeline_load_id CASCADE;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_status CASCADE;

-- Drop indexes on contract_shipper_authorizations
DROP INDEX IF EXISTS idx_contract_shipper_auth_active;
DROP INDEX IF EXISTS idx_contract_shipper_auth_email;
DROP INDEX IF EXISTS idx_contract_shipper_auth_tenant;

-- Drop contract_shipper_authorizations table
DROP TABLE IF EXISTS contract_shipper_authorizations CASCADE;

COMMIT;
