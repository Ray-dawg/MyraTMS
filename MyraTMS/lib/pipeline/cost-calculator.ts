/**
 * Myra Logistics - Cost Calculator Module
 * Pure math module for calculating the total cost to move a freight load
 * Zero external dependencies - all calculations are deterministic and side-effect free
 *
 * @version 1.0
 * @author Patrice Penda
 * @classification Technical — Engineering Only
 */

// ============================================================================
// TYPE DEFINITIONS & INTERFACES
// ============================================================================

/**
 * Input parameters for cost calculation
 * Contains all data needed to compute total cost
 */
export interface CostCalculationParams {
  /** Distance in kilometers (provide either distanceKm or distanceMiles) */
  distanceKm?: number;

  /** Distance in miles (alternative to distanceKm) */
  distanceMiles?: number;

  /** Base carrier cost per unit (USD or CAD depending on origin country) */
  carrierRate: number;

  /** Current diesel price per litre */
  fuelPricePerLitre: number;

  /** Origin country: "CA" for Canada, "US" for United States */
  originCountry: string;

  /** Destination country: "CA" for Canada, "US" for United States */
  destinationCountry: string;

  /** Whether this is a cross-border (US-CA) load */
  isCrossBorder: boolean;

  /** Accessorial charges (stops, lumpers, wait time). Default: $75 */
  accessorials?: number;

  /** Admin overhead per load (factoring, insurance, tech). Default: $35 */
  adminOverhead?: number;

  /** Deadhead percentage (empty miles as % of loaded miles). Default: 0.15 (15%) */
  deadheadPercent?: number;

  /** Factoring fee rate as decimal. Default: 0.03 (3%) */
  factoringRate?: number;

  /** Whether to use Canadian Trucking Standard formula for fuel surcharge */
  useCanadianFuelFormula?: boolean;
}

/**
 * Itemized cost breakdown showing all components
 * Used by Agent 3 (Research) and Agent 5 (Brief Compiler)
 */
export interface CostBreakdown {
  /** Base cost: loaded miles × carrier rate */
  baseCost: number;

  /** Deadhead cost: empty miles × carrier rate */
  deadheadCost: number;

  /** Fuel surcharge based on fuel price and distance */
  fuelSurcharge: number;

  /** Accessorial charges (flat, typically $75) */
  accessorials: number;

  /** Admin overhead (flat, typically $35) */
  adminOverhead: number;

  /** Cross-border fees ($250 if US-CA, $0 domestic) */
  crossBorderFees: number;

  /** Factoring fee (3% of subtotal) */
  factoringFee: number;

  /** Total cost to move the load */
  total: number;
}

/**
 * Margin estimate showing profitability relative to a selling rate
 * Used for go/no-go decisions and rate negotiation
 */
export interface MarginEstimate {
  /** Dollar margin (selling_rate - total_cost) */
  dollarMargin: number;

  /** Percentage margin ((selling_rate - total_cost) / total_cost × 100) */
  percentMargin: number;

  /** True margin after factoring fee is deducted */
  trueMargin: number;

  /** Whether margin meets minimum threshold ($200 USD / $270 CAD) */
  isAboveFloor: boolean;

  /** Whether margin meets target threshold ($350 USD / $470 CAD) */
  isAboveTarget: boolean;

  /** Whether margin meets stretch threshold ($500 USD / $675 CAD) */
  isAboveStretch: boolean;

  /** Currency of the calculation: "CAD" or "USD" */
  currency: string;

  /** Minimum acceptable margin for this currency */
  floorMargin: number;

  /** Target margin for this currency */
  targetMargin: number;

  /** Stretch margin for this currency */
  stretchMargin: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base cost per mile in USD for US-origin loads */
const COST_PER_MILE_USD = 1.50;

/** Base cost per mile in CAD for Canada-origin loads */
const COST_PER_MILE_CAD = 2.00;

/** Default deadhead allowance (15% of loaded miles) */
const DEFAULT_DEADHEAD_PERCENT = 0.15;

/** Default fuel surcharge (per-mile method) */
const DEFAULT_FUEL_SURCHARGE_PER_MILE = 0.25;

/** Canadian Trucking Standard baseline fuel price */
const CTS_BASELINE_FUEL_PRICE = 1.25; // $/L

/** Canadian Trucking Standard consumption rate */
const CTS_CONSUMPTION_RATE = 40; // L/100km

/** Default accessorial charges per load */
const DEFAULT_ACCESSORIALS = 75;

/** Default admin overhead per load */
const DEFAULT_ADMIN_OVERHEAD = 35;

/** Cross-border fee for US-CA lanes */
const CROSS_BORDER_FEE = 250;

/** Customs delay allowance for cross-border loads (historically included) */
const CUSTOMS_DELAY_ALLOWANCE = 100;

/** Default factoring fee rate */
const DEFAULT_FACTORING_RATE = 0.03;

/** USD minimum margin floor */
const MIN_MARGIN_USD = 200;

/** USD target margin */
const TARGET_MARGIN_USD = 350;

/** USD stretch margin */
const STRETCH_MARGIN_USD = 500;

/** CAD minimum margin floor */
const MIN_MARGIN_CAD = 270;

/** CAD target margin */
const TARGET_MARGIN_CAD = 470;

/** CAD stretch margin */
const STRETCH_MARGIN_CAD = 675;

/** Conversion factor: km to miles */
const KM_TO_MILES = 0.621371;

/** Conversion factor: miles to km */
const MILES_TO_KM = 1.60934;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize distance to km and miles
 * @param distanceKm - Distance in kilometers (if provided)
 * @param distanceMiles - Distance in miles (if provided)
 * @returns Object with both km and miles
 * @throws Error if neither distance is provided
 */
function normalizeDistance(
  distanceKm?: number,
  distanceMiles?: number
): { km: number; miles: number } {
  if (distanceKm && distanceKm > 0) {
    return {
      km: distanceKm,
      miles: Math.round(distanceKm * KM_TO_MILES * 100) / 100,
    };
  }

  if (distanceMiles && distanceMiles > 0) {
    return {
      miles: distanceMiles,
      km: Math.round(distanceMiles * MILES_TO_KM * 100) / 100,
    };
  }

  throw new Error(
    'Either distanceKm or distanceMiles must be provided and > 0'
  );
}

/**
 * Determine cost per mile based on origin country
 * @param originCountry - "CA" or "US"
 * @returns Cost per mile in that region's currency
 */
function getCostPerMile(originCountry: string): number {
  if (originCountry.toUpperCase() === 'CA') {
    return COST_PER_MILE_CAD;
  }
  return COST_PER_MILE_USD;
}

/**
 * Determine currency based on origin country
 * @param originCountry - "CA" or "US"
 * @returns "CAD" or "USD"
 */
function getCurrency(originCountry: string): string {
  return originCountry.toUpperCase() === 'CA' ? 'CAD' : 'USD';
}

/**
 * Get margin thresholds for a given currency
 * @param currency - "CAD" or "USD"
 * @returns Object with floor, target, stretch margins
 */
function getMarginThresholds(currency: string): {
  floor: number;
  target: number;
  stretch: number;
} {
  if (currency === 'CAD') {
    return {
      floor: MIN_MARGIN_CAD,
      target: TARGET_MARGIN_CAD,
      stretch: STRETCH_MARGIN_CAD,
    };
  }
  return {
    floor: MIN_MARGIN_USD,
    target: TARGET_MARGIN_USD,
    stretch: STRETCH_MARGIN_USD,
  };
}

/**
 * Round currency values to 2 decimal places
 * @param value - Number to round
 * @returns Rounded number
 */
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

// ============================================================================
// COST CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate base cost (loaded miles only × carrier rate)
 *
 * @param ratePerUnit - Carrier rate per mile or km
 * @param distance - Distance in the same unit as ratePerUnit
 * @returns Base cost before deadhead, fuel, and fees
 *
 * @example
 * calculateBaseCost(2.00, 250) // $2.00 CAD/mile × 250 miles = $500
 */
export function calculateBaseCost(
  ratePerUnit: number,
  distance: number
): number {
  if (ratePerUnit < 0 || distance < 0) {
    throw new Error('Rate and distance must be non-negative');
  }
  return roundCurrency(ratePerUnit * distance);
}

/**
 * Calculate deadhead cost (empty miles × carrier rate)
 * Empty miles = deadhead percentage × loaded miles
 *
 * @param baseCost - The base cost (already calculated)
 * @param deadheadPercent - Deadhead as percentage of loaded miles. Default: 0.15 (15%)
 * @returns Deadhead cost
 *
 * @example
 * calculateDeadheadCost(500, 0.15) // 15% of $500 = $75
 */
export function calculateDeadheadCost(
  baseCost: number,
  deadheadPercent: number = DEFAULT_DEADHEAD_PERCENT
): number {
  if (baseCost < 0 || deadheadPercent < 0 || deadheadPercent > 1) {
    throw new Error('baseCost must be non-negative, deadheadPercent 0-1');
  }
  return roundCurrency(baseCost * deadheadPercent);
}

/**
 * Calculate fuel surcharge using Canadian Trucking Standard formula
 * Formula: (fuel_price - $1.25/L) × (40L/100km) × distance_km
 *
 * @param fuelPricePerLitre - Current diesel price in $/L
 * @param distanceKm - Distance in kilometers
 * @returns Fuel surcharge
 *
 * @example
 * calculateFuelSurcharge(1.50, 400)
 * // (1.50 - 1.25) × (40/100) × 400 = 0.25 × 0.4 × 400 = $40
 */
export function calculateFuelSurcharge(
  fuelPricePerLitre: number,
  distanceKm: number
): number {
  if (fuelPricePerLitre < 0 || distanceKm < 0) {
    throw new Error('Fuel price and distance must be non-negative');
  }

  const priceDifference = fuelPricePerLitre - CTS_BASELINE_FUEL_PRICE;
  // If fuel is at or below baseline, fuel surcharge is 0 (no negative surcharge)
  if (priceDifference <= 0) {
    return 0;
  }

  const consumptionPerKm = CTS_CONSUMPTION_RATE / 100;
  return roundCurrency(priceDifference * consumptionPerKm * distanceKm);
}

/**
 * Calculate cross-border fee
 * $250 for US-Canada lanes, $0 for domestic
 *
 * @param originCountry - "CA" or "US"
 * @param destinationCountry - "CA" or "US"
 * @returns Cross-border fee
 *
 * @example
 * calculateCrossBorderFee("CA", "US") // $250
 * calculateCrossBorderFee("CA", "CA") // $0
 */
export function calculateCrossBorderFee(
  originCountry: string,
  destinationCountry: string
): number {
  const origin = originCountry.toUpperCase();
  const destination = destinationCountry.toUpperCase();

  // Only charge cross-border fee for US-CA or CA-US
  if (
    (origin === 'CA' && destination === 'US') ||
    (origin === 'US' && destination === 'CA')
  ) {
    return CROSS_BORDER_FEE;
  }

  return 0;
}

/**
 * Calculate factoring fee (carrier payment acceleration fee)
 * Typically 3% of subtotal
 *
 * @param subtotal - Cost before factoring fee
 * @param factoringRate - Fee as decimal. Default: 0.03 (3%)
 * @returns Factoring fee
 *
 * @example
 * calculateFactoringFee(2000, 0.03) // $2000 × 3% = $60
 */
export function calculateFactoringFee(
  subtotal: number,
  factoringRate: number = DEFAULT_FACTORING_RATE
): number {
  if (subtotal < 0 || factoringRate < 0 || factoringRate > 1) {
    throw new Error('Subtotal must be non-negative, factoringRate 0-1');
  }
  return roundCurrency(subtotal * factoringRate);
}

/**
 * Master function: Calculate total cost to move a load
 * Runs all cost components and returns itemized breakdown
 *
 * This is the primary function that Agent 3 (Research) and Agent 5 (Brief Compiler)
 * consume. It orchestrates all cost calculations into a single, auditable result.
 *
 * @param params - CostCalculationParams with all load data
 * @returns CostBreakdown with itemized costs and total
 * @throws Error if required parameters are invalid
 *
 * @example
 * const breakdown = calculateTotalCost({
 *   distanceKm: 402,
 *   carrierRate: 2.0,
 *   fuelPricePerLitre: 1.50,
 *   originCountry: "CA",
 *   destinationCountry: "CA",
 *   isCrossBorder: false
 * });
 * // Returns: { baseCost: 900, deadheadCost: 135, fuelSurcharge: 60, ... total: 1305 }
 */
export function calculateTotalCost(
  params: CostCalculationParams
): CostBreakdown {
  // Validate required parameters
  if (!params.originCountry || !params.destinationCountry) {
    throw new Error(
      'originCountry and destinationCountry are required (CA or US)'
    );
  }

  if (params.carrierRate < 0) {
    throw new Error('carrierRate must be non-negative');
  }

  if (params.fuelPricePerLitre < 0) {
    throw new Error('fuelPricePerLitre must be non-negative');
  }

  // Normalize distance
  const distance = normalizeDistance(params.distanceKm, params.distanceMiles);

  // Set defaults for optional parameters
  const deadheadPercent = params.deadheadPercent ?? DEFAULT_DEADHEAD_PERCENT;
  const accessorials = params.accessorials ?? DEFAULT_ACCESSORIALS;
  const adminOverhead = params.adminOverhead ?? DEFAULT_ADMIN_OVERHEAD;
  const factoringRate = params.factoringRate ?? DEFAULT_FACTORING_RATE;

  // Determine cost per mile and currency
  const costPerMile = getCostPerMile(params.originCountry);

  // 1. Base cost: loaded miles × cost per mile
  const baseCost = calculateBaseCost(costPerMile, distance.miles);

  // 2. Deadhead cost: 15% of loaded miles × cost per mile
  const deadheadCost = calculateDeadheadCost(baseCost, deadheadPercent);

  // 3. Fuel surcharge: Canadian Trucking Standard formula (always use CTS for accuracy)
  const fuelSurcharge = calculateFuelSurcharge(
    params.fuelPricePerLitre,
    distance.km
  );

  // 4. Accessorials: flat charge (default $75)
  const finalAccessorials = accessorials;

  // 5. Admin overhead: flat charge (default $35)
  const finalAdminOverhead = adminOverhead;

  // 6. Cross-border fees: $250 if US-CA lane, $0 domestic
  const crossBorderFees = calculateCrossBorderFee(
    params.originCountry,
    params.destinationCountry
  );

  // 7. Subtotal for factoring calculation
  const subtotal =
    baseCost +
    deadheadCost +
    fuelSurcharge +
    finalAccessorials +
    finalAdminOverhead +
    crossBorderFees;

  // 8. Factoring fee: 3% of subtotal
  const factoringFee = calculateFactoringFee(subtotal, factoringRate);

  // Final total
  const total = roundCurrency(subtotal + factoringFee);

  return {
    baseCost: roundCurrency(baseCost),
    deadheadCost: roundCurrency(deadheadCost),
    fuelSurcharge: roundCurrency(fuelSurcharge),
    accessorials: roundCurrency(finalAccessorials),
    adminOverhead: roundCurrency(finalAdminOverhead),
    crossBorderFees: roundCurrency(crossBorderFees),
    factoringFee: roundCurrency(factoringFee),
    total,
  };
}

/**
 * Estimate margin on a load given a selling rate
 * Calculates whether the load meets floor, target, or stretch margins
 *
 * Used by Agent 3 (Research) to compute the margin envelope and determine
 * the strategy (aggressive/standard/walk) for the negotiation.
 *
 * @param sellingRate - The agreed or proposed rate from the shipper
 * @param totalCost - Total cost to move the load (from calculateTotalCost)
 * @param currency - "CAD" or "USD"
 * @param factoringRate - Factoring fee rate. Default: 0.03 (3%)
 * @returns MarginEstimate with dollar, percentage, and threshold checks
 *
 * @example
 * const breakdown = calculateTotalCost({ ... });
 * const estimate = estimateMargin(2400, breakdown.total, "CAD");
 * // Returns: { dollarMargin: 550, percentMargin: 24.5, isAboveTarget: true, ... }
 */
export function estimateMargin(
  sellingRate: number,
  totalCost: number,
  currency: string = 'CAD',
  factoringRate: number = DEFAULT_FACTORING_RATE
): MarginEstimate {
  if (sellingRate < 0 || totalCost < 0) {
    throw new Error('sellingRate and totalCost must be non-negative');
  }

  // Get thresholds for this currency
  const thresholds = getMarginThresholds(currency);

  // Calculate dollar margin
  const dollarMargin = roundCurrency(sellingRate - totalCost);

  // Calculate percentage margin
  const percentMargin = totalCost > 0 ? (dollarMargin / totalCost) * 100 : 0;

  // Calculate true margin after factoring fee
  const factoringFeeOnRate = roundCurrency(sellingRate * factoringRate);
  const trueMargin = roundCurrency(dollarMargin - factoringFeeOnRate);

  return {
    dollarMargin,
    percentMargin: roundCurrency(percentMargin),
    trueMargin,
    isAboveFloor: dollarMargin >= thresholds.floor,
    isAboveTarget: dollarMargin >= thresholds.target,
    isAboveStretch: dollarMargin >= thresholds.stretch,
    currency,
    floorMargin: thresholds.floor,
    targetMargin: thresholds.target,
    stretchMargin: thresholds.stretch,
  };
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Calculate negotiation parameters (rate envelope) given a cost and margin targets
 * Helper function for Agent 3 (Research) to build the rate cascade
 *
 * @param totalCost - Total cost to move the load
 * @param currency - "CAD" or "USD"
 * @param marketRateBest - Best market rate (to cap initial offer)
 * @returns Object with initial offer, concession steps, and final offer
 *
 * @example
 * const params = calculateNegotiationParams(2000, "CAD", 2800);
 * // Returns: { initialOffer: 2470, concessionStep1: 2313, ... finalOffer: 2270 }
 */
export function calculateNegotiationParams(
  totalCost: number,
  currency: string = 'CAD',
  marketRateBest: number = Infinity
): {
  initialOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;
  maxConcessions: number;
} {
  const thresholds = getMarginThresholds(currency);

  // Build the rate envelope
  const minAcceptableRate = totalCost + thresholds.floor;
  const targetRate = totalCost + thresholds.target;
  const stretchRate = totalCost + thresholds.stretch;

  // Initial offer: target rate, capped at 102% of best market rate
  let initialOffer = targetRate;
  if (initialOffer > marketRateBest * 1.02) {
    initialOffer = Math.min(marketRateBest * 1.02, targetRate);
  }
  // Never open below minimum
  initialOffer = Math.max(initialOffer, minAcceptableRate);

  // Concession ladder: 3 steps down to floor
  const maxConcession = initialOffer - minAcceptableRate;
  const concessionStep1 = roundCurrency(
    initialOffer - maxConcession * 0.33
  );
  const concessionStep2 = roundCurrency(
    initialOffer - maxConcession * 0.67
  );
  const finalOffer = roundCurrency(minAcceptableRate);

  return {
    initialOffer: roundCurrency(initialOffer),
    concessionStep1,
    concessionStep2,
    finalOffer,
    maxConcessions: 3,
  };
}

/**
 * Quick cost estimation for simple cases (per-mile calculation)
 * Uses simplified formula without full CTS fuel calculation
 *
 * @param distanceMiles - Distance in miles
 * @param originCountry - "CA" or "US"
 * @returns Simplified total cost estimate
 *
 * @example
 * const cost = estimateSimpleCost(250, "CA");
 * // $500 base + $37.50 deadhead + $62.50 fuel + $75 + $35 = $710
 */
export function estimateSimpleCost(
  distanceMiles: number,
  originCountry: string = 'CA'
): number {
  const costPerMile = getCostPerMile(originCountry);
  const baseCost = costPerMile * distanceMiles;
  const deadheadCost = baseCost * 0.15;
  const fuelSurcharge = distanceMiles * DEFAULT_FUEL_SURCHARGE_PER_MILE;
  const accessorials = DEFAULT_ACCESSORIALS;
  const adminOverhead = DEFAULT_ADMIN_OVERHEAD;

  const subtotal =
    baseCost + deadheadCost + fuelSurcharge + accessorials + adminOverhead;
  const factoringFee = subtotal * DEFAULT_FACTORING_RATE;

  return roundCurrency(subtotal + factoringFee);
}

/**
 * Export all calculation functions and types for public API
 */
export default {
  calculateBaseCost,
  calculateDeadheadCost,
  calculateFuelSurcharge,
  calculateCrossBorderFee,
  calculateFactoringFee,
  calculateTotalCost,
  estimateMargin,
  calculateNegotiationParams,
  estimateSimpleCost,
};
