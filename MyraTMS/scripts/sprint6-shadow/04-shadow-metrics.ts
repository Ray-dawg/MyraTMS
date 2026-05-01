/**
 * Sprint 6A — post-run metrics evaluator.
 *
 * Reads everything in pipeline_loads / negotiation_briefs / agent_jobs
 * matching `TEST_*` and computes the four success criteria from the
 * Sprint 6 plan:
 *
 *   1. Qualification rate     20-30% target
 *   2. Avg matches per qual   1-3 target
 *   3. Brief validation pass  ≥99% target
 *   4. Voice shadow skips     = number of briefed loads (no real calls)
 *
 * Plus a fifth defensive check: zero failures in agent_jobs.
 *
 * Exits 0 if ALL targets met, 1 if any FAIL. WARN-only items don't block.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/04-shadow-metrics.ts
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/04-shadow-metrics.ts --strict
 */

import { neon } from '@neondatabase/serverless';

type Severity = 'PASS' | 'WARN' | 'FAIL';

interface Metric {
  name: string;
  severity: Severity;
  observed: string;
  target: string;
  detail?: string;
}

const STRICT = process.argv.includes('--strict');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sql = neon(url);

  // ── Pull the universe of TEST_ loads + their stages
  const stageRows = (await sql`
    SELECT stage, COUNT(*)::int AS n
    FROM pipeline_loads
    WHERE load_id LIKE 'TEST_%'
    GROUP BY stage
  `) as Array<{ stage: string; n: number }>;
  const stages: Record<string, number> = {};
  for (const r of stageRows) stages[r.stage] = r.n;
  const total = Object.values(stages).reduce((a, b) => a + b, 0);

  if (total === 0) {
    console.error('\nNo TEST_ loads found in pipeline_loads. Run 02-generate-shadow-loads.ts first.');
    process.exit(1);
  }

  // ── Drain status — refuse to evaluate while loads are in non-terminal stages
  const inflight =
    (stages.scanned ?? 0) +
    (stages.qualified ?? 0) +
    (stages.researched ?? 0) +
    (stages.matched ?? 0) +
    (stages.briefed ?? 0) +
    (stages.calling ?? 0);

  if (inflight > 0) {
    console.warn(`\n!! ${inflight} loads still in non-terminal stages — drain not complete.`);
    console.warn('   Wait a few more minutes (workers process at concurrency=20-50/queue) and re-run.');
    if (STRICT) process.exit(1);
  }

  const metrics: Metric[] = [];

  // ── 1. Qualification rate
  // Numerator: anything that advanced past 'scanned' on a non-failure path
  const qualifiedFurther =
    (stages.qualified ?? 0) +
    (stages.researched ?? 0) +
    (stages.matched ?? 0) +
    (stages.briefed ?? 0) +
    (stages.calling ?? 0) +
    (stages.booked ?? 0) +
    (stages.dispatched ?? 0) +
    (stages.delivered ?? 0) +
    (stages.scored ?? 0);
  const qualifiedRate = qualifiedFurther / total;
  const qualifiedPct = Math.round(qualifiedRate * 100);
  metrics.push({
    name: 'Qualification rate',
    severity:
      qualifiedRate >= 0.20 && qualifiedRate <= 0.35 ? 'PASS' :
      qualifiedRate >= 0.10 && qualifiedRate <= 0.50 ? 'WARN' :
      'FAIL',
    observed: `${qualifiedPct}% (${qualifiedFurther}/${total})`,
    target: '20-30%',
  });

  // ── 2. Avg matches per qualified
  const matchRows = (await sql`
    SELECT
      AVG(carrier_match_count)::numeric(10,2) AS avg,
      MIN(carrier_match_count) AS min,
      MAX(carrier_match_count) AS max,
      COUNT(*)::int AS n
    FROM pipeline_loads
    WHERE load_id LIKE 'TEST_%'
      AND carrier_match_count IS NOT NULL
      AND carrier_match_count > 0
  `) as Array<{ avg: string; min: number; max: number; n: number }>;
  const avgMatches = matchRows[0]?.avg ? parseFloat(matchRows[0].avg) : 0;
  const matchN = matchRows[0]?.n ?? 0;
  metrics.push({
    name: 'Avg matches per qualified',
    severity:
      matchN === 0 ? 'FAIL' :
      avgMatches >= 1 && avgMatches <= 3 ? 'PASS' :
      avgMatches > 0 ? 'WARN' :
      'FAIL',
    observed: matchN === 0 ? '0 (no matched loads)' : `${avgMatches.toFixed(1)} (range ${matchRows[0].min}-${matchRows[0].max}, n=${matchN})`,
    target: '1-3',
  });

  // ── 3. Brief validation pass
  const briefRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE pl.stage IN ('briefed','calling','booked','dispatched','delivered','scored'))::int AS reached_brief,
      COUNT(*) FILTER (WHERE nb.id IS NOT NULL)::int AS persisted_briefs,
      COUNT(*) FILTER (WHERE pl.stage = 'escalated')::int AS escalated_total
    FROM pipeline_loads pl
    LEFT JOIN negotiation_briefs nb ON nb.pipeline_load_id = pl.id
    WHERE pl.load_id LIKE 'TEST_%'
  `) as Array<{ reached_brief: number; persisted_briefs: number; escalated_total: number }>;
  const reached = briefRows[0]?.reached_brief ?? 0;
  const persisted = briefRows[0]?.persisted_briefs ?? 0;
  const briefValidation = reached === 0 ? 1 : persisted / reached;
  metrics.push({
    name: 'Brief validation pass',
    severity:
      reached === 0 ? 'WARN' :
      briefValidation >= 0.99 ? 'PASS' :
      briefValidation >= 0.90 ? 'WARN' :
      'FAIL',
    observed: reached === 0
      ? 'no loads reached brief stage (matched count too low?)'
      : `${(briefValidation * 100).toFixed(1)}% (${persisted}/${reached})`,
    target: '≥99%',
  });

  // ── 4. Voice agent shadow skips — every briefed load should produce a shadow_skip
  const voiceRows = (await sql`
    SELECT outcome, COUNT(*)::int AS n
    FROM agent_jobs
    WHERE queue_name = 'call-queue'
      AND created_at > NOW() - INTERVAL '2 hours'
    GROUP BY outcome
  `) as Array<{ outcome: string; n: number }>;
  const voice: Record<string, number> = {};
  for (const r of voiceRows) voice[r.outcome] = r.n;
  const shadowSkips = voice['shadow_skip'] ?? 0;
  const realCallsAttempted = (voice['success'] ?? 0) + (voice['in_progress'] ?? 0) + (voice['failed'] ?? 0);
  metrics.push({
    name: 'Voice shadow skips',
    severity:
      realCallsAttempted > 0 ? 'FAIL' :
      shadowSkips === 0 && reached > 0 ? 'WARN' :
      'PASS',
    observed: `shadow_skip=${shadowSkips} other=${realCallsAttempted}`,
    target: realCallsAttempted === 0 ? 'all skips, no calls' : '0 real calls',
    detail: realCallsAttempted > 0
      ? 'CRITICAL — Voice worker placed real calls during a shadow run. Verify MAX_CONCURRENT_CALLS=0.'
      : undefined,
  });

  // ── 5. agent_jobs failures
  const failRows = (await sql`
    SELECT worker_name, queue_name, COUNT(*)::int AS n
    FROM agent_jobs
    WHERE outcome IN ('failed', 'error')
      AND created_at > NOW() - INTERVAL '2 hours'
    GROUP BY worker_name, queue_name
    ORDER BY n DESC
  `) as Array<{ worker_name: string; queue_name: string; n: number }>;
  const totalFails = failRows.reduce((a, r) => a + r.n, 0);
  metrics.push({
    name: 'Worker failures',
    severity: totalFails === 0 ? 'PASS' : totalFails < 3 ? 'WARN' : 'FAIL',
    observed: totalFails === 0
      ? '0 failed jobs in last 2h'
      : failRows.map((r) => `${r.worker_name}/${r.queue_name}=${r.n}`).join(', '),
    target: '0',
  });

  // ── Render
  console.log('\n=== Sprint 6A — Shadow Mode Metrics ===\n');
  console.log(`Population: ${total} TEST_ loads (${Object.entries(stages).map(([k, v]) => `${k}=${v}`).join(', ')})\n`);
  let fails = 0;
  let warns = 0;
  for (const m of metrics) {
    const icon = m.severity === 'PASS' ? '✓' : m.severity === 'WARN' ? '!' : '✗';
    const color = m.severity === 'PASS' ? '\x1b[32m' : m.severity === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`${color}${icon} ${m.severity.padEnd(4)}${reset}  ${m.name.padEnd(28)} observed=${m.observed.padEnd(40)} target=${m.target}`);
    if (m.detail) console.log(`            ${m.detail}`);
    if (m.severity === 'FAIL') fails++;
    if (m.severity === 'WARN') warns++;
  }
  console.log(`\n  PASS: ${metrics.length - fails - warns}   WARN: ${warns}   FAIL: ${fails}\n`);

  if (fails === 0) {
    console.log('\x1b[32mSHADOW MODE: GREEN ✓\x1b[0m  — ready for Phase 6B (real Retell calls).');
    console.log('Run scripts/sprint6-shadow/05-live-call-preflight.ts when you have real DAT credentials and consenting test shippers.');
    process.exit(0);
  } else {
    console.log('\x1b[31mSHADOW MODE: RED ✗\x1b[0m  — investigate FAIL items above before proceeding.');
    console.log('Common diagnostics in scripts/sprint6-shadow/README.md.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Metrics crashed:', err);
  process.exit(1);
});
