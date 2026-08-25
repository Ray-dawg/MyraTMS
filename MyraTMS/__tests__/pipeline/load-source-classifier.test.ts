import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import {
  normalizeCompanyName,
  classifyLoadSource,
  findRegistryHit,
  findActiveAgreement,
  type ClassifyLoadSourceInput,
} from '@/lib/pipeline/load-source-classifier';

const RUN_ID = Date.now();

describe('normalizeCompanyName', () => {
  it('lowercases, strips punctuation and legal suffixes, collapses whitespace', () => {
    expect(normalizeCompanyName('Acme Freight Solutions, Inc.')).toBe('acme freight solutions');
    expect(normalizeCompanyName("Maple  Freight   Ltée")).toBe('maple freight');
    expect(normalizeCompanyName('J&R TRUCKING CORP')).toBe('j&r trucking');
  });
});

describe('classifyLoadSource — §4.5 decision table rows 0-14', () => {
  const base: ClassifyLoadSourceInput = {
    poster: { companyRaw: 'Acme Co', companyNormalized: 'acme co', mcNumber: null, dotNumber: null },
    isManualImport: false,
    attestation: null,
    registryHit: null,
    lookupResult: null,
    agreementMatch: null,
  };

  it('row 0: manual import, attestation=no → REJECT broker_posted_attested', () => {
    const r = classifyLoadSource({ ...base, isManualImport: true, attestation: { value: 'no' } });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject', method: 'manual_attestation', confidence: 1.0, reasonCode: 'broker_posted_attested' });
  });

  it('row 1: manual import, attestation=yes → ACCEPT shipper_direct', () => {
    const r = classifyLoadSource({ ...base, isManualImport: true, attestation: { value: 'yes' } });
    expect(r).toMatchObject({ class: 'shipper_direct', verdict: 'accept', method: 'manual_attestation', confidence: 1.0, reasonCode: null });
  });

  it('row 2: manual import, attestation=unknown → REVIEW poster_unresolved_review', () => {
    const r = classifyLoadSource({ ...base, isManualImport: true, attestation: { value: 'unknown' } });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'review', reasonCode: 'poster_unresolved_review' });
  });

  it('row 3: registry broker + active agreement → ACCEPT co_brokered', () => {
    const r = classifyLoadSource({
      ...base,
      registryHit: { id: 1, entityClass: 'broker', confidence: 0.9 },
      agreementMatch: { id: 1, status: 'active' },
    });
    expect(r).toMatchObject({ class: 'co_brokered', verdict: 'accept', method: 'co_broker_agreement', reasonCode: null });
  });

  it('row 4: registry broker, no agreement → REJECT broker_posted_no_agreement', () => {
    const r = classifyLoadSource({ ...base, registryHit: { id: 1, entityClass: 'broker', confidence: 0.9 } });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject', method: 'registry', reasonCode: 'broker_posted_no_agreement' });
  });

  it('row 5: registry shipper, confidence >= 0.8 → ACCEPT shipper_direct', () => {
    const r = classifyLoadSource({ ...base, registryHit: { id: 1, entityClass: 'shipper', confidence: 0.9 } });
    expect(r).toMatchObject({ class: 'shipper_direct', verdict: 'accept', method: 'registry', reasonCode: null });
  });

  it('row 5b: registry carrier_private, confidence >= 0.8 → ACCEPT shipper_direct', () => {
    const r = classifyLoadSource({ ...base, registryHit: { id: 1, entityClass: 'carrier_private', confidence: 0.85 } });
    expect(r).toMatchObject({ class: 'shipper_direct', verdict: 'accept', method: 'registry' });
  });

  it('row 6: registry carrier_for_hire → REVIEW poster_carrier_reposted_review', () => {
    const r = classifyLoadSource({ ...base, registryHit: { id: 1, entityClass: 'carrier_for_hire', confidence: 0.9 } });
    expect(r).toMatchObject({ class: 'carrier_reposted', verdict: 'review', reasonCode: 'poster_carrier_reposted_review' });
  });

  it('row 7a: no registry hit, lookup broker active + agreement → ACCEPT co_brokered', () => {
    const r = classifyLoadSource({
      ...base,
      lookupResult: mkLookup({ entityClass: 'broker', broker: 'active' }),
      agreementMatch: { id: 2, status: 'active' },
    });
    expect(r).toMatchObject({ class: 'co_brokered', verdict: 'accept', method: 'co_broker_agreement' });
  });

  it('row 7b: no registry hit, lookup broker active, no agreement → REJECT broker_posted_no_agreement', () => {
    const r = classifyLoadSource({ ...base, lookupResult: mkLookup({ entityClass: 'broker', broker: 'active' }) });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject', method: 'fmcsa_authority', reasonCode: 'broker_posted_no_agreement' });
  });

  it('row 8: lookup carrier authority, private, no broker → ACCEPT shipper_direct conf 0.9', () => {
    const r = classifyLoadSource({ ...base, lookupResult: mkLookup({ entityClass: 'carrier_private', operationClassification: 'private' }) });
    expect(r).toMatchObject({ class: 'shipper_direct', verdict: 'accept', method: 'fmcsa_authority', confidence: 0.9, reasonCode: null });
  });

  it('row 9: lookup carrier authority, for_hire, no broker → REVIEW poster_carrier_reposted_review', () => {
    const r = classifyLoadSource({ ...base, lookupResult: mkLookup({ entityClass: 'carrier_for_hire', operationClassification: 'for_hire' }) });
    expect(r).toMatchObject({ class: 'carrier_reposted', verdict: 'review', method: 'fmcsa_authority', reasonCode: 'poster_carrier_reposted_review' });
  });

  it('row 10: lookup carrier authority, operationClassification unknown → REVIEW poster_unresolved_review', () => {
    const r = classifyLoadSource({ ...base, lookupResult: mkLookup({ entityClass: 'unknown', commonOrContract: 'active', operationClassification: 'unknown' }) });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'review', method: 'fmcsa_authority', reasonCode: 'poster_unresolved_review' });
  });

  it('row 11: lookup not_found + strong broker token in name → REJECT broker_posted_inferred conf 0.7', () => {
    const r = classifyLoadSource({
      ...base,
      poster: { companyRaw: 'Northern Logistics Inc', companyNormalized: normalizeCompanyName('Northern Logistics Inc'), mcNumber: null, dotNumber: null },
      lookupResult: { ...mkLookup({}), status: 'not_found', entityClass: 'unknown' },
    });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject', method: 'heuristic', confidence: 0.7, reasonCode: 'broker_posted_inferred' });
  });

  it('row 12: lookup not_found, no broker tokens, no registry → REVIEW poster_unresolved_review', () => {
    const r = classifyLoadSource({ ...base, lookupResult: { ...mkLookup({}), status: 'not_found', entityClass: 'unknown' } });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'review', reasonCode: 'poster_unresolved_review' });
  });

  it('row 13a: lookup ambiguous → REVIEW authority_lookup_failed_review', () => {
    const r = classifyLoadSource({ ...base, lookupResult: { ...mkLookup({}), status: 'ambiguous', entityClass: 'unknown' } });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'review', reasonCode: 'authority_lookup_failed_review' });
  });

  it('row 13b: lookup error → REVIEW authority_lookup_failed_review (never accept on infra failure)', () => {
    const r = classifyLoadSource({ ...base, lookupResult: { ...mkLookup({}), status: 'error', entityClass: 'unknown' } });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'review', reasonCode: 'authority_lookup_failed_review' });
  });

  it('row 14: no poster identity at all → REJECT poster_identity_missing', () => {
    const r = classifyLoadSource({
      ...base,
      poster: { companyRaw: null, companyNormalized: null, mcNumber: null, dotNumber: null },
    });
    expect(r).toMatchObject({ class: 'unresolved', verdict: 'reject', reasonCode: 'poster_identity_missing' });
  });

  // §4.12 extra cases (the 4 that test classifyLoadSource's own logic; the
  // other 4 — lookup timeout/429/ambiguous-name/resolved-name — are covered
  // in Task 2's authority-lookup.test.ts since they test the lookup client,
  // not this pure function)

  it('extra: dual-authority broker (broker + carrier) with active agreement → ACCEPT co_brokered', () => {
    const r = classifyLoadSource({
      ...base,
      registryHit: { id: 3, entityClass: 'broker', confidence: 0.95 }, // dual-authority posters are registered as 'broker' — that's the controlling class per §4.1
      agreementMatch: { id: 3, status: 'active' },
    });
    expect(r).toMatchObject({ class: 'co_brokered', verdict: 'accept' });
  });

  it('extra: expired agreement is treated as no agreement → REJECT broker_posted_no_agreement', () => {
    const r = classifyLoadSource({
      ...base,
      registryHit: { id: 4, entityClass: 'broker', confidence: 0.9 },
      agreementMatch: { id: 4, status: 'expired' },
    });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject', reasonCode: 'broker_posted_no_agreement' });
  });

  it('extra: private-fleet with lapsed FMCSA authority is still classified carrier_private (authority lapse is a T-25 concern, not source-class)', () => {
    const r = classifyLoadSource({
      ...base,
      lookupResult: { ...mkLookup({ entityClass: 'carrier_private', operationClassification: 'private' }), authority: { broker: 'none', commonOrContract: 'inactive', operationClassification: 'private' } },
    });
    expect(r).toMatchObject({ class: 'shipper_direct', verdict: 'accept', method: 'fmcsa_authority' });
  });

  it('terminated agreement is also treated as no agreement → REJECT', () => {
    const r = classifyLoadSource({
      ...base,
      registryHit: { id: 5, entityClass: 'broker', confidence: 0.9 },
      agreementMatch: { id: 5, status: 'terminated' },
    });
    expect(r).toMatchObject({ class: 'broker_posted', verdict: 'reject' });
  });
});

function mkLookup(partial: {
  entityClass?: 'broker' | 'carrier_for_hire' | 'carrier_private' | 'shipper' | 'unknown';
  broker?: 'active' | 'inactive' | 'none' | 'unknown';
  commonOrContract?: 'active' | 'inactive' | 'none' | 'unknown';
  operationClassification?: 'for_hire' | 'private' | 'unknown';
}) {
  return {
    entityClass: partial.entityClass ?? 'unknown',
    legalName: 'Test Corp', mcNumber: null, dotNumber: '123', cvorNumber: null,
    provider: 'fmcsa_qcmobile' as const,
    authority: {
      broker: partial.broker ?? (partial.entityClass === 'broker' ? 'active' : 'none'),
      commonOrContract: partial.commonOrContract ?? (partial.entityClass && partial.entityClass !== 'broker' && partial.entityClass !== 'shipper' ? 'active' : 'none'),
      operationClassification: partial.operationClassification ?? 'unknown',
    },
    status: 'resolved' as const,
    latencyMs: 10,
    rawSnapshot: {},
  };
}

describe('findRegistryHit / findActiveAgreement (DB-facing helpers)', () => {
  const testMc = `TESTMC${RUN_ID}`;
  const testName = `Test Registry Co ${RUN_ID}`;
  const testNormName = normalizeCompanyName(testName);
  let registryId: number;
  let agreementId: number;

  beforeAll(async () => {
    const tenant = await db.query<{ id: number }>(`SELECT id FROM tenants WHERE slug = 'myra'`, []);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error('myra tenant not found — is 027_multi_tenant_foundation.sql applied?');

    const reg = await db.query<{ id: number }>(
      `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, entity_class, class_source, confidence)
       VALUES ($1, $2, $3, 'broker', 'human_review', 0.9) RETURNING id`,
      [testName, testNormName, testMc],
    );
    registryId = reg.rows[0].id;

    const agr = await db.query<{ id: number }>(
      `INSERT INTO co_broker_agreements (tenant_id, counterparty_name, counterparty_name_normalized, counterparty_mc_number, agreement_executed_at, status)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active') RETURNING id`,
      [tenantId, testName, testNormName, testMc],
    );
    agreementId = agr.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM co_broker_agreements WHERE id = $1`, [agreementId]);
    await db.query(`DELETE FROM poster_registry WHERE id = $1`, [registryId]);
  });

  it('findRegistryHit resolves by mc_number', async () => {
    const hit = await findRegistryHit(testMc, null, 'irrelevant', 'US');
    expect(hit).toMatchObject({ id: registryId, entityClass: 'broker', confidence: 0.9 });
  });

  it('findRegistryHit resolves by normalized_name when mc/dot are absent', async () => {
    const hit = await findRegistryHit(null, null, testNormName, 'US');
    expect(hit).toMatchObject({ id: registryId });
  });

  it('findActiveAgreement resolves by mc_number', async () => {
    const match = await findActiveAgreement(testMc, 'irrelevant-name');
    expect(match).toMatchObject({ id: agreementId, status: 'active' });
  });

  it('findActiveAgreement resolves by normalized name when the poster has no MC (Canadian domestic case)', async () => {
    const match = await findActiveAgreement(null, testNormName);
    expect(match).toMatchObject({ id: agreementId, status: 'active' });
  });

  it('findActiveAgreement returns null when nothing matches', async () => {
    const match = await findActiveAgreement('NO-SUCH-MC', 'no such normalized name at all');
    expect(match).toBeNull();
  });
});
