-- 045: T-21 Pricing Engine
-- Engine 3 Phase 2, Module 2. See Engine 3/T21_Pricing_Engine.md.
--
-- Same tenant_id correction as migration 044/T-20: BIGINT NOT NULL DEFAULT
-- fn_myra_tenant_id(), never INTEGER NOT NULL DEFAULT 1. See wave1.md before
-- touching this file again.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id'
    ) THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS pricing_engine_requests (
    id                     BIGSERIAL PRIMARY KEY,
    tenant_id              BIGINT NOT NULL DEFAULT fn_myra_tenant_id(),
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    direction                VARCHAR(10) NOT NULL,   -- 'sell' | 'buy'
    request_source              VARCHAR(30) NOT NULL,
    -- 'engine2_researcher_shadow' | 'engine2_researcher_live' |
    -- 'dispatch_one' | 'shadow_comparison'

    input_params                   JSONB NOT NULL,
    output_envelope                   JSONB NOT NULL,
    margin_source_used                   VARCHAR(20) NOT NULL,  -- 'tenant_override' | 'myra_default'

    computed_at                             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pricing_requests_load ON pricing_engine_requests(pipeline_load_id);
CREATE INDEX IF NOT EXISTS idx_pricing_requests_direction ON pricing_engine_requests(direction, tenant_id);
