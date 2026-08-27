-- ============================================================================
-- 051 — F1: carrier signature confirmation method + confirmer
-- ============================================================================
-- E2-04 review session, V1: there was no exit path from loads.status =
-- 'Awaiting Signature' except a disabled IMAP poller. F1 adds a manual ops
-- override (POST /api/loads/[id]/confirm-carrier-signature), mirroring M3's
-- verbal-confirmation override on the shipper side. These two columns let
-- completeDispatchOnSignedRateCon() record HOW a load was confirmed --
-- 'email_verified' (the IMAP poller matched a verified inbound reply) vs
-- 'manual_ops' (a human recorded it) -- so a manual override never looks
-- identical to a verified inbound reply in any downstream record. A manual
-- override is weaker evidence and must stay distinguishable.
-- ============================================================================

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS carrier_signature_method       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS carrier_signature_confirmed_by  VARCHAR(100);
