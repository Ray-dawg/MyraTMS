/**
 * Unit tests for Myra Logistics Cost Calculator
 * Tests all cost calculation functions with real-world examples
 *
 * @version 1.0
 * @author Test Suite
 */

import { describe, test, expect } from 'vitest';
import {
  calculateBaseCost,
  calculateDeadheadCost,
  calculateFuelSurcharge,
  calculateCrossBorderFee,
  calculateFactoringFee,
  calculateTotalCost,
  estimateMargin,
  calculateNegotiationParams,
  estimateSimpleCost,
  CostCalculationParams,
  CostBreakdown,
  MarginEstimate,
} from '../cost-calculator';

// ============================================================================
// TEST DATA & FIXTURES
// ============================================================================

/**
 * Example from Brief Compiler spec: Toronto → Sudbury (CAD)
 * 250 miles / 402 km
 */
const SUDBURY_CORRIDOR_PARAMS: CostCalculationParams = {
  distanceKm: 402,
  carrierRate: 2.0, // CAD per mile
  fuelPricePerLitre: 1.35,
  originCountry: 'CA',
  destinationCountry: 'CA',
  isCrossBorder: false,
};

/**
 * Example from T-06 Research spec: 250 miles with default settings
 */
const TORONTO_SUDBURY_250MI: CostCalculationParams = {
  distanceMiles: 250,
  carrierRate: 2.0,
  fuelPricePerLitre: 1.35,
  originCountry: 'CA',
  destinationCountry: 'CA',
  isCrossBorder: false,
};

/**
 * Cross-border US-CA example
 */
const CROSS_BORDER_PARAMS: CostCalculationParams = {
  distanceMiles: 400,
  carrierRate: 1.5,
  fuelPricePerLitre: 1.4,
  originCountry: 'US',
  destinationCountry: 'CA',
  isCrossBorder: true,
};

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Cost Calculator Module', () => {
  // ========================================================================
  // calculateBaseCost Tests
  // ========================================================================

  describe('calculateBaseCost', () => {
    test('basic calculation: 250 miles × $2.00/mile = $500', () => {
      const result = calculateBaseCost(2.0, 250);
      expect(result).toBe(500);
    });

    test('CAD rate: 250 miles × $2.00 CAD = $500', () => {
      const result = calculateBaseCost(2.0, 250);
      expect(result).toBe(500);
    });

    test('decimal precision: 300.5 miles × $1.50 = $450.75', () => {
      const result = calculateBaseCost(1.5, 300.5);
      expect(result).toBe(450.75);
    });

    test('zero distance returns zero', () => {
      const result = calculateBaseCost(2.0, 0);
      expect(result).toBe(0);
    });

    test('throws on negative rate', () => {
      expect(() => calculateBaseCost(-1, 100)).toThrow();
    });

    test('throws on negative distance', () => {
      expect(() => calculateBaseCost(1.5, -50)).toThrow();
    });
  });

  // ========================================================================
  // calculateDeadheadCost Tests
  // ========================================================================

  describe('calculateDeadheadCost', () => {
    test('default 15% deadhead on $500 base = $75', () => {
      const result = calculateDeadheadCost(500);
      expect(result).toBe(75);
    });

    test('custom deadhead 20% on $500 = $100', () => {
      const result = calculateDeadheadCost(500, 0.2);
      expect(result).toBe(100);
    });

    test('zero deadhead returns zero', () => {
      const result = calculateDeadheadCost(500, 0);
      expect(result).toBe(0);
    });

    test('decimal base cost: $431.25 × 15% = $64.69', () => {
      const result = calculateDeadheadCost(431.25, 0.15);
      expect(result).toBeCloseTo(64.69, 2);
    });

    test('throws on negative base cost', () => {
      expect(() => calculateDeadheadCost(-500, 0.15)).toThrow();
    });

    test('throws on invalid deadhead percentage', () => {
      expect(() => calculateDeadheadCost(500, 1.5)).toThrow();
    });
  });

  // ========================================================================
  // calculateFuelSurcharge Tests
  // ========================================================================

  describe('calculateFuelSurcharge', () => {
    test('CTS formula: (1.50 - 1.25) × 0.4 × 400km = $40', () => {
      const result = calculateFuelSurcharge(1.5, 400);
      expect(result).toBe(40);
    });

    test('fuel at baseline: (1.25 - 1.25) × ... = $0', () => {
      const result = calculateFuelSurcharge(1.25, 400);
      expect(result).toBe(0);
    });

    test('fuel below baseline returns zero (no negative surcharge)', () => {
      const result = calculateFuelSurcharge(1.0, 400);
      expect(result).toBe(0);
    });

    test('high fuel price: (2.0 - 1.25) × 0.4 × 402km = $120.60', () => {
      const result = calculateFuelSurcharge(2.0, 402);
      expect(result).toBeCloseTo(120.6, 2);
    });

    test('zero distance returns zero', () => {
      const result = calculateFuelSurcharge(1.5, 0);
      expect(result).toBe(0);
    });

    test('throws on negative fuel price', () => {
      expect(() => calculateFuelSurcharge(-1, 100)).toThrow();
    });
  });

  // ========================================================================
  // calculateCrossBorderFee Tests
  // ========================================================================

  describe('calculateCrossBorderFee', () => {
    test('US → CA lane: $250 fee', () => {
      const result = calculateCrossBorderFee('US', 'CA');
      expect(result).toBe(250);
    });

    test('CA → US lane: $250 fee', () => {
      const result = calculateCrossBorderFee('CA', 'US');
      expect(result).toBe(250);
    });

    test('CA → CA domestic: $0 fee', () => {
      const result = calculateCrossBorderFee('CA', 'CA');
      expect(result).toBe(0);
    });

    test('US → US domestic: $0 fee', () => {
      const result = calculateCrossBorderFee('US', 'US');
      expect(result).toBe(0);
    });

    test('case insensitive: ca → us = $250', () => {
      const result = calculateCrossBorderFee('ca', 'us');
      expect(result).toBe(250);
    });
  });

  // ========================================================================
  // calculateFactoringFee Tests
  // ========================================================================

  describe('calculateFactoringFee', () => {
    test('default 3% factoring on $2000 = $60', () => {
      const result = calculateFactoringFee(2000);
      expect(result).toBe(60);
    });

    test('custom rate 2% on $1500 = $30', () => {
      const result = calculateFactoringFee(1500, 0.02);
      expect(result).toBe(30);
    });

    test('zero subtotal returns zero', () => {
      const result = calculateFactoringFee(0);
      expect(result).toBe(0);
    });

    test('decimal subtotal: $1234.56 × 3% = $37.04', () => {
      const result = calculateFactoringFee(1234.56);
      expect(result).toBeCloseTo(37.04, 2);
    });

    test('throws on negative subtotal', () => {
      expect(() => calculateFactoringFee(-1000, 0.03)).toThrow();
    });

    test('throws on invalid factoring rate', () => {
      expect(() => calculateFactoringFee(1000, 1.5)).toThrow();
    });
  });

  // ========================================================================
  // calculateTotalCost Tests
  // ========================================================================

  describe('calculateTotalCost', () => {
    test('Sudbury corridor example from brief spec', () => {
      const result = calculateTotalCost(SUDBURY_CORRIDOR_PARAMS);

      expect(result).toHaveProperty('baseCost');
      expect(result).toHaveProperty('deadheadCost');
      expect(result).toHaveProperty('fuelSurcharge');
      expect(result).toHaveProperty('accessorials');
      expect(result).toHaveProperty('adminOverhead');
      expect(result).toHaveProperty('crossBorderFees');
      expect(result).toHaveProperty('factoringFee');
      expect(result).toHaveProperty('total');

      // Total should be > $1500 and < $2000
      expect(result.total).toBeGreaterThan(1500);
      expect(result.total).toBeLessThan(2000);
    });

    test('all cost components are positive', () => {
      const result = calculateTotalCost(TORONTO_SUDBURY_250MI);
      expect(result.baseCost).toBeGreaterThanOrEqual(0);
      expect(result.deadheadCost).toBeGreaterThanOrEqual(0);
      expect(result.fuelSurcharge).toBeGreaterThanOrEqual(0);
      expect(result.accessorials).toBeGreaterThanOrEqual(0);
      expect(result.adminOverhead).toBeGreaterThanOrEqual(0);
      expect(result.crossBorderFees).toBeGreaterThanOrEqual(0);
      expect(result.factoringFee).toBeGreaterThanOrEqual(0);
    });

    test('total equals sum of all components', () => {
      const result = calculateTotalCost(TORONTO_SUDBURY_250MI);
      const sum =
        result.baseCost +
        result.deadheadCost +
        result.fuelSurcharge +
        result.accessorials +
        result.adminOverhead +
        result.crossBorderFees +
        result.factoringFee;
      expect(result.total).toBeCloseTo(sum, 2);
    });

    test('cross-border load includes $250 fee', () => {
      const result = calculateTotalCost(CROSS_BORDER_PARAMS);
      expect(result.crossBorderFees).toBe(250);
    });

    test('domestic load has zero cross-border fee', () => {
      const result = calculateTotalCost(TORONTO_SUDBURY_250MI);
      expect(result.crossBorderFees).toBe(0);
    });

    test('custom accessorials and admin overhead', () => {
      const params: CostCalculationParams = {
        ...TORONTO_SUDBURY_250MI,
        accessorials: 150,
        adminOverhead: 50,
      };
      const result = calculateTotalCost(params);
      expect(result.accessorials).toBe(150);
      expect(result.adminOverhead).toBe(50);
    });

    test('throws if originCountry missing', () => {
      const params: any = { ...TORONTO_SUDBURY_250MI };
      delete params.originCountry;
      expect(() => calculateTotalCost(params as any)).toThrow();
    });

    test('throws if no distance provided', () => {
      const params: any = {
        carrierRate: 2.0,
        fuelPricePerLitre: 1.35,
        originCountry: 'CA',
        destinationCountry: 'CA',
        isCrossBorder: false,
      };
      expect(() => calculateTotalCost(params)).toThrow();
    });
  });

  // ========================================================================
  // estimateMargin Tests
  // ========================================================================

  describe('estimateMargin', () => {
    test('selling $2400 against $1850 cost in CAD', () => {
      const result = estimateMargin(2400, 1850, 'CAD');
      expect(result.dollarMargin).toBe(550);
      expect(result.isAboveTarget).toBe(true); // $550 > $470
      expect(result.isAboveFloor).toBe(true);
      expect(result.currency).toBe('CAD');
    });

    test('below floor margin in CAD', () => {
      const result = estimateMargin(2100, 1850, 'CAD');
      expect(result.dollarMargin).toBe(250);
      expect(result.isAboveFloor).toBe(false); // $250 < $270
      expect(result.isAboveTarget).toBe(false);
    });

    test('stretch margin in USD', () => {
      const result = estimateMargin(2700, 2000, 'USD');
      expect(result.dollarMargin).toBe(700);
      expect(result.isAboveStretch).toBe(true); // $700 > $500
      expect(result.currency).toBe('USD');
    });

    test('percentage margin calculation', () => {
      const result = estimateMargin(2400, 2000, 'CAD');
      expect(result.percentMargin).toBeCloseTo(20, 1); // ($400 / $2000) × 100
    });

    test('true margin accounts for factoring fee', () => {
      const result = estimateMargin(2000, 1800, 'CAD', 0.03);
      const factoringOnRate = 2000 * 0.03; // $60
      const expected = 200 - 60; // $140 true margin
      expect(result.trueMargin).toBe(expected);
    });

    test('zero cost returns high percentage (edge case)', () => {
      const result = estimateMargin(1000, 0, 'CAD');
      expect(result.dollarMargin).toBe(1000);
      // Percentage should be Infinity but we avoid division by zero
      expect(result.percentMargin).toBeGreaterThan(999);
    });

    test('throws on negative rates', () => {
      expect(() => estimateMargin(-100, 500, 'CAD')).toThrow();
      expect(() => estimateMargin(500, -100, 'CAD')).toThrow();
    });
  });

  // ========================================================================
  // calculateNegotiationParams Tests
  // ========================================================================

  describe('calculateNegotiationParams', () => {
    test('CAD load with $2000 cost builds negotiation envelope', () => {
      const result = calculateNegotiationParams(2000, 'CAD');

      expect(result.initialOffer).toBeGreaterThan(2000);
      expect(result.concessionStep1).toBeGreaterThan(result.concessionStep2);
      expect(result.concessionStep2).toBeGreaterThan(result.finalOffer);
      expect(result.finalOffer).toBe(2270); // $2000 + $270 floor
      expect(result.maxConcessions).toBe(3);
    });

    test('initial offer is target margin above cost', () => {
      const result = calculateNegotiationParams(1850, 'CAD'); // From Sudbury example
      // targetMargin = 470, so should open around 1850 + 470 = 2320
      expect(result.initialOffer).toBeGreaterThanOrEqual(2320 - 50); // within 5%
    });

    test('capped at 102% of market best rate', () => {
      const result = calculateNegotiationParams(1800, 'CAD', 2000); // market best = 2000
      const max102 = 2000 * 1.02; // 2040
      expect(result.initialOffer).toBeLessThanOrEqual(max102);
    });

    test('USD currency uses different thresholds', () => {
      const cadResult = calculateNegotiationParams(1000, 'CAD');
      const usdResult = calculateNegotiationParams(1000, 'USD');

      // CAD has higher thresholds ($270 floor vs $200 USD)
      expect(cadResult.finalOffer).toBeGreaterThan(usdResult.finalOffer);
    });

    test('concession steps decrease by equal percentages', () => {
      const result = calculateNegotiationParams(2000, 'CAD');
      const maxConcession = result.initialOffer - result.finalOffer;
      const step1Reduction = result.initialOffer - result.concessionStep1;
      const step2Reduction = result.initialOffer - result.concessionStep2;

      expect(step1Reduction).toBeCloseTo(maxConcession * 0.33, 0);
      expect(step2Reduction).toBeCloseTo(maxConcession * 0.67, 0);
    });
  });

  // ========================================================================
  // estimateSimpleCost Tests
  // ========================================================================

  describe('estimateSimpleCost', () => {
    test('simple estimate for 250 miles in CAD', () => {
      const result = estimateSimpleCost(250, 'CA');
      // $500 base + $75 deadhead + $62.50 fuel + $75 + $35 = $747.50 + factoring
      expect(result).toBeGreaterThan(700);
      expect(result).toBeLessThan(800);
    });

    test('USD vs CAD rates differ', () => {
      const cadCost = estimateSimpleCost(250, 'CA');
      const usdCost = estimateSimpleCost(250, 'US');
      expect(cadCost).toBeGreaterThan(usdCost);
    });

    test('includes all components', () => {
      const cost = estimateSimpleCost(100, 'CA');
      // Min: 200 base + 30 deadhead + 25 fuel + 75 + 35 = 365 + factoring ~376
      expect(cost).toBeGreaterThan(350);
    });
  });

  // ========================================================================
  // Integration Tests
  // ========================================================================

  describe('Integration: Full Cost Workflow', () => {
    test('complete workflow: cost → margin → negotiation', () => {
      // Step 1: Calculate cost
      const breakdown = calculateTotalCost(SUDBURY_CORRIDOR_PARAMS);
      expect(breakdown.total).toBeGreaterThan(0);

      // Step 2: Estimate margin at opening rate
      const openingRate = 2400;
      const marginEstimate = estimateMargin(
        openingRate,
        breakdown.total,
        'CAD'
      );
      expect(marginEstimate.isAboveTarget).toBe(true);

      // Step 3: Build negotiation envelope
      const envelope = calculateNegotiationParams(
        breakdown.total,
        'CAD',
        2800
      );
      expect(envelope.initialOffer).toBeCloseTo(openingRate, 1);
    });

    test('brief compiler scenario: Sudbury load', () => {
      // From T-08 example: Toronto → Sudbury
      const params: CostCalculationParams = {
        distanceMiles: 250,
        distanceKm: 402,
        carrierRate: 2.0,
        fuelPricePerLitre: 1.35,
        originCountry: 'CA',
        destinationCountry: 'CA',
        isCrossBorder: false,
        accessorials: 75,
        adminOverhead: 35,
      };

      const breakdown = calculateTotalCost(params);

      // Per brief spec: totalCost should be around $1850
      expect(breakdown.total).toBeGreaterThan(1700);
      expect(breakdown.total).toBeLessThan(1950);

      // Per brief spec example: initialOffer = $2400
      const envelope = calculateNegotiationParams(
        breakdown.total,
        'CAD',
        2800
      );
      expect(envelope.initialOffer).toBeCloseTo(2400, 30); // within ~$30

      // Can achieve $550 margin (difference between 2400 and ~1850)
      const margin = estimateMargin(2400, breakdown.total, 'CAD');
      expect(margin.dollarMargin).toBeGreaterThan(450);
    });

    test('cross-border workflow includes border fee', () => {
      const params: CostCalculationParams = {
        distanceMiles: 400,
        carrierRate: 1.5,
        fuelPricePerLitre: 1.4,
        originCountry: 'US',
        destinationCountry: 'CA',
        isCrossBorder: true,
      };

      const breakdown = calculateTotalCost(params);

      // Should include $250 cross-border fee
      expect(breakdown.crossBorderFees).toBe(250);
      expect(breakdown.total).toBeGreaterThan(0);

      // Cost should be substantially higher than domestic equivalent
      const domesticParams: CostCalculationParams = {
        ...params,
        isCrossBorder: false,
        originCountry: 'US',
        destinationCountry: 'US',
      };
      const domesticBreakdown = calculateTotalCost(domesticParams);
      expect(breakdown.total).toBeGreaterThan(
        domesticBreakdown.total + 200
      );
    });
  });

  // ========================================================================
  // Edge Cases & Error Handling
  // ========================================================================

  describe('Edge Cases', () => {
    test('very short haul: 10 miles', () => {
      const result = calculateTotalCost({
        distanceMiles: 10,
        carrierRate: 2.0,
        fuelPricePerLitre: 1.35,
        originCountry: 'CA',
        destinationCountry: 'CA',
        isCrossBorder: false,
      });
      expect(result.total).toBeGreaterThan(0);
      expect(result.baseCost).toBe(20);
    });

    test('long haul: 2000 miles', () => {
      const result = calculateTotalCost({
        distanceMiles: 2000,
        carrierRate: 1.5,
        fuelPricePerLitre: 1.5,
        originCountry: 'US',
        destinationCountry: 'US',
        isCrossBorder: false,
      });
      expect(result.total).toBeGreaterThan(3000);
    });

    test('high fuel price surcharge', () => {
      const expensive = calculateFuelSurcharge(3.0, 1000);
      const cheap = calculateFuelSurcharge(1.3, 1000);
      expect(expensive).toBeGreaterThan(cheap + 500);
    });

    test('decimal precision maintained through calculation chain', () => {
      const result = calculateTotalCost({
        distanceMiles: 123.45,
        carrierRate: 1.75,
        fuelPricePerLitre: 1.555,
        originCountry: 'CA',
        destinationCountry: 'CA',
        isCrossBorder: false,
        accessorials: 73.50,
        adminOverhead: 42.33,
      });
      // All values should be rounded to 2 decimal places
      expect(result.baseCost % 0.01).toBeLessThan(0.001);
      expect(result.total % 0.01).toBeLessThan(0.001);
    });
  });
});

// ============================================================================
// EXPORT TEST SUITE (for test runner)
// ============================================================================

export {};
