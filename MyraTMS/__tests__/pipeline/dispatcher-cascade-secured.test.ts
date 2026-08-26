/**
 * E2-03 M3 / PRD §11 (spec reconciliation, T-10 §4): "the Dispatcher now
 * consumes a *secured* carrier from the cascade rather than performing
 * fallback logic in-line." Before this session, dispatcher-worker.ts read
 * only pipeline_loads.top_carrier_id — the Ranker's pre-cascade pick — and,
 * with CARRIER_AUTO_ASSIGN_ENABLED defaulting false, always escalated for
 * human phone confirmation regardless of whether M2's cascade had already
 * secured a real, carrier-confirmed rate. These tests prove the new
 * cascade-secured branch: when carrier_call_outcome='accept' and
 * carrier_id_secured is set, the Dispatcher uses THAT carrier and rate
 * instead of top_carrier_id/the shipper-side estimate, and bypasses the
 * carrierAutoAssignEnabled hold (which only ever guarded the *blind*
 * top_carrier_id assign path, not a confirmed one).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const RUN_ID = Date.now();

describe('DispatcherWorker — consumes M2 cascade-secured carrier (E2-03 M3)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let receivedAssignBody: any = null;
  const seededPipelineLoadIds: number[] = [];
  const seededTmsLoadIds: string[] = [];
  const seededCarrierIds: string[] = [];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/loads') {
          res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `LD-CASCADE-${RUN_ID}` }));
          return;
        }
        if (req.method === 'POST' && req.url?.includes('/assign')) {
          receivedAssignBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + RUN_ID;

    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [`LD-CASCADE-${RUN_ID}`],
    );
    seededTmsLoadIds.push(`LD-CASCADE-${RUN_ID}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    if (seededPipelineLoadIds.length) await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
    if (seededPipelineLoadIds.length) await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    if (seededTmsLoadIds.length) await db.query(`DELETE FROM loads WHERE id = ANY($1)`, [seededTmsLoadIds]);
    if (seededCarrierIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededCarrierIds]);
  });

  async function seedCarrier(id: string, carrierStatus: 'active' | 'prospect') {
    seededCarrierIds.push(id);
    await db.query(
      `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
         authority_status, insurance_status, insurance_expiry,
         liability_insurance, cargo_insurance, safety_rating,
         carrier_status, contact_phone, created_at, updated_at)
       VALUES ($1, $2, $3, '', '', 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
         750000, 100000, 'Not Rated', $4, '+15550001234', NOW(), NOW())`,
      [id, LEGACY_DEFAULT_TENANT_ID, `Cascade Test Carrier ${id}`, carrierStatus],
    );
  }

  async function seedPipelineLoad(opts: {
    carrierCallOutcome?: string | null;
    carrierIdSecured?: string | null;
    carrierAgreedRate?: number | null;
    carrierProfit?: number | null;
    topCarrierId?: string | null;
  }): Promise<number> {
    const loadId = `TEST-CASCADE-DISPATCH-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id, stage,
         agreed_rate, agreed_rate_currency, profit,
         carrier_call_outcome, carrier_id_secured, carrier_agreed_rate, carrier_agreed_currency, carrier_profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Cascade Dispatch Co', 'x@test.test', '+17055559876', 2400, 'CAD', $2, 'booked',
         2200, 'CAD', 470,
         $3, $4, $5, 'CAD', $6
       ) RETURNING id`,
      [
        loadId, opts.topCarrierId ?? null,
        opts.carrierCallOutcome ?? null, opts.carrierIdSecured ?? null,
        opts.carrierAgreedRate ?? null, opts.carrierProfit ?? null,
      ],
    );
    seededPipelineLoadIds.push(ins.rows[0].id);
    return ins.rows[0].id;
  }

  it('cascade-secured load: dispatches using carrier_id_secured/carrier_agreed_rate, not top_carrier_id or the shipper-side rate estimate', async () => {
    const secured = `CASCADE-SECURED-A-${RUN_ID}`;
    const stale = `STALE-TOP-CARRIER-A-${RUN_ID}`;
    await seedCarrier(secured, 'active');
    await seedCarrier(stale, 'active');

    const pipelineLoadId = await seedPipelineLoad({
      topCarrierId: stale,
      carrierCallOutcome: 'accept',
      carrierIdSecured: secured,
      carrierAgreedRate: 1650.5,
      carrierProfit: 549.5,
    });

    receivedAssignBody = null;
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: false });
    const payload: DispatchJobPayload = {
      pipelineLoadId, loadId: `TEST-CASCADE-DISPATCH-${RUN_ID}`, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
      agreedRate: 2200, agreedRateCurrency: 'CAD', profit: 999, // shipper-side estimate — must NOT be what gets used
      callId: 'mock_call_cascade_secured',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.carrierId).toBe(secured);
    expect(result.details?.carrierRate).toBe(1650.5);
    expect(result.details?.cascadeSecured).toBe(true);
    expect(result.details?.profit).toBe(549.5); // carrier_profit, not the payload's stale 999

    expect(receivedAssignBody).not.toBeNull();
    expect(receivedAssignBody.carrier_id).toBe(secured);
    expect(receivedAssignBody.carrier_rate).toBe(1650.5);
  }, 30_000);

  it('cascade-secured load whose secured carrier is a prospect still escalates via the prospect gate (gate applies regardless of source)', async () => {
    const securedProspect = `CASCADE-SECURED-PROSPECT-${RUN_ID}`;
    await seedCarrier(securedProspect, 'prospect');

    const pipelineLoadId = await seedPipelineLoad({
      carrierCallOutcome: 'accept',
      carrierIdSecured: securedProspect,
      carrierAgreedRate: 1500,
      carrierProfit: 700,
    });

    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: false });
    const payload: DispatchJobPayload = {
      pipelineLoadId, loadId: `TEST-CASCADE-DISPATCH-${RUN_ID}`, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
      agreedRate: 2200, agreedRateCurrency: 'CAD', profit: 470,
      callId: 'mock_call_cascade_prospect',
    };

    const result = await worker.process(payload);
    expect(result.stage).toBe('escalated');
    expect(result.details?.reason).toBe('top_carrier_not_active');
    expect(result.details?.carrierId).toBe(securedProspect);

    const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(row.rows[0].stage).toBe('escalated');
  }, 30_000);

  it('no cascade outcome (carrier_call_outcome NULL): unchanged behavior — still escalates for human phone confirmation', async () => {
    const topCarrier = `NO-CASCADE-TOP-${RUN_ID}`;
    await seedCarrier(topCarrier, 'active');

    const pipelineLoadId = await seedPipelineLoad({ topCarrierId: topCarrier });

    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: false });
    const payload: DispatchJobPayload = {
      pipelineLoadId, loadId: `TEST-CASCADE-DISPATCH-${RUN_ID}`, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
      agreedRate: 2200, agreedRateCurrency: 'CAD', profit: 470,
      callId: 'mock_call_no_cascade',
    };

    const result = await worker.process(payload);
    expect(result.stage).toBe('escalated');
    expect(result.details?.reason).toBe('carrier_auto_assign_disabled');
    expect(result.details?.carrierId).toBe(topCarrier);
  }, 30_000);
});
