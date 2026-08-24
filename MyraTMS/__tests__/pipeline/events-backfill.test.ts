/**
 * T-17 backfill verification — acceptance criterion 2 (row-count sanity,
 * idempotent re-run).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { runBackfill } from '../../scripts/t17_backfill_events';

const RUN_ID = `T17-BACKFILL-${Date.now()}`;
let loadId: number;

beforeAll(async () => {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage, research_completed_at
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'matched', NOW())
     RETURNING id`,
    [RUN_ID],
  );
  loadId = r.rows[0].id;
  // The INSERT above already fired the live trigger. Delete those rows so
  // this test exercises only the backfill script's own SQL path.
  await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [loadId]);
});

afterAll(async () => {
  await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [loadId]);
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [loadId]);
});

describe('T-17 backfill', () => {
  it('reconstructs events for a pre-existing row and is safe to re-run', async () => {
    await runBackfill();
    const first = await db.query<{ event_type: string }>(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 ORDER BY event_type`,
      [loadId],
    );
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.map((r) => r.event_type)).toContain('load.scanned');
    expect(first.rows.map((r) => r.event_type)).toContain('load.researched');

    await runBackfill();
    const second = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 ORDER BY event_type`,
      [loadId],
    );
    expect(second.rows.length).toBe(first.rows.length);
  });
});
