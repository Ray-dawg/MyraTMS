-- ============================================================================
-- 059: T-30 CONTRACT FREIGHT INTAKE
-- ============================================================================
-- Engine 3 Phase 4. Enables tenants' shippers to tender freight directly by email.
-- See Engine 3/T30_Contract_Freight_Intake.md for design rationale.
--
-- Schema:
--   1. CREATE contract_shipper_authorizations — per-tenant whitelist of senders
--      authorized to tender freight via email. Sender must appear on this list
--      before any tender parsing / injection can occur.
--   2. ALTER inbound_emails — additive columns to track intake_type, sender
--      authorization check, created pipeline_load linkage, and intake_status.
--
-- Idempotent: yes. Rollback: 059-t30-contract-freight-intake_rollback.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- TABLE: contract_shipper_authorizations
-- Per-tenant whitelist of email senders authorized to submit freight tenders.
-- Sender authorization is checked BEFORE extraction; unauthorized emails route
-- to T-24's console as a security-relevant exception, not parsed for injection.
-- ============================================================================

CREATE TABLE IF NOT EXISTS contract_shipper_authorizations (
    id                              SERIAL PRIMARY KEY,
    tenant_id                       INTEGER NOT NULL REFERENCES tenants(id),

    -- Sender email address or verified domain pattern (exact address or domain)
    shipper_email                   VARCHAR(200) NOT NULL,

    -- Optional metadata about the shipper
    shipper_company_name            VARCHAR(200),

    -- Optional per-shipper override of tenant's default margin floor (percentage)
    margin_floor_override_pct       NUMERIC(5,2),

    -- Active/inactive toggle for the authorization
    is_active                       BOOLEAN DEFAULT true,

    -- Who authorized this sender and when
    authorized_by                   VARCHAR(100) NOT NULL,
    authorized_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Unique constraint: one sender per tenant (can't authorize same email twice)
    UNIQUE (tenant_id, shipper_email)
);

CREATE INDEX IF NOT EXISTS idx_contract_shipper_auth_tenant
    ON contract_shipper_authorizations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_shipper_auth_email
    ON contract_shipper_authorizations(shipper_email);
CREATE INDEX IF NOT EXISTS idx_contract_shipper_auth_active
    ON contract_shipper_authorizations(tenant_id, is_active);

-- ============================================================================
-- ALTER: inbound_emails — Add T-30 intake tracking columns
-- Extends the existing T-26 inbound_emails table with columns to distinguish
-- between rate-confirmation matching (T-26) and freight-tender parsing (T-30),
-- and to track intake status and pipeline linkage.
-- ============================================================================

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_type VARCHAR(30)
    DEFAULT 'rate_con_confirmation'
    CHECK (intake_type IN ('rate_con_confirmation', 'freight_tender'));

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS sender_authorized BOOLEAN;

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS created_pipeline_load_id
    INTEGER REFERENCES pipeline_loads(id);

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20)
    DEFAULT 'pending_review'
    CHECK (intake_status IN (
        'pending_review', 'approved', 'rejected', 'unauthorized_sender'
    ));

-- Index for T-30 workflow queries: find pending tenders for a given tenant
CREATE INDEX IF NOT EXISTS idx_inbound_emails_intake_status
    ON inbound_emails(intake_type, intake_status) WHERE intake_type = 'freight_tender';

COMMIT;
