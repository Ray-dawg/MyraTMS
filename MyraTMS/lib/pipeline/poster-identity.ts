/**
 * Poster identity helpers (E2-01 §4.2). Pure; shared by the CSV/API scanner
 * and, by byte-identical copy, the Railway scraper at
 * scraper/src/pipeline/poster-identity.ts (it cannot import from MyraTMS).
 */
export interface PosterFields {
  posterCompanyRaw: string | null;
  posterMcNumber: string | null;
  posterDotNumber: string | null;
}

/** 'MC-123456' -> '123456'; 'n/a' -> null. Digits only, per §4.2. */
export function normalizeIdNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits.length > 0 ? digits : null;
}

export function posterFromRawLoad(load: {
  shipperCompany: string | null;
  posterCompanyRaw?: string | null;
  posterMcNumber?: string | null;
  posterDotNumber?: string | null;
}): PosterFields {
  const company = (load.posterCompanyRaw ?? load.shipperCompany ?? '').trim();
  return {
    posterCompanyRaw: company.length > 0 ? company : null,
    posterMcNumber: normalizeIdNumber(load.posterMcNumber),
    posterDotNumber: normalizeIdNumber(load.posterDotNumber),
  };
}
