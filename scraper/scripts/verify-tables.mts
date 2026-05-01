import { Client } from 'pg';

const c = new Client({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name)::int AS cols
  FROM information_schema.tables t
  WHERE table_schema='public' AND table_name IN ('scraper_runs','scraper_log')
  ORDER BY table_name`);
console.log('Tables:', r.rows);
const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('scraper_runs','scraper_log') ORDER BY indexname`);
console.log('Indexes:', idx.rows);
await c.end();
