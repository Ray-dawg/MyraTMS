-- ============================================================================
-- 053 — T-23 DISPATCH & LOAD LIFECYCLE MONITOR
-- ============================================================================
-- Engine 3 Phase 2, Module 4. See Engine 3/T23_Dispatch_Lifecycle_Monitor.md.
--
-- Schema-reality corrections vs. the base spec (same discipline as
-- 035/044/045/052 — see the implementation plan's Global Constraints
-- (docs/superpowers/plans/2026-08-28-t23-dispatch-lifecycle-monitor.md)
-- for the full reasoning, not repeated here):
--   1. Carrier acceptance already has a real (if narrower-than-assumed)
--      confirmation signal for AI-cascade loads: loads.carrier_signature_
--      received_at/_method/_confirmed_by (049/051), gated by
--      lib/dispatch-gate.ts. carrier_acceptance_state reports the real
--      split instead of assuming 100% unconfirmed.
--   2. events.entity_id/derived_from_id are INTEGER; loads.id is TEXT. Every
--      trigger below deriving from `loads` is scoped to pipeline-linked
--      loads (WHEN NEW.pipeline_load_id IS NOT NULL) and uses
--      NEW.pipeline_load_id for entity_id/derived_from_id/pipeline_load_id
--      alike -- NOT loads.id. Manual (non-pipeline) loads produce no
--      lifecycle events under this migration.
--   3. load.delivered needs no new trigger -- T-17's existing
--      fn_events_from_pipeline_loads()/fn_stage_event_type() already emits
--      it when pipeline_loads.stage -> 'delivered'.
--   4. load.pickup_checked_in derives from loads.status -> 'In Transit',
--      not check_calls (no structured pickup/enroute distinction exists
--      there -- flagged, not guessed, same discipline as migration 044).
--
-- Bug caught during t23-verify testing (same class as T-19's wave1.md bug
-- #2): loads.carrier_signature_received_at is TIMESTAMPTZ (migration 049),
-- but fn_insert_event's p_occurred_at parameter is plain TIMESTAMP.
-- timestamptz -> timestamp is only an assignment cast in Postgres, not an
-- implicit one, so passing it directly as a function argument raised
-- "function fn_insert_event(...) does not exist" -- silently swallowed by
-- this trigger's own required EXCEPTION WHEN OTHERS handler, which also
-- rolled back the carrier_acceptance_state UPDATE in the same IF block (a
-- plpgsql exception handler rolls back every statement since the start of
-- the function it guards). Caught by the Task 1 trigger test, not assumed
-- passing on the first run. Fixed with an explicit ::timestamp cast at the
-- one call site below.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS
-- throughout. Zero changes to dispatcher-worker.ts, dispatch-gate.ts, or
-- any existing table's write path.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'carriers' AND column_name = 'carrier_registry_id'
    ) THEN
        RAISE EXCEPTION 'carriers.carrier_registry_id not found — migration 044 (T-20) must be applied first';
    END IF;
END $$;

-- ============================================================
-- 1. carrier_acceptance_state — the missing state, made explicit
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_acceptance_state (
    id                    SERIAL PRIMARY KEY,
    pipeline_load_id      INTEGER NOT NULL REFERENCES pipeline_loads(id) ON DELETE CASCADE,
    carrier_registry_id   INTEGER REFERENCES carrier_registry(id) ON DELETE SET NULL,

    assigned_at           TIMESTAMP NOT NULL,
    confirmation_method   VARCHAR(30),   -- 'dispatch_one_negotiation' | 'manual_call' | 'rate_con_signed' | 'assumed_unconfirmed'
    confirmed_at          TIMESTAMP,     -- NULL = never confirmed
    confirmation_source   VARCHAR(40),

    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_acceptance_unconfirmed ON carrier_acceptance_state(pipeline_load_id) WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_acceptance_load ON carrier_acceptance_state(pipeline_load_id);

-- ============================================================
-- 2. dispatch_routing_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch_routing_rules (
    id             SERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mode           VARCHAR(20) NOT NULL CHECK (mode IN ('myra_managed', 'in_house_notify')),
    notify_contact VARCHAR(200),
    is_active      BOOLEAN DEFAULT true,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id)
);

INSERT INTO dispatch_routing_rules (tenant_id, mode)
SELECT fn_myra_tenant_id(), 'myra_managed'
WHERE NOT EXISTS (SELECT 1 FROM dispatch_routing_rules WHERE tenant_id = fn_myra_tenant_id());

-- ============================================================
-- 3. Trigger: lifecycle events + acceptance-state from `loads`
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_events_from_loads() RETURNS TRIGGER AS $$
DECLARE
    v_registry_id INTEGER;
BEGIN
    IF NEW.pipeline_load_id IS NULL THEN
        RETURN NEW; -- manual/non-pipeline load — out of scope, see header note 2
    END IF;

    -- load.carrier_assigned + carrier_acceptance_state seed row (one per
    -- assignment; a reassignment to a different carrier gets its own row —
    -- see the report script's "reassigned" metric).
    IF NEW.carrier_id IS DISTINCT FROM OLD.carrier_id AND NEW.carrier_id IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.carrier_assigned', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id, 'carrier_id', NEW.carrier_id),
            NULL, NULL, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );

        SELECT carrier_registry_id INTO v_registry_id FROM carriers WHERE id = NEW.carrier_id;
        INSERT INTO carrier_acceptance_state (pipeline_load_id, carrier_registry_id, assigned_at, confirmation_method, confirmed_at)
        VALUES (NEW.pipeline_load_id, v_registry_id, LOCALTIMESTAMP, 'assumed_unconfirmed', NULL);
    END IF;

    -- load.rate_confirmation_sent — AI-cascade path only (manual assignment
    -- never persists rate_con_send_status at all; see plan Global Constraints).
    IF NEW.rate_con_send_status IS DISTINCT FROM OLD.rate_con_send_status AND NEW.rate_con_send_status IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.rate_confirmation_sent', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'dispatch-gate', 'system',
            jsonb_build_object('load_id', NEW.id, 'send_status', NEW.rate_con_send_status),
            NULL, NULL, COALESCE(NEW.rate_con_sent_at, LOCALTIMESTAMP), 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.carrier_acceptance_confirmed — backfill from a real signature
    -- (the one carrier_acceptance_state row this pipeline load has that's
    -- still unconfirmed; a reassigned load's earlier, superseded row is
    -- deliberately left alone). NEW.carrier_signature_received_at is
    -- TIMESTAMPTZ (049); cast to ::timestamp before passing to
    -- fn_insert_event's TIMESTAMP parameter — see file header note.
    IF NEW.carrier_signature_received_at IS DISTINCT FROM OLD.carrier_signature_received_at
       AND NEW.carrier_signature_received_at IS NOT NULL THEN
        UPDATE carrier_acceptance_state
           SET confirmed_at = NEW.carrier_signature_received_at,
               confirmation_method = CASE NEW.carrier_signature_method
                                       WHEN 'email_verified' THEN 'rate_con_signed'
                                       WHEN 'manual_ops' THEN 'manual_call'
                                       ELSE 'rate_con_signed' END,
               confirmation_source = NEW.carrier_signature_confirmed_by
         WHERE pipeline_load_id = NEW.pipeline_load_id AND confirmed_at IS NULL;

        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.carrier_acceptance_confirmed', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'dispatch-gate', 'system',
            jsonb_build_object('load_id', NEW.id, 'method', NEW.carrier_signature_method, 'confirmed_by', NEW.carrier_signature_confirmed_by),
            NULL, NULL, NEW.carrier_signature_received_at::timestamp, 'carrier_acceptance_state', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.pickup_checked_in — see header note 4.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'In Transit' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.pickup_checked_in', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id),
            OLD.status, NEW.status, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.pod_captured
    IF NEW.pod_url IS DISTINCT FROM OLD.pod_url AND NEW.pod_url IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.pod_captured', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id),
            NULL, NULL, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_events_loads ON loads;
CREATE TRIGGER trg_lifecycle_events_loads
AFTER UPDATE ON loads
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_events_from_loads();

-- ============================================================
-- 4. Trigger: load.in_transit_ping from location_pings
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_event_from_location_ping() RETURNS TRIGGER AS $$
DECLARE
    v_pipeline_load_id INTEGER;
BEGIN
    SELECT pipeline_load_id INTO v_pipeline_load_id FROM loads WHERE id = NEW.load_id;
    IF v_pipeline_load_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM fn_insert_event(
        fn_myra_tenant_id()::integer, 'load.in_transit_ping', 'load', v_pipeline_load_id, v_pipeline_load_id,
        'gps', 'system',
        jsonb_build_object('lat', NEW.lat, 'lng', NEW.lng, 'speed_mph', NEW.speed_mph),
        NULL, NULL, LOCALTIMESTAMP, 'location_pings', v_pipeline_load_id, 'load-' || v_pipeline_load_id
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_event_location_ping ON location_pings;
CREATE TRIGGER trg_lifecycle_event_location_ping
AFTER INSERT ON location_pings
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_event_from_location_ping();

-- ============================================================
-- 5. v_lifecycle_late_loads — read-only, feeds T-24
-- ============================================================
-- Base-spec fix: pl.delivery_date is nullable (pipeline_loads has no
-- NOT NULL constraint on it); the base spec's GREATEST(pickup_date,
-- delivery_date) silently returns NULL for time_overdue on any pickup_late
-- row whose delivery_date hasn't been set yet. COALESCE'd here.
CREATE OR REPLACE VIEW v_lifecycle_late_loads AS
SELECT pl.id AS pipeline_load_id,
       fn_myra_tenant_id()::integer AS tenant_id,
       pl.pickup_date, pl.delivery_date, pl.stage,
       CASE
         WHEN pl.pickup_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id AND e.event_type = 'load.pickup_checked_in')
         THEN 'pickup_late'
         WHEN pl.delivery_date IS NOT NULL AND pl.delivery_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id AND e.event_type = 'load.delivered')
         THEN 'delivery_late'
         ELSE NULL
       END AS late_status,
       NOW() - GREATEST(pl.pickup_date, COALESCE(pl.delivery_date, pl.pickup_date)) AS time_overdue
FROM pipeline_loads pl
WHERE pl.stage = 'dispatched';
