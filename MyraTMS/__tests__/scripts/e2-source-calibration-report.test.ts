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
const SEED_BROKER = `TEST CalSeedBroker ${RUN}`;

describe('buildCalibrationReport', () => {
  let bad: number;
  let unresolved: number;
  let badFromSeedList: number;

  beforeAll(async () => {
    await db.query(
      `INSERT INTO poster_registry (legal_name, normalized_name, country, entity_class, class_source, confidence)
       VALUES ($1::varchar, LOWER($1::varchar), 'US', 'broker', 'human_review', 1.0)`,
      [BROKER],
    );
    // Same label, different provenance: this is the shape the seed script
    // actually writes for the operator's broker list (class_source
    // 'seed_broker_list', not 'human_review'). Criterion 4 must see it too.
    await db.query(
      `INSERT INTO poster_registry (legal_name, normalized_name, country, entity_class, class_source, confidence)
       VALUES ($1::varchar, LOWER($1::varchar), 'US', 'broker', 'seed_broker_list', 0.9)`,
      [SEED_BROKER],
    );
    const ins = async (loadId: string, cls: string, method: string, poster: string = BROKER) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
             destination_city, destination_state, destination_country, pickup_date, equipment_type, stage,
             poster_company_raw, poster_company_normalized, load_source_class, load_source_method, created_by)
           VALUES ($1, 'csv', 'A', 'IL', 'US', 'B', 'TX', 'US', NOW() + INTERVAL '2 days', 'Dry Van', 'scanned',
             $2::varchar, LOWER($2::varchar), $3, $4, 'test') RETURNING id`,
          [loadId, poster, cls, method],
        )
      ).rows[0].id;
    bad = await ins(`TEST-CAL-${RUN}`, 'shipper_direct', 'heuristic');
    badFromSeedList = await ins(`TEST-CAL-S-${RUN}`, 'shipper_direct', 'heuristic', SEED_BROKER);
    unresolved = await ins(`TEST-CAL-U-${RUN}`, 'unresolved', 'heuristic');
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [[bad, unresolved, badFromSeedList]]);
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = ANY($1::varchar[])`, [[BROKER.toLowerCase(), SEED_BROKER.toLowerCase()]]);
  });

  it('flags a labelled broker that was classified shipper_direct', async () => {
    const r = await buildCalibrationReport();
    expect(r.labelledBrokersAccepted.some((x) => x.pipelineLoadId === bad)).toBe(true);
    expect(r.byClass.shipper_direct).toBeGreaterThanOrEqual(1);
    expect(r.totalRows).toBeGreaterThanOrEqual(2);
    expect(r.registryHitRate).toBeGreaterThanOrEqual(0);
    expect(r.registryHitRate).toBeLessThanOrEqual(1);
  });

  it("flags a broker from the operator's seeded broker list, not only class_source='human_review'", async () => {
    // The original filter was class_source = 'human_review', which excluded
    // every row e2_seed_poster_registry.ts writes — so the check could never
    // see the labels it exists to cross-validate.
    const r = await buildCalibrationReport();
    expect(r.labelledBrokersAccepted.some((x) => x.pipelineLoadId === badFromSeedList)).toBe(true);
  });

  it('lists unresolved posters for labelling', async () => {
    const r = await buildCalibrationReport();
    expect(r.unresolvedTopPosters.some((p) => p.poster === BROKER)).toBe(true);
  });
});
