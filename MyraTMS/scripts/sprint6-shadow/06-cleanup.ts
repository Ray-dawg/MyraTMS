/**
 * Sprint 6 cleanup — drains all TEST_ loads from the system.
 *
 * Idempotent. Safe to run on a fresh DB (no-op). Refuses to touch any
 * row whose load_id doesn't start with 'TEST_'.
 *
 * Cascades:
 *   - DELETE FROM agent_calls       WHERE pipeline_load_id IN (...)
 *   - DELETE FROM negotiation_briefs WHERE pipeline_load_id IN (...)
 *   - DELETE FROM match_results     WHERE load_id LIKE 'TEST_%'
 *   - DELETE FROM agent_jobs        WHERE pipeline_load_id IN (...)
 *   - DELETE FROM pipeline_loads    WHERE load_id LIKE 'TEST_%'
 *   - DELETE FROM shipper_preferences WHERE phone LIKE '+1555010%'
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts --dry-run
 */

import { neon } from '@neondatabase/serverless';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sql = neon(url);

  console.log(`\n=== Sprint 6 cleanup ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // Find target IDs first so we can do counts and explicit cascades.
  const targetRows = (await sql`
    SELECT id, load_id, stage FROM pipeline_loads WHERE load_id LIKE 'TEST_%'
  `) as Array<{ id: number; load_id: string; stage: string }>;

  if (targetRows.length === 0) {
    console.log('No TEST_ rows in pipeline_loads — nothing to clean.');
    process.exit(0);
  }

  console.log(`Found ${targetRows.length} TEST_ pipeline_loads rows:`);
  const stageBreakdown: Record<string, number> = {};
  for (const r of targetRows) stageBreakdown[r.stage] = (stageBreakdown[r.stage] ?? 0) + 1;
  for (const [stage, n] of Object.entries(stageBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  - stage=${stage.padEnd(15)} ${n}`);
  }

  const ids = targetRows.map((r) => r.id);
  const loadIds = targetRows.map((r) => r.load_id);

  // Count cascades
  const calls = (await sql`
    SELECT COUNT(*)::int AS n FROM agent_calls WHERE pipeline_load_id = ANY(${ids}::int[])
  `) as Array<{ n: number }>;
  const briefs = (await sql`
    SELECT COUNT(*)::int AS n FROM negotiation_briefs WHERE pipeline_load_id = ANY(${ids}::int[])
  `) as Array<{ n: number }>;
  const matches = (await sql`
    SELECT COUNT(*)::int AS n FROM match_results WHERE load_id = ANY(${loadIds}::text[])
  `) as Array<{ n: number }>;
  const jobs = (await sql`
    SELECT COUNT(*)::int AS n FROM agent_jobs WHERE pipeline_load_id = ANY(${ids}::int[])
  `) as Array<{ n: number }>;
  const prefs = (await sql`
    SELECT COUNT(*)::int AS n FROM shipper_preferences WHERE phone LIKE '+1555010%'
  `) as Array<{ n: number }>;

  console.log(`\nCascading deletes:`);
  console.log(`  agent_calls          ${calls[0].n}`);
  console.log(`  negotiation_briefs   ${briefs[0].n}`);
  console.log(`  match_results        ${matches[0].n}`);
  console.log(`  agent_jobs           ${jobs[0].n}`);
  console.log(`  shipper_preferences  ${prefs[0].n}  (matched by fictional +1555010* phone range)`);
  console.log(`  pipeline_loads       ${targetRows.length}\n`);

  if (DRY_RUN) {
    console.log('(dry run — no rows deleted)');
    process.exit(0);
  }

  // Order matters: delete dependent rows first, then pipeline_loads.
  await sql`DELETE FROM agent_calls       WHERE pipeline_load_id = ANY(${ids}::int[])`;
  await sql`DELETE FROM negotiation_briefs WHERE pipeline_load_id = ANY(${ids}::int[])`;
  await sql`DELETE FROM match_results     WHERE load_id = ANY(${loadIds}::text[])`;
  await sql`DELETE FROM agent_jobs        WHERE pipeline_load_id = ANY(${ids}::int[])`;
  await sql`DELETE FROM shipper_preferences WHERE phone LIKE '+1555010%'`;
  await sql`DELETE FROM pipeline_loads    WHERE load_id LIKE 'TEST_%'`;

  console.log('\x1b[32m✓ Cleanup complete\x1b[0m');
}

main().catch((err) => {
  console.error('Cleanup crashed:', err);
  process.exit(1);
});
