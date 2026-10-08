// lib/contract-intake/__tests__/validate-rate.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { quotePricing } from '@/lib/pricing/pricing-engine';
import { resolveMargin } from '@/lib/pricing/resolve-margin';
import { validateTenderedRate } from '@/lib/contract-intake/validate-rate';
import type { ExtractedTenderTerms } from '@/lib/documents/tender-terms';

// Fixed Chicago->Dallas distance: keeps the test free of live Mapbox calls.
vi.mock('@/lib/quoting/geo/distance-service', () => ({
  resolveAddressToDistance: vi.fn(async () => ({
    distanceMiles: 925, distanceKm: 1489, driveTimeHours: 14,
    originLat: 41.88, originLng: -87.63, originRegion: 'midwest',
    destLat: 32.78, destLng: -96.8, destRegion: 'south',
  })),
}));

const BASE_TENDER: ExtractedTenderTerms = {
  rate: 3000, rateCurrency: 'USD',
  originCity: 'Chicago', originState: 'IL', originCountry: 'US',
  destinationCity: 'Dallas', destinationState: 'TX', destinationCountry: 'US',
  equipmentType: 'Dry Van', commodity: 'General Freight', weightLbs: 20000,
  pickupDate: '2026-09-15',
};

describe('validateTenderedRate (acceptance criterion 4)', () => {
  let tenantId: number;
  beforeEach(async () => {
    // No live Claude call: rate-cascade skips its AI step when the key is unset
    // and falls back to benchmark rates (deterministic, no cost).
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    tenantId = await getMyraTenantId();
  });

  it('accepts a tender with an explicit override floor of $0 (any positive margin clears)', async () => {
    const result = await validateTenderedRate(tenantId, BASE_TENDER, 0);
    expect(result.acceptable).toBe(true);
    expect(result.marginFloor).toBe(0);
  });

  it('flags a tender when the override floor is set impossibly high', async () => {
    const result = await validateTenderedRate(tenantId, BASE_TENDER, 1_000_000);
    expect(result.acceptable).toBe(false);
    expect(result.reason).toContain('Below tenant margin floor');
  });

  it('flags a tender with missing required fields as unacceptable, not a thrown error', async () => {
    const incomplete: ExtractedTenderTerms = { ...BASE_TENDER, equipmentType: null };
    const result = await validateTenderedRate(tenantId, incomplete, 0);
    expect(result.acceptable).toBe(false);
    expect(result.reason).toContain('could not be fully parsed');
  });

  it('uses the tenant default floor when no override is given, and reports the real dollar margin', async () => {
    const result = await validateTenderedRate(tenantId, BASE_TENDER);
    const expectedFloor = (await resolveMargin(tenantId, 'USD')).margin.minMargin;
    const quote = await quotePricing({
      tenantId, direction: 'sell', requestSource: 'contract_intake_validation',
      load: {
        originCity: 'Chicago', originState: 'IL', originCountry: 'US',
        destinationCity: 'Dallas', destinationState: 'TX', destinationCountry: 'US',
        equipmentType: 'Dry Van', postedRate: 3000,
      },
    });
    expect(result.marginFloor).toBe(expectedFloor);
    expect(result.dollarMargin).toBeCloseTo(3000 - quote.cost.total, 2);
    expect(result.acceptable).toBe(result.dollarMargin >= expectedFloor);
  });
});
