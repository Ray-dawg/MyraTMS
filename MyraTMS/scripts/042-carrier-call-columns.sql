-- ============================================================================
-- 042 — CARRIER CALL COLUMNS ON agent_calls (E2-03 M2 foundation)
-- ============================================================================
-- Spec: Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md §6.7
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-25-e2-03-m2-foundation-design.md
--
-- Closes the same shared-column risk E2-03 M0's migration 041 already closed
-- on pipeline_loads (E2-02 §4 item 8), one table over: agent_calls.agreed_rate/
-- profit/outcome are shared between shipper and carrier calls with nothing but
-- call_type to disambiguate a read. No separate carrier_agreed_currency column
-- is needed — a single agent_calls row represents exactly one call (call_type
-- says which), so the row's existing currency column already covers it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS carrier_agreed_rate DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS carrier_outcome     VARCHAR(30),
      -- 'accept' | 'decline' | 'voicemail' | 'no_answer' | 'disconnected' | 'exhausted' | NULL
  ADD COLUMN IF NOT EXISTS carrier_profit      DECIMAL(10,2);

COMMIT;
