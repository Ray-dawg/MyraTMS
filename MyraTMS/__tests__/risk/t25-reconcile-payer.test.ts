// __tests__/risk/t25-reconcile-payer.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { reconcilePayerRegistry } from '../../scripts/t25_reconcile_payer_registry';

const REF = `T25PAYER-${Date.now()}`;

describe('reconcilePayerRegistry', () => {
  let pl1: number;
  let pl2: number;

  beforeAll(async () => {
    const a = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
         stage, shipper_company)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2) RETURNING id`,
      [`${REF}-A`, `  Acme Co  `],
    );
    pl1 = a.rows[0].id;
    const b = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type,
         stage, shipper_company)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'booked', $2) RETURNING id`,
      [`${REF}-B`, 'ACME CO'],
    );
    pl2 = b.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id IN ($1, $2)`, [pl1, pl2]);
    await db.query(`DELETE FROM payer_registry WHERE legal_name = 'Acme Co'`);
  });

  it(
    'creates one payer_registry row and links both loads to it (case/whitespace-insensitive match)',
    async () => {
      const result = await reconcilePayerRegistry();
      expect(result.total).toBeGreaterThanOrEqual(2);

      const rows = await db.query<{ payer_registry_id: number }>(
        `SELECT payer_registry_id FROM pipeline_loads WHERE id IN ($1, $2)`,
        [pl1, pl2],
      );
      expect(rows.rows[0].payer_registry_id).not.toBeNull();
      expect(rows.rows[0].payer_registry_id).toBe(rows.rows[1].payer_registry_id);

      const payerCount = await db.query(`SELECT COUNT(*) FROM payer_registry WHERE legal_name = 'Acme Co'`);
      expect(payerCount.rows[0].count).toBe('1');
    },
    30000,
  );
});
