import { neon } from '@neondatabase/serverless';

const STATEMENTS = [
  `ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check`,
  `ALTER TABLE documents ADD CONSTRAINT documents_type_check
     CHECK (type = ANY (ARRAY[
       'BOL'::text, 'POD'::text, 'Rate Confirmation'::text,
       'Shipper Rate Confirmation'::text, 'Shipper Rate Confirmation Reply'::text,
       'Insurance'::text, 'Contract'::text, 'Invoice'::text
     ]))`,
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  for (const [i, stmt] of STATEMENTS.entries()) {
    console.log(`[${i + 1}/${STATEMENTS.length}] Running...`);
    await sqlClient.query(stmt);
    console.log(`[${i + 1}/${STATEMENTS.length}] OK`);
  }
  console.log('Migration 050 applied.');
}
main().catch((err) => { console.error('Migration 050 failed:', err); process.exit(1); });
