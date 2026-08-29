-- ============================================================================
-- 055 — T-25 RISK & FRAUD SCORING
-- ============================================================================
-- Engine 3 Phase 2, Module 6. See Engine 3/T25_Risk_Fraud.md.
--
-- Schema-reality corrections (see the implementation plan's Global
-- Constraints for full reasoning, not repeated here):
--   1. Spec §4.3's view has a literal broken join placeholder and assumes a
--      pipeline_loads.tenant_id column that doesn't exist. Fixed: a real
--      pipeline_loads.payer_registry_id column (mirroring T-20's
--      carriers.carrier_registry_id) + fn_myra_tenant_id() in the view.
--   2. No banking-detail storage exists anywhere in this codebase.
--      carrier_banking_details is new, storing only account-number last4.
--   3. tenant_policies.concentration_cap_pct is additive/nullable, same
--      pattern as margin_floor_pct — app code defaults it to 25, not the DB.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'carrier_registry') THEN
        RAISE EXCEPTION 'carrier_registry not found — migration 044 (T-20) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'exception_classification_rules') THEN
        RAISE EXCEPTION 'exception_classification_rules not found — migration 054 (T-24) must be applied first';
    END IF;
END $$;

-- ============================================================
-- 1. payer_registry — platform-level, mirrors carrier_registry
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_registry (
    id                        SERIAL PRIMARY KEY,
    legal_name                VARCHAR(200) NOT NULL,
    known_aliases             TEXT[],
    tax_id_or_business_number VARCHAR(30),

    first_seen_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at          TIMESTAMP,
    created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payer_registry_name ON payer_registry(LOWER(legal_name));

-- ============================================================
-- 2. payer_credit_assessments
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_credit_assessments (
    id                SERIAL PRIMARY KEY,
    payer_registry_id INTEGER NOT NULL REFERENCES payer_registry(id) ON DELETE CASCADE,

    credit_level      VARCHAR(20) NOT NULL,
    assessment_source VARCHAR(30) NOT NULL,
    assessment_notes  TEXT,

    assessed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessed_by       VARCHAR(100) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payer_credit_current ON payer_credit_assessments(payer_registry_id, assessed_at DESC);

-- ============================================================
-- 3. transaction_halts
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_halts (
    id               SERIAL PRIMARY KEY,
    pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    halt_reason      VARCHAR(40) NOT NULL,
    halt_detail      JSONB DEFAULT '{}',

    halted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    halted_by        VARCHAR(20) NOT NULL DEFAULT 'system_auto',

    resumed_at       TIMESTAMP,
    resumed_by       VARCHAR(100),
    resolution_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_halts_active ON transaction_halts(pipeline_load_id) WHERE resumed_at IS NULL;

-- ============================================================
-- 4. carrier_banking_details — new (not in base spec, see finding #2)
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_banking_details (
    carrier_registry_id   INTEGER PRIMARY KEY REFERENCES carrier_registry(id) ON DELETE CASCADE,
    bank_name             VARCHAR(200),
    routing_number        VARCHAR(20),
    account_number_last4  VARCHAR(4),
    account_holder_name   VARCHAR(200),
    recorded_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 5. Additive linkage columns
-- ============================================================
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS payer_registry_id INTEGER REFERENCES payer_registry(id);
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS concentration_cap_pct NUMERIC(5,2);

-- ============================================================
-- 6. v_payer_concentration_exposure — corrected per finding #1
-- ============================================================
CREATE OR REPLACE VIEW v_payer_concentration_exposure AS
SELECT fn_myra_tenant_id()::integer AS tenant_id,
       pr.id AS payer_registry_id, pr.legal_name,
       SUM(pl.agreed_rate) AS open_exposure,
       SUM(pl.agreed_rate) / NULLIF(
           (SELECT SUM(agreed_rate) FROM pipeline_loads
            WHERE stage IN ('booked','dispatched','delivered') AND agreed_rate IS NOT NULL), 0
       ) AS concentration_pct
FROM pipeline_loads pl
JOIN payer_registry pr ON pr.id = pl.payer_registry_id
WHERE pl.stage IN ('booked', 'dispatched', 'delivered') AND pl.agreed_rate IS NOT NULL
GROUP BY pr.id, pr.legal_name;

-- ============================================================
-- 7. Classifier extension — additive rows only, existing 5 rows untouched
-- ============================================================
INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version) VALUES
(2, 'payer_risk', '{}'::jsonb, 'high', 1440,
  'Review payer credit before extending further exposure.', 1),
(2, 'transaction_halt', '{}'::jsonb, 'critical', 15,
  'Immediate human review required — transaction halted automatically.', 1)
ON CONFLICT (tenant_id, source_module, version) DO NOTHING;
