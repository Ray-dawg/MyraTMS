/**
 * E2-02 §4 item 2 / E2-03 §5.4.1: dispatcher-worker.ts's process() had no
 * checkpoint before creating the TMS load row. A dispatch-queue retry after
 * a downstream failure (e.g. assignCarrier() throws) re-ran from the top and
 * created a second `loads` row for the same pipeline_loads entry. This test
 * simulates that retry directly: seed a pipeline_load whose tms_load_id is
 * already set (as if createTMSLoad() succeeded on a prior attempt) and
 * confirm process() reuses it instead of creating a second loads row.
 *
 * Final-review addendum (E2-03 M0 whole-branch review, finding #1): the test
 * above only proves the guard's *logic* is correct — it pre-seeds
 * tms_load_id directly in the fixture INSERT, which says nothing about
 * whether production code ever actually writes that column. On the real
 * queue-processing path, BaseWorker.handleJob only calls updatePipelineLoad()
 * when WorkerConfig.nextStage is truthy; DispatcherWorker had it set to
 * undefined, so updatePipelineLoad() — and therefore the tms_load_id write —
 * never ran in production. The second describe block below drives the SAME
 * updatePipelineLoad() method BaseWorker.handleJob would call (not a
 * fixture-seeded column) and proves the column it writes is the one
 * process()'s idempotency guard subsequently reads.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-IDEMP-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';
const PRE_EXISTING_TMS_LOAD_ID = `LD-PREEXIST-${Date.now().toString(36).toUpperCase()}`;

interface CapturedRequest { method: string; url: string }

describe('DispatcherWorker — idempotency on retry (E2-02 §4 item 2)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  const captured: CapturedRequest[] = [];
  let pipelineLoadId: number;

  beforeAll(async () => {
    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      captured.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.method === 'POST' && req.url === '/api/loads') {
        res.writeHead(500).end('should never be called on a retry — tms_load_id already set');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // Pre-existing loads row, as if Step 1 (createTMSLoad) already succeeded
    // on a prior attempt before a downstream step failed.
    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [PRE_EXISTING_TMS_LOAD_ID],
    );

    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id,
         stage, agreed_rate, agreed_rate_currency, profit, tms_load_id
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470, $3
       ) RETURNING id`,
      [TEST_LOAD_ID, REAL_CARRIER_ID, PRE_EXISTING_TMS_LOAD_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at)
       VALUES ($1, $2, $3, 0.78, 'B', $4, true, 'auto', NOW())`,
      [`MR-IDP-${Date.now()}`, TEST_LOAD_ID, REAL_CARRIER_ID, JSON.stringify({ rate: { carrier_avg_rate: 1850 } })],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [PRE_EXISTING_TMS_LOAD_ID]);
  });

  it('reuses the existing tms_load_id instead of creating a second loads row', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: true });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_idempotency',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.tmsLoadId).toBe(PRE_EXISTING_TMS_LOAD_ID);

    // POST /api/loads was never called.
    expect(captured.some((c) => c.method === 'POST' && c.url === '/api/loads')).toBe(false);
    // But the rest of the chain still ran, against the pre-existing id.
    expect(captured.some((c) => c.url === `/api/loads/${PRE_EXISTING_TMS_LOAD_ID}/assign`)).toBe(true);

    // Still exactly one loads row for this id (no duplicate created).
    const rows = await db.query(`SELECT id FROM loads WHERE id = $1`, [PRE_EXISTING_TMS_LOAD_ID]);
    expect(rows.rows.length).toBe(1);
  }, 30_000);
});

describe('DispatcherWorker — the real write path feeds the idempotency guard (final-review finding #1)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  const captured: CapturedRequest[] = [];
  let pipelineLoadId: number;
  let createdTmsLoadId: string | null = null;

  const TEST_LOAD_ID_2 = `TEST-IDEMP2-${Date.now()}`;
  const FIRST_ATTEMPT_TMS_LOAD_ID = `LD-REALWRITE-${Date.now().toString(36).toUpperCase()}`;

  beforeAll(async () => {
    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.push({ method: req.method ?? '', url: req.url ?? '' });
        if (req.method === 'POST' && req.url === '/api/loads') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: FIRST_ATTEMPT_TMS_LOAD_ID }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }),
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // Fresh pipeline_load — NO tms_load_id yet. This is the "before any
    // attempt" state, unlike the describe block above which pre-seeds the
    // column to test the guard's branch logic in isolation.
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
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID_2, REAL_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at)
       VALUES ($1, $2, $3, 0.78, 'B', $4, true, 'auto', NOW())`,
      [`MR-IDP2-${Date.now()}`, TEST_LOAD_ID_2, REAL_CARRIER_ID, JSON.stringify({ rate: { carrier_avg_rate: 1850 } })],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID_2]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    if (createdTmsLoadId) {
      await db.query(`DELETE FROM loads WHERE id = $1`, [createdTmsLoadId]);
    }
  });

  it('config carries nextStage so BaseWorker.handleJob would invoke updatePipelineLoad in production', () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: true });
    // Sanity check on the root cause: handleJob (base-worker.ts) only calls
    // updatePipelineLoad when config.nextStage is truthy. This was
    // `undefined` before the fix, which is exactly why tms_load_id never
    // got written on the real queue-processing path.
    expect((worker as any).config.nextStage).toBe('dispatched');
  });

  it('first attempt: process() + the real updatePipelineLoad() write tms_load_id; second attempt reuses it with no duplicate loads row', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: true });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID_2,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_realwrite_attempt1',
    };

    // --- Attempt 1: fresh dispatch, no tms_load_id yet ---
    const firstResult = await worker.process(payload);
    expect(firstResult.success).toBe(true);
    expect(firstResult.details?.tmsLoadId).toBe(FIRST_ATTEMPT_TMS_LOAD_ID);
    createdTmsLoadId = FIRST_ATTEMPT_TMS_LOAD_ID;

    // POST /api/loads was called exactly once so far.
    expect(captured.filter((c) => c.method === 'POST' && c.url === '/api/loads').length).toBe(1);

    // Before the real write path runs, pipeline_loads.tms_load_id is still
    // NULL — proving it wasn't pre-seeded by the test fixture.
    const beforeWrite = await db.query<{ tms_load_id: string | null }>(
      `SELECT tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(beforeWrite.rows[0].tms_load_id).toBeNull();

    // Call the SAME updatePipelineLoad() BaseWorker.handleJob invokes in
    // production now that nextStage is set — this is the real write path,
    // not a fixture INSERT.
    await (worker as any).updatePipelineLoad(pipelineLoadId, firstResult);

    const afterWrite = await db.query<{ stage: string; tms_load_id: string | null }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(afterWrite.rows[0].stage).toBe('dispatched');
    expect(afterWrite.rows[0].tms_load_id).toBe(FIRST_ATTEMPT_TMS_LOAD_ID);

    // --- Attempt 2: simulates a dispatch-queue retry re-driving the same
    // pipeline_load. process() re-fetches the row and must see the
    // tms_load_id that updatePipelineLoad() just wrote for real. ---
    const secondResult = await worker.process({ ...payload, callId: 'mock_call_realwrite_attempt2' });
    expect(secondResult.success).toBe(true);
    expect(secondResult.details?.tmsLoadId).toBe(FIRST_ATTEMPT_TMS_LOAD_ID);

    // POST /api/loads was NOT called again on the retry.
    expect(captured.filter((c) => c.method === 'POST' && c.url === '/api/loads').length).toBe(1);
    // The rest of the chain still ran against the reused id.
    expect(
      captured.some((c) => c.url === `/api/loads/${FIRST_ATTEMPT_TMS_LOAD_ID}/assign`),
    ).toBe(true);
  }, 30_000);
});
