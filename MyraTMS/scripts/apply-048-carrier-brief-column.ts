import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  await sqlClient.query(`ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS carrier_brief JSONB`);
  console.log('Migration 048 applied.');
}
main().catch((err) => { console.error('Migration 048 failed:', err); process.exit(1); });
