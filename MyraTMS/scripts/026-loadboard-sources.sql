-- ============================================================================
-- 026: Load board source registry (Sprint 6.5 — official-API ingest path)
-- ============================================================================
-- Purpose: single source of truth for "is this load board ingested via API,
-- via the headless scraper, or off?". Both the Vercel-hosted MyraTMS API
-- path and the Railway-hosted standalone scraper read this table; flipping a
-- row here is the cutover.
--
-- Why a dedicated table (not env vars): env vars live in two different
-- deployment env stores (Vercel + Railway). A DB row is the only place both
-- services can read the SAME state atomically. Flipping ingest_method='api'
-- atomically (a) tells the API path to start polling and (b) tells the
-- scraper to stop polling — same transaction commit, no coordination
-- protocol needed.
--
-- Idempotent: yes (IF NOT EXISTS everywhere; ON CONFLICT DO NOTHING for seed).
-- Additive: no changes to any existing T-02 / pipeline_loads table.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loadboard_sources (
    source                  VARCHAR(50)  PRIMARY KEY,
                            -- 'dat' | 'truckstop' | '123lb' | 'loadlink'

    ingest_method           VARCHAR(20)  NOT NULL DEFAULT 'disabled',
                            -- 'api'     → MyraTMS Vercel cron polls the official API
                            -- 'scrape'  → Railway headless scraper polls the website
                            -- 'disabled'→ no polling at all (dark)
                            -- 'cutover' → transient state during scrape→api switch
                            --             (neither service polls — drains in-flight work)

    integration_id          UUID         REFERENCES integrations(id) ON DELETE SET NULL,
                            -- NULL when ingest_method != 'api'.
                            -- When 'api', points to the integrations row holding
                            -- the API credentials (api_key, api_secret, config jsonb).

    poll_interval_minutes   INTEGER      NOT NULL DEFAULT 5,
                            -- How often each service should poll. Throttled in code.

    rate_limit_per_minute   INTEGER      DEFAULT 30,
                            -- API rate cap enforced via Redis token bucket.

    last_polled_at          TIMESTAMP,
                            -- Updated by the active service on each poll.
                            -- Used to throttle the cron's "should we poll now?" check.

    notes                   TEXT,

    created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

    -- Mutually-exclusive states only.
    CONSTRAINT loadboard_sources_ingest_method_chk
        CHECK (ingest_method IN ('api', 'scrape', 'disabled', 'cutover')),

    -- 'api' requires a credential link; other states must not have one.
    CONSTRAINT loadboard_sources_api_requires_integration_chk
        CHECK (
            (ingest_method = 'api' AND integration_id IS NOT NULL) OR
            (ingest_method != 'api')
        )
);

CREATE INDEX IF NOT EXISTS idx_loadboard_sources_ingest_method
    ON loadboard_sources(ingest_method);

-- ──────────────────────────────────────────────────────────────────────────
-- Seed the four current sources. DAT defaults to 'scrape' (matches the
-- current Railway scraper's only enabled board); the other three are
-- 'disabled' until either the scraper adapter is built OR the official
-- API is provisioned.
INSERT INTO loadboard_sources (source, ingest_method, poll_interval_minutes, rate_limit_per_minute, notes)
VALUES
  ('dat',       'scrape',   5,  30, 'using Railway headless scraper until DAT API access lands'),
  ('truckstop', 'disabled', 10, 60, 'awaiting onboarding (API or scraper adapter)'),
  ('123lb',     'disabled', 10, 60, 'awaiting onboarding'),
  ('loadlink',  'disabled', 15, 30, 'awaiting Canadian onboarding (Loadlink uses SOAP)')
ON CONFLICT (source) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- Auto-bump updated_at on row changes — operators see when each cutover
-- happened without needing audit log queries.
CREATE OR REPLACE FUNCTION loadboard_sources_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loadboard_sources_updated_at_trg ON loadboard_sources;
CREATE TRIGGER loadboard_sources_updated_at_trg
BEFORE UPDATE ON loadboard_sources
FOR EACH ROW
EXECUTE FUNCTION loadboard_sources_set_updated_at();

COMMIT;
