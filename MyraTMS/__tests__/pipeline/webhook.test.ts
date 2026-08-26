/**
 * Retell webhook integration test.
 *
 * Tests against live Neon + live Upstash without invoking Claude:
 *   1. Bad signature → 401, no DB writes
 *   2. Voicemail / no_answer (non-conversation) → 200, retry enqueued, no
 *      transcript parsing required
 *   3. Carrier call with a non-completed status → routed to the carrier
 *      branch (fails closed), never falls through to a shipper handler
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
  // Retell scheme: header `v={ts},d={HMAC-SHA256(rawBody+ts)}` (hex), keyed by the
  // webhook-badged API key, with a 5-minute freshness window.
  const ts = String(Date.now());
  const sig =
    secret === null
      ? ''
      : `v=${ts},d=${crypto.createHmac('sha256', secret).update(raw + ts).digest('hex')}`;
  return {
    headers: { 'x-retell-signature': sig },
    text: async () => raw,
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

  it('a carrier call (metadata.callType=outbound_carrier) with a non-completed status (no_answer) does NOT fall through to the shipper handlers, and never touches agreed_rate/profit/stage', async () => {
    // Whole-branch review finding 1 (M2 Foundation session): before the
    // dispatch-ladder fix, a carrier call with any status other than
    // 'completed' fell into processCallFailed()/processNonConversation(),
    // the shipper-only handlers that write agreed_rate/profit/stage. As of
    // E2-03 M2 Session 2 (the cascade state machine), a non-completed
    // carrier call is no longer unhandled: it routes to
    // processCarrierCallOutcome(), which writes only carrier_* columns and
    // drives decideCascadeAction(). This test now asserts THAT routing
    // happened (not the earlier "fails closed as unhandled" placeholder),
    // while still protecting the same invariant its name describes: the
    // shared shipper columns must stay untouched.
    const f = await seed('carrier-no-answer');
    try {
      const payload = {
        call_id: `carrier_na_${Date.now()}`,
        agent_id: 'agent_carrier_test',
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
          persona: 'analytical',
          language: 'en',
          currency: 'CAD',
          callType: 'outbound_carrier',
          cascadePosition: 0,
          voicemailRetryCount: 0,
          carrierId: 'car_001',
          stackLength: 3,
        },
      } as unknown as RetellWebhookPayload;

      const result = await handleRetellWebhook(signedRequest(payload, TEST_SECRET) as any);

      // Routed to the carrier cascade handler: first no_answer retries the
      // same position at +2h, not an immediate advance or escalation.
      expect(result.status).toBe(200);
      expect(result.body.processed).toBe(true);
      expect(result.body.outcome).toBe('no_answer');

      // processCarrierCallOutcome() writes a carrier-side agent_calls row
      // (carrier_outcome only, never the shipper outcome/agreed_rate
      // columns processCallCompleted()/processCallFailed() own).
      const calls = await db.query<{ carrier_outcome: string; outcome: string | null }>(
        `SELECT carrier_outcome, outcome FROM agent_calls WHERE pipeline_load_id = $1`,
        [f.pipelineLoadId],
      );
      expect(calls.rows).toHaveLength(1);
      expect(calls.rows[0].carrier_outcome).toBe('no_answer');
      expect(calls.rows[0].outcome).toBeNull();

      // The shared shipper columns on pipeline_loads must be completely
      // untouched: stage stays at the seeded 'calling', never flipped to
      // 'declined'/'escalated' by the shipper-only non-conversation/failed
      // handlers, and agreed_rate/profit/call_outcome (the SHIPPER outcome
      // column) stay NULL. carrier_call_outcome, the carrier-only column,
      // is the one that's expected to be set.
      const after = await db.query<{
        stage: string; agreed_rate: string | null; profit: string | null;
        call_outcome: string | null; carrier_call_outcome: string | null;
      }>(
        `SELECT stage, agreed_rate, profit, call_outcome, carrier_call_outcome FROM pipeline_loads WHERE id = $1`,
        [f.pipelineLoadId],
      );
      expect(after.rows[0].stage).toBe('calling');
      expect(after.rows[0].agreed_rate).toBeNull();
      expect(after.rows[0].profit).toBeNull();
      expect(after.rows[0].call_outcome).toBeNull();
      expect(after.rows[0].carrier_call_outcome).toBe('no_answer');
    } finally {
      await cleanup(f);
    }
  }, 30_000);
});
