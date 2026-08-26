import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { verifyCarrierAuthority, manuallyVerifyCarrier } from '@/lib/verification/carrier-verification';

const RUN_ID = Date.now();

async function seedCarrier(overrides: {
  id: string;
  company: string;
  mcNumber: string;
  dotNumber: string;
  homeCity?: string;
  preVerified?: boolean;
}) {
  await db.query(
    `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
       authority_status, insurance_status, insurance_expiry,
       liability_insurance, cargo_insurance, safety_rating,
       carrier_status, contact_phone, home_city,
       verified_at, verified_by, verification_snapshot,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
       750000, 100000, 'Not Rated', 'active', '+15550001111', $6,
       $7, $8, $9, NOW(), NOW())`,
    [
      overrides.id, LEGACY_DEFAULT_TENANT_ID, overrides.company, overrides.mcNumber, overrides.dotNumber,
      overrides.homeCity ?? null,
      overrides.preVerified ? new Date() : null,
      overrides.preVerified ? 'test:preseed' : null,
      overrides.preVerified
        ? JSON.stringify({
            entityClass: 'carrier_for_hire', legalName: overrides.company, mcNumber: overrides.mcNumber,
            dotNumber: overrides.dotNumber, cvorNumber: null, provider: 'fmcsa_qcmobile',
            authority: { broker: 'none', commonOrContract: 'active', operationClassification: 'for_hire' },
            status: 'resolved', latencyMs: 1, rawSnapshot: {},
          })
        : null,
    ],
  );
}

describe('verifyCarrierAuthority (E2-03 M4)', () => {
  let mockServer: http.Server;
  let responseQueue: Array<{ status: number; body: unknown }> = [];
  let requestCount = 0;
  const envBackup = { ...process.env };
  const seededIds: string[] = [];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      requestCount += 1;
      const next = responseQueue.shift();
      if (!next) { res.writeHead(500).end('no queued response'); return; }
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    process.env.FMCSA_QC_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.FMCSA_QC_WEBKEY = 'test-webkey';
    process.env.AUTHORITY_LOOKUP_TIMEOUT_MS = '2000';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    process.env = envBackup;
    if (seededIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededIds]);
    await db.query(`DELETE FROM authority_lookups WHERE lookup_key LIKE $1`, [`%${RUN_ID}%`]);
  });

  beforeEach(() => {
    responseQueue = [];
    requestCount = 0;
  });

  it('verifies a for-hire carrier with active authority and a matching legal name', async () => {
    const id = `VERCAR-A-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Northern Freight Lines', mcNumber: `MC${RUN_ID}A`, dotNumber: `DOT${RUN_ID}A`, homeCity: 'Toronto, ON' });

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Northern Freight Lines Inc',
            dotNumber: `DOT${RUN_ID}A`,
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'A',
            contractAuthorityStatus: 'N',
            operatingStatus: 'AUTHORIZED FOR Property',
          },
        }],
      },
    });

    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.entityClass).toBe('carrier_for_hire');
    expect(result.legalNameMatch).toBe(true);

    const row = await db.query<{ verified_at: Date | null; verified_by: string | null }>(
      `SELECT verified_at, verified_by FROM carriers WHERE id = $1`, [id],
    );
    expect(row.rows[0].verified_at).not.toBeNull();
    expect(row.rows[0].verified_by).toBe('system:authority-lookup');
  });

  it('fails verification when the lookup resolves a broker, not a carrier (not_for_hire_authority)', async () => {
    const id = `VERCAR-B-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Suspicious Broker Co', mcNumber: `MC${RUN_ID}B`, dotNumber: `DOT${RUN_ID}B` });

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Suspicious Broker Co',
            dotNumber: `DOT${RUN_ID}B`,
            brokerAuthorityStatus: 'A',
            commonAuthorityStatus: 'N',
            contractAuthorityStatus: 'N',
          },
        }],
      },
    });

    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('not_for_hire_authority');
    expect(result.entityClass).toBe('broker');

    const row = await db.query<{ verified_at: Date | null }>(`SELECT verified_at FROM carriers WHERE id = $1`, [id]);
    expect(row.rows[0].verified_at).toBeNull();
  });

  it('fails verification when authority has lapsed (classifyFromQcCarrier resolves this as not_for_hire_authority, not a distinct authority_inactive case, given commonOrContract and entityClass are derived from the same underlying flag in the QC Mobile provider)', async () => {
    const id = `VERCAR-C-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Lapsed Authority Trucking', mcNumber: `MC${RUN_ID}C`, dotNumber: `DOT${RUN_ID}C` });

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Lapsed Authority Trucking',
            dotNumber: `DOT${RUN_ID}C`,
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'I',
            contractAuthorityStatus: 'I',
            operatingStatus: 'AUTHORIZED FOR Property',
          },
        }],
      },
    });

    // authority-lookup.ts's classifyFromQcCarrier() derives both entityClass
    // and authority.commonOrContract from the same carrierAuthority boolean
    // (commonActive || contractActive), so a lapsed carrier never reaches
    // carrier-verification.ts's 'authority_inactive' branch through THIS
    // provider -- it's caught one check earlier, at entityClass. The
    // authority_inactive reason stays in the type for a provider whose
    // classification can disagree (e.g. a cached snapshot going stale) --
    // this test documents the actual behavior through the live provider
    // chain rather than asserting an unreachable-today branch.
    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('not_for_hire_authority');
  });

  it('fails verification on a gross legal-name mismatch (legal_name_mismatch)', async () => {
    const id = `VERCAR-D-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Prairie Grain Haulers', mcNumber: `MC${RUN_ID}D`, dotNumber: `DOT${RUN_ID}D` });

    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Completely Different Entity Logistics',
            dotNumber: `DOT${RUN_ID}D`,
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'A',
            contractAuthorityStatus: 'N',
            operatingStatus: 'AUTHORIZED FOR Property',
          },
        }],
      },
    });

    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('legal_name_mismatch');
    expect(result.legalNameMatch).toBe(false);
  });

  it('fails verification when the lookup cannot resolve the carrier at all (lookup_unresolved)', async () => {
    const id = `VERCAR-E-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'No FMCSA Record Co', mcNumber: `MC${RUN_ID}E`, dotNumber: `DOT${RUN_ID}E` });

    responseQueue.push({ status: 200, body: { content: [] } });

    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('lookup_unresolved');
  });

  it('short-circuits on an already-verified carrier — zero HTTP requests to the lookup provider', async () => {
    const id = `VERCAR-F-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Already Verified Freight', mcNumber: `MC${RUN_ID}F`, dotNumber: `DOT${RUN_ID}F`, preVerified: true });

    const result = await verifyCarrierAuthority(id);
    expect(result.verified).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('throws for a nonexistent carrier id', async () => {
    await expect(verifyCarrierAuthority(`VERCAR-NOPE-${RUN_ID}`)).rejects.toThrow(/not found/);
  });
});

describe('manuallyVerifyCarrier (E2-03 M4 human-confirmation path)', () => {
  const seededIds: string[] = [];

  afterAll(async () => {
    if (seededIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededIds]);
  });

  it('sets verified_at/verified_by/verification_snapshot without ever calling the lookup provider', async () => {
    const id = `VERCAR-MANUAL-${RUN_ID}`;
    seededIds.push(id);
    await seedCarrier({ id, company: 'Small Local CVOR Carrier', mcNumber: '', dotNumber: '' });

    await manuallyVerifyCarrier(id, { verifiedBy: 'user:42', notes: 'Confirmed via CVOR portal, not in FMCSA' });

    const row = await db.query<{ verified_at: Date | null; verified_by: string | null; verification_snapshot: any }>(
      `SELECT verified_at, verified_by, verification_snapshot FROM carriers WHERE id = $1`, [id],
    );
    expect(row.rows[0].verified_at).not.toBeNull();
    expect(row.rows[0].verified_by).toBe('user:42');
    expect(row.rows[0].verification_snapshot.manual).toBe(true);
    expect(row.rows[0].verification_snapshot.notes).toBe('Confirmed via CVOR portal, not in FMCSA');
    expect(row.rows[0].verification_snapshot.confirmedBy).toBe('user:42');
  });

  it('throws for a nonexistent carrier id', async () => {
    await expect(
      manuallyVerifyCarrier(`VERCAR-MANUAL-NOPE-${RUN_ID}`, { verifiedBy: 'user:1' }),
    ).rejects.toThrow(/not found/);
  });
});
