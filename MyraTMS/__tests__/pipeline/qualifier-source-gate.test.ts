/**
 * E2-01 M1 — F1 shipper-direct gate enforcement in the Qualifier.
 * Live Neon + Redis, like qualifier.test.ts. Seeds poster_registry rows so
 * no FMCSA call is ever made; every poster resolves from the registry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QualifierWorker, type QualifyJobPayload } from '@/lib/workers/qualifier-worker';

const RUN = Date.now();
const BROKER_MC = `9${String(RUN).slice(-6)}`;
const SHIPPER_NAME = `TEST Shipper ${RUN}`;
const CARRIER_NAME = `TEST Carrier ${RUN}`;

async function insertLoad(suffix: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country, pickup_date, equipment_type,
       posted_rate, posted_rate_currency, distance_miles, stage, created_by)
     VALUES ($1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US', NOW() + INTERVAL '3 days', 'Dry Van',
       2400, 'USD', 920, 'scanned', 'test')
     RETURNING id`,
    [`TEST-GATE-${suffix}-${RUN}`],
  );
  return r.rows[0].id;
}

function payload(id: number, loadId: string, poster: Partial<QualifyJobPayload>): QualifyJobPayload {
  return {
    pipelineLoadId: id,
    loadId,
    loadBoardSource: 'csv',
    enqueuedAt: new Date().toISOString(),
    priority: 0,
    origin: { city: 'Chicago', state: 'IL', country: 'US' },
    destination: { city: 'Dallas', state: 'TX', country: 'US' },
    equipmentType: 'Dry Van',
    postedRate: 2400,
    postedRateCurrency: 'USD',
    distanceMiles: 920,
    pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
    shipperPhone: null,
    ...poster,
  };
}

describe('QualifierWorker shipper-direct gate (enforce)', () => {
  let worker: QualifierWorker;
  let researchQ: Queue;
  let matchQ: Queue;
  const ids: number[] = [];
  const prevEnv = {
    en: process.env.SHIPPER_DIRECT_GATE_ENABLED,
    mode: process.env.SHIPPER_DIRECT_GATE_MODE,
    pipe: process.env.PIPELINE_ENABLED,
  };

  beforeAll(async () => {
    process.env.PIPELINE_ENABLED = 'true';
    researchQ = new Queue('research-queue-gate-test', { connection: redisConnection });
    matchQ = new Queue('match-queue-gate-test', { connection: redisConnection });
    worker = new QualifierWorker(redisConnection, researchQ, matchQ);
    await db.query(
      `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, country, entity_class, class_source, confidence)
       VALUES ('TEST Broker', 'test broker', $1, 'US', 'broker', 'human_review', 1.0),
              ($2::varchar, LOWER($2::varchar), NULL, 'US', 'shipper', 'human_review', 1.0),
              ($3::varchar, LOWER($3::varchar), NULL, 'US', 'carrier_for_hire', 'human_review', 1.0)`,
      [BROKER_MC, SHIPPER_NAME, CARRIER_NAME],
    );
  });

  beforeEach(() => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';
    process.env.SHIPPER_DIRECT_GATE_MODE = 'enforce';
  });

  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [ids]);
    await db.query(
      `DELETE FROM poster_registry WHERE mc_number = $1 OR normalized_name IN (LOWER($2::varchar), LOWER($3::varchar))`,
      [BROKER_MC, SHIPPER_NAME, CARRIER_NAME],
    );
    await researchQ.obliterate({ force: true });
    await matchQ.obliterate({ force: true });
    await researchQ.close();
    await matchQ.close();
    await worker.shutdown();
    process.env.SHIPPER_DIRECT_GATE_ENABLED = prevEnv.en;
    process.env.SHIPPER_DIRECT_GATE_MODE = prevEnv.mode;
    process.env.PIPELINE_ENABLED = prevEnv.pipe;
  });

  it('rejects a registry-known broker with broker_posted_no_agreement before any other filter', async () => {
    const id = await insertLoad('broker');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-broker-${RUN}`, { posterCompanyRaw: 'TEST Broker', posterMcNumber: BROKER_MC }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason, load_source_class FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('disqualified');
    expect(row.qualification_reason).toBe('broker_posted_no_agreement');
    expect(row.load_source_class).toBe('broker_posted');
    const fanout = await researchQ.getJobs(['waiting', 'prioritized']);
    expect(fanout.some((j) => j.data.pipelineLoadId === id)).toBe(false);
  });

  it('accepts a registry-known shipper and adds the +100 priority bonus', async () => {
    const id = await insertLoad('shipper');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-shipper-${RUN}`, { posterCompanyRaw: SHIPPER_NAME }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, load_source_class, load_source_method, priority_score FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('qualified');
    expect(row.load_source_class).toBe('shipper_direct');
    expect(row.load_source_method).toBe('registry');
    expect(Number(row.priority_score)).toBeGreaterThanOrEqual(100);
  });

  it('accepts a manual import attested yes even with no poster identity', async () => {
    const id = await insertLoad('attested');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-attested-${RUN}`, { isManualImport: true, attestation: 'yes' }));
    expect(res.details?.passed).toBe(true);
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT load_source_class, load_source_method FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ load_source_class: 'shipper_direct', load_source_method: 'manual_attestation' });
  });

  it('rejects a board row with no poster identity with poster_identity_missing', async () => {
    const id = await insertLoad('noid');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-noid-${RUN}`, {}));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ stage: 'disqualified', qualification_reason: 'poster_identity_missing' });
  });

  it('routes a registry-known for-hire carrier to review: escalated + exceptions row', async () => {
    const id = await insertLoad('carrier');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-carrier-${RUN}`, { posterCompanyRaw: CARRIER_NAME }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ stage: 'escalated', qualification_reason: 'poster_carrier_reposted_review' });
    const ex = (await db.query(`SELECT type, source_module, severity, sla_due_at FROM exceptions WHERE pipeline_load_id = $1`, [id])).rows[0];
    expect(ex.type).toBe('load_source_review');
    expect(ex.source_module).toBe('load_source_review');
    expect(ex.severity).toBe('medium');
    expect(ex.sla_due_at).not.toBeNull();
  });

  it('in shadow mode writes the class but lets a broker through to the normal filters', async () => {
    process.env.SHIPPER_DIRECT_GATE_MODE = 'shadow';
    const id = await insertLoad('shadow');
    ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-shadow-${RUN}`, { posterCompanyRaw: 'TEST Broker', posterMcNumber: BROKER_MC }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, load_source_class FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('qualified');
    expect(row.load_source_class).toBe('broker_posted');
  });
});
