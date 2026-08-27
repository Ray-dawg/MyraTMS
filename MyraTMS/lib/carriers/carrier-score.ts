/**
 * T-20 §4.5 — the Myra Carrier Score. Same pure-core / DB-wrapper split as
 * T-18's applyEnvelope()/evaluateAuthority() and T-19's
 * applyPolicy()/evaluatePolicy() (see Engine 3/wave1.md §1) —
 * computeScoreFromStats() is pure and unit-testable with no DB; computeCarrierScore()
 * loads stats from carrier_outcome_events/carrier_risk_signals, calls the
 * pure function, and persists a versioned row.
 *
 * Stat definitions (the spec's formula assumes these but doesn't define the
 * SQL — documented here, not guessed silently):
 *   - total_loads_observed = count of 'completed_on_time' + 'completed_late'
 *     events (loads Myra actually saw run to completion with this carrier)
 *   - on_time_pct          = completed_on_time / (completed_on_time + completed_late)
 *   - acceptance_rate      = accepted / offered
 *   - cancellation_rate    = cancelled_by_carrier / accepted (cancellations
 *     as a fraction of loads the carrier actually took on)
 *   - claims_count         = count of 'claim_filed' events
 *   - open_risk_signals    = count of carrier_risk_signals where reviewed = false
 */

import { db } from '@/lib/pipeline/db-adapter';

export const FORMULA_VERSION = 'v1';

export interface CarrierScoreStats {
  totalLoadsObserved: number;
  onTimePct: number | null;
  acceptanceRate: number | null;
  cancellationRate: number;
  claimsCount: number;
  openRiskSignals: number;
}

export interface CarrierScoreResult {
  score: number | null; // NULL if totalLoadsObserved < 5
  formulaVersion: string;
  stats: CarrierScoreStats;
}

const MIN_OBSERVED_LOADS = 5;

/** Pure. No I/O. Same formula as T20_Carrier_Intelligence.md §4.5. */
export function computeScoreFromStats(stats: CarrierScoreStats): CarrierScoreResult {
  if (stats.totalLoadsObserved < MIN_OBSERVED_LOADS) {
    return { score: null, formulaVersion: FORMULA_VERSION, stats };
  }

  const onTimePct = stats.onTimePct ?? 1; // no completions with a known bad outcome yet — don't penalize what hasn't been observed
  const acceptanceRate = stats.acceptanceRate ?? 1;

  let score = 100;
  score -= stats.cancellationRate * 40;
  score -= (1 - onTimePct) * 25;
  score -= (1 - acceptanceRate) * 15;
  score -= Math.min(stats.claimsCount * 10, 30);
  score -= Math.min(stats.openRiskSignals * 15, 40);

  score = Math.max(0, Math.min(100, score));

  return { score: Math.round(score * 100) / 100, formulaVersion: FORMULA_VERSION, stats };
}

async function loadStats(carrierRegistryId: number): Promise<CarrierScoreStats> {
  const eventsRes = await db.query<{ event_type: string; n: string }>(
    `SELECT event_type, COUNT(*)::text AS n
       FROM carrier_outcome_events
      WHERE carrier_registry_id = $1
      GROUP BY event_type`,
    [carrierRegistryId],
  );
  const counts: Record<string, number> = {};
  for (const row of eventsRes.rows) counts[row.event_type] = Number(row.n);

  const offered = counts['offered'] ?? 0;
  const accepted = counts['accepted'] ?? 0;
  const cancelled = counts['cancelled_by_carrier'] ?? 0;
  const onTime = counts['completed_on_time'] ?? 0;
  const late = counts['completed_late'] ?? 0;
  const claims = counts['claim_filed'] ?? 0;

  const totalCompleted = onTime + late;

  const riskRes = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM carrier_risk_signals WHERE carrier_registry_id = $1 AND reviewed = false`,
    [carrierRegistryId],
  );

  return {
    totalLoadsObserved: totalCompleted,
    onTimePct: totalCompleted > 0 ? onTime / totalCompleted : null,
    acceptanceRate: offered > 0 ? accepted / offered : null,
    cancellationRate: accepted > 0 ? cancelled / accepted : 0,
    claimsCount: claims,
    openRiskSignals: Number(riskRes.rows[0]?.n ?? 0),
  };
}

/** DB wrapper: loads stats, computes, persists a versioned row. */
export async function computeCarrierScore(carrierRegistryId: number): Promise<CarrierScoreResult> {
  const stats = await loadStats(carrierRegistryId);
  const result = computeScoreFromStats(stats);

  await db.query(
    `INSERT INTO myra_carrier_scores
       (carrier_registry_id, score, formula_version, on_time_pct, acceptance_rate,
        cancellation_rate, claims_count, open_risk_signals, total_loads_observed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      carrierRegistryId,
      result.score,
      result.formulaVersion,
      stats.onTimePct != null ? stats.onTimePct * 100 : null,
      stats.acceptanceRate != null ? stats.acceptanceRate * 100 : null,
      stats.cancellationRate * 100,
      stats.claimsCount,
      stats.openRiskSignals,
      stats.totalLoadsObserved,
    ],
  );

  return result;
}

/** Scheduled-job entry point: recompute for every registry-linked carrier. */
export async function computeAllCarrierScores(): Promise<{ processed: number; scored: number; insufficientData: number }> {
  const rows = await db.query<{ id: number }>(`SELECT id FROM carrier_registry ORDER BY id`);
  let scored = 0;
  let insufficientData = 0;
  for (const row of rows.rows) {
    const result = await computeCarrierScore(row.id);
    if (result.score === null) insufficientData++;
    else scored++;
  }
  return { processed: rows.rows.length, scored, insufficientData };
}
