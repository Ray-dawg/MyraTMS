/**
 * T-20 §5 — shadow ranking comparison. Reads what T-07's matching engine
 * already decided (match_results, which only persists the top maxResults
 * candidates per load — see lib/matching/index.ts storeMatchResults()) and
 * independently computes what the order WOULD have been with the Myra
 * Carrier Score blended in as a 6th criterion at a proposed 15% weight,
 * redistributed proportionally from the existing five (lane 30/proximity
 * 25/rate 20/reliability 15/relationship 10 -> each x0.85, +15% carrier score).
 *
 * NEVER writes to match_results or influences carrier_stack — logs both
 * orderings into the existing `events` table (T-17) under event_type
 * 'ranking.shadow_compared', reusing the platform's one structured-event
 * mechanism instead of inventing a second logging table the spec doesn't
 * define.
 *
 * A candidate whose carrier has no myra_carrier_scores row yet (not
 * reconciled, or under the 5-load threshold) is left at its original T-07
 * weighting for the blended calculation — an unscored carrier is neither
 * rewarded nor penalized by data that doesn't exist yet.
 *
 * Real schema finding (not in the spec, found while wiring this up):
 * match_results.load_id is overloaded. ranker-worker.ts (Engine 2's Agent 4)
 * calls storeMatchResults(tenantId, load.load_id, ...) where load.load_id is
 * pipeline_loads.load_id (a string like the load board's external id) — NOT
 * loads.id (the TMS table's 'LD-...' primary key), even though the column
 * has an FK declared against loads(id). For TMS-native matching (a broker
 * matching an existing loads.id row directly, outside the pipeline),
 * load_id genuinely is loads.id. So the correct link back to a
 * pipeline_loads row is match_results.load_id = pipeline_loads.load_id
 * (string equality), never a join through the `loads` table — that join
 * returns zero rows for every pipeline-sourced match. Same overloaded-column
 * pattern the trigger in migration 044 also had to account for.
 */

import { db } from '@/lib/pipeline/db-adapter';

const BLEND_WEIGHT = 0.15;

interface MatchResultRow {
  id: string;
  carrier_id: string;
  match_score: string;
  breakdown: {
    lane_familiarity: { score: number; weight: number };
    proximity: { score: number; weight: number };
    rate: { score: number; weight: number };
    reliability: { score: number; weight: number };
    relationship: { score: number; weight: number };
  };
}

export interface ShadowCandidate {
  carrierId: string;
  actualScore: number;
  blendedScore: number;
  myraCarrierScore: number | null;
}

export interface ShadowComparisonResult {
  pipelineLoadId: number;
  loadId: string | null;
  actualTopCarrierId: string | null;
  blendedTopCarrierId: string | null;
  changed: boolean;
  candidates: ShadowCandidate[];
}

function blendedScoreFor(row: MatchResultRow, myraScore: number | null): number {
  const b = row.breakdown;
  if (myraScore === null) return Number(row.match_score);

  const carrierComponent = myraScore / 100;
  const redistributed =
    b.lane_familiarity.score * b.lane_familiarity.weight * (1 - BLEND_WEIGHT) +
    b.proximity.score * b.proximity.weight * (1 - BLEND_WEIGHT) +
    b.rate.score * b.rate.weight * (1 - BLEND_WEIGHT) +
    b.reliability.score * b.reliability.weight * (1 - BLEND_WEIGHT) +
    b.relationship.score * b.relationship.weight * (1 - BLEND_WEIGHT);
  // Weights above already sum to 1.0 before the (1 - BLEND_WEIGHT) factor,
  // so the redistributed term already sums to (1 - BLEND_WEIGHT); adding the
  // carrier component at BLEND_WEIGHT brings the total back to 1.0.
  return Math.round((redistributed + carrierComponent * BLEND_WEIGHT) * 1000) / 1000;
}

export async function shadowCompareRanking(pipelineLoadId: number): Promise<ShadowComparisonResult | null> {
  const plRes = await db.query<{ load_id: string }>(
    `SELECT load_id FROM pipeline_loads WHERE id = $1 LIMIT 1`,
    [pipelineLoadId],
  );
  const loadId = plRes.rows[0]?.load_id ?? null;
  if (!loadId) return null;

  const matchesRes = await db.query<MatchResultRow>(
    `SELECT id, carrier_id, match_score, breakdown FROM match_results WHERE load_id = $1 ORDER BY match_score DESC`,
    [loadId],
  );
  if (matchesRes.rows.length === 0) return null;

  const candidates: ShadowCandidate[] = [];
  for (const row of matchesRes.rows) {
    const scoreRes = await db.query<{ score: string | null }>(
      `SELECT s.score FROM myra_carrier_scores s
         JOIN carriers c ON c.carrier_registry_id = s.carrier_registry_id
        WHERE c.id = $1
        ORDER BY s.computed_at DESC LIMIT 1`,
      [row.carrier_id],
    );
    const myraScore = scoreRes.rows[0]?.score != null ? Number(scoreRes.rows[0].score) : null;
    candidates.push({
      carrierId: row.carrier_id,
      actualScore: Number(row.match_score),
      blendedScore: blendedScoreFor(row, myraScore),
      myraCarrierScore: myraScore,
    });
  }

  const actualTop = [...candidates].sort((a, b) => b.actualScore - a.actualScore)[0];
  const blendedTop = [...candidates].sort((a, b) => b.blendedScore - a.blendedScore)[0];
  const changed = actualTop.carrierId !== blendedTop.carrierId;

  const result: ShadowComparisonResult = {
    pipelineLoadId,
    loadId,
    actualTopCarrierId: actualTop.carrierId,
    blendedTopCarrierId: blendedTop.carrierId,
    changed,
    candidates,
  };

  await logShadowComparison(result);
  return result;
}

async function logShadowComparison(result: ShadowComparisonResult): Promise<void> {
  try {
    await db.query(
      `INSERT INTO events (
         tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
         source, actor_type, payload, occurred_at, derived_from_table, derived_from_id
       )
       SELECT (SELECT id FROM tenants WHERE slug = 'myra'), 'ranking.shadow_compared', 'pipeline_load', $1, $1,
              'engine3_t20_shadow_ranking', 'agent', $2::jsonb, LOCALTIMESTAMP, 'pipeline_loads', $1
       ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING`,
      [result.pipelineLoadId, JSON.stringify({
        loadId: result.loadId,
        actualTopCarrierId: result.actualTopCarrierId,
        blendedTopCarrierId: result.blendedTopCarrierId,
        changed: result.changed,
        blendWeight: BLEND_WEIGHT,
        candidates: result.candidates,
      })],
    );
  } catch {
    // Never let logging failure surface as a shadow-ranking failure.
  }
}

export interface ShadowRankingReport {
  loadsCompared: number;
  topPickChanged: number;
  changeRate: number;
}

/**
 * Runs shadowCompareRanking() over every load that reached 'matched'.
 * pipeline_loads.stage only stores the CURRENT stage, not history (same
 * limitation T-17's backfill documented) — a load that has since progressed
 * to 'booked'/'dispatched' would be silently excluded by `WHERE stage =
 * 'matched'`. Sourcing from pipeline_loads x match_results on load_id
 * instead: any pipeline load with a match_results row unambiguously reached
 * matched, regardless of where it is now.
 */
export async function runShadowRankingSweep(): Promise<ShadowRankingReport> {
  const loadsRes = await db.query<{ id: number }>(
    `SELECT DISTINCT pl.id
       FROM pipeline_loads pl
       JOIN match_results mr ON mr.load_id = pl.load_id`,
  );

  let compared = 0;
  let changed = 0;
  for (const row of loadsRes.rows) {
    const result = await shadowCompareRanking(row.id);
    if (result) {
      compared++;
      if (result.changed) changed++;
    }
  }

  return {
    loadsCompared: compared,
    topPickChanged: changed,
    changeRate: compared > 0 ? changed / compared : 0,
  };
}
