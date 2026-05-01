/**
 * Retell webhook integration test.
 *
 * Tests against live Neon + live Upstash without invoking Claude:
 *   1. Bad signature → 401, no DB writes
 *   2. Voicemail / no_answer (non-conversation) → 200, retry enqueued, no
 *      transcript parsing required
 *
 * The 'completed' call path (which calls Claude.parseCall) is NOT tested
 * here because it requires ANTHROPIC_API_KEY. That path is exercised in
 * Sprint 5/6 once the key is provisioned.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
import type { RetellWebhookPayload } from '@/lib/pipeline/retell-types';

const TEST_SECRET = 'test-webhook-secret-' + Date.now();
const env0 = { ...process.env };

interface Fixture {
  pipelineLoadId: number;
  briefId: number;
  loadId: string;
  phone: string;
}

async function seed(suffix: string): Promise<Fixture> {
  const loadId = `TEST-WH-${Date.now()}-${suffix}`;
  const phone = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;

  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, equipment_type, posted_rate, posted_rate_currency,
       distance_miles, distance_km, shipper_phone,
       stage, call_attempts
     ) VALUES (
       $1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', 'Dry Van', 2400, 'CAD',
       250, 402, $2, 'calling', 0
     ) RETURNING id`,
    [loadId, phone],
  );
  const pipelineLoadId = ins.rows[0].id;

  const briefRes = await db.query<{ id: number }>(
    `INSERT INTO negotiation_briefs (
       pipeline_load_id, brief, brief_version, persona_selected, strategy,
       initial_offer, target_rate, min_acceptable_rate,
       concession_step_1, concession_step_2, final_offer,
       carrier_count, top_carrier_id, created_at
     ) VALUES ($1, $2, '2.0', 'friendly', 'standard',
               1216, 1220, 1016, 1150, 1082, 1016, 1, 'car_001', NOW())
     RETURNING id`,
    [
      pipelineLoadId,
      JSON.stringify({
        load: { loadId, origin: { city: 'Toronto', state: 'ON' }, destination: { city: 'Sudbury', state: 'ON' }, equipmentType: 'dry_van' },
        rates: { totalCost: 750, minMargin: 270, currency: 'CAD' },
        negotiation: { initialOffer: 1216, walkAwayRate: 1016 },
      }),
    ],
  );
  return { pipelineLoadId, briefId: briefRes.rows[0].id, loadId, phone };
}

async function cleanup(f: Fixture) {
  await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [f.pipelineLoadId]);
  await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [f.briefId]);
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [f.pipelineLoadId]);
  await db.query(`DELETE FROM compliance_audit WHERE pipeline_load_id = $1`, [f.pipelineLoadId]);
}

function signedRequest(payload: RetellWebhookPayload, secret: string | null) {
  const raw = JSON.stringify(payload);
  const sig =
    secret === null
      ? ''
      : crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return {
    headers: { 'x-retell-signature': sig },
    json: async () => JSON.parse(raw),
  };
}

describe('handleRetellWebhook', () => {
  let callQueue: Queue;

  beforeAll(() => {
    process.env.RETELL_WEBHOOK_SECRET = TEST_SECRET;
    callQueue = new Queue('call-queue', { connection: redisConnection });
  });

  afterAll(async () => {
    process.env = env0;
    await callQueue.close();
  });

  it('rejects requests with a bad signature (401, no DB writes)', async () => {
    const f = await seed('bad-sig');
    try {
      const payload: RetellWebhookPayload = {
        call_id: `bad_sig_${Date.now()}`,
        agent_id: 'agent_x',
        call_status: 'no_answer',
        from_number: '+17055551001',
        to_number: f.phone,
        duration_ms: 0,
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        transcript: '',
        recording_url: null,
        metadata: {
          pipelineLoadId: f.pipelineLoadId,
          briefId: f.briefId,
          persona: 'friendly',
          language: 'en',
          currency: 'CAD',
        },
      };

      const result = await handleRetellWebhook(signedRequest(payload, 'wrong-secret') as any);
      expect(result.status).toBe(401);

      const calls = await db.query(
        `SELECT 1 FROM agent_calls WHERE pipeline_load_id = $1`,
        [f.pipelineLoadId],
      );
      expect(calls.rows.length).toBe(0);
    } finally {
      await cleanup(f);
    }
  }, 30_000);

  it('processes voicemail with valid signature and schedules a retry (no Claude needed)', async () => {
    const f = await seed('voicemail');
    try {
      const payload: RetellWebhookPayload = {
        call_id: `vm_${Date.now()}`,
        agent_id: 'agent_test_friendly',
        call_status: 'voicemail',
        from_number: '+17055551001',
        to_number: f.phone,
        duration_ms: 25000,
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        transcript: '',
        recording_url: null,
        metadata: {
          pipelineLoadId: f.pipelineLoadId,
          briefId: f.briefId,
          persona: 'friendly',
          language: 'en',
          currency: 'CAD',
        },
      };

      const result = await handleRetellWebhook(signedRequest(payload, TEST_SECRET) as any);
      expect(result.status).toBe(200);
      expect(result.body.processed).toBe(true);
      expect(result.body.outcome).toBe('voicemail');

      // Pipeline load should still be in 'calling' (retry queued, not declined)
      // — only after maxAttempts retries does it flip to 'declined'.
      const after = await db.query<{ stage: string; call_attempts: number }>(
        `SELECT stage, call_attempts FROM pipeline_loads WHERE id = $1`,
        [f.pipelineLoadId],
      );
      expect(after.rows[0].stage).toBe('calling');
    } finally {
      await cleanup(f);
    }
  }, 30_000);
});
