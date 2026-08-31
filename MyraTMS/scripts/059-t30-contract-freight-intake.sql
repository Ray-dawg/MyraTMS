-- scripts/059-t30-contract-freight-intake.sql
--
-- T-30 — Contract Freight Intake. See Engine 3/T30_Contract_Freight_Intake.md
-- and MyraTMS/docs/superpowers/specs/2026-08-31-t30-contract-freight-intake-design.md
-- (§2/§2a/§3) for why every column here differs from the spec's own §4.

BEGIN;

-- §4.1 of the spec, unchanged shape, two columns corrected (design §2.3/§2a):
-- margin_floor_override_amount is a DOLLAR amount (same unit as
-- resolveMargin()'s minMargin), not a percentage — the spec's own
-- _pct name and NUMERIC(5,2) width would misrepresent that.
-- tenant_id is BIGINT, not INTEGER — tenants.id is BIGINT and every other
-- tenant-scoped table in this schema (37+, including exceptions) agrees;
-- INTEGER here was a defect the brief copied verbatim from the spec without
-- cross-checking the live tenants.id type (same bug class T-19/T-27 already
-- document and fixed elsewhere).
CREATE TABLE IF NOT EXISTS contract_shipper_authorizations (
    id                            SERIAL PRIMARY KEY,
    tenant_id                     BIGINT NOT NULL REFERENCES tenants(id),
    shipper_email                 VARCHAR(200) NOT NULL,
    shipper_company_name          VARCHAR(200),
    margin_floor_override_amount  NUMERIC(10,2),
    is_active                     BOOLEAN NOT NULL DEFAULT true,
    authorized_by                 VARCHAR(100) NOT NULL,
    authorized_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, shipper_email)
);

CREATE INDEX IF NOT EXISTS idx_contract_shipper_auth_email
    ON contract_shipper_authorizations(shipper_email)
    WHERE is_active = true;

-- Additive to the REAL inbound_emails table (scripts/046-e2-04-sellside-loop-schema.sql),
-- not the spec's nonexistent inbound_document_intake (design §2.1).
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_type VARCHAR(30);
    -- NULL for pre-existing shipper_reply/carrier_reply rows and any row
    -- this migration doesn't touch; 'freight_tender' for T-30 rows.
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS sender_authorized BOOLEAN;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS created_pipeline_load_id INTEGER REFERENCES pipeline_loads(id);
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20);
    -- 'pending_review' | 'approved' | 'rejected' | 'unauthorized_sender'

-- Genuinely new columns (design §2.5) — pipeline_loads has never had either;
-- source_type/booked_via on the TMS `loads` table are a different vocabulary
-- (manual|ai_agent|load_board_import / human|ai_auto|ai_escalated), no collision.
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'load_board';
    -- 'load_board' (default, preserves every existing row's real meaning) | 'email_tender'
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS booked_via VARCHAR(20);
    -- 'ai_call' | 'email_tender' -- NULL for rows not yet booked, matching booked_at nullability

-- Links an exception back to the inbound_emails row that produced it
-- (design §2a) — none of exceptions' existing load_id/pipeline_load_id/
-- carrier_id link fields fit a freight-tender signal (no pipeline_loads row
-- exists yet, and there's no TMS loads/carriers row either).
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS inbound_email_id INTEGER REFERENCES inbound_emails(id);

COMMIT;
