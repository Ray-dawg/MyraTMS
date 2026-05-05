-- ============================================================================
-- 029 ROLLBACK: Drop RLS policies
-- ============================================================================
-- Reverses 029_create_rls_policies.sql.
--
-- SAFE TO RUN at any time. Dropping policies does NOT affect data.
--
-- If RLS has been ENABLED on any table (Phase M3), it is also DISABLED
-- here so the application can keep operating without the dropped policies.
--
-- Idempotent: yes (DROP POLICY IF EXISTS, ALTER TABLE DISABLE ROW LEVEL SECURITY).
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Helper: drop both policies and disable RLS on a table, idempotent.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION uninstall_tenant_rls_policies(p_table TEXT)
RETURNS void AS $$
BEGIN
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', p_table);
    EXECUTE format('DROP POLICY IF EXISTS service_admin_bypass ON public.%I', p_table);
    -- Disable RLS too — if we're rolling back, we don't want enforcement to
    -- linger and lock the application out.
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', p_table);
END;
$$ LANGUAGE plpgsql;

-- Same table list as 029
SELECT uninstall_tenant_rls_policies('tenant_subscriptions');
SELECT uninstall_tenant_rls_policies('tenant_users');
SELECT uninstall_tenant_rls_policies('tenant_config');
SELECT uninstall_tenant_rls_policies('tenant_audit_log');
SELECT uninstall_tenant_rls_policies('user_invites');
SELECT uninstall_tenant_rls_policies('settings');
SELECT uninstall_tenant_rls_policies('push_subscriptions');
SELECT uninstall_tenant_rls_policies('shippers');
SELECT uninstall_tenant_rls_policies('carriers');
SELECT uninstall_tenant_rls_policies('drivers');
SELECT uninstall_tenant_rls_policies('loads');
SELECT uninstall_tenant_rls_policies('invoices');
SELECT uninstall_tenant_rls_policies('documents');
SELECT uninstall_tenant_rls_policies('activity_notes');
SELECT uninstall_tenant_rls_policies('notifications');
SELECT uninstall_tenant_rls_policies('compliance_alerts');
SELECT uninstall_tenant_rls_policies('location_pings');
SELECT uninstall_tenant_rls_policies('load_events');
SELECT uninstall_tenant_rls_policies('check_calls');
SELECT uninstall_tenant_rls_policies('tracking_tokens');
SELECT uninstall_tenant_rls_policies('delivery_ratings');
SELECT uninstall_tenant_rls_policies('shipper_report_log');
SELECT uninstall_tenant_rls_policies('workflows');
SELECT uninstall_tenant_rls_policies('carrier_equipment');
SELECT uninstall_tenant_rls_policies('carrier_lanes');
SELECT uninstall_tenant_rls_policies('match_results');
SELECT uninstall_tenant_rls_policies('quotes');
SELECT uninstall_tenant_rls_policies('rate_cache');
SELECT uninstall_tenant_rls_policies('quote_corrections');
SELECT uninstall_tenant_rls_policies('integrations');

-- Drop helper functions (no longer needed once policies are gone)
DROP FUNCTION IF EXISTS install_tenant_rls_policies(TEXT);
DROP FUNCTION IF EXISTS uninstall_tenant_rls_policies(TEXT);

COMMIT;

-- ============================================================================
-- Verification (run manually after rollback):
--   SELECT COUNT(*) FROM pg_policies
--    WHERE policyname IN ('tenant_isolation', 'service_admin_bypass');
--   -- Expected: 0
--
--   SELECT relname FROM pg_class
--    WHERE relkind = 'r' AND relrowsecurity = true
--      AND relname IN ('loads', 'shippers', 'carriers', 'invoices');
--   -- Expected: 0 rows (RLS disabled everywhere)
-- ============================================================================
