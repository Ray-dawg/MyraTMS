-- Engine 2 — Sprint 4 schema addition
-- The prebuilt retell-webhook.ts auditLog() helper writes every event
-- (signature failures, processing outcomes, errors) to a compliance_audit
-- table. Without it every webhook hit spams stderr (writes throw + caught).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS compliance_audit (
  id SERIAL PRIMARY KEY,
  phone TEXT,
  check_type TEXT NOT NULL,
  result TEXT NOT NULL,
  details JSONB,
  pipeline_load_id INTEGER,
  call_id TEXT,
  checked_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_pipeline_load_id
  ON compliance_audit (pipeline_load_id);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_phone
  ON compliance_audit (phone);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_checked_at
  ON compliance_audit (checked_at DESC);
