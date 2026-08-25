-- ============================================================================
-- 034 — T-18 AGENT RUNTIME & GOVERNANCE
-- ============================================================================
-- Engine 3, Phase 1, Module 2 of 3. Spec: Engine 3/T18_Agent_Runtime_Governance.md
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-t18-agent-runtime-governance-design.md
--
-- Ships in shadow mode only: evaluateAuthority() has no callers inside any
-- live worker. This migration is purely additive — no triggers on, or
-- alterations to, any existing Engine 2 table.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout, safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- agents — registry. Seeded by scripts/t18_seed_governance.ts, not here
-- (the seed data must read live env vars, which SQL can't do).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
    id              SERIAL PRIMARY KEY,
    agent_key       VARCHAR(40)  UNIQUE NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    agent_type      VARCHAR(30)  NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'shadow',
    description     TEXT,
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────────────────────
-- authority_envelopes — versioned policy object per (agent, tenant).
--
-- ON DELETE CASCADE on agent_id: agents is a brand-new T-18 table, never
-- deleted by live worker code (agents are deactivated via status, not
-- removed) — only test/ops cleanup ever deletes a row here, same reasoning
-- as T-17's pipeline_loads cascade.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_envelopes (
    id                    SERIAL PRIMARY KEY,
    agent_id              INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tenant_id             INTEGER NOT NULL DEFAULT 1,
    version               INTEGER NOT NULL DEFAULT 1,

    envelope_name         VARCHAR(100) NOT NULL,
    permissions           JSONB NOT NULL DEFAULT '{"can": [], "cannot": []}',
    tools                 JSONB NOT NULL DEFAULT '[]',
    budget                JSONB NOT NULL DEFAULT '{}',
    policies              JSONB NOT NULL DEFAULT '{}',
    confidence_threshold  NUMERIC(4,3) DEFAULT 0.700,
    autonomy_default      VARCHAR(2) NOT NULL DEFAULT 'L2',
    escalation_rules      JSONB NOT NULL DEFAULT '[]',

    is_active             BOOLEAN NOT NULL DEFAULT true,
    effective_from        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by            VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (agent_id, tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_envelopes_active ON authority_envelopes(agent_id, tenant_id) WHERE is_active;

-- ────────────────────────────────────────────────────────────────────────────
-- authority_evaluations — append-only decision log.
--
-- UNIQUE (source_event_id) is a correction, not a spec deviation: T-18 §7
-- says in prose "Idempotent via a source_event_id uniqueness check", but the
-- base spec's DDL (§4.3) never declares that constraint. Added here so the
-- replay harness's re-run safety is real, not just described. NULL values
-- (ad-hoc evaluateAuthority() calls with no source event) are never
-- considered duplicates of each other — standard SQL NULL semantics — so
-- this only dedupes actual replay-harness re-runs.
--
-- agent_id also cascades, same reasoning as authority_envelopes above.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_evaluations (
    id                     BIGSERIAL PRIMARY KEY,
    envelope_id            INTEGER NOT NULL REFERENCES authority_envelopes(id),
    agent_id               INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tenant_id              INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    action                 VARCHAR(60) NOT NULL,
    context                JSONB NOT NULL DEFAULT '{}',

    autonomy_level_applied VARCHAR(2) NOT NULL,
    decision               VARCHAR(20) NOT NULL,
    reason                 TEXT,

    shadow_mode            BOOLEAN NOT NULL DEFAULT true,
    source_event_id        BIGINT REFERENCES events(id),

    evaluated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id         VARCHAR(100),

    UNIQUE (source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluations_agent_time ON authority_evaluations(agent_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_decision ON authority_evaluations(decision, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_load ON authority_evaluations(pipeline_load_id);

-- ────────────────────────────────────────────────────────────────────────────
-- escalations — L3 queue, seeds T-24's console. Informational only in
-- shadow mode; ON DELETE CASCADE on pipeline_load_id for the same reason
-- as T-17's events table (pipeline_loads is never deleted in production
-- code, only test/ops scripts).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
    id                  SERIAL PRIMARY KEY,
    evaluation_id       INTEGER NOT NULL REFERENCES authority_evaluations(id),
    tenant_id           INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id    INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    severity            VARCHAR(20) NOT NULL DEFAULT 'medium',
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',

    assigned_to         VARCHAR(100),
    resolution_note     TEXT,

    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(tenant_id, status, created_at);

COMMIT;
