-- ============================================================================
-- 043 — M3 RATE-CON GATE + M4 CARRIER VERIFICATION SCHEMA (E2-03)
-- ============================================================================
-- Spec: Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md §7 (M3), §8 (M4)
-- Plan: MyraTMS/docs/superpowers/plans/2026-08-26-e2-03-m3-m4-dispatch-gate.md
--
-- Two small, unrelated-but-bundled additions:
--   1. carriers.contact_email — carriers has contact_name/contact_phone but
--      no email column at all. A real gap: PRD §7/D5 wants "email first" for
--      rate-con delivery and there was nowhere to send it.
--   2. loads.rate_con_sent_at/rate_con_send_status/rate_con_send_error — the
--      "attempted and logged" record PRD §7's confirmation gate needs before
--      dispatch is allowed to flip to 'Dispatched'. rate_con_send_status is
--      one of 'sent' | 'failed' | 'skipped_no_email' (never NULL once the
--      AI-cascade gate has run for a load — NULL means "gate hasn't run",
--      not "nothing to report").
--
-- carriers.verified_at/verified_by/verification_snapshot (M4) already exist
-- from migration 041 — nothing to add there.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout. Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE carriers
  ADD COLUMN IF NOT EXISTS contact_email TEXT;

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS rate_con_sent_at     TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rate_con_send_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS rate_con_send_error  TEXT;

COMMIT;
