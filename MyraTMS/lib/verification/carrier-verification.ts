/**
 * E2-03 M4 — carrier authority verification ("Gate 2").
 *
 * Reuses E2-01's lookupAuthority() (same FMCSA/SAFER chain, same cache, same
 * audit table) with the question flipped: instead of "is this poster a
 * shipper or a broker" (E2-01's use, in qualifier-worker.ts), this asks "is
 * this carrier's authority active, is the legal name a match, is there an
 * operating-classification red flag." Does not build a second lookup client
 * — see PRD §8.
 *
 * No re-verification expiry policy: carriers.verified_at IS NOT NULL is
 * treated as verified indefinitely. Not asked for by the PRD; a future
 * session can add a staleness window if the operator wants one.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { lookupAuthority } from './authority-lookup';
import { inferCountry } from '@/lib/loadboards/normalize-helpers';
import type { AuthorityLookupResult, EntityClass } from './authority-lookup-types';

export type CarrierVerificationReason =
  | 'lookup_unresolved'
  | 'not_for_hire_authority'
  | 'authority_inactive'
  | 'legal_name_mismatch';

export interface CarrierVerificationResult {
  verified: boolean;
  reason: CarrierVerificationReason | null;
  entityClass: EntityClass;
  legalNameMatch: boolean | null; // null = couldn't evaluate (no legalName returned)
  snapshot: AuthorityLookupResult;
}

interface CarrierRow {
  company: string;
  mc_number: string | null;
  dot_number: string | null;
  home_city: string | null;
  verified_at: Date | null;
  verification_snapshot: AuthorityLookupResult | null;
}

const STOP_WORDS = new Set(['inc', 'ltd', 'ltee', 'corp', 'co', 'llc', 'limited', 'the', 'and']);

function normalizeCompanyTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[.,'"]/g, '')
      .split(/\s+/)
      .filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok)),
  );
}

/**
 * Lenient overlap check, not exact match — carrier names on file often
 * differ from FMCSA's legal name in minor ways (DBA vs legal, punctuation,
 * suffix variants). A gross mismatch (zero shared significant tokens) is
 * the actual red flag this guards against; minor spelling drift is not
 * this function's job to catch.
 */
function legalNameLooksLikeMatch(carrierCompany: string, legalName: string): boolean {
  const a = normalizeCompanyTokens(carrierCompany);
  const b = normalizeCompanyTokens(legalName);
  if (a.size === 0 || b.size === 0) return true; // nothing meaningful to compare — don't flag
  for (const tok of a) {
    if (b.has(tok)) return true;
  }
  return false;
}

function countryFromHomeCity(homeCity: string | null): 'CA' | 'US' {
  if (!homeCity) return 'US';
  const m = /,\s*([A-Za-z]{2})\s*$/.exec(homeCity);
  if (!m) return 'US';
  return inferCountry(m[1].toUpperCase());
}

export async function verifyCarrierAuthority(
  carrierId: string,
  opts: { verifiedBy?: string } = {},
): Promise<CarrierVerificationResult> {
  const r = await db.query<CarrierRow>(
    `SELECT company, mc_number, dot_number, home_city, verified_at, verification_snapshot
     FROM carriers WHERE id = $1`,
    [carrierId],
  );
  const carrier = r.rows[0];
  if (!carrier) {
    throw new Error(`verifyCarrierAuthority: carrier ${carrierId} not found`);
  }

  if (carrier.verified_at && carrier.verification_snapshot) {
    const snapshot = carrier.verification_snapshot;
    return {
      verified: true,
      reason: null,
      entityClass: snapshot.entityClass,
      legalNameMatch: snapshot.legalName ? legalNameLooksLikeMatch(carrier.company, snapshot.legalName) : null,
      snapshot,
    };
  }

  const mcNumber = carrier.mc_number?.trim() || undefined;
  const dotNumber = carrier.dot_number?.trim() || undefined;
  const result = await lookupAuthority({
    mcNumber,
    dotNumber,
    companyName: carrier.company,
    country: countryFromHomeCity(carrier.home_city),
  });

  const legalNameMatch = result.legalName ? legalNameLooksLikeMatch(carrier.company, result.legalName) : null;

  let reason: CarrierVerificationReason | null = null;
  if (result.status !== 'resolved') {
    reason = 'lookup_unresolved';
  } else if (result.entityClass !== 'carrier_for_hire') {
    reason = 'not_for_hire_authority';
  } else if (result.authority.commonOrContract !== 'active') {
    reason = 'authority_inactive';
  } else if (legalNameMatch === false) {
    reason = 'legal_name_mismatch';
  }

  const verified = reason === null;

  if (verified) {
    await db.query(
      `UPDATE carriers
       SET verified_at = NOW(), verified_by = $2, verification_snapshot = $3
       WHERE id = $1`,
      [carrierId, opts.verifiedBy ?? 'system:authority-lookup', JSON.stringify(result)],
    );
  }

  return {
    verified,
    reason,
    entityClass: result.entityClass,
    legalNameMatch,
    snapshot: result,
  };
}
