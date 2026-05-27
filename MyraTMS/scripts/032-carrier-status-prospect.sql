-- ============================================================================
-- 032 — CARRIER STATUS (prospect / active)
-- ============================================================================
-- Adds a carrier_status column to distinguish carriers we've actually
-- established a relationship with ('active') from carriers seeded from
-- public registries we haven't called yet ('prospect').
--
-- Why: A.1 of the Engine 2 Production Ship Roadmap requires a carrier pool
-- deep enough for the Ranker to produce real matches in Sprint 6A shadow
-- drains. The cleanest way to seed depth without risking accidental
-- dispatch to a never-contacted carrier is the prospect/active split:
--   - Ranker (Agent 4) freely matches both prospect AND active carriers
--     (shadow drains exercise the full pipeline as intended)
--   - Dispatcher (Agent 7) refuses to assign loads to prospect carriers
--     (a separate gate, enforced in dispatcher-worker.ts)
-- Promotion prospect -> active happens via PATCH /api/carriers/[id]/promote
-- after a human operator establishes the relationship.
--
-- Existing carriers default to 'active' (no behavior change for current rows).
-- FMCSA-seeded rows are inserted with 'prospect' by seed-carriers-from-fmcsa.ts.
--
-- Migration numbering note: 027-031 are taken by the multi-tenant work
-- (027 foundation, 028 add_tenant_id, 029 RLS, 030 engine2_tenanting PENDING,
-- 031 tenant_usage). 032 is the next free slot.
--
-- Idempotent: re-running this file is safe.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  -- Add the column if it doesn't exist. DEFAULT 'active' back-fills
  -- existing rows in a single ALTER (Postgres optimization for non-volatile
  -- defaults), so no separate UPDATE is required.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'carriers' AND column_name = 'carrier_status'
  ) THEN
    ALTER TABLE carriers
      ADD COLUMN carrier_status TEXT NOT NULL DEFAULT 'active';
  END IF;

  -- Add the CHECK constraint separately so it can be dropped/re-added
  -- without losing column data.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'carriers_carrier_status_check'
      AND conrelid = 'carriers'::regclass
  ) THEN
    ALTER TABLE carriers
      ADD CONSTRAINT carriers_carrier_status_check
      CHECK (carrier_status IN ('prospect', 'active'));
  END IF;
END
$$;

-- Index for the common Dispatcher-gate query path: filter active carriers.
CREATE INDEX IF NOT EXISTS idx_carriers_status_active
  ON carriers (carrier_status)
  WHERE carrier_status = 'active';

COMMIT;
