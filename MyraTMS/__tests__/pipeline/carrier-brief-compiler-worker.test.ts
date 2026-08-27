/**
 * CarrierBriefCompilerWorker integration test (E2-04 M5).
 * Runs against live Neon + live Upstash-backed BullMQ (this suite's
 * established convention). Covers: the happy path (brief compiled,
 * carrier-call-queue enqueued for the first time), no-ranked-carriers
 * escalation, no-active-persona escalation, and the stage-mismatch no-op.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import {
  CarrierBriefCompilerWorker,
  type CarrierBriefJobPayload,
} from '@/lib/workers/carrier-brief-compiler-worker';

const RUN_ID = Date.now();
const REAL_CARRIER_ID = 'car_001'; // FastHaul Logistics, Active — same known-good fixture compiler.test.ts uses
const seededPipelineLoadIds: number[] = [];
const seededMatchResultIds: string[] = [];
let seededTestPersonaId: number | null = null;

async function seedPipelineLoad(opts: { stage: string; loadId?: string; loadSourceClass?: string }): Promise<{ id: number; loadId: string }> {
  const loadId = opts.loadId ?? `TEST-CBC-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       shipper_company, shipper_email, shipper_phone,
       posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency,
       confirmed_rate, confirmed_rate_currency, confirmed_at, load_source_class
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
       'Carrier Brief Test Co', 'shipper@test.test', '+17055550000',
       2400, 'CAD', $2, 2200, 'CAD',
       2200, 'CAD', NOW(), $3
     ) RETURNING id`,
    [loadId, opts.stage, opts.loadSourceClass ?? null],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return { id: ins.rows[0].id, loadId };
}

async function seedMatchResult(loadId: string, carrierId: string, score: number) {
  const id = `MR-CBC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  seededMatchResultIds.push(id);
  await db.query(
    `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at)
     VALUES ($1, $2, $3, $4, 'B', $5, false, 'auto', NOW())`,
    [id, loadId, carrierId, score, JSON.stringify({})],
  );
}

function jobPayload(pipelineLoadId: number, loadId: string): CarrierBriefJobPayload {
  return { pipelineLoadId, loadId, loadBoardSource: '', enqueuedAt: new Date().toISOString(), priority: 0 };
}

describe('CarrierBriefCompilerWorker (E2-04 M5)', () => {
  let carrierCallQueue: Queue;
  let worker: CarrierBriefCompilerWorker;

  beforeAll(async () => {
    carrierCallQueue = new Queue('carrier-call-queue', { connection: redisConnection });
    await carrierCallQueue.pause();
    worker = new CarrierBriefCompilerWorker(redisConnection, carrierCallQueue);
  });

  afterAll(async () => {
    if (seededTestPersonaId) {
      await db.query(`DELETE FROM personas WHERE id = $1`, [seededTestPersonaId]);
    }
    if (seededMatchResultIds.length) {
      await db.query(`DELETE FROM match_results WHERE id = ANY($1)`, [seededMatchResultIds]);
    }
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
    await worker.shutdown();
    await carrierCallQueue.obliterate({ force: true });
    await carrierCallQueue.resume();
    await carrierCallQueue.close();
  });

  it('no ranked carriers: escalates instead of compiling a brief', async () => {
    const { id } = await seedPipelineLoad({ stage: 'shipper_confirmed' });

    const result = await worker.process(jobPayload(id, `TEST-CBC-NOCARRIER-${id}`));

    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('no_ranked_carriers');

    const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [id]);
    expect(row.rows[0].stage).toBe('escalated');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('carrier_brief_no_carriers');
  }, 15_000);

  it('ranked carriers exist but no active outbound_carrier persona: escalates (the real pre-launch state)', async () => {
    const { id, loadId } = await seedPipelineLoad({ stage: 'shipper_confirmed' });
    await seedMatchResult(loadId, REAL_CARRIER_ID, 0.8);

    const result = await worker.process(jobPayload(id, loadId));

    // Live DB's 3 seeded outbound_carrier personas are is_active=false by
    // design (migration 046) until an operator wires real Retell agent
    // ids — this is the expected state today, not a fixture gap.
    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('no_active_carrier_persona');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('carrier_brief_no_persona');
  }, 15_000);

  it('with an active carrier persona: compiles the brief, persists it, enqueues carrier-call-queue for the first time', async () => {
    const personaIns = await db.query<{ id: number }>(
      `INSERT INTO personas (persona_name, retell_agent_id_en, description, tone, prompt_template, is_active, call_type, alpha, beta)
       VALUES ($1, 'agent_test_carrier_persona', 'Test-only carrier persona', 'direct', 'test prompt', true, 'outbound_carrier', 1.00, 1.00)
       RETURNING id`,
      [`tcp_${RUN_ID}`],
    );
    seededTestPersonaId = personaIns.rows[0].id;

    const { id, loadId } = await seedPipelineLoad({ stage: 'shipper_confirmed' });
    await seedMatchResult(loadId, REAL_CARRIER_ID, 0.8);

    const result = await worker.process(jobPayload(id, loadId));

    expect(result.details?.briefCompiled).toBe(true);
    expect(result.details?.carrierStack).toEqual([REAL_CARRIER_ID]);

    const row = await db.query<{ stage: string; carrier_brief: any }>(
      `SELECT stage, carrier_brief FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    // No stage advance — carrier-side activity never moves pipeline_loads.stage.
    expect(row.rows[0].stage).toBe('shipper_confirmed');
    expect(row.rows[0].carrier_brief).not.toBeNull();
    expect(row.rows[0].carrier_brief.carrierStack).toEqual([REAL_CARRIER_ID]);
    expect(row.rows[0].carrier_brief.retellAgentId).toBe('agent_test_carrier_persona');
    expect(row.rows[0].carrier_brief.envelope.ceiling).toBeGreaterThan(0);
    expect(row.rows[0].carrier_brief.envelope.ceiling).toBeLessThan(2200);
    // F4 (closes V4): no load_source_class seeded on this fixture -- the
    // brief degrades explicitly to null rather than omitting the field or
    // crashing.
    expect(row.rows[0].carrier_brief.loadSourceClass).toBeNull();

    const jobs = await carrierCallQueue.getJobs(['waiting', 'paused']);
    const job = jobs.find((j) => j.data.pipelineLoadId === id);
    expect(job).toBeDefined();
    expect(job?.data.cascadePosition).toBe(0);
    expect(job?.data.voicemailRetryCount).toBe(0);
  }, 15_000);

  it('with load_source_class set: the brief carries it (F4, closes V4)', async () => {
    const { id, loadId } = await seedPipelineLoad({ stage: 'shipper_confirmed', loadSourceClass: 'shipper_direct' });
    await seedMatchResult(loadId, REAL_CARRIER_ID, 0.8);

    const result = await worker.process(jobPayload(id, loadId));
    expect(result.details?.briefCompiled).toBe(true);

    const row = await db.query<{ carrier_brief: any }>(`SELECT carrier_brief FROM pipeline_loads WHERE id = $1`, [id]);
    expect(row.rows[0].carrier_brief.loadSourceClass).toBe('shipper_direct');
  }, 15_000);

  it('load not at shipper_confirmed: no-ops', async () => {
    const { id, loadId } = await seedPipelineLoad({ stage: 'booked' });

    const result = await worker.process(jobPayload(id, loadId));

    expect(result.details?.skipped).toBe('stage_mismatch');
  }, 15_000);
});
