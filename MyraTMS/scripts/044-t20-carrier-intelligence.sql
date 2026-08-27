-- 044: T-20 Carrier Intelligence & Myra Carrier Score
-- Engine 3 Phase 2, Module 1. See Engine 3/T20_Carrier_Intelligence.md.
--
-- Schema-reality corrections applied vs. the base spec (same discipline as
-- migration 035/T-19 — see Engine 3/wave1.md before touching this file again):
--   1. tenant_id columns use BIGINT NOT NULL DEFAULT fn_myra_tenant_id(),
--      never INTEGER NOT NULL DEFAULT 1 — that literal is the exact bug T-19
--      fixed across T-17/T-18. fn_myra_tenant_id() must already exist
--      (migration 035); this migration fails loudly if it doesn't.
--   2. derived_from_id is TEXT, not INTEGER as the base spec assumed — every
--      real source table this derives from (match_results, loads, carriers)
--      has a TEXT primary key in this codebase (e.g. 'MR-...', 'LD-...').
--      Only pipeline_loads.id is actually a SERIAL integer.
--   3. UNIQUE (derived_from_table, derived_from_id, event_type) alone repeats
--      T-17's bug #2 (a load's second transition collides with its first) —
--      occurred_at is added to the key, same fix T-17 applied.
--   4. carriers already has tenant_id (migration 028) with composite
--      uniqueness on (tenant_id, mc_number) — carrier_registry is correctly
--      left tenant-agnostic per spec (the one deliberately platform-global
--      table), no tenant scoping added here, no change to carriers' own
--      tenant scoping.
--   5. FKs back to carrier_registry / pipeline_loads use ON DELETE CASCADE —
--      same reasoning as T-18 bug #1/#3: neither table is ever deleted by
--      live code, only by test/ops cleanup, and an unset ON DELETE behavior
--      breaks that cleanup once rows exist.
--   6. match_results.load_id is OVERLOADED — found while smoke-testing this
--      migration, not caught by the base spec. ranker-worker.ts (Engine 2's
--      Agent 4) calls storeMatchResults(tenantId, load.load_id, ...) where
--      load.load_id is pipeline_loads.load_id (a string), NOT loads.id
--      (the TMS's 'LD-...' primary key) — even though the column's FK is
--      declared REFERENCES loads(id). TMS-native matching (a broker matching
--      an existing loads.id row directly, outside the pipeline) genuinely
--      does use loads.id. fn_carrier_outcome_from_match() below resolves
--      pipeline_load_id via pipeline_loads.load_id = NEW.load_id, NOT via a
--      join through `loads` — that join returns zero rows for every
--      pipeline-sourced match, silently, since it's exception-safe by
--      design and never errors. Verified against real production match
--      data before finalizing this migration.
--
-- Explicitly NOT built here (flagged, not silently guessed): the base spec's
-- parenthetical "triggers on carriers (existing ai_acceptance_rate/
-- ai_call_count columns)" would require inventing a discrete event_type from
-- a continuous metric delta — none of the spec's named event_type values
-- (offered/accepted/declined/cancelled_by_carrier/completed_on_time/
-- completed_late/claim_filed/fraud_signal) map cleanly to "acceptance rate
-- changed by X". Building that trigger would mean guessing a mapping the
-- spec doesn't define. Only the two triggers with an unambiguous source
-- (match_results, loads) are built. Report this back before inventing one.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id'
    ) THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
END $$;

-- ============================================================
-- 1. carrier_registry — platform-level canonical carrier identity
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_registry (
    id                      SERIAL PRIMARY KEY,
    mc_number               VARCHAR(20) UNIQUE,
    dot_number               VARCHAR(20),
    legal_name                VARCHAR(200) NOT NULL,

    authority_status            VARCHAR(20),
    insurance_status              VARCHAR(20),
    insurance_verified_at           TIMESTAMP,

    first_seen_at                     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at                    TIMESTAMP,

    created_at                            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_carrier_registry_mc ON carrier_registry(mc_number);
CREATE INDEX IF NOT EXISTS idx_carrier_registry_dot ON carrier_registry(dot_number);

-- ============================================================
-- 2. Reconciliation link — additive, no structural change to carriers
-- ============================================================
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS carrier_registry_id INTEGER
    REFERENCES carrier_registry(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_carriers_registry ON carriers(carrier_registry_id);

-- ============================================================
-- 3. carrier_outcome_events
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_outcome_events (
    id                     BIGSERIAL PRIMARY KEY,
    carrier_registry_id    INTEGER NOT NULL REFERENCES carrier_registry(id) ON DELETE CASCADE,
    tenant_id              BIGINT NOT NULL DEFAULT fn_myra_tenant_id(),
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    event_type             VARCHAR(30) NOT NULL,
    -- 'offered' | 'accepted' | 'declined' | 'cancelled_by_carrier' |
    -- 'completed_on_time' | 'completed_late' | 'claim_filed' | 'fraud_signal'

    occurred_at              TIMESTAMP NOT NULL,
    derived_from_table         VARCHAR(40) NOT NULL,
    derived_from_id              TEXT NOT NULL,
    payload                         JSONB DEFAULT '{}',

    UNIQUE (derived_from_table, derived_from_id, event_type, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_carrier_outcomes_carrier ON carrier_outcome_events(carrier_registry_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_carrier_outcomes_tenant ON carrier_outcome_events(tenant_id);

-- ============================================================
-- 4. carrier_risk_signals
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_risk_signals (
    id                     SERIAL PRIMARY KEY,
    carrier_registry_id    INTEGER NOT NULL REFERENCES carrier_registry(id) ON DELETE CASCADE,

    signal_type              VARCHAR(40) NOT NULL,
    -- 'banking_change_mid_transaction' | 'insurance_lapsed' | 'authority_reassigned' |
    -- 'name_mismatch' | 'excessive_cancellation_rate' | 'multiple_mc_same_contact'

    severity                   VARCHAR(20) NOT NULL DEFAULT 'medium',
    detected_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detail                          JSONB DEFAULT '{}',

    reviewed                          BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_carrier_risk_signals_carrier ON carrier_risk_signals(carrier_registry_id, reviewed);

-- ============================================================
-- 5. myra_carrier_scores
-- ============================================================
CREATE TABLE IF NOT EXISTS myra_carrier_scores (
    id                      SERIAL PRIMARY KEY,
    carrier_registry_id     INTEGER NOT NULL REFERENCES carrier_registry(id) ON DELETE CASCADE,

    score                     NUMERIC(5,2),            -- 0-100, NULL if total_loads_observed < 5
    formula_version             VARCHAR(10) NOT NULL,

    on_time_pct                   NUMERIC(5,2),
    acceptance_rate                  NUMERIC(5,2),
    cancellation_rate                   NUMERIC(5,2),
    claims_count                          INTEGER DEFAULT 0,
    open_risk_signals                        INTEGER DEFAULT 0,
    total_loads_observed                        INTEGER DEFAULT 0,

    computed_at                                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_carrier_scores_current ON myra_carrier_scores(carrier_registry_id, computed_at DESC);

-- ============================================================
-- 6. Trigger: carrier_outcome_events from match_results
--    (offered / accepted / declined)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_carrier_outcome_from_match() RETURNS TRIGGER AS $$
DECLARE
    v_registry_id INTEGER;
    v_pipeline_load_id INTEGER;
BEGIN
    SELECT c.carrier_registry_id INTO v_registry_id FROM carriers c WHERE c.id = NEW.carrier_id;
    IF v_registry_id IS NULL THEN
        RETURN NEW; -- carrier not yet reconciled into carrier_registry — no event, not an error
    END IF;

    -- See note 6 at the top of this file: try the pipeline link first via
    -- pipeline_loads.load_id (the real overloaded meaning of
    -- match_results.load_id for pipeline-sourced matches); a TMS-native
    -- match legitimately resolves to NULL here.
    SELECT pl.id INTO v_pipeline_load_id FROM pipeline_loads pl WHERE pl.load_id = NEW.load_id LIMIT 1;

    IF TG_OP = 'INSERT' THEN
        IF NEW.was_selected THEN
            INSERT INTO carrier_outcome_events
                (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
            VALUES
                (v_registry_id, v_pipeline_load_id, 'offered', LOCALTIMESTAMP, 'match_results', NEW.id,
                 jsonb_build_object('match_grade', NEW.match_grade, 'match_score', NEW.match_score))
            ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.was_accepted IS DISTINCT FROM OLD.was_accepted AND NEW.was_accepted IS NOT NULL THEN
        INSERT INTO carrier_outcome_events
            (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
        VALUES
            (v_registry_id, v_pipeline_load_id,
             CASE WHEN NEW.was_accepted THEN 'accepted' ELSE 'declined' END,
             LOCALTIMESTAMP, 'match_results', NEW.id, jsonb_build_object('match_grade', NEW.match_grade))
        ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING;
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW; -- exception-safe: never block the write to match_results
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_carrier_outcome_from_match ON match_results;
CREATE TRIGGER trg_carrier_outcome_from_match
    AFTER INSERT OR UPDATE ON match_results
    FOR EACH ROW EXECUTE FUNCTION fn_carrier_outcome_from_match();

-- ============================================================
-- 7. Trigger: carrier_outcome_events from loads
--    (completed_on_time / completed_late)
--
--    loads has no actual-delivered timestamp column (only delivery_date, the
--    scheduled/appointment date) — LOCALTIMESTAMP at the moment status flips
--    to 'Delivered' is used as the completion instant, and compared against
--    delivery_date::date for on-time/late. Documented approximation, not a
--    guess dressed as precision — same "derive from what actually exists"
--    discipline as T-17.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_carrier_outcome_from_load_delivery() RETURNS TRIGGER AS $$
DECLARE
    v_registry_id INTEGER;
BEGIN
    IF NEW.carrier_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT carrier_registry_id INTO v_registry_id FROM carriers WHERE id = NEW.carrier_id;
    IF v_registry_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO carrier_outcome_events
        (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
    VALUES
        (v_registry_id, NEW.pipeline_load_id,
         CASE WHEN NEW.delivery_date IS NULL OR CURRENT_DATE <= NEW.delivery_date
              THEN 'completed_on_time' ELSE 'completed_late' END,
         LOCALTIMESTAMP, 'loads', NEW.id,
         jsonb_build_object('delivery_date', NEW.delivery_date, 'revenue', NEW.revenue))
    ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_carrier_outcome_from_load_delivery ON loads;
CREATE TRIGGER trg_carrier_outcome_from_load_delivery
    AFTER UPDATE ON loads
    FOR EACH ROW
    WHEN (NEW.status = 'Delivered' AND OLD.status IS DISTINCT FROM 'Delivered')
    EXECUTE FUNCTION fn_carrier_outcome_from_load_delivery();
