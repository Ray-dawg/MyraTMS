/**
 * E2-03 M2 §6.8 synthetic cascade fixtures. Shadow-mode tests prove the
 * cascade DECISION logic (which carrier, in what order) without ever making
 * a real HTTP call to Retell. Live-mode tests (CARRIER_CALLS_ENABLED=true)
 * exercise the real dial against a local mock Retell server — still no real
 * outbound call, but proving the actual wiring (metadata shape, agent_calls
 * insert, per-carrier-phone lock call site) works.
 *
 * NOTE on two fixes to the plan's original brief, applied here:
 *   1. The brief seeded match_results before carriers; match_results
 *      .carrier_id is a NOT NULL FK to carriers(id), so that order 500s
 *      with a FK violation. Fixed by seeding carriers first.
 *   2. The brief never set process.env.PIPELINE_ENABLED — without it every
 *      worker.process() call short-circuits on the kill switch before the
 *      cascade logic under test ever runs. Fixed by setting it in beforeAll,
 *      matching voice.test.ts's established per-test convention for its own
 *      non-killswitch cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { CarrierVoiceWorker, type CarrierCallCascadePayload } from '@/lib/workers/carrier-voice-worker';

const RUN_ID = Date.now();
const TEST_LOAD_ID = `TEST-CASCADE-${RUN_ID}`;
const CARRIERS = ['car_c1', 'car_c2', 'car_c3', 'car_c4', 'car_c5'].map((id) => `${id}_${RUN_ID}`);

describe('CarrierVoiceWorker — cascade (E2-03 M2 §6.8)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let requestCount = 0;
  let pipelineLoadId: number;
  const prevPipelineEnabled = process.env.PIPELINE_ENABLED;
  const createdWorkers: CarrierVoiceWorker[] = [];

  function makeWorker(opts: {
    retellBaseUrl?: string;
    carrierCallsEnabled?: boolean;
    retellApiKey?: string;
  } = {}): CarrierVoiceWorker {
    const worker = new CarrierVoiceWorker(redisConnection, opts);
    createdWorkers.push(worker);
    return worker;
  }

  beforeAll(async () => {
    // See file header note (2): required so process() reaches the cascade
    // logic instead of short-circuiting on the pipeline_disabled kill switch.
    process.env.PIPELINE_ENABLED = 'true';

    mockServer = http.createServer((req, res) => {
      requestCount += 1;
      res.writeHead(500).end('unexpected request reached the mock Retell endpoint');
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id,
         stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID, CARRIERS[0]],
    );
    pipelineLoadId = ins.rows[0].id;

    // Seed carrier rows with distinct phone numbers (needed for per-phone lock
    // tests). Must happen before match_results is seeded below — match_results
    // .carrier_id is a NOT NULL FK to carriers(id).
    for (let i = 0; i < CARRIERS.length; i++) {
      await db.query(
        `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
           authority_status, insurance_status, insurance_expiry,
           liability_insurance, cargo_insurance, safety_rating,
           carrier_status, contact_phone, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
           750000, 100000, 'Not Rated', 'active', $5, NOW(), NOW())`,
        [CARRIERS[i], LEGACY_DEFAULT_TENANT_ID, `Test Carrier ${i}`, `999${RUN_ID}${i}`, `+1555010${1000 + i}`],
      );
    }

    // Seed 5 ranked match_results rows for this load, scores descending.
    for (let i = 0; i < CARRIERS.length; i++) {
      await db.query(
        `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown)
         VALUES ($1, $2, $3, $4, 'B', $5)`,
        [
          `MR-CASCADE-${RUN_ID}-${i}`, TEST_LOAD_ID, CARRIERS[i], 0.9 - i * 0.1,
          JSON.stringify({ rate: { carrier_avg_rate: 1800 } }),
        ],
      );
    }
  });

  afterAll(async () => {
    process.env.PIPELINE_ENABLED = prevPipelineEnabled;
    await Promise.all(createdWorkers.map((w) => w.shutdown()));
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [CARRIERS]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('shadow mode (CARRIER_CALLS_ENABLED unset/false): logs the cascade decision, makes zero HTTP requests', async () => {
    const worker = makeWorker({ retellBaseUrl: mockUrl, carrierCallsEnabled: false });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
    };

    const result = await worker.process(payload);
    expect(requestCount).toBe(0);
    expect(result.success).toBe(true);
    expect(result.details?.shadowMode).toBe(true);
    // Shadow mode still computes and reports which carrier it WOULD have called first.
    expect(result.details?.wouldCallCarrierId).toBe(CARRIERS[0]);
  }, 30_000);

  it('defaults to shadow mode when CARRIER_CALLS_ENABLED is left completely unset (no explicit opt passed) — the actual production-protecting path', async () => {
    // Every other test in this file passes `carrierCallsEnabled: false`
    // explicitly, which never exercises the real default the kill switch
    // relies on in production: the constructor falling back to
    // `process.env.CARRIER_CALLS_ENABLED` when no opt is given at all. This
    // test constructs the worker without the opt and with the env var
    // deleted, so it's actually exercising that default.
    const prevEnv = process.env.CARRIER_CALLS_ENABLED;
    delete process.env.CARRIER_CALLS_ENABLED;
    try {
      const worker = makeWorker({ retellBaseUrl: mockUrl });
      const payload: CarrierCallCascadePayload = {
        pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(), priority: 5,
      };

      const result = await worker.process(payload);
      expect(requestCount).toBe(0);
      expect(result.success).toBe(true);
      expect(result.details?.shadowMode).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.CARRIER_CALLS_ENABLED;
      else process.env.CARRIER_CALLS_ENABLED = prevEnv;
    }
  }, 30_000);

  it('live mode dials the carrier at cascadePosition (default 0) via Retell, holding the per-carrier-phone lock', async () => {
    mockServer.removeAllListeners('request');
    let received: any = null;
    mockServer.on('request', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ call_id: 'call_test_live_1' }));
      });
    });

    const worker = makeWorker({
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.callId).toBe('call_test_live_1');
    expect(result.details?.carrierId).toBe(CARRIERS[0]);
    expect(received.metadata.callType).toBe('outbound_carrier');
    expect(received.metadata.cascadePosition).toBe(0);
    expect(received.metadata.voicemailRetryCount).toBe(0);
    expect(received.metadata.carrierId).toBe(CARRIERS[0]);
    expect(received.metadata.stackLength).toBe(CARRIERS.length);

    const agentCallRow = await db.query<{ carrier_outcome: string }>(
      `SELECT carrier_outcome FROM agent_calls WHERE pipeline_load_id = $1 AND call_id = $2`,
      [pipelineLoadId, 'call_test_live_1'],
    );
    expect(agentCallRow.rows[0].carrier_outcome).toBe('in_progress');

    // Lock should be released again now the dial attempt finished.
    const { acquireCarrierPhoneLock, releaseCarrierPhoneLock } = await import('@/lib/pipeline/carrier-locks');
    const token = await acquireCarrierPhoneLock(`+1555010${1000}`, 1000);
    expect(token).not.toBeNull();
    if (token) await releaseCarrierPhoneLock(`+1555010${1000}`, token);
  }, 30_000);

  it('live mode at a later cascadePosition dials that carrier, not the top of the stack', async () => {
    mockServer.removeAllListeners('request');
    let received: any = null;
    mockServer.on('request', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ call_id: 'call_test_live_2' }));
      });
    });

    const worker = makeWorker({
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5, cascadePosition: 2, voicemailRetryCount: 1,
    };

    const result = await worker.process(payload);
    expect(result.details?.carrierId).toBe(CARRIERS[2]);
    expect(received.metadata.cascadePosition).toBe(2);
    expect(received.metadata.voicemailRetryCount).toBe(1);
  }, 30_000);

  it('live mode at a cascadePosition past the stack length escalates immediately instead of dialing (defensive out-of-bounds)', async () => {
    mockServer.removeAllListeners('request');
    let requestReceived = false;
    mockServer.on('request', (req, res) => {
      requestReceived = true;
      res.writeHead(500).end();
    });

    const worker = makeWorker({
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5, cascadePosition: 99, voicemailRetryCount: 0,
    };

    const result = await worker.process(payload);
    expect(requestReceived).toBe(false);
    expect(result.details?.cascadeExhausted).toBe(true);

    const load = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(load.rows[0].stage).toBe('escalated');
    // Restore for subsequent tests in this file that assume stage='booked'.
    await db.query(`UPDATE pipeline_loads SET stage = 'booked' WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
  }, 30_000);

  it('a held per-carrier-phone lock blocks a live dial to that carrier — blocked, not raced (PRD §6.9 acceptance criterion 5)', async () => {
    mockServer.removeAllListeners('request');
    let requestReceived = false;
    mockServer.on('request', (req, res) => {
      requestReceived = true;
      res.writeHead(500).end();
    });

    const { acquireCarrierPhoneLock, releaseCarrierPhoneLock } = await import('@/lib/pipeline/carrier-locks');
    const carrier0Phone = `+1555010${1000}`;
    const heldToken = await acquireCarrierPhoneLock(carrier0Phone, 5000);
    expect(heldToken).not.toBeNull();

    try {
      const worker = makeWorker({
        retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
      });
      const payload: CarrierCallCascadePayload = {
        pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(), priority: 5,
      };
      const result = await worker.process(payload);
      expect(requestReceived).toBe(false);
      expect(result.details?.skipped).toBe(true);
      expect(result.details?.reason).toBe('carrier_phone_locked');
    } finally {
      if (heldToken) await releaseCarrierPhoneLock(carrier0Phone, heldToken);
    }
  }, 30_000);

  it('reads the top-N stack from match_results ordered by match_score DESC, default N=5', async () => {
    const worker = makeWorker({ retellBaseUrl: mockUrl, carrierCallsEnabled: false });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
    };

    const result = await worker.process(payload);
    expect(result.details?.cascadeStack).toEqual(CARRIERS);
  }, 30_000);

  it('acquires and releases the per-load lock around the cascade', async () => {
    const worker = makeWorker({ retellBaseUrl: mockUrl, carrierCallsEnabled: false });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
    };

    await worker.process(payload);

    // Lock must be released after processing (re-acquiring it now should succeed).
    const { acquireLoadLock, releaseLoadLock } = await import('@/lib/pipeline/carrier-locks');
    const token = await acquireLoadLock(pipelineLoadId, 1000);
    expect(token).not.toBeNull();
    if (token) await releaseLoadLock(pipelineLoadId, token);
  }, 30_000);

  it('a second concurrent cascade attempt on the same load is blocked by the per-load lock', async () => {
    const { acquireLoadLock, releaseLoadLock } = await import('@/lib/pipeline/carrier-locks');
    const heldToken = await acquireLoadLock(pipelineLoadId, 5000);
    expect(heldToken).not.toBeNull();

    try {
      const worker = makeWorker({ retellBaseUrl: mockUrl, carrierCallsEnabled: false });
      const payload: CarrierCallCascadePayload = {
        pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(), priority: 5,
      };
      const result = await worker.process(payload);
      expect(result.details?.skipped).toBe(true);
      expect(result.details?.reason).toBe('load_locked');
    } finally {
      if (heldToken) await releaseLoadLock(pipelineLoadId, heldToken);
    }
  }, 30_000);

  it('reports a single-carrier cascade stack correctly (no artificial padding to the default depth)', async () => {
    // A load with only 1 ranked carrier — exercises the "would exhaust after
    // N" reporting path distinctly from the 5-deep default fixture above.
    const soloLoadId = `TEST-CASCADE-SOLO-${RUN_ID}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Solo Co', 'x@test.test', '+17055551862', 2400, 'CAD', $2, 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [soloLoadId, CARRIERS[0]],
    );
    const soloId = ins.rows[0].id;
    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown)
       VALUES ($1, $2, $3, 0.5, 'C', $4)`,
      [`MR-SOLO-${RUN_ID}`, soloLoadId, CARRIERS[0], JSON.stringify({ rate: { carrier_avg_rate: 1800 } })],
    );

    try {
      const worker = makeWorker({ retellBaseUrl: mockUrl, carrierCallsEnabled: false });
      const payload: CarrierCallCascadePayload = {
        pipelineLoadId: soloId, loadId: soloLoadId, loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(), priority: 5,
      };
      const result = await worker.process(payload);
      expect(result.details?.cascadeStack).toEqual([CARRIERS[0]]);
      expect(result.details?.wouldCallCarrierId).toBe(CARRIERS[0]);
    } finally {
      await db.query(`DELETE FROM match_results WHERE load_id = $1`, [soloLoadId]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [soloId]);
    }
  }, 30_000);
});
