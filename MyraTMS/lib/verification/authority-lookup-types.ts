// lib/verification/authority-lookup-types.ts
// Types for the external authority-lookup provider chain. See
// Engine 2/E2-01_Engine2_Expansion_PRD.md §4.3.

export interface AuthorityLookupInput {
  mcNumber?: string;        // digits only — caller's responsibility to strip
  dotNumber?: string;       // digits only
  companyName?: string;     // raw; this module normalizes internally for cache keys
  country: 'CA' | 'US';
  provinceState?: string;   // used to disambiguate multi-match name searches
}

export type EntityClass =
  | 'broker'               // broker authority active (alone or dual with carrier)
  | 'carrier_for_hire'     // carrier authority, for-hire, no broker authority
  | 'carrier_private'      // carrier authority, private fleet (shipper with trucks)
  | 'shipper'              // registry-confirmed shipper, no operating authority
  | 'unknown';             // no record, ambiguous, or lookup failed

export type LookupProvider = 'fmcsa_qcmobile' | 'fmcsa_safer' | 'on_cvor' | 'none';
export type LookupStatus = 'resolved' | 'not_found' | 'ambiguous' | 'error';

export interface AuthorityLookupResult {
  entityClass: EntityClass;
  legalName: string | null;
  mcNumber: string | null;
  dotNumber: string | null;
  cvorNumber: string | null;
  provider: LookupProvider;
  authority: {
    broker: 'active' | 'inactive' | 'none' | 'unknown';
    commonOrContract: 'active' | 'inactive' | 'none' | 'unknown';
    operationClassification: 'for_hire' | 'private' | 'unknown';
  };
  status: LookupStatus;
  latencyMs: number;
  rawSnapshot: unknown;
}
