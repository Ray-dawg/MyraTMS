/**
 * E2-01 M1 — Shipper-direct gate calibration report (Task 9).
 *
 * Run BEFORE flipping SHIPPER_DIRECT_GATE_MODE=enforce (PRD §4.12 step 4):
 *
 *   pnpm tsx --env-file=.env.local scripts/e2_source_calibration_report.ts
 *
 * Prints the report as JSON. Exit codes:
 *   0 — no human-labelled broker was ever accepted as shipper_direct/co_brokered
 *   1 — labelledBrokersAccepted is non-empty: DO NOT flip the flag; fix the
 *       registry / classifier first
 *   2 — query failure
 *
 * `unresolvedTopPosters` is the labelling worklist for the operator (top 50).
 */
import { db } from '@/lib/pipeline/db-adapter';

export interface CalibrationReport {
  totalRows: number;
  byClass: Record<string, number>;
  byMethod: Record<string, number>;
  /** rows with method='registry' / rows carrying any poster identity (name or MC) */
  registryHitRate: number;
  /** MUST be empty before enforce (PRD §4.12 step 4) */
  labelledBrokersAccepted: Array<{ pipelineLoadId: number; poster: string; class: string }>;
  /** top 50 unresolved posters by volume — Patrice's labelling queue */
  unresolvedTopPosters: Array<{ poster: string; count: number }>;
}

export async function buildCalibrationReport(): Promise<CalibrationReport> {
  const total = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pipeline_loads`)).rows[0].n;

  const byClass = Object.fromEntries(
    (
      await db.query<{ k: string; n: number }>(
        `SELECT COALESCE(load_source_class, 'NULL') AS k, COUNT(*)::int AS n FROM pipeline_loads GROUP BY 1`,
      )
    ).rows.map((r) => [r.k, r.n]),
  );

  const byMethod = Object.fromEntries(
    (
      await db.query<{ k: string; n: number }>(
        `SELECT COALESCE(load_source_method, 'NULL') AS k, COUNT(*)::int AS n FROM pipeline_loads GROUP BY 1`,
      )
    ).rows.map((r) => [r.k, r.n]),
  );

  const ident = (
    await db.query<{ withId: number; registry: number }>(
      `SELECT COUNT(*) FILTER (WHERE poster_company_normalized IS NOT NULL OR poster_mc_number IS NOT NULL)::int AS "withId",
              COUNT(*) FILTER (WHERE load_source_method = 'registry')::int AS registry
         FROM pipeline_loads`,
    )
  ).rows[0];

  const labelledBrokersAccepted = (
    await db.query<{ pipelineLoadId: number; poster: string; class: string }>(
      `SELECT pl.id AS "pipelineLoadId", pl.poster_company_raw AS poster, pl.load_source_class AS class
         FROM pipeline_loads pl
         JOIN poster_registry pr
           ON (pr.mc_number IS NOT NULL AND pr.mc_number = pl.poster_mc_number)
           OR (pr.mc_number IS NULL AND pr.normalized_name = pl.poster_company_normalized)
        WHERE pr.entity_class = 'broker'
          AND pr.class_source = 'human_review'
          AND pl.load_source_class IN ('shipper_direct', 'co_brokered')
          AND NOT EXISTS (
            SELECT 1 FROM co_broker_agreements a
             WHERE a.status = 'active'
               AND (a.counterparty_mc_number = pl.poster_mc_number
                    OR a.counterparty_name_normalized = pl.poster_company_normalized))
        ORDER BY pl.id`,
    )
  ).rows;

  const unresolvedTopPosters = (
    await db.query<{ poster: string; count: number }>(
      `SELECT poster_company_raw AS poster, COUNT(*)::int AS count
         FROM pipeline_loads
        WHERE load_source_class = 'unresolved' AND poster_company_raw IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 50`,
    )
  ).rows;

  return {
    totalRows: total,
    byClass,
    byMethod,
    registryHitRate: ident.withId ? ident.registry / ident.withId : 0,
    labelledBrokersAccepted,
    unresolvedTopPosters,
  };
}

if (require.main === module) {
  buildCalibrationReport()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.labelledBrokersAccepted.length > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error('Calibration report failed:', e);
      process.exit(2);
    });
}
