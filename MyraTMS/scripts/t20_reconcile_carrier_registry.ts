/**
 * T-20 §4.2 — reconciles the existing tenant-scoped `carriers` table against
 * the new platform-global `carrier_registry`. Idempotent: only processes
 * carriers where carrier_registry_id IS NULL, so re-running after a partial
 * or interrupted run only picks up where it left off.
 *
 * Match order: MC number (exact) first, DOT number (exact) second, else
 * create a new carrier_registry row. Per the T-20 build plan, this script
 * assumes carriers.mc_number is populated — verified against production
 * before this was written (206/211 = 97.6%, well above the 95% target), so
 * no weaker match key (e.g. company name) is used anywhere in this script.
 *
 * DOT-based dedup is app-level (carrier_registry has no DB-level UNIQUE
 * constraint on dot_number, only an index — see migration 044) because a
 * carrier reconciled by MC on the first pass could otherwise be
 * re-registered under a second row if a later carrier shares its DOT number
 * but not its MC number. Checked with a SELECT before every DOT-path INSERT.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t20_reconcile_carrier_registry.ts
 */

import { db } from '../lib/pipeline/db-adapter';

interface CarrierRow {
  id: string;
  company: string;
  mc_number: string | null;
  dot_number: string | null;
}

interface Report {
  total: number;
  matchedExistingByMc: number;
  createdByMc: number;
  matchedExistingByDot: number;
  createdByDot: number;
  createdNoIdentity: number;
}

async function reconcileOne(carrier: CarrierRow, report: Report): Promise<void> {
  const mc = carrier.mc_number?.trim() || null;
  const dot = carrier.dot_number?.trim() || null;

  if (mc) {
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM carrier_registry WHERE mc_number = $1`,
      [mc],
    );
    if (existing.rows.length > 0) {
      await db.query(`UPDATE carriers SET carrier_registry_id = $1 WHERE id = $2`, [existing.rows[0].id, carrier.id]);
      report.matchedExistingByMc++;
      return;
    }
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO carrier_registry (mc_number, dot_number, legal_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (mc_number) DO UPDATE SET mc_number = EXCLUDED.mc_number
       RETURNING id`,
      [mc, dot, carrier.company],
    );
    await db.query(`UPDATE carriers SET carrier_registry_id = $1 WHERE id = $2`, [inserted.rows[0].id, carrier.id]);
    report.createdByMc++;
    return;
  }

  if (dot) {
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM carrier_registry WHERE dot_number = $1 LIMIT 1`,
      [dot],
    );
    if (existing.rows.length > 0) {
      await db.query(`UPDATE carriers SET carrier_registry_id = $1 WHERE id = $2`, [existing.rows[0].id, carrier.id]);
      report.matchedExistingByDot++;
      return;
    }
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO carrier_registry (dot_number, legal_name) VALUES ($1, $2) RETURNING id`,
      [dot, carrier.company],
    );
    await db.query(`UPDATE carriers SET carrier_registry_id = $1 WHERE id = $2`, [inserted.rows[0].id, carrier.id]);
    report.createdByDot++;
    return;
  }

  // No MC, no DOT — create a registry row keyed only by legal_name so the
  // carrier still has a platform-level identity, but this is flagged in the
  // report as a data-quality gap, not silently treated as equivalent to an
  // MC/DOT match.
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO carrier_registry (legal_name) VALUES ($1) RETURNING id`,
    [carrier.company],
  );
  await db.query(`UPDATE carriers SET carrier_registry_id = $1 WHERE id = $2`, [inserted.rows[0].id, carrier.id]);
  report.createdNoIdentity++;
}

async function main(): Promise<void> {
  const totalRes = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM carriers`);
  const total = totalRes.rows[0].n;
  const withMc = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM carriers WHERE mc_number IS NOT NULL AND mc_number != ''`,
  );
  const mcPopulationRate = total > 0 ? withMc.rows[0].n / total : 0;

  console.log(`[t20-reconcile] carriers.mc_number populated: ${withMc.rows[0].n}/${total} (${(mcPopulationRate * 100).toFixed(1)}%)`);
  if (mcPopulationRate < 0.95) {
    console.error(
      `[t20-reconcile] STOP: MC-number population rate ${(mcPopulationRate * 100).toFixed(1)}% is below the 95% target. ` +
      `This is a data-quality prerequisite, not a script bug — do not proceed with a weaker match key.`,
    );
    process.exit(1);
  }

  const pending = await db.query<CarrierRow>(
    `SELECT id, company, mc_number, dot_number FROM carriers WHERE carrier_registry_id IS NULL`,
  );

  const report: Report = {
    total: pending.rows.length,
    matchedExistingByMc: 0,
    createdByMc: 0,
    matchedExistingByDot: 0,
    createdByDot: 0,
    createdNoIdentity: 0,
  };

  for (const carrier of pending.rows) {
    await reconcileOne(carrier, report);
  }

  const matchedByMc = report.matchedExistingByMc + report.createdByMc;
  const matchRate = report.total > 0 ? matchedByMc / report.total : 1;

  console.log('\n=== T-20 carrier_registry reconciliation ===');
  console.log(`Processed this run:        ${report.total}`);
  console.log(`Matched by MC (existing):  ${report.matchedExistingByMc}`);
  console.log(`Created by MC (new):       ${report.createdByMc}`);
  console.log(`Matched by DOT (existing): ${report.matchedExistingByDot}`);
  console.log(`Created by DOT (new):      ${report.createdByDot}`);
  console.log(`Created, no identity:      ${report.createdNoIdentity}`);
  console.log(`MC match rate this run:    ${(matchRate * 100).toFixed(1)}% (target >=95%)`);
  if (matchRate < 0.95 && report.total > 0) {
    console.warn('[t20-reconcile] Below-target MC match rate — reported as a data-quality finding, not treated as a script failure.');
  }

  const totalReconciled = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM carriers WHERE carrier_registry_id IS NOT NULL`,
  );
  const totalRegistryRows = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM carrier_registry`);
  console.log(`\nTotal carriers reconciled:  ${totalReconciled.rows[0].n}/${total}`);
  console.log(`Total carrier_registry rows: ${totalRegistryRows.rows[0].n}`);
}

main().catch((err) => {
  console.error('[t20-reconcile] crashed:', err);
  process.exit(1);
});
