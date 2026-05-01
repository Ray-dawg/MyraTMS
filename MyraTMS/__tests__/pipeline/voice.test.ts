/**
 * VoiceWorker integration test.
 *
 * Exercises three paths against live Neon + live Upstash:
 *   1. Kill switch — PIPELINE_ENABLED=false → no dial, no DB write
 *   2. Shadow mode — MAX_CONCURRENT_CALLS=0 → no dial, no DB write
 *   3. Happy path — kill switches off, mocked Retell endpoint returns a
 *      call_id, agent_calls row created, pipeline_loads → 'calling'
 *
 * Retell is mocked via a tiny localhost HTTP server. The Voice worker is
 * pointed at it via the constructor's retellBaseUrl override so we never
 * touch the real Retell API in tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { VoiceWorker, type CallJobPayload } from '@/lib/workers/voice-worker';
import type { RetellCreatePhoneCallPayload } from '@/lib/pipeline/negotiation-brief';

const TEST_LOAD_PREFIX = `TEST-V-${Date.now()}`;

interface TestFixture {
  pipelineLoadId: number;
  loadId: string;
  briefId: number;
  phone: string;
  retellPayload: RetellCreatePhoneCallPayload;
}

async function seedFixture(suffix: string): Promise<TestFixture> {
  const loadId = `${TEST_LOAD_PREFIX}-${suffix}`;
  const phone = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;

  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, equipment_type, posted_rate, posted_rate_currency,
       distance_miles, distance_km, shipper_company, shipper_phone,
       stage, priority_score
     ) VALUES (
       $1, 'DAT', 'Toronto', 'ON', 'CA',
       'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', 'Dry Van', 2400, 'CAD',
       250, 402, 'Northern Mine Supply Co', $2,
       'briefed', 700
     ) RETURNING id`,
    [loadId, phone],
  );
  const pipelineLoadId = ins.rows[0].id;

  const briefJson = {
    meta: { briefId: 0, briefVersion: '2.0', pipelineLoadId, generatedAt: new Date().toISOString(), generatedBy: 'voice-test', parentBriefId: null, retryCount: 0 },
    persona: { personaName: 'friendly', retellAgentId: 'agent_test_friendly' },
    callConfig: { language: 'en' },
    rates: { currency: 'CAD', totalCost: 750, targetMargin: 470 },
    negotiation: { initialOffer: 1216, walkAwayRate: 1016 },
    shipper: { phone },
  };

  const briefRes = await db.query<{ id: number }>(
    `INSERT INTO negotiation_briefs (
       pipeline_load_id, brief, brief_version, persona_selected, strategy,
       initial_offer, target_rate, min_acceptable_rate,
       concession_step_1, concession_step_2, final_offer,
       carrier_count, top_carrier_id, top_carrier_rate, created_at
     ) VALUES ($1, $2, '2.0', 'friendly', 'standard', 1216, 1220, 1016, 1150, 1082, 1016, 1, 'car_001', 1850, NOW())
     RETURNING id`,
    [pipelineLoadId, JSON.stringify(briefJson)],
  );
  const briefId = briefRes.rows[0].id;

  const retellPayload: RetellCreatePhoneCallPayload = {
    from_number: '+17055551001',
    to_number: phone,
    agent_id: 'agent_test_friendly',
    retell_llm_dynamic_variables: { agent_name: 'Sarah' } as any,
    metadata: {
      pipelineLoadId,
      briefId,
      briefVersion: '2.0',
      persona: 'friendly',
      language: 'en',
      currency: 'CAD',
      retryCount: 0,
      parentBriefId: null,
      primaryCarrierId: 1,
      primaryCarrierRate: 1850,
      primaryCarrierPhone: '(555) 111-2222',
      initialOffer: 1216,
      finalOffer: 1016,
      minAcceptableRate: 1016,
      totalCost: 750,
      targetMargin: 470,
      briefGeneratedAt: new Date().toISOString(),
      callInitiatedAt: new Date().toISOString(),
      timezone: 'America/Toronto' as any,
    } as any,
  };

  return { pipelineLoadId, loadId, briefId, phone, retellPayload };
}

async function cleanupFixture(f: TestFixture) {
  await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [f.pipelineLoadId]);
  await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [f.briefId]);
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [f.pipelineLoadId]);
}

describe('VoiceWorker', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let mockReceived: any[] = [];

  // Snapshot env so each test can restore.
  const env0 = { ...process.env };

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url?.startsWith('/v2/create-phone-call')) {
          mockReceived.push({ headers: req.headers, body: JSON.parse(body || '{}') });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ call_id: `mock_call_${Date.now()}`, call_status: 'registered' }));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind mock');
    mockUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    process.env = env0;
  });

  beforeEach(() => {
    mockReceived = [];
  });

  it('skips dial when PIPELINE_ENABLED=false (kill switch)', async () => {
    const f = await seedFixture('killswitch');
    process.env.PIPELINE_ENABLED = 'false';
    process.env.MAX_CONCURRENT_CALLS = '5';

    const worker = new VoiceWorker(redisConnection, { retellApiKey: 'test', retellBaseUrl: mockUrl });

    try {
      const result = await worker.process({
        pipelineLoadId: f.pipelineLoadId,
        loadId: f.loadId,
        loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(),
        priority: 5,
        briefId: f.briefId,
        retellPayload: f.retellPayload,
      });

      expect(result.success).toBe(true);
      expect(result.details?.skipped).toBe(true);
      expect(result.details?.reason).toBe('pipeline_disabled');
      expect(mockReceived.length).toBe(0);

      await (worker as any).updatePipelineLoad(f.pipelineLoadId, result);
      const after = await db.query<{ stage: string }>(
        `SELECT stage FROM pipeline_loads WHERE id = $1`,
        [f.pipelineLoadId],
      );
      expect(after.rows[0].stage).toBe('briefed');
      const calls = await db.query(`SELECT 1 FROM agent_calls WHERE pipeline_load_id = $1`, [f.pipelineLoadId]);
      expect(calls.rows.length).toBe(0);
    } finally {
      await cleanupFixture(f);
    }
  }, 30_000);

  it('skips dial when MAX_CONCURRENT_CALLS=0 (shadow mode)', async () => {
    const f = await seedFixture('shadow');
    process.env.PIPELINE_ENABLED = 'true';
    process.env.MAX_CONCURRENT_CALLS = '0';

    const worker = new VoiceWorker(redisConnection, { retellApiKey: 'test', retellBaseUrl: mockUrl });

    try {
      const result = await worker.process({
        pipelineLoadId: f.pipelineLoadId,
        loadId: f.loadId,
        loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(),
        priority: 5,
        briefId: f.briefId,
        retellPayload: f.retellPayload,
      });

      expect(result.details?.skipped).toBe(true);
      expect(result.details?.reason).toBe('shadow_mode');
      expect(mockReceived.length).toBe(0);
    } finally {
      await cleanupFixture(f);
    }
  }, 30_000);

  it('dials Retell, persists agent_calls, advances stage to calling on happy path', async () => {
    const f = await seedFixture('happy');
    process.env.PIPELINE_ENABLED = 'true';
    process.env.MAX_CONCURRENT_CALLS = '5';

    // Fake-timer to land mid-day so calling-hours recheck passes.
    const noon = new Date();
    noon.setHours(14, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(noon);

    const worker = new VoiceWorker(redisConnection, { retellApiKey: 'test', retellBaseUrl: mockUrl });

    try {
      const result = await worker.process({
        pipelineLoadId: f.pipelineLoadId,
        loadId: f.loadId,
        loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(),
        priority: 5,
        briefId: f.briefId,
        retellPayload: f.retellPayload,
      });

      expect(result.success).toBe(true);
      expect(result.details?.skipped).toBeUndefined();
      expect(result.details?.callId).toMatch(/^mock_call_/);

      expect(mockReceived.length).toBe(1);
      expect(mockReceived[0].headers.authorization).toBe('Bearer test');
      expect(mockReceived[0].body.to_number).toBe(f.phone);
      expect(mockReceived[0].body.agent_id).toBe('agent_test_friendly');

      await (worker as any).updatePipelineLoad(f.pipelineLoadId, result);

      const after = await db.query<{ stage: string; call_attempts: number }>(
        `SELECT stage, call_attempts FROM pipeline_loads WHERE id = $1`,
        [f.pipelineLoadId],
      );
      expect(after.rows[0].stage).toBe('calling');
      expect(after.rows[0].call_attempts).toBe(1);

      const calls = await db.query<{ retell_call_id: string; persona: string; outcome: string }>(
        `SELECT retell_call_id, persona, outcome FROM agent_calls WHERE pipeline_load_id = $1`,
        [f.pipelineLoadId],
      );
      expect(calls.rows.length).toBe(1);
      expect(calls.rows[0].retell_call_id).toMatch(/^mock_call_/);
      expect(calls.rows[0].persona).toBe('friendly');
      expect(calls.rows[0].outcome).toBe('in_progress');
    } finally {
      vi.useRealTimers();
      await cleanupFixture(f);
    }
  }, 30_000);
});
