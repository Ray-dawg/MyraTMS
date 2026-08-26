-- ============================================================================
-- 050 — FIX: documents_type_check missing the E2-04 M1 shipper rate-con types
-- ============================================================================
-- lib/documents.ts's ALLOWED_DOC_TYPES array was updated in E2-04 M1 (commit
-- "shipper-email call-parser field, confirmation schema, stage machine,
-- persona split") to add 'Shipper Rate Confirmation' and 'Shipper Rate
-- Confirmation Reply' -- but the live DB's documents_type_check CHECK
-- constraint was never widened to match. The app-level array passing was
-- never actually exercised until M4's IMAP poller tried to attach a
-- shipper's reply document and hit a real "violates check constraint"
-- error -- caught here, not by the M1 commit's own (app-level-only) tests.
-- ============================================================================

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check
  CHECK (type = ANY (ARRAY[
    'BOL'::text, 'POD'::text, 'Rate Confirmation'::text,
    'Shipper Rate Confirmation'::text, 'Shipper Rate Confirmation Reply'::text,
    'Insurance'::text, 'Contract'::text, 'Invoice'::text
  ]));
