/**
 * Sprint 6A pre-flight — verifies infra + safe env state before a shadow run.
 *
 * Exits 0 (PASS) when everything is green. Exits 1 with red details when
 * anything would prevent a clean shadow drain. Run BEFORE every shadow
 * iteration — env vars drift, DBs get state from prior runs, queues build
 * up backlog.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/01-preflight.ts
 */

import { neon } from '@neondatabase/serverless';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

type Severity = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  label: string;
  severity: Severity;
  detail?: string;
}

const checks: Check[] = [];

function record(label: string, severity: Severity, detail?: string): void {
  checks.push({ label, severity, detail });
}

const QUEUE_NAMES = [
  'qualify-queue',
  'research-queue',
  'match-queue',
  'brief-queue',
  'call-queue',
  'dispatch-queue',
  'feedback-queue',
  'callback-queue',
  'escalation-queue',
] as const;

const REQUIRED_ENV: Record<string, 'required' | 'shadow_safe'> = {
  DATABASE_URL: 'required',
  KV_REST_API_URL: 'required',
  KV_REST_API_TOKEN: 'required',
  UPSTASH_REDIS_URL: 'required',
  JWT_SECRET: 'required',
  PIPELINE_IMPORT_TOKEN: 'required',
  CRON_SECRET: 'required',
  PIPELINE_ENABLED: 'shadow_safe',
  MAX_CONCURRENT_CALLS: 'shadow_safe',
  AUTO_BOOK_PROFIT_THRESHOLD: 'shadow_safe',
};

async function checkEnvVars(): Promise<void> {
  for (const [name, kind] of Object.entries(REQUIRED_ENV)) {
    const v = process.env[name];
    if (!v) {
      record(`env.${name}`, 'FAIL', 'not set');
      continue;
    }
    if (kind === 'shadow_safe') {
      // Verify shadow-mode-safe values
      if (name === 'PIPELINE_ENABLED' && v !== 'true') {
        record(`env.${name}`, 'FAIL', `must be 'true' for workers to process jobs (got '${v}')`);
        continue;
      }
      if (name === 'MAX_CONCURRENT_CALLS' && v !== '0') {
        record(`env.${name}`, 'FAIL', `MUST be '0' for shadow mode (got '${v}'). Set to '1+' only AFTER 6A passes.`);
        continue;
      }
      if (name === 'AUTO_BOOK_PROFIT_THRESHOLD' && parseInt(v, 10) < 1000) {
        record(`env.${name}`, 'FAIL', `must be very high (e.g. 999999) to disable auto-booking; got '${v}'`);
        continue;
      }
    }
    record(`env.${name}`, 'PASS', maskEnv(name, v));
  }
}

function maskEnv(name: string, value: string): string {
  if (/SECRET|TOKEN|KEY|PASSWORD/.test(name)) {
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  if (name === 'DATABASE_URL' || name === 'UPSTASH_REDIS_URL') {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '<unparseable>';
    }
  }
  return value;
}

async function checkDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    record('db.connect', 'FAIL', 'DATABASE_URL not set');
    return;
  }
  try {
    const sql = neon(url);
    const r = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
    if (r[0]?.ok === 1) {
      record('db.connect', 'PASS');
    } else {
      record('db.connect', 'FAIL', 'unexpected response');
    }
  } catch (err) {
    record('db.connect', 'FAIL', err instanceof Error ? err.message : String(err));
  }
}

async function checkPipelineSchema(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const expected = [
    'pipeline_loads', 'agent_calls', 'negotiation_briefs', 'consent_log',
    'dnc_list', 'shipper_preferences', 'lane_stats', 'personas', 'agent_jobs',
    'loadboard_sources', 'compliance_audit',
  ];
  const rows = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name = ANY(${expected}::text[])
  `) as Array<{ table_name: string }>;
  const present = rows.map((r) => r.table_name);
  const missing = expected.filter((t) => !present.includes(t));
  if (missing.length === 0) {
    record('db.schema', 'PASS', `${expected.length} pipeline tables present`);
  } else {
    record('db.schema', 'FAIL', `missing: ${missing.join(', ')}`);
  }
}

async function checkPersonas(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const rows = (await sql`
    SELECT persona_name, retell_agent_id_en, alpha, beta, is_active
    FROM personas
    ORDER BY persona_name
  `) as Array<{
    persona_name: string;
    retell_agent_id_en: string | null;
    alpha: number;
    beta: number;
    is_active: boolean;
  }>;
  if (rows.length < 3) {
    record('db.personas', 'FAIL', `expected 3 personas, found ${rows.length}`);
    return;
  }
  const placeholders = rows.filter(
    (r) => !r.retell_agent_id_en || /^(agent_x|agent_xxx|placeholder|TODO)/i.test(r.retell_agent_id_en),
  );
  if (placeholders.length > 0) {
    record(
      'db.personas',
      'WARN',
      `${rows.length} personas seeded but ${placeholders.length} have placeholder agent IDs (${placeholders.map((p) => p.persona_name).join(', ')}) — fine for shadow mode, REQUIRED-FIX before live calls`,
    );
  } else {
    record('db.personas', 'PASS', `${rows.length} personas seeded with real agent IDs`);
  }
  const inactive = rows.filter((r) => !r.is_active);
  if (inactive.length === rows.length) {
    record('db.personas.active', 'FAIL', 'NO active personas — Compiler will refuse to compile briefs');
  } else if (inactive.length > 0) {
    record('db.personas.active', 'WARN', `${inactive.length} personas inactive`);
  }
}

async function checkCarriers(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const rows = (await sql`
    SELECT COUNT(*)::int AS active
    FROM carriers
    WHERE authority_status = 'active'
      AND (insurance_expiry IS NULL OR insurance_expiry > NOW())
  `) as Array<{ active: number }>;
  const active = rows[0]?.active ?? 0;
  if (active === 0) {
    record('db.carriers', 'FAIL', 'no active carriers — Ranker will produce 0 matches for every load');
  } else if (active < 5) {
    record('db.carriers', 'WARN', `only ${active} active carriers — match counts will be low`);
  } else {
    record('db.carriers', 'PASS', `${active} active carriers`);
  }
}

async function checkLeftoverTestData(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM pipeline_loads WHERE load_id LIKE 'TEST_%'
  `) as Array<{ n: number }>;
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    record('db.leftover_test', 'WARN', `${n} TEST_ rows still in pipeline_loads — run 06-cleanup.ts first`);
  } else {
    record('db.leftover_test', 'PASS', 'no leftover TEST_ rows');
  }
}

async function checkRedisAndQueues(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_URL;
  if (!url) {
    record('redis.connect', 'FAIL', 'UPSTASH_REDIS_URL not set');
    return;
  }
  const redis = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') record('redis.connect', 'PASS');
    else record('redis.connect', 'FAIL', `unexpected: ${pong}`);
  } catch (err) {
    record('redis.connect', 'FAIL', err instanceof Error ? err.message : String(err));
    await redis.quit().catch(() => {});
    return;
  }

  // Queue presence + backlog check
  for (const name of QUEUE_NAMES) {
    try {
      const q = new Queue(name, { connection: redis });
      const counts = await q.getJobCounts('waiting', 'active', 'failed', 'delayed');
      const total = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
      const failed = counts.failed ?? 0;
      let detail = `waiting=${counts.waiting} active=${counts.active} delayed=${counts.delayed} failed=${failed}`;
      let severity: Severity = 'PASS';
      if (failed > 50) {
        severity = 'WARN';
        detail += ' — high failed count, consider obliterate';
      }
      if (total > 200) {
        severity = 'WARN';
        detail += ' — high backlog from prior runs';
      }
      record(`queue.${name}`, severity, detail);
      await q.close();
    } catch (err) {
      record(`queue.${name}`, 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  await redis.quit().catch(() => {});
}

async function checkWorkerImports(): Promise<void> {
  const moduleSpecs = [
    'qualifier-worker',
    'researcher-worker',
    'ranker-worker',
    'compiler-worker',
    'voice-worker',
    'dispatcher-worker',
    'feedback-worker',
  ];
  for (const m of moduleSpecs) {
    try {
      // Import via relative path so this script doesn't require Next path aliases at runtime
      // The worker host (scripts/run-workers.ts) does the same.
      // Path resolution is from MyraTMS/ root; this script lives at MyraTMS/scripts/sprint6-shadow/.
      await import(`../../lib/workers/${m}.js`).catch(async () => {
        // Fallback to .ts via tsx's transformer
        await import(`../../lib/workers/${m}.ts`);
      });
      record(`worker.${m}`, 'PASS');
    } catch (err) {
      record(`worker.${m}`, 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }
}

function summary(): number {
  console.log('\n=== Sprint 6A pre-flight ===\n');
  let fails = 0;
  let warns = 0;
  for (const c of checks) {
    const icon = c.severity === 'PASS' ? '✓' : c.severity === 'WARN' ? '!' : '✗';
    const color = c.severity === 'PASS' ? '\x1b[32m' : c.severity === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const line = `${color}${icon}${reset} ${c.label.padEnd(40)} ${c.detail ?? ''}`;
    console.log(line);
    if (c.severity === 'FAIL') fails++;
    if (c.severity === 'WARN') warns++;
  }
  console.log(`\n  PASS: ${checks.length - fails - warns}   WARN: ${warns}   FAIL: ${fails}\n`);
  if (fails === 0) {
    console.log('\x1b[32mPRE-FLIGHT: OK ✓\x1b[0m  — proceed to 02-generate-shadow-loads.ts');
    return 0;
  }
  console.log('\x1b[31mPRE-FLIGHT: FAILED ✗\x1b[0m  — fix the FAIL items above before proceeding');
  return 1;
}

async function main(): Promise<void> {
  await checkEnvVars();
  await checkDatabase();
  await checkPipelineSchema();
  await checkPersonas();
  await checkCarriers();
  await checkLeftoverTestData();
  await checkRedisAndQueues();
  await checkWorkerImports();
  process.exit(summary());
}

main().catch((err) => {
  console.error('Pre-flight crashed:', err);
  process.exit(1);
});
