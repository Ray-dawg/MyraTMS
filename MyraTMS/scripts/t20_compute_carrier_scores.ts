/**
 * T-20 §4.5 / build plan step 5 — scheduled-job entry point. Recomputes
 * myra_carrier_scores for every carrier_registry row. Safe to run repeatedly
 * (each run appends a new versioned row rather than mutating history).
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t20_compute_carrier_scores.ts
 */

import { computeAllCarrierScores } from '../lib/carriers/carrier-score';

async function main(): Promise<void> {
  const result = await computeAllCarrierScores();
  console.log('\n=== T-20 carrier score computation ===');
  console.log(`Processed:            ${result.processed}`);
  console.log(`Scored:               ${result.scored}`);
  console.log(`Insufficient data:    ${result.insufficientData} (< 5 observed loads — NULL score, correct not missing)`);
}

main().catch((err) => {
  console.error('[t20-compute-scores] crashed:', err);
  process.exit(1);
});
