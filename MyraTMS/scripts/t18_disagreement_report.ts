/**
 * T-18 disagreement report (acceptance criterion 5): for every load where
 * events shows load.escalated actually happened, checks whether the T-18
 * shadow judgment on that load's calls also said 'escalate'. Not required
 * to be 100% agreement — the spec explicitly expects disagreement early;
 * this script only has to measure and report it.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_disagreement_report.ts
 */

import { db } from '../lib/pipeline/db-adapter';

interface EscalatedLoad {
  pipeline_load_id: number;
}

async function main(): Promise<void> {
  const escalatedLoads = await db.query<EscalatedLoad>(
    `SELECT DISTINCT pipeline_load_id FROM events
      WHERE event_type = 'load.escalated' AND pipeline_load_id IS NOT NULL`,
  );

  let agree = 0;
  let disagree = 0;
  let noShadowJudgment = 0;

  for (const { pipeline_load_id } of escalatedLoads.rows) {
    const shadow = await db.query<{ decision: string }>(
      `SELECT decision FROM authority_evaluations WHERE pipeline_load_id = $1`,
      [pipeline_load_id],
    );
    if (shadow.rows.length === 0) {
      noShadowJudgment++;
      continue;
    }
    const anyEscalate = shadow.rows.some((r) => r.decision === 'escalate');
    if (anyEscalate) agree++;
    else disagree++;
  }

  const total = escalatedLoads.rows.length;
  console.log('[t18-disagreement-report] loads where Engine 2 actually escalated:', total);
  console.log(`  agree (T-18 shadow also said escalate):     ${agree}`);
  console.log(`  disagree (T-18 shadow said allow/deny):     ${disagree}`);
  console.log(`  no shadow judgment recorded for this load:  ${noShadowJudgment}`);
  console.log(
    total > 0
      ? `  agreement rate (of loads with a shadow judgment): ${
          agree + disagree > 0 ? ((agree / (agree + disagree)) * 100).toFixed(1) : 'n/a'
        }%`
      : '  no escalated loads found in this dataset',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[t18-disagreement-report] failed:', err);
    process.exit(1);
  });
