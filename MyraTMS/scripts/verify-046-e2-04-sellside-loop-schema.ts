/**
 * Verifies scripts/046-e2-04-sellside-loop-schema.sql was applied.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-046-e2-04-sellside-loop-schema.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  let allOk = true;

  const colChecks: Array<{ table: string; cols: string[] }> = [
    {
      table: 'pipeline_loads',
      cols: [
        'shipper_email',
        'confirmation_token',
        'confirmation_token_expires_at',
        'confirmation_sent_at',
        'confirmation_nudged_at',
        'confirmed_at',
        'confirmed_rate',
        'confirmed_rate_currency',
        'confirmation_snapshot',
        'confirmation_outcome',
        'decline_reason',
        'shipper_ratecon_returned_at',
        'carrier_ratecon_signed_at',
      ],
    },
    { table: 'personas', cols: ['call_type'] },
  ];

  for (const { table, cols } of colChecks) {
    const found = await sql(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = ANY($2::text[])`,
      [table, cols],
    );
    console.log(`\n${table} columns (expected ${cols.length}): ${found.length}`);
    for (const r of found) console.log(`  - ${r.column_name}: ${r.data_type}`);
    const missing = cols.filter((c) => !found.some((r: any) => r.column_name === c));
    if (missing.length) {
      console.log(`  MISSING: ${missing.join(', ')}`);
      allOk = false;
    }
  }

  const table = await sql(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'inbound_emails'`,
  );
  console.log(`\ninbound_emails table exists: ${table.length > 0}`);
  if (table.length === 0) allOk = false;

  const idx = await sql(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'pipeline_loads' AND indexname = 'uq_pipeline_confirmation_token'`,
  );
  console.log(`uq_pipeline_confirmation_token index exists: ${idx.length > 0}`);
  if (idx.length === 0) allOk = false;

  console.log(allOk ? '\n✅ Migration 046 verified.' : '\n❌ Migration 046 incomplete.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Verification failed:', err); process.exit(1); });
