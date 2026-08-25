-- ============================================================================
-- 041 — SELL-SIDE EXPANSION SCHEMA (E2-03 M0/M1/M4)
-- ============================================================================
-- Spec: Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md §6.6, §5.4, §8
-- Investigation this responds to: Engine 2/E2-02_SellSide_Investigation_Report.md
--
-- Foundation only. No live-path code reads or writes these columns as of this
-- migration landing — the M0 fix (dispatcher-worker.ts), the webhook carrier
-- branch (retell-webhook.ts), and the M4 verification precondition are built
-- in the same PR wave but land as separate, independently-reviewable diffs.
--
-- Four things bundled here because they're all small, additive, and share the
-- E2-03 M0/M1/M4 lineage:
--   1. agent_calls.call_type CHECK constraint — closes E2-02 §4 item 8 (the
--      shared-column collision risk: today every call is hardcoded
--      'outbound_shipper' in application code, nothing in the DB enforces
--      the vocabulary). Column is VARCHAR(30) NOT NULL with no DB-level
--      DEFAULT (confirmed via pipeline_migrations.sql:167 — the
--      'outbound_shipper' literal is application-level only), so no
--      DROP DEFAULT is needed here.
--   2. pipeline_loads carrier-outcome columns (E2-03 §6.6) — deliberately
--      separate from the shipper's agreed_rate/profit columns, not reused.
--   3. loads.carrier_cost_estimated (E2-03 §5.4.2) — the M0 fallback-rate
--      honesty flag; lands here (ahead of its nominal M1 slot) purely for
--      migration-sequencing convenience, same pattern the PRD itself notes
--      at §6.6 ("M0 fix, lands here too").
--   4. carriers Gate-2 verification columns (E2-03 §8 / M4).
--
-- verified_by is VARCHAR(100), matching the established convention for
-- "who did this" columns on E2-01's parallel gate (see 040_shipper_direct_
-- gate.sql:41, attested_by VARCHAR(100)) rather than an INTEGER FK to
-- users(id) — this codebase has no existing INTEGER-FK "_by" precedent to
-- match instead (grepped scripts/*.sql for promoted_by/assigned_by/attested_by
-- and found only the VARCHAR(100) pattern).
--
-- exceptions.pipeline_load_id/source_module/suggested_action/sla_due_at are
-- ALSO added by E2-01's 040_shipper_direct_gate.sql — but that migration is
-- still on E2-01's own unmerged branch as of this writing, not yet on master
-- (confirmed: master's HEAD has no 040 file). M0's escalation branch
-- (dispatcher-worker.ts) needs these columns to exist regardless of merge
-- order between the two independent PRDs, so this migration adds them here
-- too, via the identical ADD COLUMN IF NOT EXISTS DDL. Whichever of 040 or
-- 041 lands first on a given database creates them; the other is a clean
-- no-op. Same reconciliation pattern E2-01 itself used for co_broker_
-- agreements against T-19's migration 035 — see E2-01's session-1 design doc.
--
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout, CHECK
-- constraint guarded via information_schema/pg_constraint probe (matching
-- 032-carrier-status-prospect.sql's DO $$ ... END $$ pattern, since Postgres
-- has no native "ADD CONSTRAINT IF NOT EXISTS"). Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- agent_calls: call_type vocabulary constraint (E2-02 §4 item 8)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agent_calls_call_type'
      AND conrelid = 'agent_calls'::regclass
  ) THEN
    ALTER TABLE agent_calls
      ADD CONSTRAINT chk_agent_calls_call_type
      CHECK (call_type IN ('outbound_shipper', 'outbound_carrier'));
  END IF;
END
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- pipeline_loads: carrier-side outcome columns (E2-03 §6.6)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS carrier_agreed_rate      DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS carrier_agreed_currency   VARCHAR(3),
  ADD COLUMN IF NOT EXISTS carrier_call_outcome      VARCHAR(30),
      -- 'accept' | 'decline' | 'voicemail' | 'no_answer' | 'disconnected' | 'exhausted' | NULL
  ADD COLUMN IF NOT EXISTS carrier_id_secured        TEXT REFERENCES carriers(id),
  ADD COLUMN IF NOT EXISTS carrier_cascade_position  INTEGER,
  ADD COLUMN IF NOT EXISTS carrier_profit            DECIMAL(10,2);

-- ────────────────────────────────────────────────────────────────────────────
-- loads: M0's zero-rate-fallback honesty flag (E2-03 §5.4.2)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS carrier_cost_estimated BOOLEAN DEFAULT false;

-- ────────────────────────────────────────────────────────────────────────────
-- carriers: Gate 2 verification columns (E2-03 §8 / M4)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE carriers
  ADD COLUMN IF NOT EXISTS verified_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verified_by           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS verification_snapshot JSONB;

-- Index for the Dispatcher/M3 precondition-check query path.
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_carrier_call_outcome
  ON pipeline_loads (carrier_call_outcome)
  WHERE carrier_call_outcome IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- exceptions: T-24 §4.2 columns M0's escalation branch needs, added
-- independently of E2-01's 040 migration (see header note above — order-
-- independent, identical DDL to 040_shipper_direct_gate.sql).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE exceptions
  ADD COLUMN IF NOT EXISTS pipeline_load_id  INTEGER REFERENCES pipeline_loads(id),
  ADD COLUMN IF NOT EXISTS source_module     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS suggested_action  TEXT,
  ADD COLUMN IF NOT EXISTS sla_due_at        TIMESTAMP;

COMMIT;
