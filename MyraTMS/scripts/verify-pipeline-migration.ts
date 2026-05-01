/**
 * Verifies that scripts/pipeline_migrations.sql was applied per build plan §4.2.
 * Usage: pnpm tsx --env-file=.env.local scripts/verify-pipeline-migration.ts
 */

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sqlClient = neon(url) as any;
  const sql = (text: string, params: unknown[] = []) => sqlClient.query(text, params);

  // 1. Confirm 9 new pipeline tables
  const tableNames = ['pipeline_loads','agent_calls','negotiation_briefs','consent_log','dnc_list','shipper_preferences','lane_stats','personas','agent_jobs'];
  const tables = await sql(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tableNames],
  );
  console.log(`\n[1/4] Pipeline tables present (expected 9): ${tables.length}`);
  for (const r of tables) console.log(`      - ${r.table_name}`);
  const missing = tableNames.filter(n => !tables.some((r: any) => r.table_name === n));
  if (missing.length) console.log(`      MISSING: ${missing.join(', ')}`);

  // 2. Confirm 3 personas seeded with retell_agent_id_en populated
  const personas = await sql(
    `SELECT persona_name, retell_agent_id_en, alpha, beta, is_active FROM personas ORDER BY persona_name`, [],
  );
  console.log(`\n[2/4] Personas seeded (expected 3): ${personas.length}`);
  for (const p of personas) {
    const id = p.retell_agent_id_en || '<NULL>';
    const masked = id.length > 12 ? `${id.slice(0,8)}…${id.slice(-4)}` : id;
    console.log(`      - ${p.persona_name.padEnd(11)} agent=${masked} α=${p.alpha} β=${p.beta} active=${p.is_active}`);
  }

  // 3. Confirm column additions on loads/carriers/shippers
  const columnChecks: Array<[string, string[]]> = [
    ['loads',    ['pipeline_load_id','source_type','booked_via']],
    ['carriers', ['accepts_ai_dispatch','ai_call_count']],
    ['shippers', ['consent_status','preferred_language','shipper_fatigue_score']],
  ];
  console.log(`\n[3/4] Column additions:`);
  for (const [table, cols] of columnChecks) {
    const found = await sql(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name=$1 AND column_name = ANY($2::text[])
       ORDER BY column_name`,
      [table, cols],
    );
    const foundNames = found.map((r: any) => r.column_name);
    const m = cols.filter(c => !foundNames.includes(c));
    console.log(`      ${table}: ${foundNames.length}/${cols.length} columns (${foundNames.join(', ') || 'none'}${m.length ? '; MISSING ' + m.join(', ') : ''})`);
  }

  // 4. Confirm pipeline_loads is empty (sanity check — fresh state)
  const loadCount = await sql(`SELECT COUNT(*)::int AS n FROM pipeline_loads`, []);
  console.log(`\n[4/4] pipeline_loads row count: ${loadCount[0].n}`);

  console.log('\n=== VERIFICATION COMPLETE ===\n');
}

main().catch((err) => { console.error('Verify failed:', err); process.exit(1); });
