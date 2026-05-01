/**
 * Applies scripts/pipeline_migrations.sql to the database referenced by DATABASE_URL.
 * Uses @neondatabase/serverless Pool (WebSocket transport) so multi-statement SQL works.
 *
 * Usage: pnpm tsx scripts/apply-pipeline-migration.ts
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import fs from 'node:fs';
import path from 'node:path';

// Provide a WebSocket implementation for Node (browsers have it native)
neonConfig.webSocketConstructor = ws as any;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const fileArg = process.argv[2] || 'pipeline_migrations.sql';
  const sqlPath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), 'scripts', fileArg);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log(`Applying ${sqlPath} (${sql.length} bytes) to Neon...`);

  const pool = new Pool({ connectionString: url });
  try {
    const start = Date.now();
    await pool.query(sql);
    console.log(`Migration applied successfully in ${Date.now() - start}ms`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
