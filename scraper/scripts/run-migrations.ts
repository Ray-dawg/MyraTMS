/**
 * Apply scraper migrations to the Neon PostgreSQL database.
 *
 * Reads every .sql file in /migrations in lexical order and runs them
 * through pg.Client. The migration files are idempotent (IF NOT EXISTS),
 * so re-running is safe.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run migrate
 *   # or:  npx tsx --env-file=.env scripts/run-migrations.ts
 */

import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found.');
    return;
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    for (const f of files) {
      const path = join(MIGRATIONS_DIR, f);
      const sql = readFileSync(path, 'utf8');
      console.log(`→ Applying ${f} (${sql.length} bytes)`);
      await client.query(sql);
      console.log(`  ✓ ok`);
    }
    console.log(`\nApplied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
