/**
 * T-21 §5 — the Pricing Engine service: quotePricing(). Wraps T-06's
 * Steps 1-5 (distance, rate cascade, cost model, margin envelope,
 * negotiation parameters) behind a direction-aware, tenant-aware interface.
 * Pure request/response, no queue dependency — callable synchronously from
 * any worker (T-21 §9).
 */

import { db } from '@/lib/pipeline/db-adapter';
import { calculateTotalCost } from '@/lib/pipeline/cost-calculator';
import { resolveAddressToDistance } from '@/lib/quoting/geo/distance-service';
import { runRateCascade, type RateCascadeResult, type RateCascadeLoad } from './rate-cascade';
import { resolveMargin, type MarginSource } from './resolve-margin';
import { computeSellEnvelope, type SellEnvelope } from './sell-envelope';
import { computeBuyEnvelope, type BuyEnvelope } from './buy-envelope';

export interface PricingQuoteRequest {
  tenantId: number;
  direction: 'sell' | 'buy';
  requestSource: 'engine2_researcher_shadow' | 'engine2_researcher_live' | 'dispatch_one' | 'shadow_comparison';
  pipelineLoadId?: number;
  load: {
    originCity: string; originState: string; originCountry: string;
    destinationCity: string; destinationState: string; destinationCountry: string;
    equipmentType: string;
    postedRate?: number | null;
    distanceMiles?: number;
    distanceKm?: number;
  };
}

export interface NegotiationEnvelope {
  direction: 'sell' | 'buy';
  openingOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;
  walkAwayRate: number;
  marginEnvelope: { floor: number; target: number; stretch: number };
  currency: 'CAD' | 'USD';
}

export interface CostBreakdown {
  baseCost: number; deadheadCost: number; fuelSurcharge: number;
  accessorials: number; adminOverhead: number; crossBorderFees: number;
  factoringFee: number; total: number;
}

export interface PricingQuoteResult {
  rates: RateCascadeResult;
  cost: CostBreakdown;
  negotiation: NegotiationEnvelope;
  marginSourceUsed: MarginSource;
}

const CURRENT_FUEL_PRICE_CAD = 1.50;

async function resolveDistance(load: PricingQuoteRequest['load']): Promise<{ miles: number; km: number }> {
  if (load.distanceMiles) {
    return { miles: load.distanceMiles, km: load.distanceKm ?? load.distanceMiles * 1.60934 };
  }
  const originAddress = `${load.originCity}, ${load.originState}`;
  const destAddress = `${load.destinationCity}, ${load.destinationState}`;
  const result = await resolveAddressToDistance(originAddress, destAddress);
  return { miles: result.distanceMiles, km: result.distanceKm };
}

export async function quotePricing(req: PricingQuoteRequest): Promise<PricingQuoteResult> {
  const distance = await resolveDistance(req.load);

  const cascadeLoad: RateCascadeLoad = {
    origin: { city: req.load.originCity, state: req.load.originState, country: req.load.originCountry },
    destination: { city: req.load.destinationCity, state: req.load.destinationState, country: req.load.destinationCountry },
    equipmentType: req.load.equipmentType,
    postedRate: req.load.postedRate ?? null,
  };
  const rates = await runRateCascade(cascadeLoad, distance);

  const isCrossBorder = req.load.originCountry !== req.load.destinationCountry;
  const cost = calculateTotalCost({
    distanceMiles: distance.miles,
    distanceKm: distance.km,
    carrierRate: req.load.originCountry === 'CA' ? 2.0 : 1.5,
    fuelPricePerLitre: CURRENT_FUEL_PRICE_CAD,
    originCountry: req.load.originCountry,
    destinationCountry: req.load.destinationCountry,
    isCrossBorder,
  });

  const { margin, source: marginSourceUsed } = await resolveMargin(req.tenantId, rates.currency);

  const negotiation: NegotiationEnvelope = req.direction === 'sell'
    ? (() => {
        const env: SellEnvelope = computeSellEnvelope(cost.total, rates.bestRate, margin);
        return {
          direction: 'sell' as const,
          openingOffer: env.initialOffer,
          concessionStep1: env.concessionStep1,
          concessionStep2: env.concessionStep2,
          finalOffer: env.finalOffer,
          walkAwayRate: env.finalOffer,
          marginEnvelope: { floor: margin.minMargin, target: margin.targetMargin, stretch: margin.stretchMargin },
          currency: rates.currency,
        };
      })()
    : (() => {
        const env: BuyEnvelope = computeBuyEnvelope(cost.total, rates.midRate, margin);
        return {
          direction: 'buy' as const,
          openingOffer: env.openingOffer,
          concessionStep1: env.concessionStep1,
          concessionStep2: env.concessionStep2,
          finalOffer: env.finalOffer,
          walkAwayRate: env.finalOffer,
          marginEnvelope: { floor: margin.minMargin, target: margin.targetMargin, stretch: margin.stretchMargin },
          currency: rates.currency,
        };
      })();

  const result: PricingQuoteResult = { rates, cost, negotiation, marginSourceUsed };

  await logPricingRequest(req, result);
  return result;
}

async function logPricingRequest(req: PricingQuoteRequest, result: PricingQuoteResult): Promise<void> {
  try {
    await db.query(
      `INSERT INTO pricing_engine_requests
         (tenant_id, pipeline_load_id, direction, request_source, input_params, output_envelope, margin_source_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.tenantId,
        req.pipelineLoadId ?? null,
        req.direction,
        req.requestSource,
        JSON.stringify(req.load),
        JSON.stringify(result),
        result.marginSourceUsed,
      ],
    );
  } catch {
    // Logging failure must never fail a pricing quote.
  }
}
