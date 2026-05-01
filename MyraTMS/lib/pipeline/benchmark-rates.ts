// Benchmark Rate Lookup Table
// Myra Logistics — Rate Cascade Fallback (Source 6)
// Ontario freight market CAD rates with seasonal multipliers

export type EquipmentType = 'dry_van' | 'flatbed' | 'reefer' | 'step_deck';
export type DistanceBand = '0-200' | '200-500' | '500-1000' | '1000-2000' | '2000+';
export type Season = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface BenchmarkRate {
  ratePerMile: number;  // CAD
  ratePerKm: number;    // CAD
  currency: 'CAD';
}

// Base rates (before seasonal adjustment) — 5 bands × 4 equipment types
export const BENCHMARK_RATES: Record<EquipmentType, Record<DistanceBand, BenchmarkRate>> = {
  dry_van: {
    '0-200': { ratePerMile: 2.50, ratePerKm: 1.55, currency: 'CAD' },
    '200-500': { ratePerMile: 2.05, ratePerKm: 1.27, currency: 'CAD' },
    '500-1000': { ratePerMile: 1.85, ratePerKm: 1.15, currency: 'CAD' },
    '1000-2000': { ratePerMile: 1.65, ratePerKm: 1.02, currency: 'CAD' },
    '2000+': { ratePerMile: 1.50, ratePerKm: 0.93, currency: 'CAD' },
  },
  flatbed: {
    '0-200': { ratePerMile: 2.88, ratePerKm: 1.79, currency: 'CAD' },
    '200-500': { ratePerMile: 2.36, ratePerKm: 1.47, currency: 'CAD' },
    '500-1000': { ratePerMile: 2.12, ratePerKm: 1.32, currency: 'CAD' },
    '1000-2000': { ratePerMile: 1.90, ratePerKm: 1.18, currency: 'CAD' },
    '2000+': { ratePerMile: 1.73, ratePerKm: 1.07, currency: 'CAD' },
  },
  reefer: {
    '0-200': { ratePerMile: 3.10, ratePerKm: 1.93, currency: 'CAD' },
    '200-500': { ratePerMile: 2.56, ratePerKm: 1.59, currency: 'CAD' },
    '500-1000': { ratePerMile: 2.27, ratePerKm: 1.41, currency: 'CAD' },
    '1000-2000': { ratePerMile: 2.04, ratePerKm: 1.27, currency: 'CAD' },
    '2000+': { ratePerMile: 1.88, ratePerKm: 1.17, currency: 'CAD' },
  },
  step_deck: {
    '0-200': { ratePerMile: 2.80, ratePerKm: 1.74, currency: 'CAD' },
    '200-500': { ratePerMile: 2.28, ratePerKm: 1.42, currency: 'CAD' },
    '500-1000': { ratePerMile: 2.04, ratePerKm: 1.27, currency: 'CAD' },
    '1000-2000': { ratePerMile: 1.82, ratePerKm: 1.13, currency: 'CAD' },
    '2000+': { ratePerMile: 1.66, ratePerKm: 1.03, currency: 'CAD' },
  },
};

// Seasonal multipliers applied to base rates
export const SEASONAL_MULTIPLIERS: Record<Season, number> = {
  Q1: 0.95,   // Jan-Mar: winter slowdown (except reefer stable)
  Q2: 1.05,   // Apr-Jun: spring ramp-up, construction season starts
  Q3: 1.10,   // Jul-Sep: peak season, mining/construction full swing
  Q4: 1.00,   // Oct-Dec: normalize, pre-winter
};

/**
 * Get the distance band that contains the given distance in km
 */
export function getDistanceBand(distanceKm: number): DistanceBand {
  if (distanceKm <= 200) return '0-200';
  if (distanceKm <= 500) return '200-500';
  if (distanceKm <= 1000) return '500-1000';
  if (distanceKm <= 2000) return '1000-2000';
  return '2000+';
}

/**
 * Get the current season (Q1-Q4) based on current month
 */
export function getCurrentSeason(): Season {
  const month = new Date().getMonth() + 1; // 1-12
  if (month <= 3) return 'Q1';
  if (month <= 6) return 'Q2';
  if (month <= 9) return 'Q3';
  return 'Q4';
}

/**
 * Look up benchmark rate with optional seasonal multiplier
 * Returns rate adjusted by season if provided, otherwise returns base rate
 */
export function getBenchmarkRate(
  equipment: EquipmentType,
  distanceKm: number,
  season?: Season
): BenchmarkRate {
  const band = getDistanceBand(distanceKm);
  const baseRate = BENCHMARK_RATES[equipment][band];

  if (!season) {
    return baseRate;
  }

  const multiplier = SEASONAL_MULTIPLIERS[season];
  return {
    ratePerMile: Math.round(baseRate.ratePerMile * multiplier * 100) / 100,
    ratePerKm: Math.round(baseRate.ratePerKm * multiplier * 100) / 100,
    currency: 'CAD',
  };
}
