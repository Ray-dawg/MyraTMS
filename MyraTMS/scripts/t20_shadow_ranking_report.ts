/**
 * T-20 §5 / build plan step 6 — runs the shadow ranking sweep against every
 * load that reached 'matched' and prints the top-pick change-rate report.
 * Acceptance criterion 5 requires >=50 real matched loads; this script
 * reports the actual count honestly rather than padding it, same discipline
 * as T-18's replay harness on shadow-drain volume (Engine 3/wave1.md §1).
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t20_shadow_ranking_report.ts
 */

import { runShadowRankingSweep } from '../lib/carriers/shadow-ranking';

const REQUIRED_VOLUME = 50;

async function main(): Promise<void> {
  const report = await runShadowRankingSweep();

  console.log('\n=== T-20 shadow ranking comparison report ===');
  console.log(`Loads compared:        ${report.loadsCompared}`);
  console.log(`Top pick changed:      ${report.topPickChanged}`);
  console.log(`Change rate:           ${(report.changeRate * 100).toFixed(1)}%`);

  if (report.loadsCompared < REQUIRED_VOLUME) {
    console.warn(
      `\n[t20-shadow-ranking] Acceptance criterion 5 needs >=${REQUIRED_VOLUME} matched loads; ` +
      `only ${report.loadsCompared} exist. Reported honestly as OPEN, not padded to pass — ` +
      `re-run once more real/shadow-drain volume exists.`,
    );
  } else {
    console.log(`\n[t20-shadow-ranking] Acceptance criterion 5 volume threshold met (${report.loadsCompared} >= ${REQUIRED_VOLUME}).`);
  }
}

main().catch((err) => {
  console.error('[t20-shadow-ranking] crashed:', err);
  process.exit(1);
});
