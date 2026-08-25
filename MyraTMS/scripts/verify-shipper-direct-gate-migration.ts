/**
 * Verifies scripts/040_shipper_direct_gate.sql was applied per E2-01 §4.10.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-shipper-direct-gate-migration.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  // 1. New tables
  const tableNames = ['poster_registry', 'authority_lookups', 'co_broker_agreements'];
  const tables = await sql(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tableNames],
  );
  console.log(`\n[1/4] New tables present (expected 3): ${tables.length}`);
  for (const r of tables) console.log(`      - ${r.table_name}`);
  const missingTables = tableNames.filter((n) => !tables.some((r: any) => r.table_name === n));
  if (missingTables.length) console.log(`      MISSING: ${missingTables.join(', ')}`);

  // 2. co_broker_agreements.tenant_id is BIGINT, not INTEGER — confirms T-19 shape won
  const tenantIdCol = await sql(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name='co_broker_agreements' AND column_name='tenant_id'`,
    [],
  );
  const tenantIdType = tenantIdCol[0]?.data_type ?? '<MISSING>';
  console.log(`\n[2/4] co_broker_agreements.tenant_id type: ${tenantIdType} (expected: bigint)`);
  if (tenantIdType !== 'bigint') console.log('      WARNING: expected bigint (T-19 shape) — check migration order');

  // 3. pipeline_loads poster/classification columns
  const pipelineLoadsCols = [
    'poster_company_raw', 'poster_company_normalized', 'poster_mc_number', 'poster_dot_number',
    'poster_raw_html', 'poster_registry_id', 'load_source_class', 'load_source_method',
    'load_source_confidence', 'load_source_evaluated_at', 'load_source_evidence',
    'shipper_direct_attestation', 'attested_by', 'attested_at', 'qualification_detail',
  ];
  const found = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='pipeline_loads' AND column_name = ANY($1::text[])`,
    [pipelineLoadsCols],
  );
  console.log(`\n[3/4] pipeline_loads columns (expected ${pipelineLoadsCols.length}): ${found.length}`);
  const missingCols = pipelineLoadsCols.filter((c) => !found.some((r: any) => r.column_name === c));
  if (missingCols.length) console.log(`      MISSING: ${missingCols.join(', ')}`);

  // 4. exceptions columns + EXPLAIN the three new pipeline_loads indexes
  const exceptionsCols = await sql(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='exceptions' AND column_name = ANY($1::text[])`,
    [['pipeline_load_id', 'source_module', 'suggested_action', 'sla_due_at']],
  );
  console.log(`\n[4/4] exceptions columns (expected 4): ${exceptionsCols.length}`);

  console.log(`\nEXPLAIN idx_pipeline_loads_source_class:`);
  const e1 = await sql(`EXPLAIN SELECT * FROM pipeline_loads WHERE load_source_class = 'unresolved' AND stage = 'scanned'`, []);
  for (const row of e1) console.log(`  ${row['QUERY PLAN']}`);

  console.log(`\nEXPLAIN idx_pipeline_loads_poster_mc:`);
  const e2 = await sql(`EXPLAIN SELECT * FROM pipeline_loads WHERE poster_mc_number = '123456'`, []);
  for (const row of e2) console.log(`  ${row['QUERY PLAN']}`);

  console.log(`\nEXPLAIN idx_pipeline_loads_poster_norm:`);
  const e3 = await sql(`EXPLAIN SELECT * FROM pipeline_loads WHERE poster_company_normalized = 'acme freight'`, []);
  for (const row of e3) console.log(`  ${row['QUERY PLAN']}`);

  const allGood = missingTables.length === 0 && missingCols.length === 0 && exceptionsCols.length === 4;
  console.log(allGood ? '\n✅ Migration 040 verified.' : '\n❌ Migration 040 incomplete — see MISSING lines above.');
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => { console.error('Verification failed:', err); process.exit(1); });
