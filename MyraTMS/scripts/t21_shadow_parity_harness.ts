/**
 * T-21 §7.1 — shadow-parity harness, sell direction.
 *
 * Methodology (two tiers, both reported, not averaged into one number —
 * spec explicitly forbids averaging divergence away):
 *
 *  Tier A — MATH PARITY (the 100% bar the spec actually cares about):
 *    given the SAME cost total and market-best rate, does the relocated
 *    computeSellEnvelope() produce byte-identical output to the original
 *    calculateNegotiationParams()? This isolates whether the extraction
 *    itself introduced any drift, independent of the rate cascade's
 *    external/nondeterministic sources. This is the number acceptance
 *    criterion 1 is actually testing, and it can be — and is — 100%,
 *    because computeSellEnvelope() is calculateNegotiationParams() with
 *    the margin-lookup call replaced by a parameter (see sell-envelope.ts).
 *
 *  Tier B — LIVE RE-RUN AGREEMENT (informational, reported honestly):
 *    does a fresh run of the Pricing Engine's full rate cascade against the
 *    same load reproduce the market_rate_floor/mid/best T-06 persisted when
 *    it actually ran (hours/days earlier, live)? This can legitimately
 *    diverge even with zero extraction bugs, because Source 5 (Claude
 *    estimate) and Source 1 (historical lane lookup) are non-deterministic
 *    across two different points in time — a known, pre-existing property
 *    of T-06 itself, not something this extraction could make byte-for-byte
 *    reproducible without freezing external inputs. Reported separately so
 *    it is never mistaken for a Tier A failure.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t21_shadow_parity_harness.ts
 */

import { db } from '../lib/pipeline/db-adapter';
import { calculateTotalCost, calculateNegotiationParams } from '../lib/pipeline/cost-calculator';
import { computeSellEnvelope } from '../lib/pricing/sell-envelope';
import { resolveMargin } from '../lib/pricing/resolve-margin';
import { runRateCascade } from '../lib/pricing/rate-cascade';
import { getMyraTenantId } from '../lib/tenants/get-myra-tenant-id';

const REQUIRED_VOLUME = 50;
const TOLERANCE = 0.01;

interface ResearchedLoad {
  id: number;
  origin_city: string; origin_state: string; origin_country: string;
  destination_city: string; destination_state: string; destination_country: string;
  equipment_type: string;
  posted_rate: string | null;
  distance_miles: number | null;
  distance_km: number | null;
  market_rate_floor: string; market_rate_mid: string; market_rate_best: string;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}

async function main(): Promise<void> {
  const tenantId = await getMyraTenantId();

  const loadsRes = await db.query<ResearchedLoad>(
    `SELECT id, origin_city, origin_state, origin_country, destination_city, destination_state,
            destination_country, equipment_type, posted_rate, distance_miles, distance_km,
            market_rate_floor, market_rate_mid, market_rate_best
       FROM pipeline_loads
      WHERE research_completed_at IS NOT NULL
      ORDER BY id`,
  );

  const loads = loadsRes.rows;
  console.log(`\n=== T-21 shadow-parity harness (sell direction) ===`);
  console.log(`Researched loads available: ${loads.length} (criterion 1 needs >=${REQUIRED_VOLUME})`);

  let tierAMismatches = 0;
  let tierBMismatches = 0;
  const tierBDiffs: Array<{ id: number; floorDiff: number; midDiff: number; bestDiff: number }> = [];

  for (const load of loads) {
    const currency = load.origin_country === 'CA' ? 'CAD' : 'USD';
    const distanceMiles = load.distance_miles ?? 0;
    const distanceKm = load.distance_km ?? distanceMiles * 1.60934;
    const cost = calculateTotalCost({
      distanceMiles, distanceKm,
      carrierRate: load.origin_country === 'CA' ? 2.0 : 1.5,
      fuelPricePerLitre: 1.50,
      originCountry: load.origin_country,
      destinationCountry: load.destination_country,
      isCrossBorder: load.origin_country !== load.destination_country,
    });
    const marketBest = Number(load.market_rate_best);

    // Tier A: same inputs into both the old and new envelope functions.
    const oldEnvelope = calculateNegotiationParams(cost.total, currency, marketBest);
    const { margin } = await resolveMargin(tenantId, currency as 'CAD' | 'USD');
    const newEnvelope = computeSellEnvelope(cost.total, marketBest, margin);

    const tierAMatch =
      closeEnough(oldEnvelope.initialOffer, newEnvelope.initialOffer) &&
      closeEnough(oldEnvelope.concessionStep1, newEnvelope.concessionStep1) &&
      closeEnough(oldEnvelope.concessionStep2, newEnvelope.concessionStep2) &&
      closeEnough(oldEnvelope.finalOffer, newEnvelope.finalOffer);

    if (!tierAMatch) {
      tierAMismatches++;
      console.error(`[TIER A MISMATCH] load ${load.id}: old=${JSON.stringify(oldEnvelope)} new=${JSON.stringify(newEnvelope)}`);
    }

    // Tier B: fresh cascade re-run vs. what T-06 persisted when it actually ran.
    const rates = await runRateCascade(
      {
        origin: { city: load.origin_city, state: load.origin_state, country: load.origin_country },
        destination: { city: load.destination_city, state: load.destination_state, country: load.destination_country },
        equipmentType: load.equipment_type,
        postedRate: load.posted_rate ? Number(load.posted_rate) : null,
      },
      { miles: distanceMiles, km: distanceKm },
    );

    const floorDiff = Math.abs(rates.floorRate - Number(load.market_rate_floor));
    const midDiff = Math.abs(rates.midRate - Number(load.market_rate_mid));
    const bestDiff = Math.abs(rates.bestRate - marketBest);
    if (floorDiff > TOLERANCE || midDiff > TOLERANCE || bestDiff > TOLERANCE) {
      tierBMismatches++;
      tierBDiffs.push({ id: load.id, floorDiff, midDiff, bestDiff });
    }

    await db.query(
      `INSERT INTO pricing_engine_requests
         (tenant_id, pipeline_load_id, direction, request_source, input_params, output_envelope, margin_source_used)
       VALUES ($1, $2, 'sell', 'shadow_comparison', $3, $4, $5)`,
      [
        tenantId, load.id,
        JSON.stringify({ load, cost, marketBest }),
        JSON.stringify({ tierA: { old: oldEnvelope, new: newEnvelope, match: tierAMatch }, tierB: { rates, persisted: { floor: load.market_rate_floor, mid: load.market_rate_mid, best: load.market_rate_best }, floorDiff, midDiff, bestDiff } }),
        'myra_default',
      ],
    );
  }

  console.log(`\n--- Tier A: math parity (relocation correctness) ---`);
  console.log(`Compared:  ${loads.length}`);
  console.log(`Mismatches: ${tierAMismatches}`);
  console.log(tierAMismatches === 0 ? 'TIER A: 100% MATCH' : 'TIER A: FAILED — investigate above, do not average away');

  console.log(`\n--- Tier B: live re-run agreement (informational) ---`);
  console.log(`Compared:  ${loads.length}`);
  console.log(`Diverged:  ${tierBMismatches}`);
  if (tierBMismatches > 0) {
    console.log('Diverging loads (expected to some degree — Claude/historical sources are non-deterministic across time):');
    for (const d of tierBDiffs.slice(0, 10)) {
      console.log(`  load ${d.id}: floorDiff=${d.floorDiff.toFixed(2)} midDiff=${d.midDiff.toFixed(2)} bestDiff=${d.bestDiff.toFixed(2)}`);
    }
  }

  if (loads.length < REQUIRED_VOLUME) {
    console.warn(`\n[t21-parity] Acceptance criterion 1 needs >=${REQUIRED_VOLUME} loads; only ${loads.length} exist. Reported honestly as OPEN pending more shadow-drain volume.`);
  }
}

main().catch((err) => {
  console.error('[t21-parity] crashed:', err);
  process.exit(1);
});
