-- ============================================================================
-- 047 — FIX: pipeline_loads.confirmation_token_expires_at needs TIMESTAMPTZ
-- ============================================================================
-- Migration 046 declared this column as bare TIMESTAMP (no time zone).
-- Confirmed live (not just a test artifact): the Neon driver's row parser
-- for a TIMESTAMP WITHOUT TIME ZONE column reconstructs the JS Date by
-- treating the stored wall-clock value as being in the *Node process's*
-- local timezone, not UTC. Any host whose local TZ isn't UTC gets back a
-- Date shifted by its own UTC offset -- confirmation-actions.ts's
-- isExpired() check (the actual security boundary gating whether a stale
-- confirmation link still works) would silently read a load as "not
-- expired" hours early or late depending on host TZ. TIMESTAMPTZ is an
-- absolute instant and round-trips correctly regardless of session or
-- process timezone -- the correct type for anything compared against
-- `new Date()` in application code, which this column always is.
--
-- Only this one column is fixed: it's the only one of migration 046's new
-- timestamp columns whose value participates in a JS-side < comparison.
-- The others (confirmation_sent_at, confirmation_nudged_at, confirmed_at,
-- shipper_ratecon_returned_at, carrier_ratecon_signed_at) are write-once
-- audit timestamps, same pattern as this codebase's many pre-existing
-- TIMESTAMP audit columns -- left as-is, not a bug for a value nothing ever
-- diffs against a live clock.
--
-- USING confirmation_token_expires_at AT TIME ZONE 'UTC' tells Postgres the
-- existing wall-clock values were always intended as UTC (true here since
-- Neon's own session timezone is UTC -- the corruption happens in the
-- driver's read path, not in what Postgres itself stored).
-- ============================================================================

ALTER TABLE pipeline_loads
  ALTER COLUMN confirmation_token_expires_at TYPE TIMESTAMPTZ
  USING confirmation_token_expires_at AT TIME ZONE 'UTC';
