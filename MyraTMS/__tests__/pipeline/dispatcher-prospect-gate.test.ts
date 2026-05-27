/**
 * DispatcherWorker prospect-gate test.
 *
 * When the top-ranked carrier has carrier_status='prospect', the dispatcher
 * must refuse to assign the load and advance pipeline_loads.stage to
 * 'escalated' instead of 'dispatched'. No TMS API calls should be made.
 *
 * Background: Engine 2 A.1 backfilled ~200 carriers from the FMCSA L&I bulk
 * file as 'prospect' so the Ranker has depth for shadow drains. This gate
 * prevents accidental real assignments to those never-contacted carriers.
 * Promotion via PATCH /api/carriers/[id]/promote is the documented exit.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-PROSPECT-${Date.now()}`;
const PROSPECT_CARRIER_ID = `TEST-PROSPECT-CAR-${Date.now().toString(36).toUpperCase()}`;
const TEST_TENANT_ID = 2;

interface CapturedRequest {
  method: string;
  url: string;
}

describe('DispatcherWorker — prospect gate', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  const captured: CapturedRequest[] = [];
  let pipelineLoadId: number;
  const env0 = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    // Mock TMS server — should NEVER be hit when carrier is prospect.
    mockServer = http.createServer((req, res) => {
      captured.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(500).end('mock should not have been called');
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // Seed: a prospect carrier (tenant-scoped, all required columns).
    await db.query(
      `INSERT INTO carriers (
         id, tenant_id, company, mc_number, dot_number,
         authority_status, insurance_status, insurance_expiry,
         liability_insurance, cargo_insurance, safety_rating,
         carrier_status, created_at, updated_at
       ) VALUES (
         $1, $2, 'Test Prospect Carrier LLC', '', '999000${Date.now() % 1000}',
         'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
         750000, 100000, 'Not Rated',
         'prospect', NOW(), NOW()
       )`,
      [PROSPECT_CARRIER_ID, TEST_TENANT_ID],
    );

    // Seed pipeline_load in 'booked' with the prospect as top_carrier_id.
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
         'Montreal', 'QC', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         330, 540,
         'Test Shipper Co', 'test@example.test', '+15555550100',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID, PROSPECT_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [PROSPECT_CARRIER_ID]);
  });

  it("escalates the load instead of dispatching when top carrier is 'prospect'", async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_prospect_gate',
    };

    const result = await worker.process(payload);

    // No TMS API calls were made — the gate caught it before any side effect.
    expect(captured.length).toBe(0);

    // Result signals escalation, not dispatch.
    expect(result.success).toBe(true);
    expect(result.stage).toBe('escalated');
    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('top_carrier_not_active');
    expect(result.details?.carrierId).toBe(PROSPECT_CARRIER_ID);
    expect(result.details?.carrierStatus).toBe('prospect');

    // pipeline_loads.stage flipped to 'escalated'.
    const after = await db.query<{ stage: string; tms_load_id: string | null }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('escalated');
    expect(after.rows[0].tms_load_id).toBeNull();

    // No loads row was created.
    const loadsRow = await db.query(
      `SELECT id FROM loads WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(loadsRow.rows.length).toBe(0);
  }, 30_000);
});
