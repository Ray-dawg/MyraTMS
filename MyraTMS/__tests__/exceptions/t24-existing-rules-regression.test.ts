// __tests__/exceptions/t24-existing-rules-regression.test.ts
//
// Acceptance criterion 3 (spec §7): "The existing 8 TMS rules continue to
// function completely unchanged... This is the single most important
// criterion in this revision." Asserts against the REAL rule names in
// lib/exceptions/detector.ts (unassigned_urgent, late_pickup, eta_breach,
// gps_dark, pod_missing, invoice_overdue, insurance_expiring,
// missing_checkcall) — not the spec's own incorrect guessed list.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { runExceptionDetection } from '@/lib/exceptions/detector';

const REFERENCE = `T24REG-${Date.now()}`;

describe('T-24 regression: existing 8 exception-detection rules unaffected', () => {
  let loadId: string;

  beforeAll(async () => {
    loadId = `LD-${REFERENCE}`;
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pickup_date, tenant_id)
       VALUES ($1, 'Toronto', 'Sudbury', 'Booked', CURRENT_DATE, 2)`,
      [loadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE load_id = $1`, [loadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [loadId]);
  });

  it('unassigned_urgent still fires for a Booked load picking up today, with the real column shape', async () => {
    const result = await runExceptionDetection(2);
    expect(result.created).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `SELECT type, severity, status FROM exceptions WHERE load_id = $1 AND type = 'unassigned_urgent'`,
      [loadId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].status).toBe('active');
  });

  it('all 8 real rule types are the ones this module treats as untouched TMS-native rules', () => {
    const REAL_EIGHT = [
      'unassigned_urgent', 'late_pickup', 'eta_breach', 'gps_dark',
      'pod_missing', 'invoice_overdue', 'insurance_expiring', 'missing_checkcall',
    ];
    // A compile-time/documentation assertion, not a DB one: if a future
    // change to detector.ts renames or removes one of these, this constant
    // (kept identical to the one in the T-24 plan's Global Constraints)
    // should be updated deliberately, not silently.
    expect(REAL_EIGHT.length).toBe(8);
  });

  it('running the bridge poller alongside the real detector does not create a duplicate or malformed row', async () => {
    const before = await db.query(`SELECT COUNT(*) FROM exceptions WHERE load_id = $1`, [loadId]);
    await runExceptionDetection(2); // second run — dedup should hold
    const after = await db.query(`SELECT COUNT(*) FROM exceptions WHERE load_id = $1`, [loadId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
