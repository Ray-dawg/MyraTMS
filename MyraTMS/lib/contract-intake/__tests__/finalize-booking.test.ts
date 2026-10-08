// lib/contract-intake/__tests__/finalize-booking.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

describe('finalizeMatchedTenders', () => {
  let pipelineLoadId: number;

  afterEach(async () => {
    if (pipelineLoadId) await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('books a matched email_tender load, computing profit from agreed_rate and market_rate_floor as cost proxy', async () => {
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type, market_rate_floor
       ) VALUES (
         $1, 'email_tender', 'Chicago', 'IL', 'US',
         'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD',
         920, 'matched', 'email_tender', 2500
       ) RETURNING id`,
      [`TEST-T30-${Date.now()}`],
    );
    pipelineLoadId = inserted.rows[0].id;

    const result = await finalizeMatchedTenders();
    expect(result.finalized).toBeGreaterThanOrEqual(1);

    const after = await db.query<{
      stage: string; booked_via: string | null; agreed_rate: string | null;
      profit: string | null; booked_at: Date | null;
    }>(`SELECT stage, booked_via, agreed_rate, profit, booked_at FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(after.rows[0].stage).toBe('booked');
    expect(after.rows[0].booked_via).toBe('email_tender');
    expect(Number(after.rows[0].agreed_rate)).toBe(3000);
    expect(after.rows[0].booked_at).not.toBeNull();
  });

  it('ignores matched loads whose source_type is not email_tender (leaves normal AI-call loads untouched)', async () => {
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type
       ) VALUES (
         $1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD', 920, 'matched', 'load_board'
       ) RETURNING id`,
      [`TEST-T30-CTRL-${Date.now()}`],
    );
    pipelineLoadId = inserted.rows[0].id;

    await finalizeMatchedTenders();
    const after = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(after.rows[0].stage).toBe('matched'); // untouched
  });
});
