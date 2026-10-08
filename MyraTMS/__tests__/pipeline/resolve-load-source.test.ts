/**
 * E2-01 §4.7 step 3 — human review resolution. Live Neon + Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { resolveLoadSource } from '@/lib/pipeline/resolve-load-source';

const RUN = Date.now();
const POSTER = `TEST Resolve Co ${RUN}`;

describe('resolveLoadSource', () => {
  let q: Queue;
  let id: number;
  let expiredId: number;

  beforeAll(async () => {
    q = new Queue('qualify-queue-resolve-test', { connection: redisConnection });
    const mk = async (suffix: string, pickupSql: string) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
             destination_city, destination_state, destination_country, pickup_date, equipment_type,
             posted_rate, posted_rate_currency, distance_miles, stage, qualification_reason,
             poster_company_raw, poster_company_normalized, created_by)
           VALUES ($1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US', ${pickupSql}, 'Dry Van',
             2400, 'USD', 920, 'escalated', 'poster_unresolved_review', $2::varchar, LOWER($2::varchar), 'test')
           RETURNING id`,
          [`TEST-RESOLVE-${suffix}-${RUN}`, POSTER],
        )
      ).rows[0].id;
    id = await mk('ok', `NOW() + INTERVAL '3 days'`);
    expiredId = await mk('expired', `NOW() - INTERVAL '1 day'`);
    await db.query(
      `INSERT INTO exceptions (type, severity, title, detail, pipeline_load_id, source_module, status)
       VALUES ('load_source_review', 'medium', 't', '{}', $1, 'load_source_review', 'active')`,
      [id],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1::int[])`, [[id, expiredId]]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [[id, expiredId]]);
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = LOWER($1::varchar)`, [POSTER]);
    await q.obliterate({ force: true });
    await q.close();
  });

  it('writes the registry, resolves the exception, resets to scanned, and re-enqueues', async () => {
    const res = await resolveLoadSource(
      { pipelineLoadId: id, entityClass: 'shipper', appliesToPoster: true, note: 'known customer', resolvedBy: 'user-1' },
      q,
    );
    expect(res.ok).toBe(true);
    const reg = (
      await db.query(`SELECT entity_class, class_source, confidence, verified_by FROM poster_registry WHERE normalized_name = LOWER($1::varchar)`, [POSTER])
    ).rows[0];
    expect(reg).toMatchObject({ entity_class: 'shipper', class_source: 'human_review', verified_by: 'user-1' });
    expect(Number(reg.confidence)).toBe(1);
    const load = (await db.query(`SELECT stage, qualification_reason, poster_registry_id FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(load.stage).toBe('scanned');
    expect(load.qualification_reason).toBeNull();
    expect(load.poster_registry_id).not.toBeNull();
    const ex = (await db.query(`SELECT status FROM exceptions WHERE pipeline_load_id = $1`, [id])).rows[0];
    expect(ex.status).toBe('resolved');
    const jobs = await q.getJobs(['waiting', 'prioritized']);
    expect(jobs.some((j) => j.data.pipelineLoadId === id && j.data.posterCompanyRaw === POSTER)).toBe(true);
  });

  it('refuses a load whose pickup window has passed', async () => {
    const res = await resolveLoadSource(
      { pipelineLoadId: expiredId, entityClass: 'shipper', appliesToPoster: false, note: null, resolvedBy: 'user-1' },
      q,
    );
    expect(res).toEqual({ ok: false, error: 'expired' });
  });

  it('refuses a load that is not in review', async () => {
    const res = await resolveLoadSource(
      { pipelineLoadId: id, entityClass: 'shipper', appliesToPoster: false, note: null, resolvedBy: 'user-1' },
      q,
    );
    expect(res).toEqual({ ok: false, error: 'not_in_review' }); // it is 'scanned' after the first test
  });
});
