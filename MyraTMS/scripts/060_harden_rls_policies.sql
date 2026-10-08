-- ============================================================================
-- 060: Harden RLS policies before Phase M3 enable (NULLIF on the GUC)
-- ============================================================================
-- Found 2026-10-07 during the M3 pre-flight on the dev-tests branch:
--
--   current_setting('app.current_tenant_id', true) returns '' (NOT NULL) on a
--   pooled connection after any earlier transaction did SET LOCAL on it.
--   029's policy casts that straight to BIGINT, so with RLS enabled every
--   query on a reused connection that has NO tenant context fails with
--     "invalid input syntax for type bigint: """
--   instead of returning zero rows. asServiceAdmin() connections are exactly
--   that case (they set app.role, never app.current_tenant_id).
--
-- Fix: NULLIF(current_setting(...), '')::BIGINT — NULL compares false, so a
-- context-less query returns zero rows (fail-closed, as designed) and the
-- service_admin_bypass policy still OR's in correctly.
--
-- This migration is safe to apply while RLS is still OFF: policies are inert
-- until ENABLE ROW LEVEL SECURITY. It must be applied BEFORE the first
-- production enable in RLS_ROLLOUT.md.
--
-- Idempotent: yes (DROP POLICY IF EXISTS + CREATE).
-- Rollback:   060_harden_rls_policies_rollback.sql (restores 029's shape).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION install_tenant_rls_policies(p_table TEXT)
RETURNS void AS $$
BEGIN
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', p_table);
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I '
        'FOR ALL '
        'USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::BIGINT) '
        'WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::BIGINT)',
        p_table
    );

    EXECUTE format('DROP POLICY IF EXISTS service_admin_bypass ON public.%I', p_table);
    EXECUTE format(
        'CREATE POLICY service_admin_bypass ON public.%I '
        'FOR ALL '
        'USING (current_setting(''app.role'', true) = ''service_admin'') '
        'WITH CHECK (current_setting(''app.role'', true) = ''service_admin'')',
        p_table
    );
END;
$$ LANGUAGE plpgsql;

-- Re-install on every table that currently carries the 029 policies.
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN
        SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname IN ('tenant_isolation', 'service_admin_bypass')
    LOOP
        PERFORM install_tenant_rls_policies(t);
    END LOOP;
END $$;

INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_applied',
       jsonb_build_object(
         'migration', '060_harden_rls_policies',
         'applied_at', NOW(),
         'description', 'Recreated tenant_isolation policies with NULLIF() guard on app.current_tenant_id. RLS still NOT enabled.'
       )
FROM tenants WHERE slug = 'myra';

COMMIT;

-- Verify:
--   SELECT tablename, qual FROM pg_policies
--    WHERE policyname = 'tenant_isolation' AND qual NOT ILIKE '%NULLIF%';
--   -- Expected: 0 rows
