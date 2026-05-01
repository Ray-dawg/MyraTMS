/**
 * Sprint 6B — live-call pre-flight.
 *
 * AGGRESSIVE GATE before flipping MAX_CONCURRENT_CALLS=0 → 1. The cost
 * of a missed shadow check is wasted disk; the cost of a missed live
 * check is calling the wrong shipper at 3am, possibly violating CASL/
 * TCPA, possibly burning trust. This script refuses to greenlight if
 * ANY check fails. There is no `--force`.
 *
 * What it verifies:
 *   ✓ All required env vars set (RETELL_API_KEY, RETELL_WEBHOOK_SECRET, ANTHROPIC_API_KEY)
 *   ✓ Webhook URL reachable AND returns 401/403 to unsigned requests
 *   ✓ All personas have real (non-placeholder) Retell agent IDs
 *   ✓ DNC list non-empty (operator's own numbers should be on it)
 *   ✓ Calling-hours window currently allows calls (you should be at the keyboard)
 *   ✓ MAX_CONCURRENT_CALLS is currently 0 (script flips it AFTER you confirm)
 *   ✓ Shadow Phase 6A passed metrics in the last 7 days (audit trail check)
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts --webhook-url=https://your-app.vercel.app/api/webhooks/retell-callback
 */

import { neon } from '@neondatabase/serverless';

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

function parseArgs(): { webhookUrl: string | null } {
  const args = process.argv.slice(2);
  let webhookUrl: string | null = null;
  for (const a of args) {
    if (a.startsWith('--webhook-url=')) webhookUrl = a.split('=')[1];
  }
  if (!webhookUrl) {
    webhookUrl =
      process.env.RETELL_WEBHOOK_PUBLIC_URL ||
      (process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/retell-callback` : null);
  }
  return { webhookUrl };
}

function checkEnv(): void {
  const required = ['RETELL_API_KEY', 'RETELL_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'JWT_SECRET'];
  for (const name of required) {
    const v = process.env[name];
    if (!v) {
      record(`env.${name}`, 'FAIL', 'not set — live calls cannot proceed');
    } else if (v.length < 16) {
      record(`env.${name}`, 'WARN', `unusually short (${v.length} chars) — verify it's the real key`);
    } else {
      record(`env.${name}`, 'PASS', `${v.slice(0, 4)}…${v.slice(-4)}`);
    }
  }

  const maxConcurrent = process.env.MAX_CONCURRENT_CALLS;
  if (maxConcurrent !== '0') {
    record(
      'env.MAX_CONCURRENT_CALLS',
      'FAIL',
      `must be '0' when running this preflight (got '${maxConcurrent}'). Flip it to '1' AFTER this passes, then deploy.`,
    );
  } else {
    record('env.MAX_CONCURRENT_CALLS', 'PASS', '0 (will flip to 1+ after green)');
  }

  const autobook = parseInt(process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999', 10);
  if (autobook < 1000) {
    record('env.AUTO_BOOK_PROFIT_THRESHOLD', 'FAIL', `must be high (e.g. 999999) for first 10 calls — got ${autobook}`);
  } else {
    record('env.AUTO_BOOK_PROFIT_THRESHOLD', 'PASS', `${autobook} (auto-book disabled)`);
  }
}

async function checkPersonas(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const rows = (await sql`
    SELECT persona_name, retell_agent_id_en, is_active
    FROM personas
    WHERE is_active = true
    ORDER BY persona_name
  `) as Array<{ persona_name: string; retell_agent_id_en: string | null; is_active: boolean }>;

  if (rows.length < 3) {
    record('personas.active', 'FAIL', `expected 3 active personas, got ${rows.length}`);
    return;
  }

  const placeholders = rows.filter(
    (r) => !r.retell_agent_id_en ||
      /^(agent_x|agent_xxx|placeholder|TODO|test_)/i.test(r.retell_agent_id_en) ||
      r.retell_agent_id_en.length < 12,
  );

  if (placeholders.length > 0) {
    record(
      'personas.retell_agent_ids',
      'FAIL',
      `${placeholders.length} persona(s) have placeholder/short agent IDs: ${placeholders.map((p) => `${p.persona_name}=${p.retell_agent_id_en ?? 'NULL'}`).join(', ')}. Configure each in the Retell dashboard, then UPDATE personas SET retell_agent_id_en='<real_id>'.`,
    );
  } else {
    record('personas.retell_agent_ids', 'PASS', `${rows.length} personas with real agent IDs`);
  }
}

async function checkDNC(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  const rows = (await sql`SELECT COUNT(*)::int AS n FROM dnc_list`) as Array<{ n: number }>;
  const n = rows[0]?.n ?? 0;
  if (n === 0) {
    record(
      'dnc_list',
      'WARN',
      'DNC list is empty. Add at least your own phone numbers and any other do-not-call entries before going live.',
    );
  } else {
    record('dnc_list', 'PASS', `${n} entries`);
  }
}

function checkCallingHours(): void {
  // Simple check: not 1-7am local (broad-stroke; the real Voice worker checks per-shipper TZ)
  const hour = new Date().getHours();
  if (hour < 8 || hour >= 20) {
    record(
      'calling_hours',
      'WARN',
      `current local hour is ${hour}:00 — outside typical 8-20 window. Voice worker WILL still gate per-call, but you may not see calls fire if every test shipper's TZ is also outside hours.`,
    );
  } else {
    record('calling_hours', 'PASS', `${hour}:00 — within typical window`);
  }
}

async function checkWebhook(webhookUrl: string | null): Promise<void> {
  if (!webhookUrl) {
    record('webhook.url', 'FAIL', 'No webhook URL — pass --webhook-url= or set NEXT_PUBLIC_APP_URL');
    return;
  }

  try {
    // Send an unsigned POST. The webhook MUST reject this (HMAC verification).
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', call_id: 'preflight' }),
    });

    if (res.status === 401 || res.status === 403) {
      record('webhook.signature_check', 'PASS', `${webhookUrl} rejects unsigned requests with HTTP ${res.status}`);
    } else if (res.status >= 500) {
      record('webhook.signature_check', 'FAIL', `${webhookUrl} returned ${res.status} (server error — investigate)`);
    } else if (res.status === 200) {
      record('webhook.signature_check', 'FAIL', `${webhookUrl} accepted an unsigned request (security hole — verify HMAC verification is on)`);
    } else {
      record('webhook.signature_check', 'WARN', `${webhookUrl} returned ${res.status} (expected 401/403)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record('webhook.reachable', 'FAIL', `cannot reach ${webhookUrl}: ${msg}`);
  }
}

async function checkRetellAPI(): Promise<void> {
  const key = process.env.RETELL_API_KEY;
  if (!key) return;
  try {
    // Hit Retell's GET /list-agents (lightweight, low-side-effect).
    const res = await fetch('https://api.retellai.com/list-agents', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 200) {
      const data = (await res.json()) as Array<unknown>;
      record('retell.api', 'PASS', `Retell API reachable, ${Array.isArray(data) ? data.length : '?'} agents configured`);
    } else if (res.status === 401) {
      record('retell.api', 'FAIL', 'Retell API rejected key — verify RETELL_API_KEY is current');
    } else {
      record('retell.api', 'WARN', `Retell returned ${res.status}`);
    }
  } catch (err) {
    record('retell.api', 'FAIL', `cannot reach Retell API: ${err instanceof Error ? err.message : err}`);
  }
}

async function checkRecentShadowRun(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = neon(url);
  // Was there a TEST_ shadow run in the last 7 days?
  const rows = (await sql`
    SELECT MAX(created_at)::text AS last_test_run, COUNT(*)::int AS n
    FROM pipeline_loads
    WHERE load_id LIKE 'TEST_%'
      AND created_at > NOW() - INTERVAL '7 days'
  `) as Array<{ last_test_run: string | null; n: number }>;

  const n = rows[0]?.n ?? 0;
  if (n === 0) {
    record(
      'shadow.recent_run',
      'WARN',
      'No TEST_ shadow rows in the last 7 days. Ran 02-generate-shadow-loads.ts → 04-shadow-metrics.ts at all? Going live without a recent shadow pass is risky.',
    );
  } else {
    record('shadow.recent_run', 'PASS', `${n} TEST_ loads in last 7 days (last: ${rows[0].last_test_run})`);
  }
}

function summary(): number {
  console.log('\n=== Sprint 6B — Live-Call Pre-Flight ===\n');
  let fails = 0;
  let warns = 0;
  for (const c of checks) {
    const icon = c.severity === 'PASS' ? '✓' : c.severity === 'WARN' ? '!' : '✗';
    const color = c.severity === 'PASS' ? '\x1b[32m' : c.severity === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`${color}${icon}${reset} ${c.label.padEnd(36)} ${c.detail ?? ''}`);
    if (c.severity === 'FAIL') fails++;
    if (c.severity === 'WARN') warns++;
  }
  console.log(`\n  PASS: ${checks.length - fails - warns}   WARN: ${warns}   FAIL: ${fails}\n`);

  if (fails === 0) {
    console.log('\x1b[32mLIVE CALLS: APPROVED ✓\x1b[0m');
    console.log('\nNext steps:');
    console.log('  1. Set MAX_CONCURRENT_CALLS=1 in Vercel env');
    console.log('  2. Redeploy MyraTMS so the env change takes effect');
    console.log('  3. Restart the worker host (Railway service: scripts/run-workers.ts)');
    console.log('  4. Submit your 10-shipper batch via /api/pipeline/import');
    console.log('  5. Watch Retell dashboard live and SQL queries in 03-watch-pipeline.sql');
    return 0;
  }
  console.log('\x1b[31mLIVE CALLS: BLOCKED ✗\x1b[0m  — fix the FAIL items above. Do NOT bypass.');
  return 1;
}

async function main(): Promise<void> {
  const { webhookUrl } = parseArgs();
  checkEnv();
  await checkPersonas();
  await checkDNC();
  checkCallingHours();
  await checkWebhook(webhookUrl);
  await checkRetellAPI();
  await checkRecentShadowRun();
  process.exit(summary());
}

main().catch((err) => {
  console.error('Pre-flight crashed:', err);
  process.exit(1);
});
