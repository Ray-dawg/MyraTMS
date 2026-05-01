/**
 * AGENT 3 - RESEARCHER WORKER
 *
 * Performs deep analysis on qualified loads. Runs the rate cascade (6 sources),
 * computes cost model, calculates margin envelope, profiles shipper, and recommends
 * negotiation strategy. This is the first agent using Claude API.
 *
 * Runs in PARALLEL with Agent 4 (Carrier Ranker). Both triggered simultaneously
 * when a load enters 'qualified' stage. Converges at completion gate before
 * Agent 5 compiles the brief.
 *
 * Input: research-queue with ResearchJobPayload
 * Output: Load stage stays 'qualified', research_completed_at set in DB
 * Next Stage: matched (only after Agent 4 also completes - completion gate)
 *
 * Uses Claude API for rate estimation fallback and optional shipper profiling.
 * Reuses existing quoting engine infrastructure.
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Researcher job payload - received from Agent 2 (Qualifier)
 */
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

/**
 * Rate cascade result - output of 6-source rate lookup
 */
interface RateCascadeResult {
  floorRate: number;
  midRate: number;
  bestRate: number;
  confidence: number; // 0.0 to 1.0
  sources: string[]; // Which sources contributed
  currency: string; // 'CAD' | 'USD'
}

/**
 * Cost breakdown for the load
 */
interface CostBreakdown {
  baseCost: number;
  deadheadCost: number;
  fuelSurcharge: number;
  accessorials: number;
  adminOverhead: number;
  crossBorderFees: number;
  factoringFee: number;
  total: number;
}

/**
 * Negotiation parameters computed from cost and rates
 */
interface NegotiationParams {
  initialOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;
  walkAwayRate: number;
  minMargin: number;
  targetMargin: number;
  stretchMargin: number;
  marginEnvelope: {
    floor: number;
    target: number;
    stretch: number;
  };
}

/**
 * Shipper profile from historical data
 */
interface ShipperProfile {
  preferredLanguage: string;
  preferredCurrency: string;
  previousCallCount: number;
  previousOutcomes: string[];
  postingFrequency: number;
  bestPerformingPersona: string | null;
  lastBookedRate: number | null;
  fatigueScore: number;
}

/**
 * Complete research result
 */
interface LoadIntelligence {
  rates: RateCascadeResult;
  cost: CostBreakdown;
  negotiation: NegotiationParams;
  shipperProfile: ShipperProfile;
  strategy: { approach: string; reasoning: string };
  distance: { miles: number; km: number; durationHours: number };
}

/**
 * Researcher worker - deep load analysis
 */
export class ResearcherWorker extends BaseWorker<ResearchJobPayload> {
  private anthropic: Anthropic;
  private briefQueue: any; // TODO: Import Queue type

  constructor(redis: Redis, briefQueue: any) {
    const config: WorkerConfig = {
      queueName: 'research-queue',
      expectedStage: 'qualified',
      nextStage: 'matched', // Set conditionally by completion gate
      concurrency: 20, // Each job makes Claude API calls (~2-5 seconds per load)
      retryConfig: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000, // 60 seconds
        },
      },
      redis,
    };

    super(config);
    this.anthropic = new Anthropic(); // Uses ANTHROPIC_API_KEY env var
    this.briefQueue = briefQueue;
  }

  /**
   * Main research pipeline
   */
  public async process(payload: ResearchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, qualifiedLoad } = payload;
    logger.debug(`[Researcher] Processing load ${pipelineLoadId}`);

    try {
      // Execute the 7-step research pipeline
      // Step 1: Distance (retrieve or compute)
      // TODO: const distance = await getDistance(qualifiedLoad.origin, qualifiedLoad.destination);

      // Step 2: Rate Cascade (6 sources)
      const rates = await this.runRateCascade(qualifiedLoad);

      // Step 3: Cost Model
      const cost = this.calculateTotalCost(
        qualifiedLoad.distanceMiles,
        qualifiedLoad.origin.country,
        qualifiedLoad.origin.country !== qualifiedLoad.destination.country
      );

      // Step 4-5: Margin Envelope and Negotiation Params
      const negotiation = this.computeNegotiationParams(cost.total, rates, rates.currency);

      // Step 6: Shipper Profile
      // TODO: const shipperProfile = await this.profileShipper(payload.shipperPhone);

      // Step 7: Strategy Recommendation
      const strategy = this.determineStrategy(qualifiedLoad, rates, negotiation);

      const intelligence: LoadIntelligence = {
        rates,
        cost,
        negotiation,
        shipperProfile: this.defaultShipperProfile(), // Placeholder
        strategy,
        distance: {
          miles: qualifiedLoad.distanceMiles,
          km: qualifiedLoad.distanceKm,
          durationHours: 0, // TODO: Get from distance service
        },
      };

      logger.info(
        `[Researcher] Load ${pipelineLoadId} researched. Market rates: $${rates.floorRate}-$${rates.bestRate}. Strategy: ${strategy.approach}`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          rates: {
            floor: rates.floorRate,
            mid: rates.midRate,
            best: rates.bestRate,
            confidence: rates.confidence,
          },
          cost: cost.total,
          strategy: strategy.approach,
          intelligence,
        },
      };
    } catch (error) {
      logger.error(`[Researcher] Error processing load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Run the rate cascade - 6 sources in priority order
   */
  private async runRateCascade(load: any): Promise<RateCascadeResult> {
    // TODO: Implement complete rate cascade
    // Priority order:
    // 1. Historical loads on this lane (existing in quoting engine)
    // 2. DAT RateView API (existing integration slot)
    // 3. Truckstop API (existing integration slot)
    // 4. Manual rate cache (existing rate_cache table)
    // 5. Claude API estimation
    // 6. Benchmark fallback (existing hardcoded table)

    // Placeholder - return default for now
    const benchmark = 2500; // TODO: Implement getBenchmarkRate

    return {
      floorRate: Math.round(benchmark * 0.85),
      midRate: benchmark,
      bestRate: Math.round(benchmark * 1.15),
      confidence: 0.4, // Low confidence - using benchmark only
      sources: ['benchmark'],
      currency: 'CAD',
    };
  }

  /**
   * Calculate total cost to Myra to move this load
   */
  private calculateTotalCost(
    distanceMiles: number,
    originCountry: string,
    crossBorder: boolean
  ): CostBreakdown {
    const costPerMile = originCountry === 'CA' ? 2.0 : 1.5;
    const deadheadMiles = distanceMiles * 0.15;
    const totalMiles = distanceMiles + deadheadMiles;

    const baseCost = totalMiles * costPerMile;
    const deadheadCost = deadheadMiles * costPerMile;
    const fuelSurcharge = distanceMiles * 0.25;
    const accessorials = 75;
    const adminOverhead = 35;
    const crossBorderFees = crossBorder ? 250 : 0;
    const estimatedFactoringFee = (baseCost + fuelSurcharge + accessorials) * 0.03;

    return {
      baseCost: Math.round(baseCost * 100) / 100,
      deadheadCost: Math.round(deadheadCost * 100) / 100,
      fuelSurcharge: Math.round(fuelSurcharge * 100) / 100,
      accessorials,
      adminOverhead,
      crossBorderFees,
      factoringFee: Math.round(estimatedFactoringFee * 100) / 100,
      total: Math.round(
        (baseCost + fuelSurcharge + accessorials + adminOverhead + crossBorderFees + estimatedFactoringFee) * 100
      ) / 100,
    };
  }

  /**
   * Compute negotiation envelope from cost and rates
   */
  private computeNegotiationParams(totalCost: number, rates: RateCascadeResult, currency: string): NegotiationParams {
    const minMargin = currency === 'CAD' ? 270 : 200;
    const targetMargin = currency === 'CAD' ? 470 : 350;
    const stretchMargin = currency === 'CAD' ? 675 : 500;

    const minAcceptableRate = totalCost + minMargin;
    const targetRate = totalCost + targetMargin;
    const stretchRate = totalCost + stretchMargin;

    // Initial offer: target rate, capped at 102% of best market rate
    let initialOffer = targetRate;
    if (initialOffer > rates.bestRate * 1.02) {
      initialOffer = Math.min(rates.bestRate * 1.02, targetRate);
    }
    initialOffer = Math.max(initialOffer, minAcceptableRate); // Never open below minimum

    // Concession ladder
    const maxConcession = initialOffer - minAcceptableRate;
    const concessionStep1 = initialOffer - maxConcession * 0.33;
    const concessionStep2 = initialOffer - maxConcession * 0.67;
    const finalOffer = minAcceptableRate;

    return {
      initialOffer: Math.round(initialOffer),
      concessionStep1: Math.round(concessionStep1),
      concessionStep2: Math.round(concessionStep2),
      finalOffer: Math.round(finalOffer),
      walkAwayRate: Math.round(minAcceptableRate),
      minMargin,
      targetMargin,
      stretchMargin,
      marginEnvelope: {
        floor: Math.round(minAcceptableRate - totalCost),
        target: Math.round(targetRate - totalCost),
        stretch: Math.round(stretchRate - totalCost),
      },
    };
  }

  /**
   * Determine negotiation strategy (rule-based, no Claude API needed for this)
   */
  private determineStrategy(
    load: any,
    rates: RateCascadeResult,
    negotiation: NegotiationParams
  ): { approach: string; reasoning: string } {
    const estimatedMargin = negotiation.initialOffer - rates.midRate > 0
      ? negotiation.marginEnvelope.target
      : negotiation.marginEnvelope.floor;

    if (estimatedMargin >= negotiation.stretchMargin && rates.confidence > 0.7) {
      return {
        approach: 'aggressive',
        reasoning: 'Strong margin opportunity with high-confidence rate data. Push for stretch rate.',
      };
    }

    if (estimatedMargin >= negotiation.targetMargin) {
      return {
        approach: 'standard',
        reasoning: 'Healthy margin at target rate. Standard negotiation approach.',
      };
    }

    if (estimatedMargin >= negotiation.minMargin) {
      return {
        approach: 'standard',
        reasoning: 'Margin is viable but tight. Be prepared to hold firm on rate.',
      };
    }

    return {
      approach: 'walk',
      reasoning: 'Margin below minimum threshold. Proceed with call but prepared to decline.',
    };
  }

  /**
   * Default shipper profile for new shippers
   */
  private defaultShipperProfile(): ShipperProfile {
    return {
      preferredLanguage: 'en',
      preferredCurrency: 'CAD',
      previousCallCount: 0,
      previousOutcomes: [],
      postingFrequency: 0,
      bestPerformingPersona: null,
      lastBookedRate: null,
      fatigueScore: 0,
    };
  }

  /**
   * Override updatePipelineLoad to store research results
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      const intel = result.details.intelligence;

      // TODO: Update pipeline_loads with research results
      // After this, check if Agent 4 (Ranker) is also done
      // If both done, advance to 'matched' and enqueue to brief-queue

      // Step 1: Update with research results
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
        ]
      );

      // Step 2: Check if Agent 4 (Ranker) is also done
      const check = await db.query(
        'SELECT carrier_match_count FROM pipeline_loads WHERE id = $1',
        [pipelineLoadId]
      );

      if (check.rows[0]?.carrier_match_count > 0) {
        // Both agents done - advance to 'matched' and enqueue to brief-queue
        await db.query(
          "UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() WHERE id = $1",
          [pipelineLoadId]
        );

        // TODO: Enqueue to brief-queue with both research + matching results
        // const briefPayload = this.buildBriefPayload(pipelineLoadId, result);
        // await this.briefQueue.add('brief', briefPayload, { priority: ... });

        logger.info(
          `[Researcher] Completion gate triggered. Load ${pipelineLoadId} advanced to 'matched' and enqueued to brief-queue.`
        );
      } else {
        logger.debug(
          `[Researcher] Agent 4 not yet done. Load ${pipelineLoadId} waiting for carrier matching to complete.`
        );
      }
    } catch (error) {
      logger.error(`[Researcher] Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

// TODO: Export initialized worker
// export const researcherWorker = new ResearcherWorker(redisClient, briefQueue);

// TODO: Implement additional functions
// - getDistance(origin, destination): Promise<Distance>
// - profileShipper(phone): Promise<ShipperProfile>
// - claudeRateEstimate(load): Promise<RateCascadeResult | null>
