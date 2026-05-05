-- ============================================================================
-- 028: Add tenant_id to TMS-core Category A tables
-- ============================================================================
-- Session 2 / Phase M1b — every transactional table gets tenant_id BIGINT
-- NOT NULL with a default that resolves to the Myra tenant. Existing rows
-- backfill to Myra. Composite indexes added on hot paths. Unique constraints
-- with global scope today become per-tenant where appropriate.
--
-- Engine 2 tables (pipeline_loads, agent_calls, negotiation_briefs,
-- consent_log, dnc_list, shipper_preferences, lane_stats, personas,
-- agent_jobs, compliance_audit) are EXCLUDED per Rule A — see 030.PENDING.
--
-- Idempotent: yes (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- DO blocks gate UNIQUE-constraint changes via information_schema lookups).
-- Rollback:   028_add_tenant_id_rollback.sql
--
-- DEPENDS ON: 027 must have been applied (tenants, tenant_audit_log exist;
-- 'myra' tenant seeded).
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 0. Resolve the Myra tenant id once and stash it in a session GUC for
--    use throughout the migration. Avoids repeating the subquery and lets
--    us fail fast if 027 wasn't applied.
-- ──────────────────────────────────────────────────────────────────────────
DO $bootstrap$
DECLARE
    v_myra_id BIGINT;
BEGIN
    SELECT id INTO v_myra_id FROM tenants WHERE slug = 'myra';
    IF v_myra_id IS NULL THEN
        RAISE EXCEPTION 'Myra tenant not found. Apply 027_multi_tenant_foundation.sql first.';
    END IF;
    -- Set as session GUC; queries below reference current_setting.
    PERFORM set_config('myra_migration.tenant_id', v_myra_id::text, false);
END $bootstrap$;

-- ──────────────────────────────────────────────────────────────────────────
-- Helper macro pattern: every ADD COLUMN uses
--   tenant_id BIGINT NOT NULL DEFAULT current_setting('myra_migration.tenant_id')::bigint
--     REFERENCES tenants(id) ON DELETE RESTRICT
-- ON DELETE RESTRICT prevents accidental tenant deletion from cascading
-- through every table — purge goes through /api/admin/tenants/[id]/purge
-- which explicitly removes child rows first.
-- ──────────────────────────────────────────────────────────────────────────

-- ============================================================================
-- §A — Identity & invites
-- ============================================================================

-- user_invites: per-tenant invitation
ALTER TABLE user_invites
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_user_invites_tenant ON user_invites(tenant_id, status);

-- settings: per-tenant + per-user; semantics shift per Q4 resolution
ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

-- Replace global unique (user_id, settings_key) with per-tenant variant.
-- Old index allowed a global setting (user_id IS NULL) once; now it's per-tenant.
DROP INDEX IF EXISTS idx_settings_user_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_tenant_user_key
    ON settings(tenant_id, COALESCE(user_id, ''), settings_key);

-- push_subscriptions: NOT IN PRODUCTION SCHEMA as of 2026-05-01
-- (migration 013 was apparently never applied). If/when the table is created,
-- a follow-up migration `031_add_tenant_id_to_push_subscriptions.sql` should
-- add the tenant_id column. Discovered during staging apply — see
-- docs/architecture/SESSION_2_SUMMARY.md §3.1.

-- ============================================================================
-- §B — Customer & vendor master
-- ============================================================================

-- shippers
ALTER TABLE shippers
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_shippers_tenant ON shippers(tenant_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_shippers_tenant_rep ON shippers(tenant_id, assigned_rep);

-- carriers — adds composite uniqueness on (tenant_id, mc_number)
ALTER TABLE carriers
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_carriers_tenant ON carriers(tenant_id, performance_score DESC);
-- Per-tenant MC uniqueness (only enforced when mc_number is non-empty)
CREATE UNIQUE INDEX IF NOT EXISTS idx_carriers_tenant_mc
    ON carriers(tenant_id, mc_number) WHERE mc_number IS NOT NULL AND mc_number != '';

-- drivers — per-tenant via carrier; PIN scoping per-tenant
ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_drivers_tenant_status ON drivers(tenant_id, status);

-- ============================================================================
-- §C — Operations
-- ============================================================================

-- loads — single hottest table; multiple composite indexes
ALTER TABLE loads
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_loads_tenant_status   ON loads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_loads_tenant_shipper  ON loads(tenant_id, shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_tenant_carrier  ON loads(tenant_id, carrier_id);
CREATE INDEX IF NOT EXISTS idx_loads_tenant_driver   ON loads(tenant_id, driver_id);
CREATE INDEX IF NOT EXISTS idx_loads_tenant_created  ON loads(tenant_id, created_at DESC);

-- reference_number: was UNIQUE globally, becomes per-tenant
DO $reference_number$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'loads'
          AND indexname = 'loads_reference_number_key'
    ) THEN
        ALTER TABLE loads DROP CONSTRAINT loads_reference_number_key;
    END IF;
END $reference_number$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_loads_tenant_reference
    ON loads(tenant_id, reference_number) WHERE reference_number IS NOT NULL;

-- tracking_token stays GLOBALLY unique (public URL collision space).
-- The existing UNIQUE constraint on loads.tracking_token is preserved.

-- invoices
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON invoices(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_due    ON invoices(tenant_id, due_date);

-- documents
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_related
    ON documents(tenant_id, related_type, related_to);

-- activity_notes
ALTER TABLE activity_notes
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_activity_notes_tenant_entity
    ON activity_notes(tenant_id, entity_type, entity_id);

-- notifications
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_read
    ON notifications(tenant_id, user_id, read);

-- compliance_alerts
ALTER TABLE compliance_alerts
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_tenant
    ON compliance_alerts(tenant_id, carrier_id, resolved);

-- exceptions (NOT in T01 §2 inventory — discovered during staging apply 2026-05-01.
-- Used by /api/exceptions/* routes per T01 §1.7. Per-tenant load/carrier exceptions.)
ALTER TABLE exceptions
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_exceptions_tenant
    ON exceptions(tenant_id, status, severity);

-- location_pings (denormalized tenant_id for query performance)
ALTER TABLE location_pings
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_location_pings_tenant_load_time
    ON location_pings(tenant_id, load_id, recorded_at DESC);

-- load_events (denormalized)
ALTER TABLE load_events
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_load_events_tenant_load_time
    ON load_events(tenant_id, load_id, created_at DESC);

-- check_calls (denormalized)
ALTER TABLE check_calls
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_check_calls_tenant_next
    ON check_calls(tenant_id, next_check_call) WHERE next_check_call IS NOT NULL;

-- tracking_tokens (token stays globally unique; tenant_id added for RLS)
ALTER TABLE tracking_tokens
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tracking_tokens_tenant
    ON tracking_tokens(tenant_id, load_id);

-- delivery_ratings (token_hash stays globally unique)
ALTER TABLE delivery_ratings
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_delivery_ratings_tenant_load
    ON delivery_ratings(tenant_id, load_id);

-- shipper_report_log — UNIQUE expands from 3-col to 4-col
ALTER TABLE shipper_report_log
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

DO $shipper_report_unique$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shipper_report_log_shipper_id_period_year_period_month_key'
    ) THEN
        ALTER TABLE shipper_report_log
            DROP CONSTRAINT shipper_report_log_shipper_id_period_year_period_month_key;
    END IF;
END $shipper_report_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipper_report_log_tenant_unique
    ON shipper_report_log(tenant_id, shipper_id, period_year, period_month);

-- ============================================================================
-- §D — Workflow & automation
-- ============================================================================

ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, active, trigger_type);

-- ============================================================================
-- §E — Carrier matching engine
-- ============================================================================

ALTER TABLE carrier_equipment
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS idx_carrier_equip_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_equip_tenant_unique
    ON carrier_equipment(tenant_id, carrier_id, equipment_type);

ALTER TABLE carrier_lanes
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS idx_carrier_lane_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_lane_tenant_unique
    ON carrier_lanes(tenant_id, carrier_id, origin_region, dest_region, equipment_type);

CREATE INDEX IF NOT EXISTS idx_carrier_lane_tenant_region
    ON carrier_lanes(tenant_id, origin_region, dest_region);

ALTER TABLE match_results
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_match_results_tenant_load_score
    ON match_results(tenant_id, load_id, match_score DESC);

-- ============================================================================
-- §F — Quoting engine
-- ============================================================================

ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_status  ON quotes(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_tenant_shipper ON quotes(tenant_id, shipper_id);

-- quotes.reference: was global UNIQUE, becomes per-tenant
DO $quote_reference$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'quotes_reference_key'
    ) THEN
        ALTER TABLE quotes DROP CONSTRAINT quotes_reference_key;
    END IF;
END $quote_reference$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_tenant_reference
    ON quotes(tenant_id, reference);

-- rate_cache (per-tenant for now; cross-tenant aggregate is later work)
ALTER TABLE rate_cache
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_rate_cache_tenant_lane
    ON rate_cache(tenant_id, origin_region, dest_region, equipment_type, expires_at);

-- quote_corrections
ALTER TABLE quote_corrections
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

DO $quote_corrections_unique$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname LIKE 'quote_corrections%' AND contype = 'u'
    ) THEN
        ALTER TABLE quote_corrections
            DROP CONSTRAINT IF EXISTS quote_corrections_source_origin_region_dest_region_equipme_key;
    END IF;
END $quote_corrections_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_corrections_tenant_unique
    ON quote_corrections(tenant_id, source, origin_region, dest_region, equipment_type);

-- ============================================================================
-- §G — Integrations
-- ============================================================================

-- integrations: provider becomes per-tenant
ALTER TABLE integrations
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL
        DEFAULT current_setting('myra_migration.tenant_id')::bigint
        REFERENCES tenants(id) ON DELETE RESTRICT;

DO $integrations_unique$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'integrations_provider_key'
    ) THEN
        ALTER TABLE integrations DROP CONSTRAINT integrations_provider_key;
    END IF;
END $integrations_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_tenant_provider
    ON integrations(tenant_id, provider);

-- ============================================================================
-- §H — Verification + audit
-- ============================================================================

-- Self-audit
INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_applied',
       jsonb_build_object(
         'migration', '028_add_tenant_id',
         'applied_at', NOW(),
         'description', 'Added tenant_id to 24 Cat A tables; backfilled to Myra; composite indexes + uniqueness changes'
       )
FROM tenants WHERE slug = 'myra';

COMMIT;

-- ============================================================================
-- Verification queries (run manually after applying):
--
--   -- Confirm every Cat A table has tenant_id NOT NULL DEFAULT
--   SELECT table_name, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND column_name = 'tenant_id'
--   ORDER BY table_name;
--
--   -- Confirm Myra-tenant backfill (every existing row has tenant_id = myra.id)
--   SELECT 'shippers' AS t, COUNT(*) FROM shippers WHERE tenant_id IS NULL
--   UNION ALL SELECT 'carriers', COUNT(*) FROM carriers WHERE tenant_id IS NULL
--   UNION ALL SELECT 'loads',    COUNT(*) FROM loads    WHERE tenant_id IS NULL
--   ;  -- All should return 0
--
--   -- Confirm Engine 2 tables NOT touched
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'pipeline_loads' AND column_name = 'tenant_id';
--   -- Expected: 0 rows (Phase M5 deferred)
-- ============================================================================
