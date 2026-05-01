-- ============================================================================
-- 023 — PIPELINE SCHEMA CORRECTIONS
-- ============================================================================
-- The original pipeline_migrations.sql declared pipeline_loads.top_carrier_id
-- and pipeline_loads.tms_load_id as INTEGER, but the corresponding TMS columns
-- (carriers.id, loads.id) are text (e.g. 'car_005', 'LD-2024-002').
--
-- This migration fixes the type mismatch so Engine 2 workers can write the
-- actual carrier/load IDs without parseInt gymnastics. Both columns are
-- nullable and currently empty (pipeline_loads has 0 rows after migration 001),
-- so the cast is safe.
--
-- Idempotency: guarded by a DO block that only runs the ALTER if the column
-- is still INTEGER. Re-running this file is safe.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pipeline_loads' AND column_name = 'top_carrier_id') = 'integer' THEN
    ALTER TABLE pipeline_loads ALTER COLUMN top_carrier_id TYPE TEXT USING top_carrier_id::text;
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pipeline_loads' AND column_name = 'tms_load_id') = 'integer' THEN
    ALTER TABLE pipeline_loads ALTER COLUMN tms_load_id TYPE TEXT USING tms_load_id::text;
  END IF;

  -- Drop match_results.load_id FK so Agent 4 can persist matches before
  -- Agent 7 has created the corresponding TMS loads row. The constraint was
  -- added by 014-carrier-matching-engine.sql when pipeline-style matching
  -- (match-before-book) wasn't in scope. ON DELETE SET NULL was already
  -- lenient; we don't need referential integrity here — match_results is
  -- an append-only audit log.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'match_results_load_id_fkey'
      AND conrelid = 'match_results'::regclass
  ) THEN
    ALTER TABLE match_results DROP CONSTRAINT match_results_load_id_fkey;
  END IF;
END
$$;

COMMIT;
