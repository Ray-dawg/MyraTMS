-- ============================================================================
-- 035 — T-19 TENANT & POLICY MODEL
-- ============================================================================
-- Engine 3, Phase 1, Module 3 of 3. Spec: Engine 3/T19_Tenant_Policy_Model.md
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-t19-tenant-policy-model-design.md
--
-- Does NOT create tenants/tenant_users — they already exist (027) with a
-- different, incompatible shape than the base spec assumed. This migration:
--   1. Adds fn_myra_tenant_id(), the single slug-based resolver that replaces
--      every hardcoded tenant_id=1 literal in T-17/T-18 (which mislabeled
--      production data — id=1 is the "_system" tenant, id=2 is "myra").
--   2. Backfill-corrects existing T-17/T-18 rows from 1 to the real Myra id.
--   3. Adds tenants.freight_business_type (additive column, not tenant_config
--      — see design doc decision 3).
--   4. Adds the three genuinely-new tables: tenant_type_policy_templates,
--      tenant_policies, co_broker_agreements.
--   5. Corrects tenant_config's margin_floor_cad/margin_floor_usd (were
--      seeded 150/110; live behavior is actually 270/200) and removes the
--      dead auto_book_profit_threshold_cad key.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / guarded UPDATEs throughout.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- fn_myra_tenant_id — the single source of truth for "which tenant is Myra."
-- Resolved by slug, never a hardcoded integer, so this bug class can't recur.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_myra_tenant_id() RETURNS BIGINT AS $$
    SELECT id FROM tenants WHERE slug = 'myra';
$$ LANGUAGE sql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- T-17 fixes: fn_insert_event's fallback, the events table default, and
-- v_cost_per_call's two COALESCE(..., 1) fallbacks.
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
        COALESCE(p_tenant_id, fn_myra_tenant_id()), p_event_type, p_entity_type, p_entity_id, p_pipeline_load_id,
        p_source, p_actor_type, COALESCE(p_payload, '{}'::jsonb), p_stage_from, p_stage_to,
        COALESCE(p_occurred_at, LOCALTIMESTAMP), p_derived_from_table, p_derived_from_id, p_correlation_id
    )
    ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE events ALTER COLUMN tenant_id SET DEFAULT fn_myra_tenant_id();

CREATE OR REPLACE FUNCTION fn_events_from_pipeline_loads()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'load.scanned', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            NULL, NEW.stage,
            NEW.created_at, 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'load.stage_changed', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            OLD.stage, NEW.stage,
            COALESCE(NEW.stage_updated_at, LOCALTIMESTAMP), 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );

        IF fn_stage_event_type(NEW.stage) IS NOT NULL THEN
            PERFORM fn_insert_event(
                fn_myra_tenant_id(), fn_stage_event_type(NEW.stage), 'load', NEW.id, NEW.id,
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
            fn_myra_tenant_id(), 'load.researched', 'load', NEW.id, NEW.id,
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

CREATE OR REPLACE FUNCTION fn_events_from_agent_calls()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'call.initiated', 'call', NEW.id, NEW.pipeline_load_id,
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
            fn_myra_tenant_id(), 'call.connected', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent', jsonb_build_object('call_id', NEW.call_id),
            NULL, NULL, NEW.call_connected_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.call_ended_at IS DISTINCT FROM NEW.call_ended_at
       AND NEW.call_ended_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'call.ended', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'duration_seconds', NEW.duration_seconds),
            NULL, NULL, NEW.call_ended_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.outcome IS DISTINCT FROM NEW.outcome
       AND NEW.outcome IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'call.outcome_recorded', 'call', NEW.id, NEW.pipeline_load_id,
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

CREATE OR REPLACE FUNCTION fn_events_from_agent_jobs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('completed', 'failed') THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'job.' || NEW.status, 'job', NEW.id, NEW.pipeline_load_id,
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

CREATE OR REPLACE FUNCTION fn_events_from_consent_log()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id(), 'consent.logged', 'consent', NEW.id, NULL,
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

CREATE OR REPLACE FUNCTION fn_events_from_scraper_runs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('success', 'partial', 'failed') THEN
        PERFORM fn_insert_event(
            COALESCE(NEW.tenant_id, fn_myra_tenant_id()), 'scraper.run_completed', 'scraper_run', NEW.id, NULL,
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

-- v_cost_per_call's two COALESCE(e.tenant_id, 1) fallbacks corrected.
CREATE OR REPLACE VIEW v_cost_per_call AS
SELECT
    COALESCE(e.tenant_id, fn_myra_tenant_id()) AS tenant_id,
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
GROUP BY COALESCE(e.tenant_id, fn_myra_tenant_id());

-- ────────────────────────────────────────────────────────────────────────────
-- T-18 fixes: the three table defaults.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE authority_envelopes ALTER COLUMN tenant_id SET DEFAULT fn_myra_tenant_id();
ALTER TABLE authority_evaluations ALTER COLUMN tenant_id SET DEFAULT fn_myra_tenant_id();
ALTER TABLE escalations ALTER COLUMN tenant_id SET DEFAULT fn_myra_tenant_id();

-- ────────────────────────────────────────────────────────────────────────────
-- One-time backfill: correct every existing tenant_id=1 row to the real
-- Myra tenant. Guarded so re-running this migration is a no-op the second
-- time (nothing left at tenant_id=1 to move).
-- ────────────────────────────────────────────────────────────────────────────
UPDATE events SET tenant_id = fn_myra_tenant_id() WHERE tenant_id = 1;
UPDATE authority_envelopes SET tenant_id = fn_myra_tenant_id() WHERE tenant_id = 1;
UPDATE authority_evaluations SET tenant_id = fn_myra_tenant_id() WHERE tenant_id = 1;
UPDATE escalations SET tenant_id = fn_myra_tenant_id() WHERE tenant_id = 1;

INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
VALUES (
    fn_myra_tenant_id(), 'system:migration-035',
    'tenant_id_backfill_corrected',
    jsonb_build_object(
        'reason', 'T-17/T-18 hardcoded tenant_id=1 (the _system tenant) instead of resolving Myra by slug (real id from fn_myra_tenant_id())',
        'tables', jsonb_build_array('events', 'authority_envelopes', 'authority_evaluations', 'escalations')
    )
);

-- ────────────────────────────────────────────────────────────────────────────
-- tenants.freight_business_type — additive, nullable. Answers "what kind of
-- freight business" (E3-00 §4.2), distinct from tenants.type which answers
-- "what kind of platform/billing relationship" (027). Not stored in
-- tenant_config: that table is a closed keyspace of scalar settings/
-- credentials, never a structural classification (design doc decision 3).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS freight_business_type VARCHAR(20)
    CHECK (freight_business_type IN ('broker', 'dispatcher', 'carrier', 'acquired_opco'));

UPDATE tenants SET freight_business_type = 'broker' WHERE slug = 'myra' AND freight_business_type IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- tenant_type_policy_templates — the four defaults from E3-00 §4.2, keyed
-- by freight_business_type (not tenants.type).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_type_policy_templates (
    id                     SERIAL PRIMARY KEY,
    freight_business_type  VARCHAR(20)  UNIQUE NOT NULL
                           CHECK (freight_business_type IN ('broker', 'dispatcher', 'carrier', 'acquired_opco')),
    load_source_policy     VARCHAR(30)  NOT NULL,
    dispatch_agent_default VARCHAR(10)  NOT NULL,
    negotiation_directions VARCHAR(20)  NOT NULL,
    description            TEXT
);

INSERT INTO tenant_type_policy_templates (freight_business_type, load_source_policy, dispatch_agent_default, negotiation_directions, description) VALUES
('broker',        'shipper_direct_or_coBroker', 'on',     'both',      'Non-asset brokerage. Shipper-direct only, or broker-posted with an executed co-broker agreement.'),
('dispatcher',    'broker_or_shipper_direct',   'on',     'buy_only',  'Dispatch service acting for owner-operators. Broker-posted and shipper-direct both permitted.'),
('carrier',       'any',                        'opt_in', 'sell_only', 'Asset trucking company. Any load source; dispatch agent is opt-in, default routes to in-house dispatch.'),
('acquired_opco',  'inherit',                    'inherit','inherit',   'Inherits broker or carrier template by the acquired entity''s actual type.')
ON CONFLICT (freight_business_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- tenant_policies — versioned, per-tenant, overridable. tenant_id is BIGINT
-- REFERENCES tenants(id), matching the real table (base spec assumed INTEGER
-- against a table it also assumed it was creating).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_policies (
    id                     SERIAL PRIMARY KEY,
    tenant_id              BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version                INTEGER NOT NULL DEFAULT 1,

    load_source_policy     VARCHAR(30) NOT NULL,
    dispatch_agent_enabled BOOLEAN NOT NULL,
    negotiation_directions VARCHAR(20) NOT NULL,

    geographic_scope       JSONB DEFAULT '{"domestic_only": true, "countries": ["CA"]}',
    margin_floor_pct       NUMERIC(5,2),

    is_active              BOOLEAN NOT NULL DEFAULT true,
    effective_from         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by              VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_policies_active ON tenant_policies(tenant_id) WHERE is_active;

-- Myra's v1 policy: matches the Broker template. Geographic scope is
-- domestic-Canada-only per the real Qualifier's freshness/geography
-- handling; the base spec's claim that "shipper-direct required" is also
-- verified is NOT assumed here (see design doc decision 6 — no such filter
-- exists in the live pipeline yet, tracked separately).
INSERT INTO tenant_policies (tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions, geographic_scope, created_by)
SELECT fn_myra_tenant_id(), 1, 'shipper_direct_or_coBroker', true, 'both',
       '{"domestic_only": true, "countries": ["CA"]}'::jsonb, 'system'
WHERE NOT EXISTS (SELECT 1 FROM tenant_policies WHERE tenant_id = fn_myra_tenant_id());

-- ────────────────────────────────────────────────────────────────────────────
-- co_broker_agreements — empty at launch. Myra has none yet.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS co_broker_agreements (
    id                      SERIAL PRIMARY KEY,
    tenant_id               BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    counterparty_name       VARCHAR(200) NOT NULL,
    counterparty_mc_number  VARCHAR(20),

    agreement_executed_at   DATE NOT NULL,
    agreement_document_url  TEXT,

    status                  VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────────────────────
-- Threshold consolidation: correct the two existing (but wrong) tenant_config
-- keys to the value that's actually live (270 CAD / 200 USD, currently
-- hardcoded independently in compiler-worker.ts, qualifier-worker.ts,
-- researcher-worker.ts), and remove the dead auto_book_profit_threshold_cad
-- key. This is a refactor, not a behavior change — see the parity test in
-- lib/tenants/__tests__/margin-floor.test.ts.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE tenant_config SET value = '270', updated_at = NOW(), updated_by = 'system:migration-035'
 WHERE tenant_id = fn_myra_tenant_id() AND key = 'margin_floor_cad';
UPDATE tenant_config SET value = '200', updated_at = NOW(), updated_by = 'system:migration-035'
 WHERE tenant_id = fn_myra_tenant_id() AND key = 'margin_floor_usd';
DELETE FROM tenant_config WHERE tenant_id = fn_myra_tenant_id() AND key = 'auto_book_profit_threshold_cad';

COMMIT;
