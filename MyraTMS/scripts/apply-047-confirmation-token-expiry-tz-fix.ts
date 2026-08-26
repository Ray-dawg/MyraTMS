/**
 * Applies scripts/047-confirmation-token-expiry-tz-fix.sql against live Neon.
 * Usage: pnpm tsx --env-file=.env.local scripts/apply-047-confirmation-token-expiry-tz-fix.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;

  await sqlClient.query(
    `ALTER TABLE pipeline_loads
       ALTER COLUMN confirmation_token_expires_at TYPE TIMESTAMPTZ
       USING confirmation_token_expires_at AT TIME ZONE 'UTC'`,
  );

  console.log('✅ Migration 047 applied.');
}

main().catch((err) => { console.error('Migration 047 failed:', err); process.exit(1); });
