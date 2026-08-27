/**
 * T-21 §5 build plan step 2 — T-06's rate cascade (researcher-worker.ts's
 * private runRateCascade()/lookupHistoricalRate()/tryClaudeEstimate()
 * methods), relocated verbatim into a standalone, callable function. Logic
 * unchanged; only the class-method -> exported-function shape changes, per
 * the "git mv + wrapper, not a rewrite" instruction (T-21 §10 step 2).
 *
 * This is a parallel copy, not yet a shared call site — researcher-worker.ts
 * is explicitly off-limits this session (T-21 §10, "do not let Claude Code
 * touch researcher-worker.ts"). T-21b is what cuts researcher-worker.ts over
 * to call this instead of its own private methods; until then both copies
 * exist and must be kept in sync by hand. Documented, not hidden.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getBenchmarkRate, getCurrentSeason, type EquipmentType as BenchmarkEquipmentType } from '@/lib/pipeline/benchmark-rates';
import { ClaudeService } from '@/lib/pipeline/claude-service';

export interface RateCascadeLoad {
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  equipmentType: string;
  postedRate: number | null;
}

export interface RateCascadeResult {
  floorRate: number;
  midRate: number;
  bestRate: number;
  confidence: number;
  sources: string[];
  currency: 'CAD' | 'USD';
}

function normalizeEquipment(raw: string): BenchmarkEquipmentType {
  const lower = raw.toLowerCase();
  if (lower.includes('flat')) return 'flatbed';
  if (lower.includes('reefer') || lower.includes('refrigerated')) return 'reefer';
  if (lower.includes('step') || lower.includes('stepdeck')) return 'step_deck';
  return 'dry_van';
}

async function lookupHistoricalRate(
  load: RateCascadeLoad,
): Promise<{ mid: number; range: number; confidence: number } | null> {
  try {
    const result = await db.query<{ avg_rate: string | null; n: string }>(
      `SELECT AVG(revenue)::numeric AS avg_rate, COUNT(*)::int AS n
       FROM loads
       WHERE origin ILIKE $1
         AND destination ILIKE $2
         AND equipment ILIKE $3
         AND status IN ('Delivered', 'Invoiced', 'Closed')
         AND created_at > NOW() - INTERVAL '90 days'
         AND revenue IS NOT NULL AND revenue > 0`,
      [`%, ${load.origin.state}`, `%, ${load.destination.state}`, `%${load.equipmentType}%`],
    );

    const row = result.rows[0];
    const n = Number(row?.n ?? 0);
    const avg = row?.avg_rate ? Number(row.avg_rate) : 0;
    if (n < 2 || avg <= 0) return null;

    const confidence = Math.min(0.5 + n * 0.05, 0.9);
    return { mid: Math.round(avg), range: 0.12, confidence };
  } catch (err) {
    logger.warn('[pricing/rate-cascade] Historical lookup failed; skipping source 1', err);
    return null;
  }
}

let claudeService: ClaudeService | null | undefined;
function getClaudeService(): ClaudeService | null {
  if (claudeService !== undefined) return claudeService;
  if (!process.env.ANTHROPIC_API_KEY) {
    claudeService = null;
    return claudeService;
  }
  try {
    claudeService = new ClaudeService();
  } catch (err) {
    logger.warn('[pricing/rate-cascade] Claude service init failed; cascade will skip Source 5', err);
    claudeService = null;
  }
  return claudeService;
}

async function tryClaudeEstimate(
  load: RateCascadeLoad,
  distanceMiles: number,
): Promise<{ mid: number; range: number; confidence: number } | null> {
  const svc = getClaudeService();
  if (!svc) return null;

  const jobId = `pricing-${Date.now()}`;
  svc.initializeBudget(jobId, 10000, 5000);

  const result = await svc.research(
    {
      loadId: 'pricing-engine',
      originCity: load.origin.city,
      originState: load.origin.state,
      destinationCity: load.destination.city,
      destinationState: load.destination.state,
      distanceMiles,
      equipmentType: load.equipmentType,
      pickupDate: new Date().toISOString(),
      originCountry: load.origin.country,
    } as any,
    jobId,
  );

  const intel = result.data;
  return {
    mid: intel.rates.midRate,
    range: intel.rates.bestRate > 0
      ? (intel.rates.bestRate - intel.rates.floorRate) / (2 * intel.rates.midRate)
      : 0.15,
    confidence: intel.rates.confidence,
  };
}

export async function runRateCascade(
  load: RateCascadeLoad,
  distance: { miles: number; km: number },
): Promise<RateCascadeResult> {
  const sources: string[] = [];
  const currency: 'CAD' | 'USD' = load.origin.country === 'CA' ? 'CAD' : 'USD';

  let bestEstimate: { mid: number; range: number; confidence: number; source: string } | null = null;

  const historical = await lookupHistoricalRate(load);
  if (historical) {
    sources.push('historical');
    bestEstimate = { ...historical, source: 'historical' };
  }

  if (getClaudeService()) {
    const claude = await tryClaudeEstimate(load, distance.miles).catch((err) => {
      logger.warn('[pricing/rate-cascade] Claude estimate failed; continuing cascade', err);
      return null;
    });
    if (claude) {
      sources.push('claude_estimate');
      if (!bestEstimate || claude.confidence > bestEstimate.confidence) {
        bestEstimate = { ...claude, source: 'claude_estimate' };
      }
    }
  }

  if (!bestEstimate) {
    const benchmark = getBenchmarkRate(normalizeEquipment(load.equipmentType), distance.km, getCurrentSeason());
    const mid = Math.round(benchmark.ratePerMile * distance.miles);
    sources.push('benchmark');
    bestEstimate = { mid, range: 0.15, confidence: 0.45, source: 'benchmark' };
  }

  if (load.postedRate && load.postedRate > 0) {
    sources.push('posted');
    if (load.postedRate > bestEstimate.mid * 1.1) {
      const blendedMid = Math.round(load.postedRate * 0.75 + bestEstimate.mid * 0.25);
      bestEstimate = {
        mid: blendedMid,
        range: 0.12,
        confidence: Math.min(bestEstimate.confidence + 0.2, 0.85),
        source: bestEstimate.source,
      };
    }
  }

  const mid = Math.round(bestEstimate.mid);
  const floor = Math.round(mid * (1 - bestEstimate.range));
  const best = Math.round(mid * (1 + bestEstimate.range));

  return { floorRate: floor, midRate: mid, bestRate: best, confidence: bestEstimate.confidence, sources, currency };
}
