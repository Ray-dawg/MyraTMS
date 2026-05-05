-- ============================================================================
-- 027 ROLLBACK: Multi-Tenant Foundation Tables
-- ============================================================================
-- Reverses 027_multi_tenant_foundation.sql.
--
-- SAFE TO RUN if 028 has NOT been applied (no FK dependents from existing
-- TMS tables yet). Refuses to run otherwise via the assertion below.
--
-- Idempotent: yes (DROP IF EXISTS / CASCADE).
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Safety assertion: refuse to run if migration 028 has added tenant_id columns
-- to any TMS-core table. Rolling back foundation while existing tables still
-- have tenant_id columns and FK references would orphan those FKs.
-- ──────────────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
    v_dependents INT;
BEGIN
    SELECT COUNT(*) INTO v_dependents
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'tenant_id'
      AND table_name NOT IN (
          'tenants', 'tenant_subscriptions', 'tenant_users',
          'tenant_config', 'tenant_audit_log'
      );

    IF v_dependents > 0 THEN
        RAISE EXCEPTION 'Refusing to roll back 027: % TMS-core tables still have tenant_id columns. Roll back 028 first.', v_dependents;
    END IF;
END $assert$;

-- ──────────────────────────────────────────────────────────────────────────
-- Drop triggers (must drop before dropping tables, though CASCADE would also)
-- ──────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tenants_updated_at_trg ON tenants;
DROP TRIGGER IF EXISTS tenant_subscriptions_updated_at_trg ON tenant_subscriptions;
DROP TRIGGER IF EXISTS tenant_config_updated_at_trg ON tenant_config;

-- Drop the trigger function (safe — used only by the tables we're dropping)
DROP FUNCTION IF EXISTS tenant_set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Drop tables in dependency order (children before parents)
-- ──────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS tenant_audit_log    CASCADE;
DROP TABLE IF EXISTS tenant_config       CASCADE;
DROP TABLE IF EXISTS tenant_users        CASCADE;
DROP TABLE IF EXISTS tenant_subscriptions CASCADE;
DROP TABLE IF EXISTS tenants             CASCADE;

COMMIT;

-- ============================================================================
-- Verification (run manually after rollback):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name LIKE 'tenant%';
-- Expected: 0 rows.
-- ============================================================================
