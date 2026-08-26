-- ============================================================================
-- 049 — E2-04 M6: loads.status gains 'Awaiting Signature'
-- ============================================================================
-- Architecture decision confirmed with the user directly (not inferred):
-- the AI-cascade dispatch gate (lib/dispatch-gate.ts) should not consider a
-- load truly 'Dispatched' until the carrier has returned a SIGNED rate
-- confirmation -- a load whose rate-con was only just sent and never
-- countersigned is not the same state as one a carrier has actually
-- committed to in writing. This is a live status-enum change on a column
-- read throughout the whole TMS app (kanban board, status badges, filters)
-- -- confirmed as the intended scope before applying, given the blast
-- radius, rather than the additive/non-enum alternative.
--
-- Existing loads_status_check: CHECK (status = ANY (ARRAY['Booked',
-- 'Dispatched', 'In Transit', 'Delivered', 'Invoiced', 'Closed'])). Adds
-- 'Awaiting Signature' between Booked and Dispatched in the lifecycle.
--
-- Only the AI-cascade path (loads.pipeline_load_id IS NOT NULL) ever
-- produces this status -- lib/dispatch-gate.ts's runAiCascadeDispatchGate()
-- is scoped, per its own file header, to AI-cascade bookings only; manual
-- human assignments through the same /assign route never reach that gate
-- and keep flipping straight to 'Dispatched' exactly as before. Existing
-- rows and every non-AI-cascade dispatch are unaffected.
--
-- carrier_signature_due_at / carrier_signature_received_at: the 90-minute
-- SLA timer and its resolution timestamp. TIMESTAMPTZ from the start --
-- migration 047 in this same PRD is the reason bare TIMESTAMP is never
-- used again for anything compared against a live clock.
-- ============================================================================

ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_status_check;
ALTER TABLE loads ADD CONSTRAINT loads_status_check
  CHECK (status = ANY (ARRAY['Booked'::text, 'Awaiting Signature'::text, 'Dispatched'::text, 'In Transit'::text, 'Delivered'::text, 'Invoiced'::text, 'Closed'::text]));

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS carrier_signature_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS carrier_signature_received_at TIMESTAMPTZ;
