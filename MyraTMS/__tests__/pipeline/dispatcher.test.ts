/**
 * DispatcherWorker integration test.
 *
 * Mocks the existing TMS routes (POST /api/loads, /assign, /tracking-token,
 * /send-tracking) on a localhost server and points the worker at it via
 * tmsApiUrl. Asserts:
 *   - All 4 TMS routes are hit in order
 *   - Each request carries the service-token cookie (auth-token=<jwt>)
 *   - The created loads.id is propagated to pipeline_loads.tms_load_id
 *   - pipeline_loads stage advances to 'dispatched'
 *   - pipeline_load_id / source_type / booked_via are written via direct DB UPDATE
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-DISP-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';
const FAKE_TMS_LOAD_ID = `LD-MOCK-${Date.now().toString(36).toUpperCase()}`;

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

describe('DispatcherWorker', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let captured: CapturedRequest[] = [];
  let pipelineLoadId: number;
  let realLoadInsertedId: string | null = null;
  const env0 = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });

        if (req.method === 'POST' && req.url === '/api/loads') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: FAKE_TMS_LOAD_ID }));
        } else if (req.method === 'POST' && req.url?.endsWith('/assign')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'POST' && req.url?.endsWith('/tracking-token')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: 'mock_token_' + Date.now(), trackingUrl: 'https://example.test/t/x' }));
        } else if (req.method === 'POST' && req.url?.endsWith('/send-tracking')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // Seed: pipeline_load in 'booked' stage, with top_carrier_id set, plus
    // a match_results row (so fetchCarrierRate returns a non-zero number).
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
      [TEST_LOAD_ID, REAL_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown,
                                  was_selected, assignment_method, created_at)
       VALUES ($1, $2, $3, 0.78, 'B', $4, true, 'auto', NOW())`,
      [
        `MR-DSP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        TEST_LOAD_ID,
        REAL_CARRIER_ID,
        JSON.stringify({ rate: { carrier_avg_rate: 1850 } }),
      ],
    );

    // Seed a fake loads row to satisfy the post-create UPDATE (which patches
    // pipeline_load_id). The mock TMS server pretends it was created at
    // FAKE_TMS_LOAD_ID, but the real DB has nothing — insert a stub.
    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [FAKE_TMS_LOAD_ID],
    );
    realLoadInsertedId = FAKE_TMS_LOAD_ID;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    if (realLoadInsertedId) {
      await db.query(`DELETE FROM loads WHERE id = $1`, [realLoadInsertedId]);
    }
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('chains the 4 TMS routes, links tms_load_id, advances pipeline stage', async () => {
    const worker = new DispatcherWorker(redisConnection, {
      tmsApiUrl: mockUrl,
    });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_dispatch',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.tmsLoadId).toBe(FAKE_TMS_LOAD_ID);
    expect(result.details?.carrierRate).toBe(1850);

    // Verify the four TMS routes were called in order.
    expect(captured.length).toBe(4);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('/api/loads');
    expect(captured[1].url).toBe(`/api/loads/${FAKE_TMS_LOAD_ID}/assign`);
    expect(captured[2].url).toBe(`/api/loads/${FAKE_TMS_LOAD_ID}/tracking-token`);
    expect(captured[3].url).toBe(`/api/loads/${FAKE_TMS_LOAD_ID}/send-tracking`);

    // All four carry the auth-token cookie (service token).
    for (const c of captured) {
      expect(c.headers.cookie ?? '').toMatch(/^auth-token=eyJ/);
    }

    // POST /api/loads body shape
    const createBody = captured[0].body;
    expect(createBody.origin).toBe('Toronto, ON');
    expect(createBody.destination).toBe('Sudbury, ON');
    expect(createBody.revenue).toBe(2200);
    expect(createBody.equipment).toBe('Dry Van');
    expect(createBody.status).toBe('Booked');
    expect(createBody.source).toBe('Load Board');

    // /assign body shape
    const assignBody = captured[1].body;
    expect(assignBody.carrier_id).toBe(REAL_CARRIER_ID);
    expect(assignBody.carrier_rate).toBe(1850);

    // Direct-DB linkage UPDATE happened
    const linked = await db.query<{ pipeline_load_id: number; source_type: string; booked_via: string }>(
      `SELECT pipeline_load_id, source_type, booked_via FROM loads WHERE id = $1`,
      [FAKE_TMS_LOAD_ID],
    );
    expect(linked.rows[0].pipeline_load_id).toBe(pipelineLoadId);
    expect(linked.rows[0].source_type).toBe('ai_agent');
    expect(linked.rows[0].booked_via).toBe('ai_auto');

    // Run updatePipelineLoad to flip pipeline_loads.stage and link tms_load_id
    await (worker as any).updatePipelineLoad(pipelineLoadId, result);

    const after = await db.query<{ stage: string; tms_load_id: string }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('dispatched');
    expect(after.rows[0].tms_load_id).toBe(FAKE_TMS_LOAD_ID);
  }, 30_000);
});
