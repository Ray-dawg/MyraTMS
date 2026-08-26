/**
 * confirmation-actions.ts integration tests (E2-04 M3).
 * Runs against live Neon + live carrier-brief-queue (real queue name — the
 * module hardcodes it, so the test inspects/cleans the same real queue,
 * matching retell-webhook-carrier-cascade.test.ts's established pattern of
 * pausing a real hardcoded-name queue around its own assertions).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import {
  getConfirmationByToken,
  submitConfirmation,
  declineConfirmation,
  recordVerbalConfirmation,
} from '@/lib/confirmation-actions';

const RUN_ID = Date.now();
const seededPipelineLoadIds: number[] = [];

async function seedPipelineLoad(opts: {
  stage: string;
  token?: string | null;
  // Seconds from DB NOW() -- positive = future (not expired), negative =
  // past (expired). Computed via SQL interval math, not a JS Date passed
  // as a parameter: a JS ISO string written into a TIMESTAMP WITHOUT TIME
  // ZONE column round-trips through this dev machine's non-UTC local
  // timezone on readback (Postgres silently drops the 'Z' on insert, then
  // the driver re-parses the bare string as local time), which drifts the
  // instant by the local UTC offset. Production is unaffected (Railway/
  // Vercel run TZ=UTC, so the same round trip has zero drift there) -- this
  // is a local-dev-only test artifact, not a real defect in
  // shipper-confirmation-worker.ts or confirmation-actions.ts.
  tokenExpiresInSeconds?: number | null;
}): Promise<{ id: number; loadId: string; token: string }> {
  const runSuffix = `${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const loadId = `TEST-CA-${runSuffix}`;
  const token = opts.token === undefined ? `${'b'.repeat(56)}${runSuffix.slice(-8)}` : opts.token ?? null;
  const snapshot = {
    loadId,
    origin: 'Toronto, ON',
    destination: 'Sudbury, ON',
    pickupDate: null,
    deliveryDate: null,
    equipmentType: 'Dry Van',
    rate: 2200,
    rateCurrency: 'CAD',
    snapshotAt: new Date().toISOString(),
  };

  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       shipper_company, shipper_email, shipper_phone,
       posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency,
       confirmation_token, confirmation_token_expires_at, confirmation_snapshot
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
       'Confirm Actions Test Co', 'shipper@test.test', '+17055550000',
       2400, 'CAD', $2, 2200, 'CAD',
       $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + ($4::int || ' seconds')::interval END, $5
     ) RETURNING id`,
    [loadId, opts.stage, token, opts.tokenExpiresInSeconds ?? null, JSON.stringify(snapshot)],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return { id: ins.rows[0].id, loadId, token: token! };
}

describe('confirmation-actions (E2-04 M3)', () => {
  let briefQueue: Queue;

  beforeAll(async () => {
    briefQueue = new Queue('carrier-brief-queue', { connection: redisConnection });
    await briefQueue.pause();
  });

  afterAll(async () => {
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM compliance_audit WHERE details->>'pipeline_load_id' = ANY($1::text[])`, [
        seededPipelineLoadIds.map(String),
      ]);
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
    await briefQueue.obliterate({ force: true });
    await briefQueue.resume();
    await briefQueue.close();
  });

  describe('getConfirmationByToken', () => {
    it('returns found=false for an unknown token', async () => {
      const result = await getConfirmationByToken('nonexistent-token-xyz');
      expect(result.found).toBe(false);
    });

    it('returns expired for a token past its expiry', async () => {
      const { token, loadId } = await seedPipelineLoad({
        stage: 'awaiting_shipper_confirmation',
        tokenExpiresInSeconds: -60,
      });
      const result = await getConfirmationByToken(token);
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.expired).toBe(true);
        expect(result.loadId).toBe(loadId);
      }
    });

    it('returns the snapshot for a live, unresolved token', async () => {
      const { token } = await seedPipelineLoad({
        stage: 'awaiting_shipper_confirmation',
        tokenExpiresInSeconds: 3600,
      });
      const result = await getConfirmationByToken(token);
      expect(result.found).toBe(true);
      if (result.found && !result.expired) {
        expect(result.alreadyResolved).toBe(false);
        expect(result.snapshot?.rate).toBe(2200);
      }
    });
  });

  describe('submitConfirmation', () => {
    it('confirms an awaiting load, sets confirmed_rate, enqueues carrier-brief-queue', async () => {
      const { id, token, loadId } = await seedPipelineLoad({
        stage: 'awaiting_shipper_confirmation',
        tokenExpiresInSeconds: 3600,
      });

      const result = await submitConfirmation(token);
      expect(result.outcome).toBe('confirmed');
      if (result.outcome === 'confirmed') expect(result.loadId).toBe(loadId);

      const row = await db.query<{ stage: string; confirmed_rate: string; confirmation_outcome: string }>(
        `SELECT stage, confirmed_rate, confirmation_outcome FROM pipeline_loads WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].stage).toBe('shipper_confirmed');
      expect(Number(row.rows[0].confirmed_rate)).toBe(2200);
      expect(row.rows[0].confirmation_outcome).toBe('confirmed');

      const jobs = await briefQueue.getJobs(['waiting', 'paused']);
      expect(jobs.some((j) => j.data.pipelineLoadId === id)).toBe(true);
    }, 15_000);

    it('a second confirm on an already-confirmed load returns already_confirmed, does not double-enqueue', async () => {
      const { token, id } = await seedPipelineLoad({
        stage: 'shipper_confirmed',
        tokenExpiresInSeconds: 3600,
      });

      const before = (await briefQueue.getJobs(['waiting', 'paused'])).length;
      const result = await submitConfirmation(token);
      const after = (await briefQueue.getJobs(['waiting', 'paused'])).length;

      expect(result.outcome).toBe('already_confirmed');
      expect(after).toBe(before);
      void id;
    }, 15_000);

    it('an expired token returns expired, does not confirm', async () => {
      const { token, id } = await seedPipelineLoad({
        stage: 'awaiting_shipper_confirmation',
        tokenExpiresInSeconds: -60,
      });

      const result = await submitConfirmation(token);
      expect(result.outcome).toBe('expired');

      const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [id]);
      expect(row.rows[0].stage).toBe('awaiting_shipper_confirmation');
    }, 15_000);

    it('an unknown token returns not_found', async () => {
      const result = await submitConfirmation('totally-unknown-token');
      expect(result.outcome).toBe('not_found');
    });
  });

  describe('declineConfirmation', () => {
    it('declines an awaiting load, escalates, writes an exceptions row with the reason', async () => {
      const { token, id } = await seedPipelineLoad({
        stage: 'awaiting_shipper_confirmation',
        tokenExpiresInSeconds: 3600,
      });

      const result = await declineConfirmation(token, 'Rate is too low, need to renegotiate');
      expect(result.outcome).toBe('declined');

      const row = await db.query<{ stage: string; confirmation_outcome: string; decline_reason: string }>(
        `SELECT stage, confirmation_outcome, decline_reason FROM pipeline_loads WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].stage).toBe('escalated');
      expect(row.rows[0].confirmation_outcome).toBe('declined');
      expect(row.rows[0].decline_reason).toBe('Rate is too low, need to renegotiate');

      const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
      expect(exc.rows).toHaveLength(1);
      expect(exc.rows[0].type).toBe('shipper_declined_confirmation');
    }, 15_000);
  });

  describe('recordVerbalConfirmation', () => {
    it('confirms an escalated (timed-out) load verbally, logs compliance_audit, enqueues carrier-brief-queue', async () => {
      const { id, loadId } = await seedPipelineLoad({ stage: 'escalated' });

      const result = await recordVerbalConfirmation(id, 'user:test-ops', 'Confirmed by phone, shipper OK with terms');
      expect(result.outcome).toBe('confirmed');
      if (result.outcome === 'confirmed') expect(result.loadId).toBe(loadId);

      const row = await db.query<{ stage: string; confirmation_outcome: string }>(
        `SELECT stage, confirmation_outcome FROM pipeline_loads WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].stage).toBe('shipper_confirmed');
      expect(row.rows[0].confirmation_outcome).toBe('confirmed_verbal');

      const audit = await db.query<{ check_type: string }>(
        `SELECT check_type FROM compliance_audit WHERE check_type = 'shipper_verbal_confirmation' AND details->>'pipeline_load_id' = $1`,
        [String(id)],
      );
      expect(audit.rows.length).toBeGreaterThan(0);

      const jobs = await briefQueue.getJobs(['waiting', 'paused']);
      expect(jobs.some((j) => j.data.pipelineLoadId === id)).toBe(true);
    }, 15_000);

    it('a dispatched load is not eligible for a verbal confirmation', async () => {
      const { id } = await seedPipelineLoad({ stage: 'dispatched' });

      const result = await recordVerbalConfirmation(id, 'user:test-ops', null);
      expect(result.outcome).toBe('already_resolved');
    }, 15_000);
  });
});
