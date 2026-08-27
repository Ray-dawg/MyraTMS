-- 052: T-22 objection_playbook — formalizes the sell-side static
-- OBJECTION_PLAYBOOK array (lib/pipeline/objection-playbook.ts, untouched)
-- into a shared, DB-backed table both directions read. No tenant_id: this
-- is a platform-global knowledge base, same precedent as carrier_registry
-- (migration 044). Seed data lives in 052_seed_objection_playbook.ts, not
-- in this file — the sell-side rows are seeded by importing the live
-- source array programmatically so "zero drift" is guaranteed by
-- construction, not by a second hand-typed copy that can silently rot.

CREATE TABLE IF NOT EXISTS objection_playbook (
    id                   SERIAL PRIMARY KEY,
    counterparty_type    VARCHAR(10) NOT NULL,   -- 'shipper' | 'carrier'
    objection_type        VARCHAR(40) NOT NULL,
    objection_label         VARCHAR(100) NOT NULL,
    response                  TEXT NOT NULL,
    alternate_response         TEXT,
    follow_up_question           TEXT,
    escalate_after                 INTEGER DEFAULT 0,
    priority                        INTEGER NOT NULL,
    is_active                        BOOLEAN DEFAULT true,

    UNIQUE (counterparty_type, objection_type)
);

CREATE INDEX IF NOT EXISTS idx_objection_playbook_type ON objection_playbook(counterparty_type, is_active);
