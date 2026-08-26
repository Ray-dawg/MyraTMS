// __tests__/pipeline/carrier-webhook-branch.test.ts
/**
 * E2-03 M2 (§6.7): a carrier call's completion must write to agent_calls'
 * new carrier_* columns and pipeline_loads' M0-era carrier_* columns, and
 * must NEVER touch agreed_rate/profit/stage on either table (those are the
 * shipper path's columns). This is the exact fix for E2-02's most
 * consequential finding, one level deeper than where E2-03 M0 already
 * closed it on pipeline_loads.
 *
 * These tests call processCarrierCallCompleted() directly (not through the
 * full HTTP handleRetellWebhook() — that requires real signature
 * verification and is exercised by the existing webhook.test.ts for the
 * shipper path; this test proves the carrier write-path in isolation,
 * matching PRD §6.7's "a synthetic call_type='outbound_carrier' fixture"
 * requirement).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { processCarrierCallCompleted } from '@/lib/pipeline/retell-webhook';
import type { RetellWebhookPayload, CallMetadata } from '@/lib/pipeline/retell-types';

const RUN_ID = Date.now();
const TEST_LOAD_ID = `TEST-CARRWH-${RUN_ID}`;

describe('processCarrierCallCompleted (E2-03 M2 §6.7)', () => {
  let pipelineLoadId: number;

  beforeAll(async () => {
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
         $1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', 'car_001',
         'calling', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = ins.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  function mkPayload(overrides: Partial<RetellWebhookPayload> = {}): RetellWebhookPayload {
    return {
      call_id: `carrier_call_${RUN_ID}`,
      call_status: 'completed',
      from_number: '+14165550000',
      to_number: '+17055551861',
      duration_ms: 45000,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      recording_url: null,
      agent_id: 'agent_carrier_test',
      // agreedShipperRate=2200 CAD, floor=270 → ceiling=1930. 1800 is BELOW
      // the ceiling, so the default fixture exercises the genuine accept
      // path (Test 1, Test 2); Test 3 below overrides this to a
      // ceiling-breaching value to exercise the escalation path instead.
      transcript: 'Carrier agreed to run the load at 1800 CAD.',
      metadata: {
        pipelineLoadId,
        briefId: 0,
        persona: 'analytical',
        language: 'en',
        currency: 'CAD',
        callType: 'outbound_carrier',
      },
      ...overrides,
    } as unknown as RetellWebhookPayload;
  }

  function mkMetadata(overrides: Partial<CallMetadata> = {}): CallMetadata {
    return {
      pipelineLoadId,
      briefId: 0,
      persona: 'analytical',
      language: 'en',
      currency: 'CAD',
      fromNumber: '+14165550000',
      toNumber: '+17055551861',
      durationSeconds: 45,
      startTime: new Date(),
      endTime: new Date(),
      recordingUrl: null,
      retellCallId: `carrier_call_${RUN_ID}`,
      retellAgentId: 'agent_carrier_test',
      callType: 'outbound_carrier',
      ...overrides,
    } as CallMetadata;
  }

  it('accept below ceiling: writes carrier_outcome=accept + carrier_agreed_rate + carrier_profit to agent_calls, never touches agreed_rate/profit', async () => {
    const payload = mkPayload();
    const metadata = mkMetadata();

    const result = await processCarrierCallCompleted(payload, metadata);
    expect(result.success).toBe(true);
    expect(result.outcome).toBe('accept');

    const row = await db.query<{
      call_type: string; carrier_outcome: string | null; carrier_agreed_rate: string | null; carrier_profit: string | null;
      agreed_rate: string | null; profit: string | null; outcome: string | null;
    }>(
      `SELECT call_type, carrier_outcome, carrier_agreed_rate, carrier_profit, agreed_rate, profit, outcome
       FROM agent_calls WHERE call_id = $1`,
      [payload.call_id],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].call_type).toBe('outbound_carrier');
    expect(row.rows[0].carrier_outcome).toBe('accept');
    expect(Number(row.rows[0].carrier_agreed_rate)).toBe(1800);
    expect(Number(row.rows[0].carrier_profit)).toBe(400); // 2200 (shipper agreed_rate) - 1800
    // The shared shipper columns must stay untouched by a carrier call.
    expect(row.rows[0].agreed_rate).toBeNull();
    expect(row.rows[0].profit).toBeNull();
    expect(row.rows[0].outcome).toBeNull();
  });

  it('accept below ceiling: writes to pipeline_loads carrier_* columns with the real agreed rate, never touches agreed_rate/profit/stage', async () => {
    const payload = mkPayload({ call_id: `carrier_call_2_${RUN_ID}` });
    const metadata = mkMetadata({ retellCallId: `carrier_call_2_${RUN_ID}` });

    await processCarrierCallCompleted(payload, metadata);

    const row = await db.query<{
      stage: string; agreed_rate: string; carrier_call_outcome: string | null;
      carrier_agreed_rate: string | null; carrier_profit: string | null;
    }>(
      `SELECT stage, agreed_rate, carrier_call_outcome, carrier_agreed_rate, carrier_profit FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    // Shipper columns from the beforeAll seed must be untouched.
    expect(row.rows[0].stage).toBe('calling');
    expect(Number(row.rows[0].agreed_rate)).toBe(2200);
    expect(row.rows[0].carrier_call_outcome).toBe('accept');
    expect(Number(row.rows[0].carrier_agreed_rate)).toBe(1800);
    expect(Number(row.rows[0].carrier_profit)).toBe(400);
  });

  it('rewrites an above-ceiling accepted rate to escalated server-side, never books it (PRD §6.3/§6.5 envelope enforcement)', async () => {
    // agreedShipperRate=2200 CAD → ceiling = 2200-270 = 1930. Simulate a
    // transcript-parsed "accept" at 2100, which is ABOVE the ceiling.
    const payload = mkPayload({
      call_id: `carrier_call_3_${RUN_ID}`,
      transcript: 'Carrier agreed to 2100 CAD.',
    });
    const metadata = mkMetadata({ retellCallId: `carrier_call_3_${RUN_ID}` });

    const result = await processCarrierCallCompleted(payload, metadata);

    const acRow = await db.query<{ carrier_outcome: string }>(
      `SELECT carrier_outcome FROM agent_calls WHERE call_id = $1`,
      [payload.call_id],
    );
    expect(acRow.rows[0].carrier_outcome).toBe('escalated');
    expect(result.outcome).toBe('escalated');
  });
});
