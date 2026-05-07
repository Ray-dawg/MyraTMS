-- =============================================================================
-- Migration 031 — tenant_usage table
--
-- Spec: docs/architecture/ADR-003-feature-gating.md §Usage tracking
--
-- Hot-path metered counts live in Redis (lib/usage/tracker.ts). This table
-- is the durable store: a daily aggregation cron (Phase 4.4 follow-up) reads
-- the Redis counters and persists them here so dashboards and historical
-- reports survive a Redis flush.
--
-- Schema:
--   (tenant_id, period_start, key) is the unique row.
--   period is one of 'monthly' | 'daily' | 'concurrent' (mirrors LIMIT_PERIODS
--   in lib/features/index.ts).
--   value is whole numeric (counts, minutes, etc) — no fractional usage.
--
-- RLS: Cat A (per-tenant). Policy added by 029 catch-up section below.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_usage (
    id           BIGSERIAL    PRIMARY KEY,
    tenant_id    BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key          VARCHAR(60)  NOT NULL,
                 -- one of LIMIT_KEYS in lib/features/index.ts
    period       VARCHAR(20)  NOT NULL
                 CHECK (period IN ('monthly', 'daily', 'concurrent')),
    period_start TIMESTAMPTZ  NOT NULL,
                 -- Floor of the bucket. monthly = first day of month UTC at 00:00,
                 -- daily = day UTC at 00:00, concurrent = always NOW() at write time
                 -- (concurrent rows are upserted, not appended).
    value        BIGINT       NOT NULL DEFAULT 0,
    written_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                 -- When the daily aggregator persisted this row.
    UNIQUE (tenant_id, key, period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant_period
    ON tenant_usage (tenant_id, period, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_key_period
    ON tenant_usage (key, period, period_start DESC);

-- RLS — same policy shape as the other Cat A tables added in 029.
ALTER TABLE tenant_usage ADD CONSTRAINT IF NOT EXISTS tenant_usage_tenant_check
    CHECK (tenant_id > 0);

CREATE POLICY tenant_usage_tenant_isolation
    ON tenant_usage
    FOR ALL
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)::bigint
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant_id', true)::bigint
    );

CREATE POLICY tenant_usage_service_admin_bypass
    ON tenant_usage
    FOR ALL
    USING (current_setting('app.role', true) = 'service_admin')
    WITH CHECK (current_setting('app.role', true) = 'service_admin');

-- Per RLS_ROLLOUT.md: policies are CREATED but RLS is NOT enabled on this
-- migration. Phase M3 enables across all Cat A tables in batches with a
-- monitoring window between each.
--
-- The daily aggregation cron (Phase 4.4 follow-up) writes via
-- asServiceAdmin so it bypasses RLS once enabled.
