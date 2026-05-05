-- ============================================================================
-- 028 ROLLBACK: Remove tenant_id from TMS-core Category A tables
-- ============================================================================
-- Reverses 028_add_tenant_id.sql.
--
-- SAFE TO RUN if 029 (RLS policies) has not been applied OR has been rolled
-- back first. RLS policies reference the tenant_id column; dropping the
-- column with policies in place would fail.
--
-- This rollback also restores the original UNIQUE constraints that 028
-- replaced with composite-tenant variants.
--
-- Idempotent: yes (DROP IF EXISTS, conditional restoration of old constraints).
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Safety assertion: refuse to run if RLS policies still reference tenant_id
-- ──────────────────────────────────────────────────────────────────────────
DO $assert$
DECLARE
    v_policies INT;
BEGIN
    SELECT COUNT(*) INTO v_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('tenant_isolation', 'service_admin_bypass');
    IF v_policies > 0 THEN
        RAISE EXCEPTION 'Refusing to roll back 028: % RLS policies reference tenant_id. Roll back 029 first.', v_policies;
    END IF;
END $assert$;

-- ──────────────────────────────────────────────────────────────────────────
-- Drop composite indexes added by 028 (CREATE INDEX IF NOT EXISTS pattern)
-- ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_user_invites_tenant;
DROP INDEX IF EXISTS idx_settings_tenant_user_key;
DROP INDEX IF EXISTS idx_push_subs_tenant;
DROP INDEX IF EXISTS idx_shippers_tenant;
DROP INDEX IF EXISTS idx_shippers_tenant_rep;
DROP INDEX IF EXISTS idx_carriers_tenant;
DROP INDEX IF EXISTS idx_carriers_tenant_mc;
DROP INDEX IF EXISTS idx_drivers_tenant_status;
DROP INDEX IF EXISTS idx_loads_tenant_status;
DROP INDEX IF EXISTS idx_loads_tenant_shipper;
DROP INDEX IF EXISTS idx_loads_tenant_carrier;
DROP INDEX IF EXISTS idx_loads_tenant_driver;
DROP INDEX IF EXISTS idx_loads_tenant_created;
DROP INDEX IF EXISTS idx_loads_tenant_reference;
DROP INDEX IF EXISTS idx_invoices_tenant_status;
DROP INDEX IF EXISTS idx_invoices_tenant_due;
DROP INDEX IF EXISTS idx_documents_tenant_related;
DROP INDEX IF EXISTS idx_activity_notes_tenant_entity;
DROP INDEX IF EXISTS idx_notifications_tenant_user_read;
DROP INDEX IF EXISTS idx_compliance_alerts_tenant;
DROP INDEX IF EXISTS idx_location_pings_tenant_load_time;
DROP INDEX IF EXISTS idx_load_events_tenant_load_time;
DROP INDEX IF EXISTS idx_check_calls_tenant_next;
DROP INDEX IF EXISTS idx_tracking_tokens_tenant;
DROP INDEX IF EXISTS idx_delivery_ratings_tenant_load;
DROP INDEX IF EXISTS idx_shipper_report_log_tenant_unique;
DROP INDEX IF EXISTS idx_workflows_tenant;
DROP INDEX IF EXISTS idx_carrier_equip_tenant_unique;
DROP INDEX IF EXISTS idx_carrier_lane_tenant_unique;
DROP INDEX IF EXISTS idx_carrier_lane_tenant_region;
DROP INDEX IF EXISTS idx_match_results_tenant_load_score;
DROP INDEX IF EXISTS idx_quotes_tenant_status;
DROP INDEX IF EXISTS idx_quotes_tenant_shipper;
DROP INDEX IF EXISTS idx_quotes_tenant_reference;
DROP INDEX IF EXISTS idx_rate_cache_tenant_lane;
DROP INDEX IF EXISTS idx_quote_corrections_tenant_unique;
DROP INDEX IF EXISTS idx_integrations_tenant_provider;

-- ──────────────────────────────────────────────────────────────────────────
-- Restore original UNIQUE constraints that 028 dropped
-- ──────────────────────────────────────────────────────────────────────────

-- settings: restore (user_id, settings_key) UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key
    ON settings(user_id, settings_key);

-- carrier_equipment: restore (carrier_id, equipment_type) UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_equip_unique
    ON carrier_equipment(carrier_id, equipment_type);

-- carrier_lanes: restore (carrier_id, origin_region, dest_region, equipment_type) UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_lane_unique
    ON carrier_lanes(carrier_id, origin_region, dest_region, equipment_type);

-- loads: restore reference_number UNIQUE
DO $restore_loads$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'loads_reference_number_key'
    ) THEN
        ALTER TABLE loads ADD CONSTRAINT loads_reference_number_key UNIQUE (reference_number);
    END IF;
END $restore_loads$;

-- shipper_report_log: restore (shipper_id, period_year, period_month) UNIQUE
DO $restore_shipper_report$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shipper_report_log_shipper_id_period_year_period_month_key'
    ) THEN
        ALTER TABLE shipper_report_log
            ADD CONSTRAINT shipper_report_log_shipper_id_period_year_period_month_key
            UNIQUE (shipper_id, period_year, period_month);
    END IF;
END $restore_shipper_report$;

-- quotes: restore reference UNIQUE
DO $restore_quotes$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'quotes_reference_key'
    ) THEN
        ALTER TABLE quotes ADD CONSTRAINT quotes_reference_key UNIQUE (reference);
    END IF;
END $restore_quotes$;

-- integrations: restore provider UNIQUE
DO $restore_integrations$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'integrations_provider_key'
    ) THEN
        ALTER TABLE integrations ADD CONSTRAINT integrations_provider_key UNIQUE (provider);
    END IF;
END $restore_integrations$;

-- ──────────────────────────────────────────────────────────────────────────
-- Drop tenant_id columns (DROP IF EXISTS for idempotency)
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE user_invites       DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE settings           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE shippers           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE carriers           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE drivers            DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE loads              DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE invoices           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE documents          DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE activity_notes     DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE notifications      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE compliance_alerts  DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE location_pings     DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE load_events        DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE check_calls        DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE tracking_tokens    DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE delivery_ratings   DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE shipper_report_log DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE workflows          DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE carrier_equipment  DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE carrier_lanes      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE match_results      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE quotes             DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE rate_cache         DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE quote_corrections  DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE integrations       DROP COLUMN IF EXISTS tenant_id;

COMMIT;

-- ============================================================================
-- Verification (run manually after rollback):
--   SELECT COUNT(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND column_name = 'tenant_id'
--      AND table_name NOT IN ('tenants', 'tenant_subscriptions', 'tenant_users',
--                             'tenant_config', 'tenant_audit_log');
-- Expected: 0
-- ============================================================================
