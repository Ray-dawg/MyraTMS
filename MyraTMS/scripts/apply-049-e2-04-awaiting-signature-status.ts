import { neon } from '@neondatabase/serverless';

const STATEMENTS = [
  `ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_status_check`,
  `ALTER TABLE loads ADD CONSTRAINT loads_status_check
     CHECK (status = ANY (ARRAY['Booked'::text, 'Awaiting Signature'::text, 'Dispatched'::text, 'In Transit'::text, 'Delivered'::text, 'Invoiced'::text, 'Closed'::text]))`,
  `ALTER TABLE loads
     ADD COLUMN IF NOT EXISTS carrier_signature_due_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS carrier_signature_received_at TIMESTAMPTZ`,
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
  console.log('Migration 049 applied.');
}
main().catch((err) => { console.error('Migration 049 failed:', err); process.exit(1); });
