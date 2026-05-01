-- =============================================================================
-- Sprint 6A — pipeline observation queries
-- =============================================================================
-- Run these against Neon (psql or any Postgres client) WHILE a shadow drain
-- is in progress. Re-run every 30s for ~10 min until the pipeline is idle.
--
-- Each query has a comment describing what to expect at different drain stages.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Stage distribution — heartbeat of where loads are
-- -----------------------------------------------------------------------------
-- Right after generator runs:  ~all in 'scanned'
-- Within ~30s:                  half-half scanned/qualified
-- Within ~3 min:                most should be in 'briefed' or 'disqualified'
-- After drain:                  ZERO loads in non-terminal stages
--                               (scanned/qualified/researched/matched/briefed/calling)
SELECT stage, COUNT(*) AS n
FROM pipeline_loads
WHERE load_id LIKE 'TEST_%'
GROUP BY stage
ORDER BY n DESC;


-- -----------------------------------------------------------------------------
-- 2. Disqualification reasons — by load family
-- -----------------------------------------------------------------------------
-- Each TEST_<FAMILY>_<n> family should disqualify (or qualify) at expected rates.
-- TEST_GOOD_*       → mostly 'qualified' / 'matched' / 'briefed'
-- TEST_MARGINFAIL_* → mostly 'disqualified' (margin filter)
-- TEST_LANEFAIL_*   → mostly 'disqualified' (lane filter)
-- TEST_EQUIPFAIL_*  → mostly 'disqualified' (equipment filter)
-- TEST_FRESHFAIL_*  → mostly 'disqualified' (freshness filter)
SELECT
  CASE
    WHEN load_id LIKE 'TEST_GOOD_%'       THEN 'GOOD'
    WHEN load_id LIKE 'TEST_MARGINFAIL_%' THEN 'MARGINFAIL'
    WHEN load_id LIKE 'TEST_LANEFAIL_%'   THEN 'LANEFAIL'
    WHEN load_id LIKE 'TEST_EQUIPFAIL_%'  THEN 'EQUIPFAIL'
    WHEN load_id LIKE 'TEST_FRESHFAIL_%'  THEN 'FRESHFAIL'
    ELSE 'OTHER'
  END AS family,
  stage,
  COUNT(*) AS n
FROM pipeline_loads
WHERE load_id LIKE 'TEST_%'
GROUP BY family, stage
ORDER BY family, n DESC;


-- -----------------------------------------------------------------------------
-- 3. Match counts on qualified loads
-- -----------------------------------------------------------------------------
-- Target: avg 1-3 matches per qualified load. If you see avg=0, the Ranker
-- isn't finding any carriers (check carriers table; lib/matching/index.ts).
SELECT
  COUNT(*)                                                    AS qualified_loads,
  AVG(carrier_match_count)::numeric(10,2)                     AS avg_matches,
  MIN(carrier_match_count)                                    AS min_matches,
  MAX(carrier_match_count)                                    AS max_matches,
  PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY carrier_match_count) AS p50_matches,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY carrier_match_count) AS p95_matches
FROM pipeline_loads
WHERE load_id LIKE 'TEST_%'
  AND carrier_match_count IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 4. Brief validation pass rate
-- -----------------------------------------------------------------------------
-- Target: ≥99% of loads that reached 'briefed' or beyond have a valid brief.
-- A failure at this stage points loads to 'escalated' (or compiler fail-closed).
SELECT
  COUNT(*) FILTER (WHERE pl.stage IN ('briefed','calling','booked','dispatched','delivered','scored')) AS briefed_or_later,
  COUNT(*) FILTER (WHERE pl.stage = 'escalated')                                                       AS escalated,
  COUNT(*) FILTER (WHERE nb.id IS NOT NULL)                                                            AS briefs_persisted
FROM pipeline_loads pl
LEFT JOIN negotiation_briefs nb ON nb.pipeline_load_id = pl.id
WHERE pl.load_id LIKE 'TEST_%';


-- -----------------------------------------------------------------------------
-- 5. Voice agent shadow skips
-- -----------------------------------------------------------------------------
-- In shadow mode (MAX_CONCURRENT_CALLS=0), every brief should produce an
-- agent_jobs row from voice-worker with outcome 'shadow_skip'. If you see
-- 'in_progress' rows here, MAX_CONCURRENT_CALLS is NOT 0 — abort.
SELECT
  aj.outcome,
  COUNT(*) AS n
FROM agent_jobs aj
WHERE aj.queue_name = 'call-queue'
  AND aj.created_at > NOW() - INTERVAL '30 minutes'
GROUP BY aj.outcome
ORDER BY n DESC;


-- -----------------------------------------------------------------------------
-- 6. Stuck loads (60+ min in non-terminal stage)
-- -----------------------------------------------------------------------------
-- After a clean drain, this should be empty. Anything here means a worker
-- crashed or a queue is wedged.
SELECT
  id, load_id, stage, stage_updated_at,
  EXTRACT(EPOCH FROM (NOW() - stage_updated_at))::int AS seconds_in_stage
FROM pipeline_loads
WHERE load_id LIKE 'TEST_%'
  AND stage NOT IN ('disqualified','expired','scored','dispatched','delivered','escalated')
  AND stage_updated_at < NOW() - INTERVAL '5 minutes'
ORDER BY seconds_in_stage DESC
LIMIT 20;


-- -----------------------------------------------------------------------------
-- 7. agent_jobs failures — anything that didn't succeed
-- -----------------------------------------------------------------------------
-- Investigate every row this returns. error_message + retell_call_id (if any)
-- are usually enough to triage.
SELECT
  worker_name, queue_name, outcome, error_message, attempts, created_at
FROM agent_jobs
WHERE outcome IN ('failed', 'error')
  AND created_at > NOW() - INTERVAL '30 minutes'
ORDER BY created_at DESC
LIMIT 50;


-- -----------------------------------------------------------------------------
-- 8. End-to-end durations (post-drain only)
-- -----------------------------------------------------------------------------
-- Run AFTER the drain is complete. Tells you how long each stage transition
-- took on average — useful for SLO tracking later.
WITH transitions AS (
  SELECT
    pl.id,
    pl.load_id,
    pl.created_at AS scanned_at,
    aj_q.created_at AS qualified_at,
    aj_b.created_at AS briefed_at
  FROM pipeline_loads pl
  LEFT JOIN agent_jobs aj_q ON aj_q.pipeline_load_id = pl.id AND aj_q.queue_name = 'qualify-queue' AND aj_q.outcome = 'success'
  LEFT JOIN agent_jobs aj_b ON aj_b.pipeline_load_id = pl.id AND aj_b.queue_name = 'brief-queue'   AND aj_b.outcome = 'success'
  WHERE pl.load_id LIKE 'TEST_%'
)
SELECT
  AVG(EXTRACT(EPOCH FROM (qualified_at - scanned_at)))::numeric(10,1) AS avg_qualify_seconds,
  AVG(EXTRACT(EPOCH FROM (briefed_at   - scanned_at)))::numeric(10,1) AS avg_brief_seconds,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (briefed_at - scanned_at)))::numeric(10,1) AS p95_brief_seconds
FROM transitions
WHERE briefed_at IS NOT NULL;
