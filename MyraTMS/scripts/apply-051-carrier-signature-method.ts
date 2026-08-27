import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  await sqlClient.query(
    `ALTER TABLE loads
       ADD COLUMN IF NOT EXISTS carrier_signature_method VARCHAR(20),
       ADD COLUMN IF NOT EXISTS carrier_signature_confirmed_by VARCHAR(100)`,
  );
  console.log('Migration 051 applied.');
}
main().catch((err) => { console.error('Migration 051 failed:', err); process.exit(1); });
