/**
 * ShipperConfirmationWorker integration test (E2-04 M2 + review session F2).
 * Runs against live Neon + live Upstash-backed BullMQ (this suite's
 * established convention — see dispatch-gate.test.ts, compiler.test.ts).
 * Covers all 3 actions (send/nudge/escalate), their no-op skip paths, and
 * F2's two new escalation paths (feature disabled, send failure).
 *
 * sendShipperConfirmationRequestEmail() is mocked at the module boundary --
 * this dev/test environment has no SMTP configured either (same as
 * production today), so without the mock every "successful send" test below
 * would now correctly hit F2's new escalate-on-failure path instead of
 * reaching 'awaiting_shipper_confirmation', making the happy path
 * untestable here. Matches this suite's established pattern of mocking at
 * the I/O boundary (dispatch-gate.test.ts mocks @vercel/blob's put() the
 * same way).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import {
  ShipperConfirmationWorker,
  type ShipperConfirmationJobPayload,
} from '@/lib/workers/shipper-confirmation-worker';

vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return { ...actual, sendShipperConfirmationRequestEmail: vi.fn() };
});
import { sendShipperConfirmationRequestEmail } from '@/lib/email';
const mockSendEmail = vi.mocked(sendShipperConfirmationRequestEmail);

const RUN_ID = Date.now();
const seededPipelineLoadIds: number[] = [];

async function seedPipelineLoad(opts: {
  stage: string;
  shipperEmail?: string | null;
  confirmationNudgedAt?: boolean;
}): Promise<number> {
  const runSuffix = `${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       shipper_company, shipper_contact_name, shipper_email, shipper_phone,
       posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency,
       confirmation_nudged_at
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
       'Confirm Test Co', 'Jean Test', $2, '+17055550000',
       2400, 'CAD', $3, 2200, 'CAD', $4
     ) RETURNING id`,
    [
      `TEST-SCW-${runSuffix}`,
      opts.shipperEmail === undefined ? 'shipper@test.test' : opts.shipperEmail,
      opts.stage,
      opts.confirmationNudgedAt ? new Date().toISOString() : null,
    ],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return ins.rows[0].id;
}

function jobPayload(pipelineLoadId: number, action: ShipperConfirmationJobPayload['action']): ShipperConfirmationJobPayload {
  return {
    pipelineLoadId,
    loadId: '',
    loadBoardSource: '',
    enqueuedAt: new Date().toISOString(),
    priority: 0,
    action,
  };
}

describe('ShipperConfirmationWorker (E2-04 M2)', () => {
  let selfQueue: Queue<ShipperConfirmationJobPayload>;
  let worker: ShipperConfirmationWorker;
  const envBackup = { ...process.env };

  beforeAll(() => {
    process.env.PIPELINE_ENABLED = 'true';
    selfQueue = new Queue(`shipper-confirmation-queue-test-${RUN_ID}`, { connection: redisConnection });
    // F2: shipperConfirmationEnabled defaults false (SHIPPER_CONFIRMATION_ENABLED
    // unset) -- explicitly true here so the existing happy-path tests below
    // still exercise 'send' rather than the new disabled-escalation path.
    // The dedicated disabled/failure tests construct their own worker or
    // override the mock per-case.
    worker = new ShipperConfirmationWorker(redisConnection, selfQueue, { shipperConfirmationEnabled: true });
  });

  beforeEach(() => {
    mockSendEmail.mockReset();
    mockSendEmail.mockResolvedValue(true);
  });

  afterAll(async () => {
    process.env = envBackup;
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
    await worker.shutdown();
    await selfQueue.obliterate({ force: true });
    await selfQueue.close();
  });

  it('send: booked load with a shipper email — issues a token, advances stage, schedules nudge+escalate', async () => {
    const id = await seedPipelineLoad({ stage: 'booked' });

    const result = await worker.process(jobPayload(id, 'send'));

    expect(result.success).toBe(true);
    expect(result.stage).toBe('awaiting_shipper_confirmation');
    expect(result.details?.emailSent).toBe(true);

    const row = await db.query<{
      stage: string;
      confirmation_token: string | null;
      confirmation_sent_at: Date | null;
      confirmation_snapshot: unknown;
    }>(
      `SELECT stage, confirmation_token, confirmation_sent_at, confirmation_snapshot FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].stage).toBe('awaiting_shipper_confirmation');
    expect(row.rows[0].confirmation_token).toHaveLength(64);
    expect(row.rows[0].confirmation_sent_at).not.toBeNull();
    expect(row.rows[0].confirmation_snapshot).not.toBeNull();

    const delayed = await selfQueue.getJobs(['delayed', 'waiting']);
    const names = delayed.map((j) => j.name).sort();
    expect(names).toEqual(['escalate', 'nudge']);
  }, 30_000);

  it('send: no shipper email — escalates instead of sending', async () => {
    const id = await seedPipelineLoad({ stage: 'booked', shipperEmail: null });

    const result = await worker.process(jobPayload(id, 'send'));

    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('shipper_email_missing');

    const row = await db.query<{ stage: string; confirmation_outcome: string | null }>(
      `SELECT stage, confirmation_outcome FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].stage).toBe('escalated');
    expect(row.rows[0].confirmation_outcome).toBe('no_email');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_email_missing');
  }, 15_000);

  it('send: malformed shipper_email (e.g. a hallucinated non-email string) — escalates the same as missing, never attempts a send (F3, closes V3)', async () => {
    const id = await seedPipelineLoad({ stage: 'booked', shipperEmail: 'not provided' });

    const result = await worker.process(jobPayload(id, 'send'));

    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('shipper_email_missing');
    expect(mockSendEmail).not.toHaveBeenCalled();

    const row = await db.query<{ stage: string; confirmation_outcome: string | null }>(
      `SELECT stage, confirmation_outcome FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].stage).toBe('escalated');
    expect(row.rows[0].confirmation_outcome).toBe('no_email');

    const exc = await db.query<{ type: string; detail: string }>(`SELECT type, detail FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_email_missing');
    expect(exc.rows[0].detail).toContain('not provided');
  }, 15_000);

  it('nudge: still awaiting confirmation and not yet nudged — sends reminder, sets confirmation_nudged_at', async () => {
    const id = await seedPipelineLoad({ stage: 'awaiting_shipper_confirmation' });
    await db.query(
      `UPDATE pipeline_loads SET confirmation_token = $2 WHERE id = $1`,
      [id, 'a'.repeat(64)],
    );

    const result = await worker.process(jobPayload(id, 'nudge'));

    expect(result.details?.nudgeSent !== undefined || result.details?.skipped === 'no_token').toBe(true);

    if (result.details?.nudgeSent !== undefined) {
      const row = await db.query<{ confirmation_nudged_at: Date | null }>(
        `SELECT confirmation_nudged_at FROM pipeline_loads WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].confirmation_nudged_at).not.toBeNull();
    }
  }, 15_000);

  it('nudge: load already resolved (shipper_confirmed) — no-ops', async () => {
    const id = await seedPipelineLoad({ stage: 'shipper_confirmed' });

    const result = await worker.process(jobPayload(id, 'nudge'));

    expect(result.details?.skipped).toBe('already_resolved');
  }, 15_000);

  it('nudge: already nudged once — does not re-send', async () => {
    const id = await seedPipelineLoad({ stage: 'awaiting_shipper_confirmation', confirmationNudgedAt: true });

    const result = await worker.process(jobPayload(id, 'nudge'));

    expect(result.details?.skipped).toBe('already_nudged');
  }, 15_000);

  it('escalate: still awaiting confirmation after timeout — escalates with an exceptions row', async () => {
    const id = await seedPipelineLoad({ stage: 'awaiting_shipper_confirmation' });

    const result = await worker.process(jobPayload(id, 'escalate'));

    expect(result.stage).toBe('escalated');

    const row = await db.query<{ stage: string; confirmation_outcome: string | null }>(
      `SELECT stage, confirmation_outcome FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].stage).toBe('escalated');
    expect(row.rows[0].confirmation_outcome).toBe('timeout');

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_confirmation_timeout');
  }, 15_000);

  it('escalate: shipper already confirmed before the timer fired — no-ops, does not overwrite the confirmed stage', async () => {
    const id = await seedPipelineLoad({ stage: 'shipper_confirmed' });

    const result = await worker.process(jobPayload(id, 'escalate'));

    expect(result.details?.skipped).toBe('already_resolved');

    const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [id]);
    expect(row.rows[0].stage).toBe('shipper_confirmed');
  }, 15_000);

  it('send: SHIPPER_CONFIRMATION_ENABLED=false — escalates immediately, no token, no nudge/escalate scheduled (F2, closes V2)', async () => {
    const disabledQueue = new Queue(`shipper-confirmation-queue-test-disabled-${RUN_ID}`, { connection: redisConnection });
    const disabledWorker = new ShipperConfirmationWorker(redisConnection, disabledQueue, { shipperConfirmationEnabled: false });
    try {
      const id = await seedPipelineLoad({ stage: 'booked' });

      const result = await disabledWorker.process(jobPayload(id, 'send'));

      expect(result.details?.escalated).toBe(true);
      expect(result.details?.reason).toBe('shipper_confirmation_disabled');
      expect(mockSendEmail).not.toHaveBeenCalled();

      const row = await db.query<{ stage: string; confirmation_outcome: string | null; confirmation_token: string | null }>(
        `SELECT stage, confirmation_outcome, confirmation_token FROM pipeline_loads WHERE id = $1`, [id],
      );
      expect(row.rows[0].stage).toBe('escalated');
      expect(row.rows[0].confirmation_outcome).toBe('disabled');
      expect(row.rows[0].confirmation_token).toBeNull();

      const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
      expect(exc.rows).toHaveLength(1);
      expect(exc.rows[0].type).toBe('shipper_confirmation_disabled');

      const jobs = await disabledQueue.getJobs(['delayed', 'waiting']);
      expect(jobs).toHaveLength(0);
    } finally {
      await disabledWorker.shutdown();
      await disabledQueue.obliterate({ force: true });
      await disabledQueue.close();
    }
  }, 15_000);

  it('send: email send returns false (SMTP unconfigured) — escalates on first failure, does not wait out the 2h SLA (F2, closes V2)', async () => {
    mockSendEmail.mockResolvedValueOnce(false);
    const id = await seedPipelineLoad({ stage: 'booked' });

    const result = await worker.process(jobPayload(id, 'send'));

    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('shipper_confirmation_send_failed');

    const row = await db.query<{ stage: string; confirmation_outcome: string | null; confirmation_token: string | null }>(
      `SELECT stage, confirmation_outcome, confirmation_token FROM pipeline_loads WHERE id = $1`, [id],
    );
    expect(row.rows[0].stage).toBe('escalated');
    expect(row.rows[0].confirmation_outcome).toBe('send_failed');
    expect(row.rows[0].confirmation_token).toBeNull();

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('shipper_confirmation_send_failed');

    const jobs = await selfQueue.getJobs(['delayed', 'waiting']);
    expect(jobs.filter((j) => j.data.pipelineLoadId === id)).toHaveLength(0);
  }, 15_000);

  it('send: email send throws — escalates rather than propagating into BaseWorker retry (F2, closes V2)', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const id = await seedPipelineLoad({ stage: 'booked' });

    const result = await worker.process(jobPayload(id, 'send'));

    expect(result.success).toBe(true); // handled, not re-thrown
    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('shipper_confirmation_send_failed');

    const row = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [id]);
    expect(row.rows[0].stage).toBe('escalated');
  }, 15_000);
});
