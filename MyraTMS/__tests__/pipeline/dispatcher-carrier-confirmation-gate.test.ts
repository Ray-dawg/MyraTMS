// __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts
/**
 * E2-03 M0: when CARRIER_AUTO_ASSIGN_ENABLED is false (the default), the
 * Dispatcher must not call any TMS route or auto-assign a carrier who was
 * never actually contacted. It must instead escalate: pipeline_loads.stage
 * flips to 'escalated' and an exceptions row appears with enough context
 * for a human to secure the carrier by phone from the Alert Center alone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-CARRHOLD-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';

describe('DispatcherWorker — carrier confirmation gate (E2-03 M0)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let requestCount = 0;
  let pipelineLoadId: number;

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      requestCount += 1;
      res.writeHead(500).end('mock TMS should not have been called');
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('escalates instead of dispatching when carrierAutoAssignEnabled is false (explicit)', async () => {
    const worker = new DispatcherWorker(redisConnection, {
      tmsApiUrl: mockUrl,
      carrierAutoAssignEnabled: false,
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
      callId: 'mock_call_carrier_hold',
    };

    const result = await worker.process(payload);

    // No TMS API calls were made — the gate caught it before any side effect.
    expect(requestCount).toBe(0);

    expect(result.success).toBe(true);
    expect(result.stage).toBe('escalated');
    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('carrier_auto_assign_disabled');
    expect(result.details?.carrierId).toBe(REAL_CARRIER_ID);

    const after = await db.query<{ stage: string; tms_load_id: string | null }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('escalated');
    expect(after.rows[0].tms_load_id).toBeNull();

    // No loads row was created.
    const loadsRow = await db.query(`SELECT id FROM loads WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(loadsRow.rows.length).toBe(0);

    // Exception row carries the evidence a human needs, renderable via the
    // existing Alert Center (title/detail/severity/carrier_id, no new UI).
    const exc = await db.query<{
      title: string; detail: string; severity: string; carrier_id: string; load_id: string | null;
      pipeline_load_id: number; source_module: string; suggested_action: string;
    }>(
      `SELECT title, detail, severity, carrier_id, load_id, pipeline_load_id, source_module, suggested_action
       FROM exceptions WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(exc.rows.length).toBe(1);
    const row = exc.rows[0];
    expect(row.carrier_id).toBe(REAL_CARRIER_ID);
    expect(row.load_id).toBeNull(); // no TMS load exists yet at escalation time
    expect(row.severity).toBe('high');
    expect(row.source_module).toBe('carrier_confirmation_required');
    expect(row.suggested_action).toMatch(/AI carrier calling is not yet live/);
    expect(row.title).toMatch(/Toronto, ON/);
    expect(row.title).toMatch(/Sudbury, ON/);
    expect(row.detail).toMatch(new RegExp(REAL_CARRIER_ID));
    expect(row.detail).toMatch(/Dry Van/);
  }, 30_000);

  it('escalates by default when carrierAutoAssignEnabled is not passed at all', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl });
    // Re-seed: the previous test already escalated this load; reset stage to 'booked' to re-test.
    await db.query(`UPDATE pipeline_loads SET stage = 'booked' WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    requestCount = 0;

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_default_off',
    };

    const result = await worker.process(payload);
    expect(requestCount).toBe(0);
    expect(result.stage).toBe('escalated');
  }, 30_000);
});
