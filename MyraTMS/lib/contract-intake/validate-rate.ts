// lib/contract-intake/validate-rate.ts
//
// T-30 §4.3 (design-corrected — see design doc §2.3/§2a): a thin wrapper on
// T-21's quotePricing(), not new pricing logic. Compares a DOLLAR margin
// (tender.rate - cost.total) against resolveMargin()'s minMargin, which is
// also a dollar amount — this codebase's margin system has no percentage
// concept anywhere (confirmed via computeSellEnvelope()).
import { quotePricing } from '@/lib/pricing/pricing-engine';
import { resolveMargin } from '@/lib/pricing/resolve-margin';
import type { ExtractedTenderTerms } from '@/lib/documents/tender-terms';

export interface TenderValidationResult {
  acceptable: boolean;
  dollarMargin: number;
  marginFloor: number;
  reason: string;
}

export async function validateTenderedRate(
  tenantId: number,
  tender: ExtractedTenderTerms,
  marginFloorOverrideAmount?: number | null,
): Promise<TenderValidationResult> {
  if (
    tender.rate === null || tender.originCity === null || tender.originState === null || tender.originCountry === null ||
    tender.destinationCity === null || tender.destinationState === null || tender.destinationCountry === null ||
    tender.equipmentType === null
  ) {
    return { acceptable: false, dollarMargin: 0, marginFloor: 0, reason: 'Tender could not be fully parsed — required fields missing' };
  }

  const currency = tender.rateCurrency ?? 'USD';
  const quote = await quotePricing({
    tenantId,
    direction: 'sell',
    requestSource: 'contract_intake_validation',
    load: {
      originCity: tender.originCity, originState: tender.originState, originCountry: tender.originCountry,
      destinationCity: tender.destinationCity, destinationState: tender.destinationState, destinationCountry: tender.destinationCountry,
      equipmentType: tender.equipmentType,
      postedRate: tender.rate,
    },
  });

  const marginFloor = marginFloorOverrideAmount ?? (await resolveMargin(tenantId, currency)).margin.minMargin;
  const dollarMargin = tender.rate - quote.cost.total;
  const acceptable = dollarMargin >= marginFloor;

  return {
    acceptable,
    dollarMargin,
    marginFloor,
    reason: acceptable ? 'Clears margin floor' : 'Below tenant margin floor — human decision required',
  };
}
