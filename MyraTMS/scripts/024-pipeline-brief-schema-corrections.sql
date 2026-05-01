-- Engine 2 — Sprint 3 schema corrections
-- The prebuilt pipeline_migrations.sql declared negotiation_briefs.top_carrier_id as INTEGER,
-- but carriers.id is TEXT in the live TMS schema. The Compiler stores carrier IDs from
-- match_results, which are TEXT. Without this fix the brief INSERT fails on first run.
--
-- Idempotent — uses information_schema lookups so it can be re-applied safely.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'negotiation_briefs'
      AND column_name = 'top_carrier_id'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE negotiation_briefs
      ALTER COLUMN top_carrier_id TYPE TEXT USING top_carrier_id::TEXT;
    RAISE NOTICE 'Altered negotiation_briefs.top_carrier_id INTEGER -> TEXT';
  ELSE
    RAISE NOTICE 'negotiation_briefs.top_carrier_id already TEXT — no change';
  END IF;
END $$;
