-- ============================================================================
-- 058: T-28 Customer OS & Onboarding
-- ============================================================================
-- tenant_onboarding_sessions tracks a prospective tenant through the staged
-- signup flow. tenant_id is NULL until the 'company_created' step provisions
-- the real tenants row (design doc §3.3).
--
-- Also seeds one exception_classification_rules row for source_module=
-- 'tenant_onboarding' — without it, bridgeToExceptions() silently no-ops
-- for every go-live request (design doc finding #5; same mechanism T-18's
-- authority_shadow sourceModule uses to be deliberately suppressed).
--
-- Idempotent: yes. Rollback: 058-t28-customer-os-onboarding_rollback.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_onboarding_sessions (
    id                 SERIAL PRIMARY KEY,
    tenant_id          INTEGER REFERENCES tenants(id),

    current_step       VARCHAR(30) NOT NULL DEFAULT 'sign_up'
                        CHECK (current_step IN (
                            'sign_up', 'company_created', 'users_created', 'billing_captured',
                            'load_sources_selected', 'policy_confirmed', 'agents_configured',
                            'tested', 'go_live_requested', 'live'
                        )),

    step_data           JSONB NOT NULL DEFAULT '{}',
    status              VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                         CHECK (status IN ('in_progress', 'completed', 'abandoned')),

    started_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_onboarding_sessions_tenant ON tenant_onboarding_sessions(tenant_id) WHERE tenant_id IS NOT NULL;

-- Seed one exception_classification_rules row for tenant_onboarding source_module.
-- Vocabulary check (migration 054/055): condition is JSONB, '{}' is the "always" sentinel,
-- not condition_type/condition_value columns which do not exist in the real schema.
INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version)
VALUES (2, 'tenant_onboarding', '{}'::jsonb, 'medium', 1440, 'Review onboarding session and approve or reject go-live', 1)
ON CONFLICT (tenant_id, source_module, version) DO NOTHING;

COMMIT;
