/**
 * T-17 trigger verification — acceptance criteria 1 and 6.
 *
 * Verifies the migration 033 triggers fire correctly and are exception-safe,
 * without touching any file in the live call path. Point DATABASE_URL at the
 * Neon verification branch before running this — never point it at
 * production.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const RUN_ID = `T17-TRIG-${Date.now()}`;
const loadIds: number[] = [];
const callIds: number[] = [];
const jobIds: string[] = [];
const consentIds: number[] = [];

async function insertTestLoad(suffix: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'scanned')
     RETURNING id`,
    [`${RUN_ID}-${suffix}`],
  );
  const id = r.rows[0].id;
  loadIds.push(id);
  return id;
}

describe('T-17 event triggers', () => {
  afterAll(async () => {
    if (callIds.length) await db.query(`DELETE FROM agent_calls WHERE id = ANY($1::int[])`, [callIds]);
    if (jobIds.length) {
      await db.query(
        `DELETE FROM events WHERE derived_from_table = 'agent_jobs'
           AND derived_from_id IN (SELECT id FROM agent_jobs WHERE job_id = ANY($1::text[]))`,
        [jobIds],
      );
      await db.query(`DELETE FROM agent_jobs WHERE job_id = ANY($1::text[])`, [jobIds]);
    }
    if (consentIds.length) {
      await db.query(
        `DELETE FROM events WHERE derived_from_table = 'consent_log' AND derived_from_id = ANY($1::int[])`,
        [consentIds],
      );
      await db.query(`DELETE FROM consent_log WHERE id = ANY($1::int[])`, [consentIds]);
    }
    if (loadIds.length) {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = ANY($1::int[])`, [loadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [loadIds]);
    }
  });

  it('acceptance criterion 1: a single stage UPDATE produces exactly one load.stage_changed row', async () => {
    const id = await insertTestLoad('AC1');
    await db.query(`UPDATE pipeline_loads SET stage = 'qualified', stage_updated_at = NOW() WHERE id = $1`, [id]);

    const r = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed'`,
      [id],
    );
    expect(r.rows.length).toBe(1);

    const typed = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.qualified'`,
      [id],
    );
    expect(typed.rows.length).toBe(1);
  });

  it('acceptance criterion 6: escalated then back to calling produces both transitions, in order, queryable by pipeline_load_id', async () => {
    const id = await insertTestLoad('AC6');
    await db.query(`UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW() WHERE id = $1`, [id]);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'calling', stage_updated_at = NOW() + INTERVAL '1 minute' WHERE id = $1`,
      [id],
    );

    const r = await db.query<{ stage_from: string; stage_to: string; occurred_at: string }>(
      `SELECT stage_from, stage_to, occurred_at FROM events
        WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed'
        ORDER BY occurred_at ASC`,
      [id],
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].stage_to).toBe('escalated');
    expect(r.rows[1].stage_from).toBe('escalated');
    expect(r.rows[1].stage_to).toBe('calling');
  });

  it('agent_calls INSERT produces call.initiated; outcome UPDATE produces call.outcome_recorded', async () => {
    const loadId = await insertTestLoad('CALL');
    const r = await db.query<{ id: number }>(
      `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type)
       VALUES ($1, $2, 'negotiation') RETURNING id`,
      [loadId, `${RUN_ID}-CALL-1`],
    );
    const id = r.rows[0].id;
    callIds.push(id);

    await db.query(`UPDATE agent_calls SET outcome = 'booked', agreed_rate = 2400 WHERE id = $1`, [id]);

    const initiated = await db.query(
      `SELECT id FROM events WHERE derived_from_table = 'agent_calls' AND derived_from_id = $1 AND event_type = 'call.initiated'`,
      [id],
    );
    expect(initiated.rows.length).toBe(1);

    const outcome = await db.query<{ payload: { outcome: string } }>(
      `SELECT payload FROM events WHERE derived_from_table = 'agent_calls' AND derived_from_id = $1 AND event_type = 'call.outcome_recorded'`,
      [id],
    );
    expect(outcome.rows.length).toBe(1);
    expect(outcome.rows[0].payload.outcome).toBe('booked');
  });

  it('agent_jobs status UPDATE produces job.completed', async () => {
    const loadId = await insertTestLoad('JOB');
    const jobId = `${RUN_ID}-JOB-1`;
    await db.query(
      `INSERT INTO agent_jobs (job_id, queue_name, pipeline_load_id, status)
       VALUES ($1, 'qualify-queue', $2, 'processing')`,
      [jobId, loadId],
    );
    jobIds.push(jobId);

    await db.query(`UPDATE agent_jobs SET status = 'completed', completed_at = NOW() WHERE job_id = $1`, [jobId]);

    const r = await db.query<{ event_type: string }>(
      `SELECT e.event_type FROM events e
         JOIN agent_jobs j ON j.id = e.derived_from_id AND e.derived_from_table = 'agent_jobs'
        WHERE j.job_id = $1`,
      [jobId],
    );
    expect(r.rows.map((row) => row.event_type)).toContain('job.completed');
  });

  it('consent_log INSERT produces consent.logged with only the last 4 phone digits', async () => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO consent_log (phone, consent_type, consent_source)
       VALUES ('+14165551234', 'implied_load_post', 'manual_entry') RETURNING id`,
    );
    const id = r.rows[0].id;
    consentIds.push(id);

    const events = await db.query<{ payload: { phone_last4: string } }>(
      `SELECT payload FROM events WHERE derived_from_table = 'consent_log' AND derived_from_id = $1`,
      [id],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].payload.phone_last4).toBe('1234');
  });

  it('trigger exception-safety: an unmapped stage value still succeeds on the parent table with no typed event', async () => {
    const id = await insertTestLoad('SAFE');
    await expect(
      db.query(`UPDATE pipeline_loads SET stage = 'briefed', stage_updated_at = NOW() WHERE id = $1`, [id]),
    ).resolves.toBeDefined();

    const generic = await db.query(
      `SELECT id FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed' AND stage_to = 'briefed'`,
      [id],
    );
    expect(generic.rows.length).toBe(1);

    const typed = await db.query(
      `SELECT id FROM events WHERE pipeline_load_id = $1 AND stage_to = 'briefed'
         AND event_type LIKE 'load.%' AND event_type != 'load.stage_changed'`,
      [id],
    );
    expect(typed.rows.length).toBe(0);
  });
});
