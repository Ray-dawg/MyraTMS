-- ============================================================================
-- 029: Create RLS policies (NOT enabled)
-- ============================================================================
-- Session 2 / Phase M1d — every Cat A table gets two RLS policies:
--   tenant_isolation       — USING (tenant_id = current_setting('app.current_tenant_id')::BIGINT)
--   service_admin_bypass   — USING (current_setting('app.role', true) = 'service_admin')
--
-- IMPORTANT: This migration CREATES the policies but does NOT enable RLS on
-- any table. ENABLE ROW LEVEL SECURITY is deferred to Phase M3, run per
-- RLS_ROLLOUT.md on a per-batch cadence with monitoring.
--
-- Why split CREATE from ENABLE: per ADR-004 §M1d, this lets Phase 2 code
-- deploy and operate normally (writes carrying tenant_id, reads not yet
-- gated) for 24h before RLS becomes authoritative. The policies sit dormant
-- and are activated table-by-table in Phase M3.
--
-- Idempotent: yes (DO blocks check pg_policies before CREATE).
-- Rollback:   029_create_rls_policies_rollback.sql
--
-- DEPENDS ON: 028 must have been applied (tenant_id column exists on every
-- Cat A table that this migration policies).
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Helper: create the two policies on a table, idempotent.
-- (Postgres lacks CREATE POLICY IF NOT EXISTS, so we wrap each call.)
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION install_tenant_rls_policies(p_table TEXT)
RETURNS void AS $$
BEGIN
    -- tenant_isolation
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = p_table
          AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I '
            'FOR ALL '
            'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::BIGINT) '
            'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::BIGINT)',
            p_table
        );
    END IF;

    -- service_admin_bypass
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = p_table
          AND policyname = 'service_admin_bypass'
    ) THEN
        EXECUTE format(
            'CREATE POLICY service_admin_bypass ON public.%I '
            'FOR ALL '
            'USING (current_setting(''app.role'', true) = ''service_admin'') '
            'WITH CHECK (current_setting(''app.role'', true) = ''service_admin'')',
            p_table
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────────────────
-- Install policies on every Cat A table from TENANTING_AUDIT.md §2 + §1
-- (excludes Engine 2 tables per Rule A; those are handled in 030.PENDING).
-- Order doesn't matter; CREATE POLICY is independent per table.
-- ──────────────────────────────────────────────────────────────────────────

-- Tenant-metadata tables (themselves multi-tenant under super-admin scope)
SELECT install_tenant_rls_policies('tenant_subscriptions');
SELECT install_tenant_rls_policies('tenant_users');
SELECT install_tenant_rls_policies('tenant_config');
SELECT install_tenant_rls_policies('tenant_audit_log');
-- NOTE: 'tenants' table itself does NOT get RLS — every authenticated request
-- needs to read its own tenant row at resolution time. Visibility scoped by
-- application-layer joins to tenant_users instead.

-- §A — Identity & invites
SELECT install_tenant_rls_policies('user_invites');
SELECT install_tenant_rls_policies('settings');
-- push_subscriptions: NOT IN PRODUCTION SCHEMA as of 2026-05-01.
-- Add when migration 031 (if/when written) creates the table.

-- §B — Customer & vendor master
SELECT install_tenant_rls_policies('shippers');
SELECT install_tenant_rls_policies('carriers');
SELECT install_tenant_rls_policies('drivers');

-- §C — Operations
SELECT install_tenant_rls_policies('loads');
SELECT install_tenant_rls_policies('invoices');
SELECT install_tenant_rls_policies('documents');
SELECT install_tenant_rls_policies('activity_notes');
SELECT install_tenant_rls_policies('notifications');
SELECT install_tenant_rls_policies('compliance_alerts');
SELECT install_tenant_rls_policies('exceptions');
SELECT install_tenant_rls_policies('location_pings');
SELECT install_tenant_rls_policies('load_events');
SELECT install_tenant_rls_policies('check_calls');
SELECT install_tenant_rls_policies('tracking_tokens');
SELECT install_tenant_rls_policies('delivery_ratings');
SELECT install_tenant_rls_policies('shipper_report_log');

-- §D — Workflow & automation
SELECT install_tenant_rls_policies('workflows');

-- §E — Carrier matching engine
SELECT install_tenant_rls_policies('carrier_equipment');
SELECT install_tenant_rls_policies('carrier_lanes');
SELECT install_tenant_rls_policies('match_results');

-- §F — Quoting engine
SELECT install_tenant_rls_policies('quotes');
SELECT install_tenant_rls_policies('rate_cache');
SELECT install_tenant_rls_policies('quote_corrections');

-- §G — Integrations
SELECT install_tenant_rls_policies('integrations');

-- ──────────────────────────────────────────────────────────────────────────
-- Self-audit
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_applied',
       jsonb_build_object(
         'migration', '029_create_rls_policies',
         'applied_at', NOW(),
         'description', 'Created tenant_isolation + service_admin_bypass policies on 28 Cat A tables. RLS NOT enabled — see RLS_ROLLOUT.md'
       )
FROM tenants WHERE slug = 'myra';

COMMIT;

-- ============================================================================
-- Verification queries (run manually after applying):
--
--   -- Confirm 28 tables × 2 policies each = 56 policy rows
--   SELECT COUNT(*) FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname IN ('tenant_isolation', 'service_admin_bypass');
--   -- Expected: 56
--
--   -- Confirm RLS is NOT yet enabled on any of these tables
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('loads', 'shippers', 'carriers', 'invoices')
--      AND relkind = 'r';
--   -- Expected: relrowsecurity = false on all
--
--   -- Listing policies per table
--   SELECT tablename, policyname, qual
--   FROM pg_policies
--   WHERE schemaname = 'public' AND policyname LIKE 'tenant_%' OR policyname LIKE 'service_%'
--   ORDER BY tablename, policyname;
-- ============================================================================
