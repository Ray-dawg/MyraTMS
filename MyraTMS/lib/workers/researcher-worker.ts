/**
 * AGENT 3 - RESEARCHER WORKER
 *
 * Performs deep analysis on qualified loads. Runs the rate cascade (6 sources),
 * computes cost model, calculates margin envelope, profiles shipper, and recommends
 * negotiation strategy. This is the first agent that may use Claude API.
 *
 * Runs in PARALLEL with Agent 4 (Carrier Ranker). Both triggered simultaneously
 * when a load enters 'qualified' stage. Converges at completion gate before
 * Agent 5 compiles the brief.
 *
 * Input:  research-queue with ResearchJobPayload
 * Output: pipeline_loads.market_rate_floor/mid/best, recommended_strategy,
 *         research_completed_at populated. Optionally enqueues to brief-queue
 *         when both parallel agents complete.
 */

import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import {
  calculateTotalCost,
  calculateNegotiationParams,
  type CostBreakdown,
} from '@/lib/pipeline/cost-calculator';
import {
  getBenchmarkRate,
  getCurrentSeason,
  type EquipmentType as BenchmarkEquipmentType,
} from '@/lib/pipeline/benchmark-rates';
import { onResearcherComplete, buildBriefPayload } from '@/lib/pipeline/gate';
import { ClaudeService } from '@/lib/pipeline/claude-service';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface ResearchJobPayload extends BaseJobPayload {
  qualifiedLoad: {
    origin: { city: string; state: string; country: string };
    destination: { city: string; state: string; country: string };
    equipmentType: string;
    distanceMiles: number;
    distanceKm: number;
    postedRate: number | null;
    postedRateCurrency: string;
    pickupDate: string;
    deliveryDate: string | null;
    commodity: string | null;
    weightLbs: number | null;
  };
  priorityScore: number;
  estimatedMarginRange: { low: number; high: number };
}

interface RateCascadeResult {
  floorRate: number;
  midRate: number;
  bestRate: number;
  confidence: number;
  sources: string[];
  currency: 'CAD' | 'USD';
}

interface ShipperProfile {
  preferredLanguage: 'en' | 'fr';
  preferredCurrency: 'CAD' | 'USD';
  previousCallCount: number;
  previousOutcomes: string[];
  bestPerformingPersona: string | null;
  lastBookedRate: number | null;
  lastBookedDate: string | null;
  fatigueScore: number;
  isRepeatShipper: boolean;
  knownObjections: string[];
  notes: string | null;
  companyName: string | null;
  contactName: string | null;
}

interface ResearchIntelligence {
  rates: RateCascadeResult;
  cost: CostBreakdown;
  negotiation: ReturnType<typeof calculateNegotiationParams>;
  shipperProfile: ShipperProfile;
  strategy: { approach: 'aggressive' | 'standard' | 'walk'; reasoning: string };
  distance: { miles: number; km: number };
}

const CURRENT_FUEL_PRICE_CAD = 1.50;

function normalizeEquipment(raw: string): BenchmarkEquipmentType {
  const lower = raw.toLowerCase();
  if (lower.includes('flat')) return 'flatbed';
  if (lower.includes('reefer') || lower.includes('refrigerated')) return 'reefer';
  if (lower.includes('step') || lower.includes('stepdeck')) return 'step_deck';
  return 'dry_van';
}

export class ResearcherWorker extends BaseWorker<ResearchJobPayload> {
  private claudeService: ClaudeService | null = null;
  private briefQueue: Queue;

  constructor(redis: Redis, briefQueue: Queue) {
    const config: WorkerConfig = {
      queueName: 'research-queue',
      expectedStage: 'qualified',
      nextStage: 'matched',
      concurrency: 20,
      retryConfig: { attempts: 3, backoff: { type: 'exponential', delay: 60000 } },
      redis,
    };
    super(config);
    this.briefQueue = briefQueue;

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        this.claudeService = new ClaudeService();
        logger.debug('[Researcher] Claude service available — Source 5 enabled');
      } catch (err) {
        logger.warn('[Researcher] Claude service init failed; cascade will skip Source 5', err);
      }
    } else {
      logger.debug('[Researcher] ANTHROPIC_API_KEY missing — cascade will skip Source 5');
    }
  }

  public async process(payload: ResearchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, qualifiedLoad } = payload;
    logger.debug(`[Researcher] Processing load ${pipelineLoadId}`);

    const distance = {
      miles: qualifiedLoad.distanceMiles,
      km: qualifiedLoad.distanceKm || qualifiedLoad.distanceMiles * 1.60934,
    };

    const rates = await this.runRateCascade(qualifiedLoad, distance);

    const isCrossBorder = qualifiedLoad.origin.country !== qualifiedLoad.destination.country;
    const cost = calculateTotalCost({
      distanceMiles: distance.miles,
      distanceKm: distance.km,
      carrierRate: qualifiedLoad.origin.country === 'CA' ? 2.0 : 1.5,
      fuelPricePerLitre: CURRENT_FUEL_PRICE_CAD,
      originCountry: qualifiedLoad.origin.country,
      destinationCountry: qualifiedLoad.destination.country,
      isCrossBorder,
    });

    const negotiation = calculateNegotiationParams(cost.total, rates.currency, rates.bestRate);

    const shipperProfile = await this.profileShipper(payload, qualifiedLoad);

    const strategy = this.determineStrategy(rates, cost, negotiation, shipperProfile);

    const intelligence: ResearchIntelligence = {
      rates,
      cost,
      negotiation,
      shipperProfile,
      strategy,
      distance,
    };

    logger.info(
      `[Researcher] Load ${pipelineLoadId} researched. Market $${rates.floorRate}-$${rates.bestRate} (${rates.sources.join(',')}, conf ${rates.confidence.toFixed(2)}). Cost $${cost.total}. Strategy: ${strategy.approach}.`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        rates,
        cost: cost.total,
        strategy: strategy.approach,
        intelligence,
      },
    };
  }

  /**
   * Rate cascade — 6 sources in priority order, plus the posted rate as an
   * anchor. The posted_rate from a load board is "what this shipper is willing
   * to pay" and dominates static benchmarks when present, since the benchmark
   * table reflects carrier-side per-mile costs and tends to undershoot
   * shipper-paying rates on short-haul lanes.
   *
   *   Source 1: Historical loads on this lane         — `loads` table
   *   Source 2: DAT RateView API                       — TODO
   *   Source 3: Truckstop API                          — TODO
   *   Source 4: Manual rate cache                      — TODO
   *   Source 5: Claude AI estimate                     — optional
   *   Source 6: Benchmark fallback                     — always available
   *   Anchor:   Posted rate                            — used when present
   */
  private async runRateCascade(
    load: ResearchJobPayload['qualifiedLoad'],
    distance: { miles: number; km: number },
  ): Promise<RateCascadeResult> {
    const sources: string[] = [];
    const currency: 'CAD' | 'USD' = load.origin.country === 'CA' ? 'CAD' : 'USD';

    let bestEstimate: { mid: number; range: number; confidence: number; source: string } | null = null;

    const historical = await this.lookupHistoricalRate(load);
    if (historical) {
      sources.push('historical');
      bestEstimate = { ...historical, source: 'historical' };
    }

    if (this.claudeService) {
      const claude = await this.tryClaudeEstimate(load, distance.miles).catch((err) => {
        logger.warn('[Researcher] Claude estimate failed; continuing cascade', err);
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
      const benchmark = getBenchmarkRate(
        normalizeEquipment(load.equipmentType),
        distance.km,
        getCurrentSeason(),
      );
      const mid = Math.round(benchmark.ratePerMile * distance.miles);
      sources.push('benchmark');
      bestEstimate = { mid, range: 0.15, confidence: 0.45, source: 'benchmark' };
    }

    // Anchor: posted_rate is a real shipper-paying signal when available, and
    // the benchmark table tends to undershoot on short-haul. If posted is
    // notably higher than the cascade mid, blend toward it (75/25 weighting
    // pulls confidence up too).
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

    return {
      floorRate: floor,
      midRate: mid,
      bestRate: best,
      confidence: bestEstimate.confidence,
      sources,
      currency,
    };
  }

  /**
   * Source 1: Look up historical rates for similar loads on this lane.
   * Queries the `loads` table for delivered loads in the same origin state →
   * destination state corridor with matching equipment over the last 90 days.
   *
   * Uses `revenue` (shipper-paying rate) — the broker's revenue is what we
   * want as a market-rate signal for new loads. Equipment values like 'Dry
   * Van' / 'Reefer' match the canonical TMS equipment column.
   */
  private async lookupHistoricalRate(
    load: ResearchJobPayload['qualifiedLoad'],
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
      logger.warn('[Researcher] Historical lookup failed; skipping source 1', err);
      return null;
    }
  }

  /**
   * Source 5: Optional Claude estimate. Falls through silently if anything goes
   * wrong — the cascade is designed so Source 6 always provides a fallback.
   */
  private async tryClaudeEstimate(
    load: ResearchJobPayload['qualifiedLoad'],
    distanceMiles: number,
  ): Promise<{ mid: number; range: number; confidence: number } | null> {
    if (!this.claudeService) return null;

    const jobId = `research-${Date.now()}`;
    this.claudeService.initializeBudget(jobId, 10000, 5000);

    const result = await this.claudeService.research(
      {
        loadId: 'pipeline-research',
        originCity: load.origin.city,
        originState: load.origin.state,
        destinationCity: load.destination.city,
        destinationState: load.destination.state,
        distanceMiles,
        equipmentType: load.equipmentType,
        pickupDate: load.pickupDate,
        originCountry: load.origin.country,
      } as any,
      jobId,
    );

    const intel = result.data;
    return {
      mid: intel.rates.midRate,
      range:
        intel.rates.bestRate > 0
          ? (intel.rates.bestRate - intel.rates.floorRate) / (2 * intel.rates.midRate)
          : 0.15,
      confidence: intel.rates.confidence,
    };
  }

  /**
   * Profile a shipper from history. Falls back to defaults for new shippers.
   */
  private async profileShipper(
    payload: ResearchJobPayload,
    load: ResearchJobPayload['qualifiedLoad'],
  ): Promise<ShipperProfile> {
    const phone = (payload as any).shipperPhone || null;

    const defaults: ShipperProfile = {
      preferredLanguage: 'en',
      preferredCurrency: load.origin.country === 'CA' ? 'CAD' : 'USD',
      previousCallCount: 0,
      previousOutcomes: [],
      bestPerformingPersona: null,
      lastBookedRate: null,
      lastBookedDate: null,
      fatigueScore: 0,
      isRepeatShipper: false,
      knownObjections: [],
      notes: null,
      companyName: null,
      contactName: null,
    };

    if (!phone) return defaults;

    try {
      const prefRes = await db.query<{
        preferred_language: string | null;
        preferred_currency: string | null;
        total_calls_received: number | null;
        total_bookings: number | null;
        best_performing_persona: string | null;
        avg_agreed_rate: string | null;
        last_objection_type: string | null;
        company_name: string | null;
        contact_name: string | null;
      }>(`SELECT * FROM shipper_preferences WHERE phone = $1 LIMIT 1`, [phone]);

      const recentRes = await db.query<{
        outcome: string;
        agreed_rate: string | null;
        call_initiated_at: Date;
      }>(
        `SELECT outcome, agreed_rate, call_initiated_at
         FROM agent_calls
         WHERE phone_number_called = $1
         ORDER BY call_initiated_at DESC
         LIMIT 10`,
        [phone],
      );

      const previousOutcomes = recentRes.rows.map((r) => r.outcome).filter(Boolean);
      const recentCount = recentRes.rows.filter(
        (r) =>
          new Date(r.call_initiated_at).getTime() > Date.now() - 7 * 86400_000,
      ).length;

      const lastBooked = recentRes.rows.find((r) => r.outcome === 'booked' && r.agreed_rate);

      const pref = prefRes.rows[0];

      return {
        preferredLanguage: ((pref?.preferred_language as 'en' | 'fr') || 'en'),
        preferredCurrency: ((pref?.preferred_currency as 'CAD' | 'USD') ||
          defaults.preferredCurrency),
        previousCallCount: pref?.total_calls_received ?? recentRes.rows.length,
        previousOutcomes,
        bestPerformingPersona: pref?.best_performing_persona ?? null,
        lastBookedRate: lastBooked?.agreed_rate ? Number(lastBooked.agreed_rate) : null,
        lastBookedDate: lastBooked
          ? new Date(lastBooked.call_initiated_at).toISOString().split('T')[0]
          : null,
        fatigueScore: recentCount,
        isRepeatShipper: (pref?.total_bookings ?? 0) > 0,
        knownObjections: pref?.last_objection_type ? [pref.last_objection_type] : [],
        notes: null,
        companyName: pref?.company_name ?? null,
        contactName: pref?.contact_name ?? null,
      };
    } catch (err) {
      logger.warn('[Researcher] Shipper profile lookup failed; using defaults', err);
      return defaults;
    }
  }

  private determineStrategy(
    rates: RateCascadeResult,
    cost: CostBreakdown,
    negotiation: ReturnType<typeof calculateNegotiationParams>,
    shipperProfile: ShipperProfile,
  ): { approach: 'aggressive' | 'standard' | 'walk'; reasoning: string } {
    const minMargin = rates.currency === 'CAD' ? 270 : 200;
    const targetMargin = rates.currency === 'CAD' ? 470 : 350;
    const stretchMargin = rates.currency === 'CAD' ? 675 : 500;

    // Hard walk: market ceiling can't clear the floor margin. The voice agent
    // would have to demand >100% of best rate. Don't waste a call.
    if (rates.bestRate < cost.total + minMargin) {
      return {
        approach: 'walk',
        reasoning: `Market ceiling $${rates.bestRate} below cost $${cost.total} + min margin $${minMargin}. Decline gracefully.`,
      };
    }

    const expectedMargin = negotiation.initialOffer - cost.total;

    if (expectedMargin >= stretchMargin && rates.confidence >= 0.7) {
      return {
        approach: 'aggressive',
        reasoning: `Strong margin ($${expectedMargin}) with high-confidence rate data (${rates.confidence.toFixed(2)}) from ${rates.sources.join(', ')}. Push for stretch rate.`,
      };
    }

    if (expectedMargin >= targetMargin) {
      return {
        approach: 'standard',
        reasoning: `Healthy margin ($${expectedMargin}) at target rate. Standard approach with cushion to concede.`,
      };
    }

    return {
      approach: 'standard',
      reasoning: `Margin viable but tight (expected $${expectedMargin}). Hold firm on rate, lean on service value.`,
    };
  }

  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    const intel: ResearchIntelligence = result.details?.intelligence;
    if (!intel) {
      logger.warn(`[Researcher] No intelligence in result for load ${pipelineLoadId}; skipping update`);
      return;
    }

    await db.query(
      `UPDATE pipeline_loads
       SET research_completed_at = NOW(),
           market_rate_floor = $2,
           market_rate_mid = $3,
           market_rate_best = $4,
           recommended_strategy = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        pipelineLoadId,
        intel.rates.floorRate,
        intel.rates.midRate,
        intel.rates.bestRate,
        intel.strategy.approach,
      ],
    );

    const gate = await onResearcherComplete(db as any, pipelineLoadId);
    if (gate.shouldEnqueue) {
      const briefPayload = await buildBriefPayload(db as any, pipelineLoadId);
      await this.briefQueue.add('compile', briefPayload, { priority: briefPayload.priority });
      logger.info(`[Researcher] Gate opened for load ${pipelineLoadId} → brief-queue`);
    } else {
      logger.debug(`[Researcher] Gate not yet open for load ${pipelineLoadId}: ${gate.reason}`);
    }
  }
}
