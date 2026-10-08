// Mirror of MyraTMS/lib/pipeline/poster-identity.ts (plus the
// normalizeCompanyName() from MyraTMS/lib/pipeline/load-source-classifier.ts)
// — keep byte-identical. The scraper cannot import across projects.
/**
 * Poster identity helpers (E2-01 §4.2). Pure; shared by the CSV/API scanner
 * and, by byte-identical copy, the Railway scraper.
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

/** Same rule as the MyraTMS classifier: lowercase, strip punctuation + legal suffixes. */
export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\b(inc|ltd|lt[ée]e|corp|co|llc|limited)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
