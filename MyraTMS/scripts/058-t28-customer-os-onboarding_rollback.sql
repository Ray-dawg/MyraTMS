-- ============================================================================
-- 058 Rollback: T-28 Customer OS & Onboarding
-- ============================================================================

BEGIN;

-- Remove the tenant_onboarding source_module row from exception_classification_rules
DELETE FROM exception_classification_rules
WHERE source_module = 'tenant_onboarding';

-- Drop the tenant_onboarding_sessions table
DROP TABLE IF EXISTS tenant_onboarding_sessions;

COMMIT;
