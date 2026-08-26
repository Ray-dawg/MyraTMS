/**
 * Verifies scripts/042-carrier-call-columns.sql was applied per E2-03 §6.7.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-042-carrier-call-columns.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  const cols = ['carrier_agreed_rate', 'carrier_outcome', 'carrier_profit'];
  const found = await sql(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name='agent_calls' AND column_name = ANY($1::text[])`,
    [cols],
  );
  console.log(`\nagent_calls carrier columns (expected ${cols.length}): ${found.length}`);
  for (const r of found) console.log(`  - ${r.column_name}: ${r.data_type}`);
  const missing = cols.filter((c) => !found.some((r: any) => r.column_name === c));
  if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`);

  const ok = missing.length === 0;
  console.log(ok ? '\n✅ Migration 042 verified.' : '\n❌ Migration 042 incomplete.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('Verification failed:', err); process.exit(1); });
