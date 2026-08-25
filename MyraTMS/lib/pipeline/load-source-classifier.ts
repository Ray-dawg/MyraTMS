/**
 * The F1 filter: classifies a load's poster as shipper-direct, co-brokered,
 * broker-posted, carrier-reposted, or unresolved. See
 * Engine 2/E2-01_Engine2_Expansion_PRD.md §4.4-§4.6, §4.9.
 *
 * classifyLoadSource() is pure — it decides from pre-resolved inputs
 * (registry hit, lookup result, agreement match) rather than querying the
 * DB itself. findRegistryHit()/findActiveAgreement() are the two DB-facing
 * helpers that resolve those inputs; callers (Session 2's Qualifier, this
 * session's backfill script) compose them.
 */

import { db } from '@/lib/pipeline/db-adapter';
import type { AuthorityLookupResult } from '@/lib/verification/authority-lookup';

export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\b(inc|ltd|lt[ée]e|corp|co|llc|limited)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Appendix B — Broker-signal tokens. Strong tokens drive row 11's
// auto-reject; weak tokens are documentation only per the PRD ("must not
// drive a reject") and are not consulted by classifyLoadSource in Session 1.
export const STRONG_BROKER_TOKENS = [
  'logistics', 'logistique', 'brokerage', 'freight solutions', 'freight services',
  'freight management', '3pl', 'forwarding', 'forwarders', 'transport solutions',
  'cargo solutions', 'supply chain solutions', 'load services', 'dispatch services',
];
export const WEAK_BROKER_TOKENS = ['transport', 'trucking', 'express', 'carriers', 'lines'];

function matchesStrongBrokerToken(normalizedName: string | null): boolean {
  if (!normalizedName) return false;
  return STRONG_BROKER_TOKENS.some((t) => normalizedName.includes(t));
}

export interface PosterIdentity {
  companyRaw: string | null;
  companyNormalized: string | null;
  mcNumber: string | null;
  dotNumber: string | null;
}

export type RegistryEntityClass = 'broker' | 'carrier_for_hire' | 'carrier_private' | 'shipper' | 'unknown';

export interface RegistryHit {
  id: number;
  entityClass: RegistryEntityClass;
  confidence: number;
}

export interface CoBrokerAgreementMatch {
  id: number;
  status: 'active' | 'expired' | 'terminated';
}

export interface ManualAttestation {
  value: 'yes' | 'no' | 'unknown';
}

export type LoadSourceClass = 'shipper_direct' | 'co_brokered' | 'broker_posted' | 'carrier_reposted' | 'unresolved';
export type LoadSourceMethod = 'registry' | 'fmcsa_authority' | 'co_broker_agreement' | 'manual_attestation' | 'heuristic' | 'human_review';
export type Verdict = 'accept' | 'reject' | 'review';

export interface ClassifyLoadSourceInput {
  poster: PosterIdentity;
  isManualImport: boolean;
  attestation: ManualAttestation | null;
  registryHit: RegistryHit | null;
  lookupResult: AuthorityLookupResult | null;
  agreementMatch: CoBrokerAgreementMatch | null;
}

export interface ClassifyLoadSourceResult {
  class: LoadSourceClass;
  verdict: Verdict;
  method: LoadSourceMethod | null;
  confidence: number;
  reasonCode: string | null;
  evidence: Record<string, unknown>;
}

function hasNoIdentity(poster: PosterIdentity): boolean {
  return !poster.companyRaw && !poster.mcNumber && !poster.dotNumber;
}

function hasActiveAgreement(agreementMatch: CoBrokerAgreementMatch | null): boolean {
  return agreementMatch !== null && agreementMatch.status === 'active';
}

export function classifyLoadSource(input: ClassifyLoadSourceInput): ClassifyLoadSourceResult {
  const { poster, isManualImport, attestation, registryHit, lookupResult, agreementMatch } = input;
  const evidence: Record<string, unknown> = { poster, registryHit, lookupResult: lookupResult ? { status: lookupResult.status, entityClass: lookupResult.entityClass, provider: lookupResult.provider } : null, agreementMatch };

  // Rows 0-2: manual import — attestation is authoritative, identity is not consulted.
  if (isManualImport) {
    if (attestation?.value === 'no') {
      return { class: 'broker_posted', verdict: 'reject', method: 'manual_attestation', confidence: 1.0, reasonCode: 'broker_posted_attested', evidence };
    }
    if (attestation?.value === 'yes') {
      return { class: 'shipper_direct', verdict: 'accept', method: 'manual_attestation', confidence: 1.0, reasonCode: null, evidence };
    }
    // attestation === 'unknown' or missing (defensive — §4.8 requires it, fail closed if it's somehow absent)
    return { class: 'unresolved', verdict: 'review', method: null, confidence: 0, reasonCode: 'poster_unresolved_review', evidence };
  }

  // Rows 3-6: registry hit.
  if (registryHit) {
    if (registryHit.entityClass === 'broker') {
      if (hasActiveAgreement(agreementMatch)) {
        return { class: 'co_brokered', verdict: 'accept', method: 'co_broker_agreement', confidence: registryHit.confidence, reasonCode: null, evidence };
      }
      return { class: 'broker_posted', verdict: 'reject', method: 'registry', confidence: registryHit.confidence, reasonCode: 'broker_posted_no_agreement', evidence };
    }
    if ((registryHit.entityClass === 'shipper' || registryHit.entityClass === 'carrier_private') && registryHit.confidence >= 0.8) {
      return { class: 'shipper_direct', verdict: 'accept', method: 'registry', confidence: registryHit.confidence, reasonCode: null, evidence };
    }
    if (registryHit.entityClass === 'carrier_for_hire') {
      return { class: 'carrier_reposted', verdict: 'review', method: 'registry', confidence: registryHit.confidence, reasonCode: 'poster_carrier_reposted_review', evidence };
    }
    // registryHit.entityClass is 'unknown', or shipper/carrier_private below confidence 0.8 — fall through to unresolved review, never silently accept a low-confidence hit.
    return { class: 'unresolved', verdict: 'review', method: 'registry', confidence: registryHit.confidence, reasonCode: 'poster_unresolved_review', evidence };
  }

  // Rows 7-13: no registry hit — decide from the external lookup.
  if (lookupResult) {
    if (lookupResult.status === 'ambiguous' || lookupResult.status === 'error') {
      return { class: 'unresolved', verdict: 'review', method: null, confidence: 0, reasonCode: 'authority_lookup_failed_review', evidence };
    }

    if (lookupResult.status === 'resolved') {
      if (lookupResult.authority.broker === 'active') {
        if (hasActiveAgreement(agreementMatch)) {
          return { class: 'co_brokered', verdict: 'accept', method: 'co_broker_agreement', confidence: 0.9, reasonCode: null, evidence };
        }
        return { class: 'broker_posted', verdict: 'reject', method: 'fmcsa_authority', confidence: 0.9, reasonCode: 'broker_posted_no_agreement', evidence };
      }
      if (lookupResult.authority.operationClassification === 'private') {
        return { class: 'shipper_direct', verdict: 'accept', method: 'fmcsa_authority', confidence: 0.9, reasonCode: null, evidence };
      }
      if (lookupResult.authority.operationClassification === 'for_hire') {
        return { class: 'carrier_reposted', verdict: 'review', method: 'fmcsa_authority', confidence: 0.7, reasonCode: 'poster_carrier_reposted_review', evidence };
      }
      // resolved but operationClassification unknown (e.g. carrier authority exists but we can't tell private vs for-hire)
      return { class: 'unresolved', verdict: 'review', method: 'fmcsa_authority', confidence: 0.5, reasonCode: 'poster_unresolved_review', evidence };
    }

    if (lookupResult.status === 'not_found') {
      if (matchesStrongBrokerToken(poster.companyNormalized)) {
        return { class: 'broker_posted', verdict: 'reject', method: 'heuristic', confidence: 0.7, reasonCode: 'broker_posted_inferred', evidence };
      }
      return { class: 'unresolved', verdict: 'review', method: null, confidence: 0, reasonCode: 'poster_unresolved_review', evidence };
    }
  }

  // Row 14 / fallback: no registry hit, no lookup was performed (or possible), and no identity to act on.
  if (hasNoIdentity(poster)) {
    return { class: 'unresolved', verdict: 'reject', method: null, confidence: 0, reasonCode: 'poster_identity_missing', evidence };
  }

  // Defensive fallback: identity exists but neither a registry hit nor a lookup result was supplied.
  // Not a documented §4.5 row — a caller bug (lookup should always be attempted on registry miss when
  // identity exists) — but fails closed rather than silently accepting.
  return { class: 'unresolved', verdict: 'review', method: null, confidence: 0, reasonCode: 'poster_unresolved_review', evidence };
}

export async function findRegistryHit(
  mcNumber: string | null,
  dotNumber: string | null,
  normalizedName: string | null,
  country: string | null,
): Promise<RegistryHit | null> {
  if (mcNumber) {
    const r = await db.query<{ id: number; entity_class: RegistryEntityClass; confidence: string }>(
      `SELECT id, entity_class, confidence FROM poster_registry WHERE mc_number = $1 LIMIT 1`, [mcNumber],
    );
    if (r.rows.length) return { id: r.rows[0].id, entityClass: r.rows[0].entity_class, confidence: Number(r.rows[0].confidence) };
  }
  if (dotNumber) {
    const r = await db.query<{ id: number; entity_class: RegistryEntityClass; confidence: string }>(
      `SELECT id, entity_class, confidence FROM poster_registry WHERE dot_number = $1 LIMIT 1`, [dotNumber],
    );
    if (r.rows.length) return { id: r.rows[0].id, entityClass: r.rows[0].entity_class, confidence: Number(r.rows[0].confidence) };
  }
  if (normalizedName) {
    const r = await db.query<{ id: number; entity_class: RegistryEntityClass; confidence: string }>(
      `SELECT id, entity_class, confidence FROM poster_registry WHERE normalized_name = $1 AND ($2::varchar IS NULL OR country IS NULL OR country = $2) ORDER BY confidence DESC LIMIT 1`,
      [normalizedName, country],
    );
    if (r.rows.length) return { id: r.rows[0].id, entityClass: r.rows[0].entity_class, confidence: Number(r.rows[0].confidence) };
  }
  return null;
}

export async function findActiveAgreement(
  mcNumber: string | null,
  normalizedName: string | null,
): Promise<CoBrokerAgreementMatch | null> {
  if (mcNumber) {
    const r = await db.query<{ id: number; status: 'active' | 'expired' | 'terminated' }>(
      `SELECT id, status FROM co_broker_agreements WHERE counterparty_mc_number = $1 AND status = 'active' ORDER BY agreement_executed_at DESC LIMIT 1`,
      [mcNumber],
    );
    if (r.rows.length) return r.rows[0];
  }
  if (normalizedName) {
    const r = await db.query<{ id: number; status: 'active' | 'expired' | 'terminated' }>(
      `SELECT id, status FROM co_broker_agreements WHERE counterparty_name_normalized = $1 AND status = 'active' ORDER BY agreement_executed_at DESC LIMIT 1`,
      [normalizedName],
    );
    if (r.rows.length) return r.rows[0];
  }
  return null;
}

