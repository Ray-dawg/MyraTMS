import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import {
  decideCascadeAction,
  escalateCascadeExhausted,
  VOICEMAIL_RETRY_DELAY_MS,
} from '@/lib/pipeline/carrier-cascade';

describe('decideCascadeAction (E2-03 M2 §6.3 pure state machine)', () => {
  it('accept at any position returns {type: accept}, no advance', () => {
    const r = decideCascadeAction({ outcome: 'accept', position: 2, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'accept' });
  });

  it('decline mid-stack advances to the next position', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 1, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'advance', nextPosition: 2 });
  });

  it('decline on the last position exhausts the cascade', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 4, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'exhausted' });
  });

  it('decline on a single-carrier stack (position 0 of 1) exhausts immediately', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 0, stackLength: 1, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'exhausted' });
  });

  it('voicemail on first attempt retries the same position at +2h', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 0, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('voicemail after the retry has already been used advances instead of retrying again', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 0, stackLength: 5, voicemailRetryCount: 1 });
    expect(r).toEqual({ type: 'advance', nextPosition: 1 });
  });

  it('no_answer is treated identically to voicemail (retry once, per PRD §6.3)', () => {
    const first = decideCascadeAction({ outcome: 'no_answer', position: 2, stackLength: 5, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 2, delayMs: VOICEMAIL_RETRY_DELAY_MS });
    const second = decideCascadeAction({ outcome: 'no_answer', position: 2, stackLength: 5, voicemailRetryCount: 1 });
    expect(second).toEqual({ type: 'advance', nextPosition: 3 });
  });

  it('disconnected (mapped from call_status=failed) is treated identically to voicemail', () => {
    const first = decideCascadeAction({ outcome: 'disconnected', position: 0, stackLength: 3, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('busy is folded into the same retry-once bucket as voicemail/no_answer/disconnected', () => {
    const first = decideCascadeAction({ outcome: 'busy', position: 0, stackLength: 3, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('an unreachable retry that lands on the last position exhausts rather than advancing out of bounds', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 4, stackLength: 5, voicemailRetryCount: 1 });
    expect(r).toEqual({ type: 'exhausted' });
  });
});

describe('escalateCascadeExhausted (E2-03 M2 §6.3 exhaustion — Alert Center pattern)', () => {
  it('sets stage=escalated and inserts a visible exceptions row naming every carrier tried', async () => {
    const runId = Date.now();
    const loadId = `TEST-EXHAUST-${runId}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Exhaust Co', 'x@test.test', '+17055559999', 2400, 'CAD', 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [loadId],
    );
    const pipelineLoadId = ins.rows[0].id;
    const stack = [`car_a_${runId}`, `car_b_${runId}`, `car_c_${runId}`];

    try {
      await escalateCascadeExhausted({
        pipelineLoadId, loadId, stack,
        originCity: 'Toronto', originState: 'ON',
        destinationCity: 'Sudbury', destinationState: 'ON',
      });

      const loadRow = await db.query<{ stage: string }>(
        `SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
      );
      expect(loadRow.rows[0].stage).toBe('escalated');

      const exc = await db.query<{ type: string; detail: string; pipeline_load_id: number }>(
        `SELECT type, detail, pipeline_load_id FROM exceptions WHERE pipeline_load_id = $1`,
        [pipelineLoadId],
      );
      expect(exc.rows).toHaveLength(1);
      expect(exc.rows[0].type).toBe('carrier_cascade_exhausted');
      for (const carrierId of stack) {
        expect(exc.rows[0].detail).toContain(carrierId);
      }
    } finally {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    }
  }, 30_000);
});
