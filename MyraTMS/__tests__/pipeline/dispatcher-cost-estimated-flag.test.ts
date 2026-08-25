/**
 * E2-02 §4 item 3: when a carrier has no rate history, fetchCarrierRate()
 * fell back to 0, producing margin = revenue, a 100% margin indistinguishable
 * from a genuine zero-cost load. This doesn't fix the underlying "no real
 * carrier rate" problem (M2 does that) - it stops the number from lying
 * about its own confidence: loads.carrier_cost_estimated must be true
 * whenever the fallback fired, false when a real carrier_avg_rate was used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-COSTEST-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';
const FAKE_TMS_LOAD_ID = `LD-COSTEST-${Date.now().toString(36).toUpperCase()}`;

describe('DispatcherWorker — carrier_cost_estimated honesty flag (E2-02 §4 item 3)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let pipelineLoadId: number;

  beforeAll(async () => {
    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/loads') {
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: FAKE_TMS_LOAD_ID }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // No match_results row for this carrier — fetchCarrierRate() has
    // nothing to read and must fall back.
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

    // Seed a fake loads row to satisfy the post-create UPDATE (which patches
    // pipeline_load_id / carrier_cost_estimated). The mock TMS server pretends
    // it was created at FAKE_TMS_LOAD_ID, but the real DB has nothing yet —
    // insert a stub (same pattern as dispatcher.test.ts).
    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [FAKE_TMS_LOAD_ID],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM loads WHERE id = $1`, [FAKE_TMS_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('sets carrier_cost_estimated=true when carrier rate falls back to 0 (no match_results row)', async () => {
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
      callId: 'mock_call_cost_estimated',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.carrierRate).toBe(0);

    const row = await db.query<{ carrier_cost_estimated: boolean }>(
      `SELECT carrier_cost_estimated FROM loads WHERE id = $1`,
      [FAKE_TMS_LOAD_ID],
    );
    expect(row.rows[0].carrier_cost_estimated).toBe(true);
  }, 30_000);
});
