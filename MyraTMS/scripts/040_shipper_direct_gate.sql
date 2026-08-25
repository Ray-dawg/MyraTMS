-- ============================================================================
-- 040 — SHIPPER-DIRECT HARD GATE (E2-01 M1 Session 1)
-- ============================================================================
-- Spec: Engine 2/E2-01_Engine2_Expansion_PRD.md §4.10
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-e2-01-m1-session1-design.md
--
-- Foundation only. No live-path code reads or writes these columns yet —
-- that starts in E2-01 Session 2 (qualifier-worker.ts F0/F1 wiring).
--
-- co_broker_agreements deliberately does NOT match the PRD's literal §4.10.4
-- text. It matches T-19's already-drafted (not yet applied) migration 035
-- instead: tenant_id BIGINT REFERENCES tenants(id), no DEFAULT 1 literal.
-- Whichever of 035 or 040 runs first creates the table; CREATE TABLE IF NOT
-- EXISTS makes the other a clean no-op. See design doc §2 for the full
-- reconciliation.
--
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout. Safe to
-- re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- pipeline_loads: poster identity + classification block
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS poster_company_raw          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS poster_company_normalized   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS poster_mc_number            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS poster_dot_number            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS poster_raw_html             TEXT,
  ADD COLUMN IF NOT EXISTS poster_registry_id          INTEGER,
  ADD COLUMN IF NOT EXISTS load_source_class           VARCHAR(20),
      -- 'shipper_direct' | 'co_brokered' | 'broker_posted' | 'carrier_reposted' | 'unresolved'
  ADD COLUMN IF NOT EXISTS load_source_method          VARCHAR(30),
      -- 'registry' | 'fmcsa_authority' | 'co_broker_agreement' | 'manual_attestation' | 'heuristic' | 'human_review'
  ADD COLUMN IF NOT EXISTS load_source_confidence      NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS load_source_evaluated_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS load_source_evidence        JSONB,
  ADD COLUMN IF NOT EXISTS shipper_direct_attestation  VARCHAR(10),   -- 'yes' | 'no' | 'unknown' | NULL (board-sourced)
  ADD COLUMN IF NOT EXISTS attested_by                 VARCHAR(100),
  ADD COLUMN IF NOT EXISTS attested_at                 TIMESTAMP,
  ADD COLUMN IF NOT EXISTS qualification_detail        TEXT;

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_source_class ON pipeline_loads(load_source_class, stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_poster_mc    ON pipeline_loads(poster_mc_number) WHERE poster_mc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_poster_norm  ON pipeline_loads(poster_company_normalized);

-- ────────────────────────────────────────────────────────────────────────────
-- poster_registry (platform-level, no tenant_id — a broker for one tenant is
-- a broker for all tenants)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poster_registry (
    id                    SERIAL PRIMARY KEY,
    legal_name            VARCHAR(200),
    normalized_name       VARCHAR(200) NOT NULL,
    mc_number             VARCHAR(20),
    dot_number            VARCHAR(20),
    cvor_number           VARCHAR(20),
    country               VARCHAR(2),
    province_state        VARCHAR(10),
    entity_class          VARCHAR(20) NOT NULL,
        -- 'broker' | 'carrier_for_hire' | 'carrier_private' | 'shipper' | 'unknown'
    class_source          VARCHAR(30) NOT NULL,
        -- 'seed_shipper_list' | 'seed_mines_dossier' | 'seed_broker_list' | 'fmcsa_authority' | 'heuristic' | 'human_review'
    confidence            NUMERIC(3,2) NOT NULL,
    authority_snapshot    JSONB,
    last_verified_at      TIMESTAMP,
    verified_by           VARCHAR(100),
    posting_count         INTEGER NOT NULL DEFAULT 0,
    first_seen_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes                 TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_registry_mc   ON poster_registry(mc_number)  WHERE mc_number  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_registry_dot  ON poster_registry(dot_number) WHERE dot_number IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_poster_registry_name ON poster_registry(normalized_name, country);

-- ────────────────────────────────────────────────────────────────────────────
-- authority_lookups (audit + cache for every external lookup attempt)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_lookups (
    id              SERIAL PRIMARY KEY,
    lookup_key      VARCHAR(250) NOT NULL,    -- 'mc:123456' | 'dot:7890' | 'name:{normalized}|CA'
    provider        VARCHAR(30)  NOT NULL,    -- 'fmcsa_qcmobile' | 'fmcsa_safer' | 'on_cvor' | 'none'
    status          VARCHAR(20)  NOT NULL,    -- 'resolved' | 'not_found' | 'ambiguous' | 'error'
    entity_class    VARCHAR(20),
    request         JSONB,
    response        JSONB,
    latency_ms      INTEGER,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_authority_lookups_key ON authority_lookups(lookup_key, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- co_broker_agreements — T-19's shape (migration 035), created here if 035
-- hasn't landed first. See header note above.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS co_broker_agreements (
    id                      SERIAL PRIMARY KEY,
    tenant_id               BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    counterparty_name       VARCHAR(200) NOT NULL,
    counterparty_mc_number  VARCHAR(20),
    agreement_executed_at   DATE NOT NULL,
    agreement_document_url  TEXT,
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'terminated'
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- M1 addition (additive to T-19's shape): normalized name for MC-less Canadian counterparties
ALTER TABLE co_broker_agreements ADD COLUMN IF NOT EXISTS counterparty_name_normalized VARCHAR(200);
CREATE INDEX IF NOT EXISTS idx_co_broker_agreements_mc   ON co_broker_agreements(counterparty_mc_number) WHERE counterparty_mc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_co_broker_agreements_name ON co_broker_agreements(counterparty_name_normalized);

-- ────────────────────────────────────────────────────────────────────────────
-- exceptions — T-24 §4.2 columns, only if T-24 hasn't landed (confirmed: it hasn't)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE exceptions
  ADD COLUMN IF NOT EXISTS pipeline_load_id  INTEGER REFERENCES pipeline_loads(id),
  ADD COLUMN IF NOT EXISTS source_module     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS suggested_action  TEXT,
  ADD COLUMN IF NOT EXISTS sla_due_at        TIMESTAMP;

COMMIT;
