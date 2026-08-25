/**
 * E2-02 §4 item 2 / E2-03 §5.4.1: dispatcher-worker.ts's process() had no
 * checkpoint before creating the TMS load row. A dispatch-queue retry after
 * a downstream failure (e.g. assignCarrier() throws) re-ran from the top and
 * created a second `loads` row for the same pipeline_loads entry. This test
 * simulates that retry directly: seed a pipeline_load whose tms_load_id is
 * already set (as if createTMSLoad() succeeded on a prior attempt) and
 * confirm process() reuses it instead of creating a second loads row.
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
