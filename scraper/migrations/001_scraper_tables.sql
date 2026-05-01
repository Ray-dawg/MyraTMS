-- ============================================================================
-- T-04A: HEADLESS SCANNER OBSERVABILITY TABLES
-- ============================================================================
-- Source: Engine 2/T04A_Headless_Scanner_Fallback.md §5.1
-- Target: Neon PostgreSQL (serverless), shared with MyraTMS
-- Idempotent: yes (IF NOT EXISTS everywhere)
-- Additive only: no changes to pipeline_loads or any other existing T-02 table.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- scraper_runs — one row per polling cycle, per source.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraper_runs (
    id                  SERIAL PRIMARY KEY,
    source              VARCHAR(50)  NOT NULL,    -- 'dat' | 'truckstop' | '123lb' | 'loadlink'
    tenant_id           INTEGER      NOT NULL DEFAULT 1,

    started_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at        TIMESTAMP,

    status              VARCHAR(20)  NOT NULL DEFAULT 'running',
                        -- 'running' | 'success' | 'partial' | 'failed' | 'auth_required'

    loads_found         INTEGER      DEFAULT 0,
    loads_inserted      INTEGER      DEFAULT 0,
    loads_duplicates    INTEGER      DEFAULT 0,
    loads_skipped       INTEGER      DEFAULT 0,

    error_message       TEXT,
    error_stack         TEXT,

    duration_ms         INTEGER,

    user_agent          VARCHAR(500),
    proxy_used          VARCHAR(200),
    session_reused      BOOLEAN      DEFAULT false,

    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_source_started
    ON scraper_runs(source, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_status
    ON scraper_runs(status, started_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- scraper_log — granular events within a run.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraper_log (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER REFERENCES scraper_runs(id) ON DELETE CASCADE,

    level               VARCHAR(10)  NOT NULL,    -- 'debug' | 'info' | 'warn' | 'error'
    event               VARCHAR(50)  NOT NULL,    -- 'login_attempted' | 'load_parsed' | etc.
    message             TEXT,
    metadata            JSONB,

    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraper_log_run
    ON scraper_log(run_id);

CREATE INDEX IF NOT EXISTS idx_scraper_log_event
    ON scraper_log(event, created_at DESC);

COMMIT;
