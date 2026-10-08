/**
 * E2-01 M1 — Task 9: calibration report that gates the shipper-direct enforce flip.
 *
 * Seeds one human-labelled broker in poster_registry and one pipeline_loads row
 * posted by that broker but classified shipper_direct. The report MUST surface it
 * in labelledBrokersAccepted (PRD §4.12 step 4: zero labelled brokers accepted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { buildCalibrationReport } from '@/scripts/e2_source_calibration_report';

const RUN = Date.now();
const BROKER = `TEST CalBroker ${RUN}`;

describe('buildCalibrationReport', () => {
  let bad: number;
  let unresolved: number;

  beforeAll(async () => {
    await db.query(
      `INSERT INTO poster_registry (legal_name, normalized_name, country, entity_class, class_source, confidence)
       VALUES ($1::varchar, LOWER($1::varchar), 'US', 'broker', 'human_review', 1.0)`,
      [BROKER],
    );
    const ins = async (loadId: string, cls: string, method: string) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
             destination_city, destination_state, destination_country, pickup_date, equipment_type, stage,
             poster_company_raw, poster_company_normalized, load_source_class, load_source_method, created_by)
           VALUES ($1, 'csv', 'A', 'IL', 'US', 'B', 'TX', 'US', NOW() + INTERVAL '2 days', 'Dry Van', 'scanned',
             $2::varchar, LOWER($2::varchar), $3, $4, 'test') RETURNING id`,
          [loadId, BROKER, cls, method],
        )
      ).rows[0].id;
    bad = await ins(`TEST-CAL-${RUN}`, 'shipper_direct', 'heuristic');
    unresolved = await ins(`TEST-CAL-U-${RUN}`, 'unresolved', 'heuristic');
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [[bad, unresolved]]);
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = LOWER($1::varchar)`, [BROKER]);
  });

  it('flags a labelled broker that was classified shipper_direct', async () => {
    const r = await buildCalibrationReport();
    expect(r.labelledBrokersAccepted.some((x) => x.pipelineLoadId === bad)).toBe(true);
    expect(r.byClass.shipper_direct).toBeGreaterThanOrEqual(1);
    expect(r.totalRows).toBeGreaterThanOrEqual(2);
    expect(r.registryHitRate).toBeGreaterThanOrEqual(0);
    expect(r.registryHitRate).toBeLessThanOrEqual(1);
  });

  it('lists unresolved posters for labelling', async () => {
    const r = await buildCalibrationReport();
    expect(r.unresolvedTopPosters.some((p) => p.poster === BROKER)).toBe(true);
  });
});
