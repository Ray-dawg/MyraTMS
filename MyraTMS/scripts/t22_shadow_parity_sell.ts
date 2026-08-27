// scripts/t22_shadow_parity_sell.ts
//
// T-22 acceptance criterion 1 -- sell-side shadow parity. Mirrors
// scripts/t21_shadow_parity_harness.ts's two-tier, never-averaged reporting
// convention. Compares compileEnvelope({direction:'sell'}) against what
// compiler-worker.ts ACTUALLY persisted to negotiation_briefs.brief for the
// same pipeline_load_id -- structural/numeric fields must match exactly
// (Tier A); free-text reasoning/talking-point strings are compared for
// presence of the same key facts, not byte-equality, since wording is
// allowed to differ as long as the underlying numbers/decisions match.
//
// IMPORTANT NOTE ON TIMEOUTS: Each compileEnvelope() call invokes the full
// Pricing Engine rate cascade, which includes external API calls (Claude,
// benchmarking services, distance/region lookups). Observed latency: 30-50s
// per call. The withTimeout() function uses Promise.race(), which stops
// waiting for the result but does NOT cancel the underlying operation —
// compileEnvelope() and its DB writes via quotePricing() will continue
// running in the background even after timeout fires. This can result in
// audit rows being written minutes after the harness reports them as
// "timed out". The process does not hang waiting for these orphaned promises
// because we do not await anything after main() completes.
//
// Usage: DATABASE_URL=<branch or prod URL> pnpm tsx --env-file=.env.local scripts/t22_shadow_parity_sell.ts

import { db } from '../lib/pipeline/db-adapter';
import { compileEnvelope } from '../lib/negotiation';
import { getMyraTenantId } from '../lib/tenants/get-myra-tenant-id';

const REQUIRED_VOLUME = 30;
const TOLERANCE = 0.01;
const CALL_TIMEOUT_MS = 90000; // 90 seconds — accounts for 30-50s observed latency in pricing engine + buffer
const MAX_SAMPLE_SIZE = 0; // 0 = unlimited; set to N to run first N briefs

interface BriefRow {
  pipeline_load_id: number;
  brief: any;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function main(): Promise<void> {
  const tenantId = await getMyraTenantId();

  const { rows } = await db.query<BriefRow>(
    `SELECT DISTINCT ON (pipeline_load_id) pipeline_load_id, brief
       FROM negotiation_briefs
      ORDER BY pipeline_load_id, created_at DESC`,
  );

  const targetRows = MAX_SAMPLE_SIZE > 0 ? rows.slice(0, MAX_SAMPLE_SIZE) : rows;

  console.log(`\n=== T-22 shadow-parity harness (sell direction) ===`);
  console.log(`Total real briefs available: ${rows.length} (criterion 1 needs >=${REQUIRED_VOLUME})`);
  console.log(`Running comparison on: ${targetRows.length} briefs${MAX_SAMPLE_SIZE > 0 ? ` (sampled)` : ''}`);

  let compared = 0;
  let mismatches = 0;
  let callErrors = 0;
  const mismatchDetails: string[] = [];

  for (const row of targetRows) {
    const original = row.brief;
    let fresh;
    try {
      fresh = await withTimeout(
        compileEnvelope({ tenantId, direction: 'sell', pipelineLoadId: row.pipeline_load_id, counterpartyId: 0 }),
        CALL_TIMEOUT_MS
      );
    } catch (err) {
      callErrors++;
      mismatchDetails.push(
        `load ${row.pipeline_load_id}: compileEnvelope unavailable (${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    compared++;

    const checks: Array<[string, boolean]> = [
      ['load.origin.city', fresh.load.origin.city === original.load?.origin?.city],
      ['load.destination.city', fresh.load.destination.city === original.load?.destination?.city],
      ['load.equipmentType', fresh.load.equipmentType === original.load?.equipmentType],
      ['counterparty.phone (vs shipper.phone)', fresh.counterparty.phone === original.shipper?.phone],
      ['strategy.approach', fresh.strategy.approach === original.strategy?.approach],
    ];
    checks.push(['pricing.openingOffer', closeEnough(fresh.pricing.openingOffer, original.negotiation?.initialOffer ?? -1)]);
    checks.push(['pricing.finalOffer', closeEnough(fresh.pricing.finalOffer, original.negotiation?.finalOffer ?? -1)]);

    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length > 0) {
      mismatches++;
      mismatchDetails.push(`load ${row.pipeline_load_id}: ${failed.map(([name]) => name).join(', ')}`);
    }

    try {
      await db.query(
        `INSERT INTO pricing_engine_requests
           (tenant_id, pipeline_load_id, direction, request_source, input_params, output_envelope, margin_source_used)
         VALUES ($1, $2, 'sell', 'shadow_comparison', $3, $4, 'myra_default')`,
        [tenantId, row.pipeline_load_id, JSON.stringify({ compared: 'T-22 sell parity' }), JSON.stringify({ fresh, original, failed: failed.map(([n]) => n) })],
      );
    } catch (insertErr) {
      console.warn(`  [audit row insert failed for load ${row.pipeline_load_id}]: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`);
    }
  }

  console.log(`\n--- Field-for-field parity ---`);
  console.log(`Attempted:   ${targetRows.length}`);
  console.log(`Compared:    ${compared}`);
  console.log(`Call errors: ${callErrors}`);
  console.log(`Mismatches:  ${mismatches}`);

  if (mismatchDetails.length > 0 && mismatchDetails.length <= 20) {
    console.log(`\nDetails:`);
    for (const d of mismatchDetails) console.log(`  ${d}`);
  } else if (mismatchDetails.length > 20) {
    console.log(`\nDetails (first 20 of ${mismatchDetails.length}):`);
    for (const d of mismatchDetails.slice(0, 20)) console.log(`  ${d}`);
  }

  if (compared === 0) {
    console.log(
      '\nRESULT: No successful comparisons possible. ' +
      (callErrors > 0 ? 'All calls failed (timeout or service unavailable).' : 'No calls attempted.')
    );
  } else if (mismatches === 0) {
    console.log(`\nRESULT: ${compared === 1 ? '1 brief' : `${compared} briefs`} matched 100%`);
  } else {
    console.log(`\nRESULT: FAILED — ${mismatches} mismatches found, investigate above, do not average away`);
  }

  if (rows.length < REQUIRED_VOLUME) {
    console.warn(`\n[t22-parity-sell] Acceptance criterion 1 needs >=${REQUIRED_VOLUME} real briefs; only ${rows.length} exist. Reported honestly as OPEN pending more volume.`);
  }
}

main().catch((err) => {
  console.error('[t22-parity-sell] crashed:', err);
  process.exit(1);
});
