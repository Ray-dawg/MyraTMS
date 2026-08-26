/**
 * E2-03 M2 §6.8 — integration-level cascade fixtures. Each test posts a
 * synthetic Retell webhook payload (never a real HTTP call to Retell) and
 * asserts the resulting DB writes + carrier-call-queue enqueue. Complements
 * carrier-cascade.test.ts's pure unit tests with the actual wiring.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { Queue } from 'bullmq';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
import crypto from 'crypto';

const RUN_ID = Date.now();
const WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || 'test-secret';

function signedRequest(body: object) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw + ts).digest('hex');
  return {
    text: async () => raw,
    headers: { 'x-retell-signature': `v=${ts},d=${digest}` },
  };
}

describe('carrier cascade — webhook integration (E2-03 M2 §6.8)', () => {
  let pipelineLoadId: number;
  const loadId = `TEST-WEBHOOK-CASCADE-${RUN_ID}`;
  const carriers = ['wc1', 'wc2', 'wc3'].map((s) => `${s}_${RUN_ID}`);
  const carrierCallQueue = new Queue('carrier-call-queue', { connection: redisConnection });
  // E2-04 M6: an accept now also enqueues dispatch-queue -- pause/inspect
  // it the same way as carrierCallQueue, same cross-file-pollution reasoning.
  const dispatchQueue = new Queue('dispatch-queue', { connection: redisConnection });
  const prevSecret = process.env.RETELL_WEBHOOK_SECRET;

  beforeAll(async () => {
    // Pausing the queue (a real BullMQ/Redis operation, not just this Queue
    // instance) stops EVERY worker anywhere -- including a dangling
    // CarrierVoiceWorker from a concurrently-running test file that hasn't
    // reached its own afterAll shutdown yet -- from consuming the jobs this
    // file enqueues while its assertions are still reading job counts.
    // Without this, a stray worker can race-consume a job mid-test and
    // corrupt both files' state (E2-03 M2 Session 2 cross-file pollution,
    // found once carrierCallQueue.add() started producing real jobs).
    await carrierCallQueue.pause();
    await dispatchQueue.pause();
  });

  afterAll(async () => {
    await carrierCallQueue.resume();
    await carrierCallQueue.close();
    const dispatchJobs = await dispatchQueue.getJobs(['waiting', 'paused']);
    if (dispatchJobs.length) await dispatchQueue.drain(true);
    await dispatchQueue.resume();
    await dispatchQueue.close();
  });

  beforeEach(async () => {
    process.env.RETELL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Webhook Cascade Co', 'x@test.test', '+17055551234', 2400, 'CAD', $2, 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [loadId, carriers[0]],
    );
    pipelineLoadId = ins.rows[0].id;
    for (let i = 0; i < carriers.length; i++) {
      await db.query(
        `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
           authority_status, insurance_status, insurance_expiry,
           liability_insurance, cargo_insurance, safety_rating,
           carrier_status, contact_phone, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
           750000, 100000, 'Not Rated', 'active', $5, NOW(), NOW())`,
        [carriers[i], LEGACY_DEFAULT_TENANT_ID, `Webhook Carrier ${i}`, `888${RUN_ID}${i}`, `+1555020${1000 + i}`],
      );
    }
    for (let i = 0; i < carriers.length; i++) {
      await db.query(
        `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown)
         VALUES ($1, $2, $3, $4, 'B', $5)`,
        [`MR-WEBHOOK-${RUN_ID}-${i}`, loadId, carriers[i], 0.9 - i * 0.1, JSON.stringify({ rate: { carrier_avg_rate: 1800 } })],
      );
    }
  });

  afterEach(async () => {
    process.env.RETELL_WEBHOOK_SECRET = prevSecret;
    // Defensive: even with the queue paused, clear any agent_jobs row that
    // could otherwise FK-block the pipeline_loads delete below.
    await db.query(`DELETE FROM agent_jobs WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [loadId]);
    // pipeline_loads before carriers (E2-04 M6): carrier_id_secured now
    // gets a real value on an accept -- a genuine FK from pipeline_loads to
    // carriers this test never exercised before that write existed.
    // Deleting carriers first would violate it and abort this whole
    // afterEach mid-way, leaving pipeline_loads' row (and its fixed loadId
    // constant, reused every test) behind to collide with the next test's
    // beforeEach insert -- exactly the failure this ordering fix closes.
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [carriers]);
  });

  function carrierPayload(overrides: Partial<any>) {
    return {
      call_id: `call_${RUN_ID}_${Math.random().toString(36).slice(2)}`,
      agent_id: 'agent_test',
      call_status: 'completed',
      from_number: '+15145551000',
      to_number: '+17055551234',
      duration_ms: 30000,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      transcript: '',
      recording_url: null,
      metadata: {
        pipelineLoadId,
        briefId: 1,
        persona: 'assertive',
        language: 'en',
        currency: 'CAD',
        callType: 'outbound_carrier',
        cascadePosition: 0,
        voicemailRetryCount: 0,
        carrierId: carriers[0],
        stackLength: carriers.length,
      },
      ...overrides,
    };
  }

  it('decline on carrier 1 of 3 re-enqueues carrier-call-queue at position 1', async () => {
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Sorry, we cannot cover that lane this week.' });
    const res = await handleRetellWebhook(signedRequest(payload));
    expect(res.status).toBe(200);

    const load = await db.query<{ carrier_call_outcome: string }>(
      `SELECT carrier_call_outcome FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('decline');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0) + (after.paused ?? 0)).toBeGreaterThan(
      (before.waiting ?? 0) + (before.delayed ?? 0) + (before.paused ?? 0),
    );
  }, 30_000);

  it('decline on the last carrier (position 2 of 3) exhausts and escalates, no re-enqueue', async () => {
    const payload = carrierPayload({
      transcript: 'No thanks.',
      metadata: {
        pipelineLoadId, briefId: 1, persona: 'assertive', language: 'en', currency: 'CAD',
        callType: 'outbound_carrier', cascadePosition: 2, voicemailRetryCount: 0,
        carrierId: carriers[2], stackLength: carriers.length,
      },
    });
    const before = await carrierCallQueue.getJobCounts();
    const res = await handleRetellWebhook(signedRequest(payload));
    expect(res.status).toBe(200);

    const load = await db.query<{ stage: string }>(
      `SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].stage).toBe('escalated');

    const exc = await db.query(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(exc.rows).toHaveLength(1);
    expect((exc.rows[0] as any).type).toBe('carrier_cascade_exhausted');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0) + (after.paused ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0) + (before.paused ?? 0));
  }, 30_000);

  it('voicemail on carrier 1 schedules a delayed retry at the same position, not an advance', async () => {
    const payload = carrierPayload({ call_status: 'voicemail', transcript: '' });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getDelayed();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.cascadePosition).toBe(0);
    expect(mine!.data.voicemailRetryCount).toBe(1);
  }, 30_000);

  it('no_answer after the retry is already used advances to the next position immediately (no delay)', async () => {
    const payload = carrierPayload({
      call_status: 'no_answer',
      metadata: {
        pipelineLoadId, briefId: 1, persona: 'assertive', language: 'en', currency: 'CAD',
        callType: 'outbound_carrier', cascadePosition: 0, voicemailRetryCount: 1,
        carrierId: carriers[0], stackLength: carriers.length,
      },
    });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getWaiting();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.cascadePosition).toBe(1);
    expect(mine!.data.voicemailRetryCount).toBe(0);
  }, 30_000);

  it('failed call_status (mapped to "disconnected") is retried once before advancing, same as voicemail', async () => {
    const payload = carrierPayload({ call_status: 'failed' });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getDelayed();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.voicemailRetryCount).toBe(1);
  }, 30_000);

  it('accept within the envelope ceiling does not enqueue a cascade step (cascade ends), secures the carrier, and enqueues dispatch-queue', async () => {
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Great, we agreed to $1800 for this load.' });
    await handleRetellWebhook(signedRequest(payload));

    const load = await db.query<{ carrier_call_outcome: string; carrier_agreed_rate: string; carrier_id_secured: string | null }>(
      `SELECT carrier_call_outcome, carrier_agreed_rate, carrier_id_secured FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('accept');
    expect(Number(load.rows[0].carrier_agreed_rate)).toBe(1800);
    // E2-04 M6: the real gap this session closed -- carrier_id_secured was
    // never written by any code path before this fix, so
    // dispatcher-worker.ts's cascade-secured branch could never fire.
    expect(load.rows[0].carrier_id_secured).toBe(carriers[0]);

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0) + (after.paused ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0) + (before.paused ?? 0));

    // The other half of the same gap: nothing used to enqueue dispatch-queue
    // after an accept at all.
    // BullMQ 5.x: a job added with priority > 0 lands in the 'prioritized'
    // state, not 'waiting' -- the same gotcha Sprint 2's own completion.md
    // entry already documents catching once before.
    const dispatchJobs = await dispatchQueue.getJobs(['waiting', 'paused', 'prioritized']);
    const job = dispatchJobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(job).toBeDefined();
    expect(job?.data.agreedRate).toBe(2200); // pipeline_loads.agreed_rate seeded above (no confirmed_rate on this fixture -> fallback)
  }, 30_000);

  it('accept above the envelope ceiling is rewritten to escalated and does not enqueue a cascade step', async () => {
    // agreed_rate_currency CAD, agreed_rate 2200 -> carrier ceiling well
    // under $2200; $2199 asked by the carrier exceeds any sane margin floor.
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Deal, we agreed to $2199 for the run.' });
    await handleRetellWebhook(signedRequest(payload));

    const load = await db.query<{ carrier_call_outcome: string }>(
      `SELECT carrier_call_outcome FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('escalated');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0) + (after.paused ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0) + (before.paused ?? 0));
  }, 30_000);
});
