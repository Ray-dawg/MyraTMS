-- ============================================================================
-- 057 — T-27 FINANCE ORCHESTRATION
-- ============================================================================
-- Engine 3 Phase 3, Module 1. See Engine 3/T27_Finance_Orchestration.md.
--
-- Schema-reality corrections (see this migration's implementation plan's
-- Global Constraints for full reasoning, not repeated here):
--   1. financing_decisions.tenant_id: spec's literal `INTEGER NOT NULL
--      DEFAULT 1` replaced with `BIGINT NOT NULL REFERENCES tenants(id)
--      DEFAULT fn_myra_tenant_id()` — the same T-19-documented
--      mislabeling-bug correction applied to every tenant-scoped table
--      added since T-20.
--   2. carriers.payment_preference does not exist anywhere in this schema.
--      Added instead on carrier_registry (T-20's platform-level canonical
--      carrier identity table), matching the precedent set by T-25's
--      carrier_banking_details.
--   3. financing_decisions.route_selected widened from the spec's
--      VARCHAR(4) to VARCHAR(10) — VARCHAR(4) cannot hold the literal
--      'DECLINE' (7 chars) that decideRoute() returns.
--   4. Acceptance criteria 1 and 6 (exact match to Pilot 1's worked
--      $12.00/$3.81/$91.28/self-funding example) are OPEN — the source
--      document (Pilot 1's Financial Architecture §6) does not exist
--      anywhere in this repository. See completion.md's T-27 entry.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'carrier_registry') THEN
        RAISE EXCEPTION 'carrier_registry not found — migration 044 (T-20) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payer_credit_assessments') THEN
        RAISE EXCEPTION 'payer_credit_assessments not found — migration 055 (T-25) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_policies') THEN
        RAISE EXCEPTION 'tenant_policies not found — migration 035 (T-19) must be applied first';
    END IF;
END $$;

-- 1. treasury_policy — extends T-19's tenant_policies (spec §4.1, verbatim)
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS treasury_policy JSONB DEFAULT
  '{"quick_pay_discount_pct": 2.5, "factoring_fee_pct": 5.0, "float_cap_usd": null, "float_cap_cad": null}';

-- 2. carrier_registry.payment_preference — new (not in base spec, see finding #2)
ALTER TABLE carrier_registry ADD COLUMN IF NOT EXISTS payment_preference VARCHAR(20);
-- values: 'quick_pay' | 'net_30'; NULL = no preference recorded (treated as net_30/false)

-- 3. financing_decisions (spec §4.2, corrected per findings #1 and #3)
CREATE TABLE IF NOT EXISTS financing_decisions (
    id                       SERIAL PRIMARY KEY,
    pipeline_load_id         INTEGER NOT NULL REFERENCES pipeline_loads(id),
    tenant_id                BIGINT NOT NULL REFERENCES tenants(id) DEFAULT fn_myra_tenant_id(),

    payer_credit_level_at_decision        VARCHAR(20) NOT NULL,
    carrier_payment_preference            VARCHAR(20) NOT NULL,
    float_capacity_available_at_decision  BOOLEAN NOT NULL,

    route_selected           VARCHAR(10) NOT NULL,
    capital_days_projected   NUMERIC(10,2),
    yield_projected          NUMERIC(10,4),

    decided_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by               VARCHAR(20) NOT NULL DEFAULT 'system_auto',
    override_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_financing_decisions_load ON financing_decisions(pipeline_load_id);
CREATE INDEX IF NOT EXISTS idx_financing_decisions_tenant ON financing_decisions(tenant_id, decided_at DESC);

-- 4. v_float_exposure (spec §4.3, verbatim — fd.tenant_id is now correctly sourced)
CREATE OR REPLACE VIEW v_float_exposure AS
SELECT fd.tenant_id,
       SUM(CASE WHEN fd.route_selected IN ('T1', 'T2') THEN pl.agreed_rate ELSE 0 END) AS current_float_usd,
       (tp.treasury_policy->>'float_cap_usd')::numeric AS float_cap_usd
FROM financing_decisions fd
JOIN pipeline_loads pl ON pl.id = fd.pipeline_load_id
JOIN tenant_policies tp ON tp.tenant_id = fd.tenant_id AND tp.is_active
WHERE pl.stage IN ('booked', 'dispatched', 'delivered')
GROUP BY fd.tenant_id, tp.treasury_policy;

-- 5. Adapter records (spec §4.4, verbatim)
CREATE TABLE IF NOT EXISTS factoring_submissions (
    id SERIAL PRIMARY KEY, pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id),
    ecapital_reference_id VARCHAR(100), status VARCHAR(20) DEFAULT 'not_submitted',
    -- mirrors existing TMS field values: 'N/A' | 'Submitted' | 'Approved' | 'Funded'
    advance_rate NUMERIC(5,2), fee_pct NUMERIC(5,2), submitted_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);

CREATE TABLE IF NOT EXISTS quick_pay_disbursements (
    id SERIAL PRIMARY KEY, pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id),
    carrier_registry_id INTEGER REFERENCES carrier_registry(id),
    amount NUMERIC(10,2), discount_applied NUMERIC(10,2), stripe_transfer_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending', disbursed_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);

CREATE TABLE IF NOT EXISTS kyc_verifications (
    id SERIAL PRIMARY KEY, entity_type VARCHAR(20) NOT NULL, entity_id INTEGER NOT NULL,
    verification_status VARCHAR(20) DEFAULT 'pending', persona_reference_id VARCHAR(100),
    verified_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);
