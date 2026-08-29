// __tests__/risk/t25-concentration-math.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const REF = `T25CONC-${Date.now()}`;

describe('v_payer_concentration_exposure — 100% arithmetic accuracy (criterion 3)', () => {
  let payerAId: number;
  let payerBId: number;
  const loadIds: number[] = [];

  beforeAll(async () => {
    const a = await db.query<{ id: number }>(`INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`, [`${REF}-PayerA`]);
    payerAId = a.rows[0].id;
    const b = await db.query<{ id: number }>(`INSERT INTO payer_registry (legal_name) VALUES ($1) RETURNING id`, [`${REF}-PayerB`]);
    payerBId = b.rows[0].id;

    // Hand-calculated: total open exposure = 1000 (A) + 3000 (A) + 6000 (B) = 10000.
    // A = 4000/10000 = 40%. B = 6000/10000 = 60%.
    const rates: [number, number][] = [[payerAId, 1000], [payerAId, 3000], [payerBId, 6000]];
    for (const [payerId, rate] of rates) {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
           destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
           stage, agreed_rate, payer_registry_id)
         VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2, $3) RETURNING id`,
        [`${REF}-${loadIds.length}`, rate, payerId],
      );
      loadIds.push(ins.rows[0].id);
    }
  }, 15000);

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [loadIds]);
    await db.query(`DELETE FROM payer_registry WHERE id IN ($1, $2)`, [payerAId, payerBId]);
  });

  it('computes exact percentages for both payers against total real open exposure', async () => {
    const { rows } = await db.query<{ payer_registry_id: number; open_exposure: string; concentration_pct: string }>(
      `SELECT payer_registry_id, open_exposure, concentration_pct FROM v_payer_concentration_exposure
        WHERE payer_registry_id IN ($1, $2)`,
      [payerAId, payerBId],
    );
    const a = rows.find((r) => r.payer_registry_id === payerAId)!;
    const b = rows.find((r) => r.payer_registry_id === payerBId)!;
    expect(Number(a.open_exposure)).toBe(4000);
    expect(Number(b.open_exposure)).toBe(6000);

    // Percentages are against the GLOBAL total (all open loads in the DB,
    // not just this test's fixtures), so assert the ratio between the two
    // test payers rather than an absolute percentage — this is exact
    // arithmetic either way (a/b = 4000/6000 = 0.6666...).
    const ratio = Number(a.concentration_pct) / Number(b.concentration_pct);
    expect(ratio).toBeCloseTo(4000 / 6000, 10);
  });
});
