-- ============================================================================
-- 054 — T-24 EXCEPTION ENGINE: CLASSIFICATION RULES
-- ============================================================================
-- Engine 3 Phase 2, Module 5. See Engine 3/T24_Exception_Engine_Console.md.
--
-- Schema-reality correction (spec §4.0's own required check, done before
-- writing this file): the existing `exceptions` table already has every
-- column spec §4.2 proposes adding (tenant_id, pipeline_load_id,
-- source_module, suggested_action, sla_due_at) -- added by
-- 028_add_tenant_id.sql and 041-sellside-expansion-schema.sql, the latter
-- explicitly for an E2-03 dispatch-gate escalation path this spec didn't
-- know existed. This migration therefore adds NOTHING to `exceptions` --
-- only the new exception_classification_rules table, which governs
-- severity/SLA for the *new* source modules this module bridges in. The
-- existing 8 TMS rules (lib/exceptions/detector.ts) keep their own
-- hardcoded severity logic untouched, exactly as spec §4.3 specifies.
--
-- Idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS exception_classification_rules (
    id                SERIAL PRIMARY KEY,
    tenant_id         INTEGER NOT NULL DEFAULT 2,
    source_module     VARCHAR(30) NOT NULL,
    condition         JSONB NOT NULL,
    severity          VARCHAR(20) NOT NULL,
    sla_minutes       INTEGER NOT NULL,
    suggested_action  TEXT NOT NULL,
    is_active         BOOLEAN DEFAULT true,
    version           INTEGER NOT NULL DEFAULT 1,

    UNIQUE (tenant_id, source_module, version)
);

CREATE INDEX IF NOT EXISTS idx_exception_classification_rules_lookup
    ON exception_classification_rules(tenant_id, source_module, is_active);

-- Seed rows -- directly from T-00/spec §4.3's own worked example (a load 20
-- minutes late is routine; six hours late needs stakeholder contact) plus
-- the spec's own §5 mockup text (carrier_risk's "Review before next
-- assignment"). tenant_id defaults to 2 (Myra) matching the existing
-- exceptions.tenant_id column default -- both predate T-19's
-- fn_myra_tenant_id() resolver and are out of this module's scope to fix.
INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version) VALUES
(2, 'lifecycle_late', '{"time_overdue_minutes": {">=": 20}}'::jsonb, 'low', 240,
  'Monitor; contact carrier if the delay continues.', 1),
(2, 'lifecycle_late', '{"time_overdue_minutes": {">=": 360}}'::jsonb, 'critical', 30,
  'Contact carrier and shipper immediately — see resolution options.', 2),
(2, 'carrier_risk', '{}'::jsonb, 'medium', 1440,
  'Review before next assignment.', 1),
(2, 'stage_escalated', '{}'::jsonb, 'high', 120,
  'Investigate why this load was escalated and resolve or reassign.', 1),
(2, 'dead_letter', '{}'::jsonb, 'high', 60,
  'Investigate the failed job — check agent_jobs.error_message and retry or manually complete.', 1)
ON CONFLICT (tenant_id, source_module, version) DO NOTHING;
