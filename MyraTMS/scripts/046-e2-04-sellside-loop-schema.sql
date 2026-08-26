-- ============================================================================
-- 046 — E2-04 SELL-SIDE AUTONOMOUS LOOP SCHEMA
-- ============================================================================
-- Spec: Engine 2/E2-04_SellSide_Autonomous_Loop_PRD.md §5
-- Plan: MyraTMS/docs/superpowers/plans/2026-08-26-e2-04-sellside-autonomous-loop.md
--
-- Migration number note: 044/045 exist on disk as another session's
-- uncommitted, untracked work (T-20 carrier intelligence, T-21 pricing
-- engine) — confirmed via `git status` before picking this number. This
-- migration does not depend on either.
--
-- Four things:
--   1. pipeline_loads gains the shipper-confirmation columns (§5) —
--      confirmation token/expiry/timestamps, the immutable snapshot, the
--      confirmed_rate that becomes the sole source for carrier envelope
--      math from M3 onward (never agreed_rate again), plus the paper-trail
--      timestamps for the shipper/carrier rate-con round trip.
--   2. shipper_email — the M0 write target (retell-webhook.ts's
--      determinePipelineStage()/updatePipelineLoad() already wired this
--      session; this is the column that makes it real).
--   3. inbound_emails — every message the M4 IMAP poller touches, matched
--      or not, writes a row here. Silent drops are how paper trails
--      develop holes (§8).
--   4. personas.call_type — closes E2-02 §3.6 item 21 BEFORE the carrier
--      brief compiler (M5) ever reads personas. Existing 3 rows default to
--      'outbound_shipper'; 3 new 'outbound_carrier' rows seeded here with
--      placeholder Retell agent IDs — real IDs land when the operator
--      configures the 3 carrier-facing agents in the Retell dashboard,
--      same deferred-config pattern the original 3 shipper personas used.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
-- throughout. Safe to re-run. Applied as individual non-transactional
-- statements against @neondatabase/serverless's .query() — confirmed this
-- session that multi-statement text in one call fails with "cannot insert
-- multiple commands into a prepared statement".
-- ============================================================================

ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS shipper_email                    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS confirmation_token                VARCHAR(64),
  ADD COLUMN IF NOT EXISTS confirmation_token_expires_at     TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at               TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_nudged_at             TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmed_at                       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmed_rate                     DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS confirmed_rate_currency            VARCHAR(3),
  ADD COLUMN IF NOT EXISTS confirmation_snapshot              JSONB,
  ADD COLUMN IF NOT EXISTS confirmation_outcome               VARCHAR(20),
  ADD COLUMN IF NOT EXISTS decline_reason                     TEXT,
  ADD COLUMN IF NOT EXISTS shipper_ratecon_returned_at        TIMESTAMP,
  ADD COLUMN IF NOT EXISTS carrier_ratecon_signed_at          TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_confirmation_token
  ON pipeline_loads(confirmation_token) WHERE confirmation_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound_emails (
    id                 SERIAL PRIMARY KEY,
    message_id         VARCHAR(255) NOT NULL UNIQUE,
    from_address       VARCHAR(255) NOT NULL,
    subject            TEXT,
    body_text          TEXT,
    received_at        TIMESTAMP NOT NULL,
    matched_load_id    INTEGER REFERENCES pipeline_loads(id),
    match_method       VARCHAR(30),
    sender_verified    BOOLEAN NOT NULL DEFAULT false,
    verification_note  TEXT,
    reply_type         VARCHAR(30),
    attachment_count   INTEGER DEFAULT 0,
    processed_at       TIMESTAMP,
    quarantined        BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbound_emails_load ON inbound_emails(matched_load_id, received_at DESC);

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS call_type VARCHAR(30) NOT NULL DEFAULT 'outbound_shipper';

-- 3 carrier-facing personas (M5 brief compiler reads call_type='outbound_carrier').
-- is_active=false until the operator configures real Retell agent IDs for
-- these in the dashboard (same deferred pattern as the original 3 shipper
-- personas) -- placeholder retell_agent_id_en values are NOT dialable.
INSERT INTO personas (persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
SELECT * FROM (VALUES
  ('carrier_direct', 'PENDING_RETELL_AGENT_ID', 'Direct, efficient carrier-facing negotiator. Leads with the load and rate.', 'direct',
   'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Be direct and efficient. Lead with lane, equipment, and rate. Close decisively within the negotiation envelope.',
   false, 'outbound_carrier', 1.00, 1.00),
  ('carrier_relationship', 'PENDING_RETELL_AGENT_ID', 'Relationship-driven carrier-facing negotiator. References carrier history.', 'warm',
   'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Reference the carrier''s history with Myra where available. Build rapport, then present the load and rate.',
   false, 'outbound_carrier', 1.00, 1.00),
  ('carrier_data_driven', 'PENDING_RETELL_AGENT_ID', 'Data-driven carrier-facing negotiator. Leads with lane stats and market rate.', 'precise',
   'You are a freight broker dispatcher negotiating with a carrier on behalf of Myra Logistics to secure this load. Lead with lane statistics and market rate data. Present the offer as the data-backed number for this lane.',
   false, 'outbound_carrier', 1.00, 1.00)
) AS v(persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
WHERE NOT EXISTS (SELECT 1 FROM personas WHERE persona_name = v.persona_name);
