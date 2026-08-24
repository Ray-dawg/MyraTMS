-- ============================================================================
-- 033 — T-17 EVENT & DATA LAYER
-- ============================================================================
-- Engine 3, Phase 1, Module 1 of 3. Spec: Engine 3/T17_Event_Data_Layer.md
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-t17-event-data-layer-design.md
--
-- Adds an append-only `events` table populated entirely by PostgreSQL
-- triggers on tables Engine 2 already writes (pipeline_loads, agent_calls,
-- agent_jobs, consent_log, scraper_runs). No application code in the live
-- call path is touched by this migration.
--
-- Idempotent: every statement uses IF NOT EXISTS / CREATE OR REPLACE, safe
-- to re-run.
--
-- NOTE on timestamp types: fn_insert_event's p_occurred_at is declared plain
-- TIMESTAMP (matching pipeline_loads.stage_updated_at, agent_calls.*_at,
-- agent_jobs.*_at, consent_log.consent_date, scraper_runs.*_at — all
-- `timestamp without time zone`). Every fallback in this file uses
-- LOCALTIMESTAMP (returns `timestamp without time zone`), never
-- CURRENT_TIMESTAMP/NOW() (return `timestamptz`) — mixing the two inside a
-- COALESCE with a real timestamp column resolves to timestamptz, which then
-- fails to match fn_insert_event's overload and is silently swallowed by
-- its (required, per T-17 §5.2) exception handler.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- events — append-only, tenant-aware from day one.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id                  BIGSERIAL PRIMARY KEY,

    tenant_id           INTEGER      NOT NULL DEFAULT 1,

    event_type          VARCHAR(60)  NOT NULL,
    entity_type         VARCHAR(30)  NOT NULL,
    entity_id           INTEGER      NOT NULL,

    pipeline_load_id    INTEGER      REFERENCES pipeline_loads(id),

    source              VARCHAR(40)  NOT NULL,
    actor_type          VARCHAR(20)  NOT NULL DEFAULT 'agent',

    payload             JSONB        NOT NULL DEFAULT '{}',
    stage_from          VARCHAR(30),
    stage_to            VARCHAR(30),

    occurred_at         TIMESTAMP    NOT NULL,
    recorded_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    derived_from_table  VARCHAR(40)  NOT NULL,
    derived_from_id     INTEGER      NOT NULL,
    correlation_id      VARCHAR(100),

    -- occurred_at is part of the idempotency key, not just an attribute:
    -- event types like load.stage_changed legitimately fire more than once
    -- per source row (once per transition). Without occurred_at here, the
    -- second transition on the same load would collide with the first on
    -- (derived_from_table, derived_from_id, event_type) and be silently
    -- dropped by ON CONFLICT ... DO NOTHING. Re-deriving the SAME transition
    -- (e.g. a backfill re-run) still produces the same occurred_at, so
    -- idempotency is preserved.
    UNIQUE (derived_from_table, derived_from_id, event_type, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_load ON events(pipeline_load_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Cost scaffolding on agent_calls (design doc decision 1 — nullable, no
-- backfill; a future module starts populating these, not this one).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS retell_cost_cents INTEGER;
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS claude_cost_cents INTEGER;

-- ────────────────────────────────────────────────────────────────────────────
-- fn_insert_event — single choke point for writing to `events`. Every
-- trigger and the backfill script call this instead of INSERTing directly,
-- so the exception-safety guarantee (T-17 §5.2 — a bug here can never abort
-- the write that triggered it) lives in exactly one place.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_insert_event(
    p_tenant_id          INTEGER,
    p_event_type         VARCHAR,
    p_entity_type        VARCHAR,
    p_entity_id          INTEGER,
    p_pipeline_load_id   INTEGER,
    p_source             VARCHAR,
    p_actor_type         VARCHAR,
    p_payload            JSONB,
    p_stage_from         VARCHAR,
    p_stage_to           VARCHAR,
    p_occurred_at        TIMESTAMP,
    p_derived_from_table VARCHAR,
    p_derived_from_id    INTEGER,
    p_correlation_id     VARCHAR
) RETURNS VOID AS $$
BEGIN
    INSERT INTO events (
        tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
        source, actor_type, payload, stage_from, stage_to,
        occurred_at, derived_from_table, derived_from_id, correlation_id
    ) VALUES (
        COALESCE(p_tenant_id, 1), p_event_type, p_entity_type, p_entity_id, p_pipeline_load_id,
        p_source, p_actor_type, COALESCE(p_payload, '{}'::jsonb), p_stage_from, p_stage_to,
        COALESCE(p_occurred_at, LOCALTIMESTAMP), p_derived_from_table, p_derived_from_id, p_correlation_id
    )
    ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
    -- Never let event derivation break the write that triggered it.
    NULL;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────────
-- fn_stage_event_type — single source of truth for the pipeline_loads.stage
-- -> typed event_type mapping (T-17 §4.2). Shared by the trigger and the
-- backfill script so they can never drift apart.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_stage_event_type(p_stage VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN CASE p_stage
        WHEN 'qualified'    THEN 'load.qualified'
        WHEN 'disqualified' THEN 'load.disqualified'
        WHEN 'matched'      THEN 'load.matched'
        WHEN 'booked'       THEN 'load.booked'
        WHEN 'dispatched'   THEN 'load.dispatched'
        WHEN 'delivered'    THEN 'load.delivered'
        WHEN 'scored'       THEN 'load.scored'
        WHEN 'escalated'    THEN 'load.escalated'
        ELSE NULL
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 1: pipeline_loads -> load.scanned, load.stage_changed, typed stage
-- events, load.researched.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_pipeline_loads()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'load.scanned', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            NULL, NEW.stage,
            NEW.created_at, 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage THEN
        PERFORM fn_insert_event(
            1, 'load.stage_changed', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            OLD.stage, NEW.stage,
            COALESCE(NEW.stage_updated_at, LOCALTIMESTAMP), 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );

        IF fn_stage_event_type(NEW.stage) IS NOT NULL THEN
            PERFORM fn_insert_event(
                1, fn_stage_event_type(NEW.stage), 'load', NEW.id, NEW.id,
                'system', 'system',
                jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
                OLD.stage, NEW.stage,
                COALESCE(NEW.stage_updated_at, LOCALTIMESTAMP), 'pipeline_loads', NEW.id, 'load-' || NEW.id
            );
        END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.research_completed_at IS DISTINCT FROM NEW.research_completed_at
       AND NEW.research_completed_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'load.researched', 'load', NEW.id, NEW.id,
            'researcher', 'agent',
            jsonb_build_object('market_rate_mid', NEW.market_rate_mid, 'recommended_strategy', NEW.recommended_strategy),
            NULL, NULL,
            NEW.research_completed_at, 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_pipeline_loads ON pipeline_loads;
CREATE TRIGGER trg_events_pipeline_loads
AFTER INSERT OR UPDATE ON pipeline_loads
FOR EACH ROW EXECUTE FUNCTION fn_events_from_pipeline_loads();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 2: agent_calls -> call.initiated, call.connected, call.ended,
-- call.outcome_recorded. NOTE: live column is `outcome`, not `call_outcome`
-- as the base spec's example shows (see design doc reconciliation table).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_agent_calls()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'call.initiated', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'persona', NEW.persona, 'call_type', NEW.call_type),
            NULL, NULL,
            NEW.call_initiated_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.call_connected_at IS DISTINCT FROM NEW.call_connected_at
       AND NEW.call_connected_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.connected', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent', jsonb_build_object('call_id', NEW.call_id),
            NULL, NULL, NEW.call_connected_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.call_ended_at IS DISTINCT FROM NEW.call_ended_at
       AND NEW.call_ended_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.ended', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'duration_seconds', NEW.duration_seconds),
            NULL, NULL, NEW.call_ended_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.outcome IS DISTINCT FROM NEW.outcome
       AND NEW.outcome IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.outcome_recorded', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'outcome', NEW.outcome, 'agreed_rate', NEW.agreed_rate),
            NULL, NULL,
            COALESCE(NEW.call_ended_at, LOCALTIMESTAMP), 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_agent_calls ON agent_calls;
CREATE TRIGGER trg_events_agent_calls
AFTER INSERT OR UPDATE ON agent_calls
FOR EACH ROW EXECUTE FUNCTION fn_events_from_agent_calls();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 3: agent_jobs -> job.completed, job.failed.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_agent_jobs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('completed', 'failed') THEN
        PERFORM fn_insert_event(
            1, 'job.' || NEW.status, 'job', NEW.id, NEW.pipeline_load_id,
            NEW.queue_name, 'system',
            jsonb_build_object('job_id', NEW.job_id, 'attempts', NEW.attempts, 'error_message', NEW.error_message),
            NULL, NULL,
            COALESCE(NEW.completed_at, NEW.failed_at, LOCALTIMESTAMP), 'agent_jobs', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_agent_jobs ON agent_jobs;
CREATE TRIGGER trg_events_agent_jobs
AFTER UPDATE ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION fn_events_from_agent_jobs();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 4: consent_log -> consent.logged. Payload stores only the last 4
-- phone digits, never the full number.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_consent_log()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'consent.logged', 'consent', NEW.id, NULL,
            'compliance-service', 'system',
            jsonb_build_object(
                'phone_last4', RIGHT(NEW.phone, 4),
                'consent_type', NEW.consent_type,
                'consent_source', NEW.consent_source
            ),
            NULL, NULL,
            NEW.consent_date, 'consent_log', NEW.id, NULL
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_consent_log ON consent_log;
CREATE TRIGGER trg_events_consent_log
AFTER INSERT ON consent_log
FOR EACH ROW EXECUTE FUNCTION fn_events_from_consent_log();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 5: scraper_runs -> scraper.run_completed. Table lives in the
-- sibling scraper/ project's migration, same physical Neon DB.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_scraper_runs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('success', 'partial', 'failed') THEN
        PERFORM fn_insert_event(
            COALESCE(NEW.tenant_id, 1), 'scraper.run_completed', 'scraper_run', NEW.id, NULL,
            'scanner', 'system',
            jsonb_build_object(
                'source_board', NEW.source, 'status', NEW.status,
                'loads_found', NEW.loads_found, 'loads_inserted', NEW.loads_inserted,
                'error_message', NEW.error_message
            ),
            NULL, NULL,
            COALESCE(NEW.completed_at, LOCALTIMESTAMP), 'scraper_runs', NEW.id, NULL
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_scraper_runs ON scraper_runs;
CREATE TRIGGER trg_events_scraper_runs
AFTER UPDATE ON scraper_runs
FOR EACH ROW EXECUTE FUNCTION fn_events_from_scraper_runs();

-- ────────────────────────────────────────────────────────────────────────────
-- Metric views (T-17 §4.3). v_call_funnel keeps the spec's hardcoded 30-day
-- window (it's a convenience/BI view); the read API's ?window= parameter is
-- served by a direct parametrized query, not this view. v_time_in_stage adds
-- tenant_id (missing from the base spec's version) since the read API
-- contract needs it for filtering. v_cost_per_call is new — see design doc
-- decision 1.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_stage_conversion AS
SELECT tenant_id, stage_to AS stage,
       COUNT(*) AS entries,
       COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') AS entries_7d
FROM events
WHERE event_type = 'load.stage_changed'
GROUP BY tenant_id, stage_to;

CREATE OR REPLACE VIEW v_call_funnel AS
SELECT tenant_id,
       COUNT(*) FILTER (WHERE event_type = 'call.initiated') AS calls_initiated,
       COUNT(*) FILTER (WHERE event_type = 'call.connected') AS calls_connected,
       COUNT(*) FILTER (WHERE event_type = 'call.outcome_recorded'
                         AND payload->>'outcome' = 'booked') AS calls_booked
FROM events
WHERE occurred_at > NOW() - INTERVAL '30 days'
GROUP BY tenant_id;

CREATE OR REPLACE VIEW v_time_in_stage AS
SELECT tenant_id, pipeline_load_id, stage_to AS stage,
       occurred_at,
       LEAD(occurred_at) OVER (PARTITION BY pipeline_load_id ORDER BY occurred_at) - occurred_at AS time_in_stage
FROM events
WHERE event_type = 'load.stage_changed';

CREATE OR REPLACE VIEW v_cost_per_call AS
SELECT
    COALESCE(e.tenant_id, 1) AS tenant_id,
    COUNT(ac.id) AS calls_total,
    COUNT(ac.id) FILTER (WHERE ac.retell_cost_cents IS NOT NULL OR ac.claude_cost_cents IS NOT NULL) AS calls_with_cost_data,
    ROUND(
        AVG(COALESCE(ac.retell_cost_cents, 0) + COALESCE(ac.claude_cost_cents, 0))
            FILTER (WHERE ac.retell_cost_cents IS NOT NULL OR ac.claude_cost_cents IS NOT NULL)
        / 100.0, 2
    ) AS avg_cost_per_call_dollars
FROM agent_calls ac
LEFT JOIN events e
       ON e.derived_from_table = 'agent_calls'
      AND e.derived_from_id = ac.id
      AND e.event_type = 'call.initiated'
GROUP BY COALESCE(e.tenant_id, 1);

COMMIT;
