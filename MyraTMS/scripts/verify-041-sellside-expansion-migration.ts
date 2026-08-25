/**
 * Verifies scripts/041-sellside-expansion-schema.sql was applied per E2-03 §6.6/§5.4/§8.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-041-sellside-expansion-migration.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  // 1. agent_calls.call_type CHECK constraint
  const callTypeConstraint = await sql(
    `SELECT conname FROM pg_constraint
     WHERE conname = 'chk_agent_calls_call_type' AND conrelid = 'agent_calls'::regclass`,
    [],
  );
  console.log(`\n[1/4] agent_calls.chk_agent_calls_call_type constraint present: ${callTypeConstraint.length === 1}`);
  if (callTypeConstraint.length !== 1) console.log('      MISSING: chk_agent_calls_call_type');

  // 2. pipeline_loads carrier-outcome columns
  const pipelineLoadsCols = [
    'carrier_agreed_rate', 'carrier_agreed_currency', 'carrier_call_outcome',
    'carrier_id_secured', 'carrier_cascade_position', 'carrier_profit',
  ];
  const foundPipelineCols = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='pipeline_loads' AND column_name = ANY($1::text[])`,
    [pipelineLoadsCols],
  );
  console.log(`\n[2/4] pipeline_loads carrier columns (expected ${pipelineLoadsCols.length}): ${foundPipelineCols.length}`);
  const missingPipelineCols = pipelineLoadsCols.filter(
    (c) => !foundPipelineCols.some((r: any) => r.column_name === c),
  );
  if (missingPipelineCols.length) console.log(`      MISSING: ${missingPipelineCols.join(', ')}`);

  // 3. loads.carrier_cost_estimated
  const loadsCol = await sql(
    `SELECT column_name, column_default FROM information_schema.columns
     WHERE table_name='loads' AND column_name='carrier_cost_estimated'`,
    [],
  );
  console.log(`\n[3/4] loads.carrier_cost_estimated present: ${loadsCol.length === 1}`);
  if (loadsCol.length !== 1) console.log('      MISSING: loads.carrier_cost_estimated');

  // 4. carriers verification columns
  const carriersCols = ['verified_at', 'verified_by', 'verification_snapshot'];
  const foundCarriersCols = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='carriers' AND column_name = ANY($1::text[])`,
    [carriersCols],
  );
  console.log(`\n[4/5] carriers verification columns (expected ${carriersCols.length}): ${foundCarriersCols.length}`);
  const missingCarriersCols = carriersCols.filter(
    (c) => !foundCarriersCols.some((r: any) => r.column_name === c),
  );
  if (missingCarriersCols.length) console.log(`      MISSING: ${missingCarriersCols.join(', ')}`);

  // 5. exceptions columns (added here independently of E2-01's 040 — order-independent, see migration header)
  const exceptionsCols = ['pipeline_load_id', 'source_module', 'suggested_action', 'sla_due_at'];
  const foundExceptionsCols = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='exceptions' AND column_name = ANY($1::text[])`,
    [exceptionsCols],
  );
  console.log(`\n[5/5] exceptions columns (expected ${exceptionsCols.length}): ${foundExceptionsCols.length}`);
  const missingExceptionsCols = exceptionsCols.filter(
    (c) => !foundExceptionsCols.some((r: any) => r.column_name === c),
  );
  if (missingExceptionsCols.length) console.log(`      MISSING: ${missingExceptionsCols.join(', ')}`);

  console.log(`\nEXPLAIN idx_pipeline_loads_carrier_call_outcome:`);
  const e1 = await sql(
    `EXPLAIN SELECT * FROM pipeline_loads WHERE carrier_call_outcome = 'accept'`,
    [],
  );
  for (const row of e1) console.log(`  ${row['QUERY PLAN']}`);

  const allGood =
    callTypeConstraint.length === 1 &&
    missingPipelineCols.length === 0 &&
    loadsCol.length === 1 &&
    missingCarriersCols.length === 0 &&
    missingExceptionsCols.length === 0;
  console.log(allGood ? '\n✅ Migration 041 verified.' : '\n❌ Migration 041 incomplete — see MISSING lines above.');
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => { console.error('Verification failed:', err); process.exit(1); });
