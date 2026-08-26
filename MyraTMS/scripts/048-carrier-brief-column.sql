-- ============================================================================
-- 048 — E2-04 M5: pipeline_loads.carrier_brief
-- ============================================================================
-- CarrierBriefCompilerWorker (lib/workers/carrier-brief-compiler-worker.ts)
-- writes the computed carrier-facing brief here once, keyed by pipeline
-- load: the ranked carrier stack snapshot, the negotiation envelope, and
-- the Thompson-Sampled persona/Retell agent id. carrier-voice-worker.ts
-- reads it back on every cascade step (first dial AND every retry), not
-- just the first job's payload -- retell-webhook.ts's enqueueCascadeStep()
-- rebuilds re-enqueue payloads from scratch (cascadePosition/
-- voicemailRetryCount only), so anything the brief computed would be lost
-- on a retry if it only lived in the BullMQ job data. A DB column, read
-- fresh each dial, survives every cascade step for free.
--
-- JSONB, not a new table: this is the same pattern pipeline_loads already
-- uses for confirmation_snapshot (E2-04 M1) -- one computed-once blob per
-- load, no independent lifecycle of its own, doesn't need joins or its own
-- indexes.
-- ============================================================================

ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS carrier_brief JSONB;
