/**
 * self-call.ts — first live-call test that dials the OPERATOR'S OWN number.
 *
 * The safest possible first live Retell call: instead of a real third-party
 * shipper, the single load's "shipper phone" is your own phone. When
 * MAX_CONCURRENT_CALLS>=1 on the Railway worker host, the Voice agent calls you
 * and you talk to the negotiation persona live.
 *
 * Commands:
 *   seed     — log operator consent + a placeholder DNC row (compliance hygiene)
 *   import   — inject ONE high-confidence load (Toronto->Montreal Dry Van,
 *              generous rate so it reaches `briefed`), shipper phone = SELF_CALL_TO
 *   watch    — snapshot this load's stage + recent agent_calls
 *   cleanup  — delete the TEST_SELFCALL_* rows
 *
 * Env:
 *   DATABASE_URL          (required)
 *   SELF_CALL_TO          (required) target phone, E.164, e.g. +14168291197
 *   PIPELINE_IMPORT_TOKEN (required for `import`)
 *   BASE_URL              (default https://myratms.vercel.app)
 *
 * Run from MyraTMS/:
 *   SELF_CALL_TO=+14168291197 pnpm tsx --env-file=.env.local scripts/sprint6-shadow/self-call.ts import
 */
import { neon } from '@neondatabase/serverless';
import { Queue } from 'bullmq';
import { redisConnection } from '../../lib/pipeline/redis-bullmq';
import { ScannerService } from '../../lib/workers/scanner-worker';

const sql = neon(process.env.DATABASE_URL!);
const TO = process.env.SELF_CALL_TO ?? '';
const LOAD_PREFIX = 'TEST_SELFCALL_';

function buildLoad() {
  // Toronto -> Montreal, Dry Van, 335 mi. Generous CAD rate (~$4/mi) guarantees
  // a healthy margin so the Researcher picks a `standard`/`aggressive` strategy
  // (not `walk`) and the Compiler produces a valid brief.
  const miles = 335;
  const postedRate = Math.round(miles * 4.0); // ~1340 CAD
  const pickup = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  pickup.setHours(8, 0, 0, 0);
  const delivery = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  delivery.setHours(17, 0, 0, 0);
  return {
    loadId: `${LOAD_PREFIX}${Date.now()}`,
    loadBoardSource: 'manual' as const,
    sourceUrl: null,
    originCity: 'Toronto', originState: 'ON', originCountry: 'CA',
    originLat: null, originLng: null,
    destinationCity: 'Montreal', destinationState: 'QC', destinationCountry: 'CA',
    destinationLat: null, destinationLng: null,
    equipmentType: 'Dry Van',
    commodity: 'General freight', weightLbs: 38000, distanceMiles: miles,
    pickupDate: pickup.toISOString(), pickupTimeWindow: '08:00-16:00',
    deliveryDate: delivery.toISOString(), deliveryTimeWindow: '09:00-17:00',
    postedRate, postedRateCurrency: 'CAD', rateType: 'all_in',
    shipperCompany: 'TEST_Myra Self-Call Co',
    shipperContactName: 'Operator Test',
    shipperPhone: TO,
    shipperEmail: 'selftest@example.test',
    postedAt: new Date().toISOString(),
    expiresAt: null,
    scannedAt: new Date().toISOString(),
  };
}

async function seed() {
  if (!TO) throw new Error('SELF_CALL_TO required');
  // Operator consent (hygiene; load_booking already implies consent). Best-effort.
  try {
    await sql`
      INSERT INTO consent_log (phone, consent_type, consent_source, consent_date, consent_proof, expires_at)
      VALUES (${TO}, 'implied_load_post', 'dat_load_post', NOW(),
              'Self-test: operator consents to receive AI test call', NOW() + INTERVAL '1 year')`;
    console.log('consent_log: inserted for', TO);
  } catch (e: any) { console.log('consent_log: skipped (', e.message, ')'); }

  // Placeholder DNC row so the gate is provably non-empty — a FICTIONAL number,
  // never the operator's. Best-effort across possible source/CHECK constraints.
  const dummy = '+15555550199';
  let dncOk = false;
  for (const source of ['internal', 'manual', 'federal_us']) {
    try {
      await sql`INSERT INTO dnc_list (phone, source, reason, added_by)
                VALUES (${dummy}, ${source}, 'self-test placeholder (keep DNC non-empty)', 'self-call-test')`;
      console.log('dnc_list: inserted placeholder', dummy, 'source=', source);
      dncOk = true; break;
    } catch (e: any) { /* try next source value */ }
  }
  if (!dncOk) console.log('dnc_list: placeholder insert skipped (already present or constraint)');

  // Safety assertion: operator number must NOT be on DNC.
  const onDnc = await sql`SELECT 1 FROM dnc_list WHERE phone = ${TO} LIMIT 1`;
  console.log(onDnc.length ? '⛔ WARNING: operator number IS on DNC — call would be blocked!' : '✓ operator number not on DNC');
}

async function importLoad() {
  if (!TO) throw new Error('SELF_CALL_TO required');
  if (process.env.PIPELINE_ENABLED !== 'true') throw new Error('PIPELINE_ENABLED must be true');
  const load = buildLoad();
  console.log('Enqueuing load', load.loadId, '(direct ScannerService.ingestRawLoads → qualify-queue)');
  const queue = new Queue('qualify-queue', { connection: redisConnection });
  const svc = new ScannerService(redisConnection as never, queue);
  const result = await svc.ingestRawLoads([load], 'manual');
  console.log('ingest result:', JSON.stringify(result));
  await queue.close();
  await redisConnection.quit();
  if (result.inserted < 1) process.exitCode = 1;
}

async function watch() {
  const loads = await sql`
    SELECT id, load_id, stage, top_carrier_id, recommended_strategy, updated_at
    FROM pipeline_loads WHERE load_id LIKE ${LOAD_PREFIX + '%'}
    ORDER BY updated_at DESC LIMIT 5`;
  console.log('--- self-call loads ---'); console.table(loads);
  const calls = await sql`
    SELECT call_id, retell_call_id, outcome, persona, phone_number_called, created_at
    FROM agent_calls ORDER BY created_at DESC LIMIT 5`;
  console.log('--- recent agent_calls ---'); console.table(calls);
}

async function cleanup() {
  const ids = (await sql`SELECT id FROM pipeline_loads WHERE load_id LIKE ${LOAD_PREFIX + '%'}`).map((r: any) => r.id);
  if (ids.length === 0) { console.log('cleanup: nothing to delete'); return; }
  // Delete FK children first, then the loads.
  await sql`DELETE FROM negotiation_briefs WHERE pipeline_load_id = ANY(${ids})`;
  await sql`DELETE FROM agent_calls WHERE pipeline_load_id = ANY(${ids})`;
  await sql`DELETE FROM agent_jobs WHERE pipeline_load_id = ANY(${ids})`;
  const r = await sql`DELETE FROM pipeline_loads WHERE id = ANY(${ids}) RETURNING id`;
  console.log('cleanup: deleted', r.length, 'self-call loads (+ briefs/calls/jobs)');
}

async function qstat() {
  const q = new Queue('call-queue', { connection: redisConnection });
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'paused', 'failed', 'completed');
  console.log('call-queue counts:', JSON.stringify(counts));
  const briefed = await sql`SELECT id, load_id, stage, created_by FROM pipeline_loads WHERE stage IN ('briefed','calling') ORDER BY updated_at DESC LIMIT 20`;
  console.log('--- loads in briefed/calling (could dial if a voice job is pending) ---');
  console.table(briefed);
  await q.close();
  await redisConnection.quit();
}

const cmd = process.argv[2];
const fns: Record<string, () => Promise<void>> = { seed, import: importLoad, watch, cleanup, qstat };
const fn = fns[cmd];
if (!fn) { console.error('usage: self-call.ts <seed|import|watch|cleanup>'); process.exit(1); }
fn().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
