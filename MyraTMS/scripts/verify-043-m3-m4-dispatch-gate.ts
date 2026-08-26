/**
 * Verifies scripts/043-m3-m4-dispatch-gate.sql was applied per E2-03 §7/§8.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-043-m3-m4-dispatch-gate.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  const checks: Array<{ table: string; cols: string[] }> = [
    { table: 'carriers', cols: ['contact_email'] },
    { table: 'loads', cols: ['rate_con_sent_at', 'rate_con_send_status', 'rate_con_send_error'] },
  ];

  let allOk = true;
  for (const { table, cols } of checks) {
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

  console.log(allOk ? '\n✅ Migration 043 verified.' : '\n❌ Migration 043 incomplete.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Verification failed:', err); process.exit(1); });
