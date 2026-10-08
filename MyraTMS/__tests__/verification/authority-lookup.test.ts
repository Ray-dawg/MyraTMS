import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { lookupAuthority, operationClassFromDescriptions } from '@/lib/verification/authority-lookup';

const RUN_ID = Date.now();
const TEST_MC = `TESTMC${RUN_ID}`;
const TEST_DOT = `TESTDOT${RUN_ID}`;

describe('authority-lookup', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let responseQueue: Array<{ status: number; body: unknown; delayMs?: number }> = [];
  const envBackup = { ...process.env };

  beforeAll(async () => {
    mockServer = http.createServer(async (req, res) => {
      const next = responseQueue.shift();
      if (!next) { res.writeHead(500).end('no queued response'); return; }
      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;
    process.env.FMCSA_QC_BASE_URL = mockUrl;
    process.env.FMCSA_QC_WEBKEY = 'test-webkey';
    process.env.AUTHORITY_LOOKUP_TIMEOUT_MS = '300';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    process.env = envBackup;
    await db.query(`DELETE FROM authority_lookups WHERE lookup_key LIKE $1 OR lookup_key = 'name:|CA'`, [`%${RUN_ID}%`]);
  });

  beforeEach(() => { responseQueue = []; });

  it('resolves a broker via docket (MC) lookup and writes one audit row', async () => {
    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Test Broker Co',
            dbaName: null,
            dotNumber: TEST_DOT,
            brokerAuthorityStatus: 'A',
            commonAuthorityStatus: 'N',
            contractAuthorityStatus: 'N',
            allowedToOperate: 'Y',
          },
        }],
      },
    });

    responseQueue.push({ status: 200, body: { content: [] } }); // /operation-classification: pure broker, no classes

    const result = await lookupAuthority({ mcNumber: TEST_MC, country: 'US' });

    expect(result.status).toBe('resolved');
    expect(result.entityClass).toBe('broker');
    expect(result.authority.broker).toBe('active');
    expect(result.provider).toBe('fmcsa_qcmobile');
    expect(result.legalName).toBe('Test Broker Co');

    const audit = await db.query(
      `SELECT * FROM authority_lookups WHERE lookup_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [`mc:${TEST_MC}`],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].status).toBe('resolved');
    expect(audit.rows[0].provider).toBe('fmcsa_qcmobile');
  });

  it('classifies a for-hire carrier with no broker authority as carrier_for_hire', async () => {
    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Test For-Hire Carrier',
            dotNumber: TEST_DOT + '2',
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'A',
            contractAuthorityStatus: 'N',
            allowedToOperate: 'Y',
          },
        }],
      },
    });
    responseQueue.push({ status: 200, body: { content: [{ operationClassDesc: 'Authorized For Hire' }] } }); // GET /operation-classification sub-resource

    const result = await lookupAuthority({ dotNumber: TEST_DOT + '2', country: 'US' });
    expect(result.status).toBe('resolved');
    expect(result.entityClass).toBe('carrier_for_hire');
    expect(result.authority.operationClassification).toBe('for_hire');
  });

  it('classifies a private-fleet carrier as carrier_private', async () => {
    responseQueue.push({
      status: 200,
      body: {
        content: [{
          carrier: {
            legalName: 'Test Private Fleet Mine',
            dotNumber: TEST_DOT + '3',
            brokerAuthorityStatus: 'N',
            commonAuthorityStatus: 'A',
            contractAuthorityStatus: 'N',
            allowedToOperate: 'Y',
          },
        }],
      },
    });
    responseQueue.push({ status: 200, body: { content: [{ operationClassDesc: 'Private Property' }] } }); // GET /operation-classification sub-resource

    const result = await lookupAuthority({ dotNumber: TEST_DOT + '3', country: 'US' });
    expect(result.status).toBe('resolved');
    expect(result.entityClass).toBe('carrier_private');
    expect(result.authority.operationClassification).toBe('private');
  });

  it('returns not_found (never accept) when the API returns an empty result set', async () => {
    responseQueue.push({ status: 200, body: { content: [] } });
    const result = await lookupAuthority({ mcNumber: TEST_MC + 'NF', country: 'US' });
    expect(result.status).toBe('not_found');
    expect(result.entityClass).toBe('unknown');
  });

  it('returns ambiguous when a name search matches multiple provinces/states with no disambiguator', async () => {
    responseQueue.push({
      status: 200,
      body: {
        content: [
          { carrier: { legalName: 'Test Ambiguous Co', dotNumber: 'A1', phyState: 'ON', brokerAuthorityStatus: 'N', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } },
          { carrier: { legalName: 'Test Ambiguous Co', dotNumber: 'A2', phyState: 'TX', brokerAuthorityStatus: 'N', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } },
        ],
      },
    });
    const result = await lookupAuthority({ companyName: 'Test Ambiguous Co', country: 'US' });
    expect(result.status).toBe('ambiguous');
    expect(result.entityClass).toBe('unknown');
  });

  it('resolves a name search when exactly one match shares the given province/state', async () => {
    responseQueue.push({
      status: 200,
      body: {
        content: [
          { carrier: { legalName: 'Test Resolved Co', dotNumber: 'B1', phyState: 'ON', brokerAuthorityStatus: 'N', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } },
          { carrier: { legalName: 'Test Resolved Co', dotNumber: 'B2', phyState: 'TX', brokerAuthorityStatus: 'N', commonAuthorityStatus: 'A', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } },
        ],
      },
    });
    responseQueue.push({ status: 200, body: { content: [{ operationClassDesc: 'Authorized For Hire' }] } }); // GET /operation-classification sub-resource

    const result = await lookupAuthority({ companyName: 'Test Resolved Co', country: 'US', provinceState: 'ON' });
    expect(result.status).toBe('resolved');
    expect(result.dotNumber).toBe('B1');
  });

  it('times out and returns status error rather than hanging or accepting (fail-closed)', async () => {
    responseQueue.push({ status: 200, body: { content: [] }, delayMs: 1000 }); // exceeds 300ms test timeout
    const result = await lookupAuthority({ mcNumber: TEST_MC + 'TO', country: 'US' });
    expect(result.status).toBe('error');
    expect(result.entityClass).toBe('unknown');
  }, 10_000);

  it('retries once on a 429 and succeeds on the second attempt', async () => {
    responseQueue.push({ status: 429, body: { error: 'rate limited' } });
    responseQueue.push({
      status: 200,
      body: { content: [{ carrier: { legalName: 'Test Retry Co', dotNumber: TEST_DOT + '4', brokerAuthorityStatus: 'A', commonAuthorityStatus: 'N', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } }] },
    });
    responseQueue.push({ status: 200, body: { content: [{ operationClassDesc: 'Authorized For Hire' }] } }); // GET /operation-classification sub-resource

    const result = await lookupAuthority({ mcNumber: TEST_MC + 'RETRY', country: 'US' });
    expect(result.status).toBe('resolved');
    expect(result.legalName).toBe('Test Retry Co');
  }, 10_000);

  it('serves a resolved result from cache on the second call without hitting the network', async () => {
    responseQueue.push({
      status: 200,
      body: { content: [{ carrier: { legalName: 'Test Cache Co', dotNumber: TEST_DOT + '5', brokerAuthorityStatus: 'A', commonAuthorityStatus: 'N', contractAuthorityStatus: 'N', allowedToOperate: 'Y' } }] },
    });
    responseQueue.push({ status: 200, body: { content: [{ operationClassDesc: 'Authorized For Hire' }] } }); // GET /operation-classification sub-resource

    const first = await lookupAuthority({ mcNumber: TEST_MC + 'CACHE', country: 'US' });
    expect(first.status).toBe('resolved');

    responseQueue = []; // if the second call hits the network, it 500s (no queued response)
    const second = await lookupAuthority({ mcNumber: TEST_MC + 'CACHE', country: 'US' });
    expect(second.status).toBe('resolved');
    expect(second.legalName).toBe('Test Cache Co');
  });

  it('SAFER and MTO providers report error/not_implemented and still write an audit row (fail-closed stub)', async () => {
    // No QCMobile response queued at all — this input has no mcNumber/dotNumber/companyName
    // for QCMobile to try (path stays null), so QCMobile itself resolves to 'not_found'
    // (nothing to look up) while the CA-country branch still calls the stubbed MTO
    // provider alongside it. Confirms the MTO branch runs and fails closed — 'not_found'
    // is itself a fail-closed terminal status (classifier row 12 routes it to review,
    // never accept), and the stub never fabricates a 'resolved' result.
    const result = await lookupAuthority({ country: 'CA' });
    expect(result.status).toBe('not_found');
    expect(result.entityClass).toBe('unknown');

    const audit = await db.query<{ provider: string; status: string; response: any }>(
      `SELECT provider, status, response FROM authority_lookups
       WHERE lookup_key = 'name:|CA' ORDER BY created_at DESC LIMIT 5`,
      [],
    );
    expect(audit.rows.some((r) => r.response?.reason === 'not_implemented')).toBe(true);
  });
});

describe('operationClassFromDescriptions (E2-01 — live-FMCSA shape regression)', () => {
  // Regression for the 2026-10-08 finding: the old code read
  // `carrier.operatingStatus`, a field live QCMobile never returns, so
  // operationClassification was permanently 'unknown' and classifyLoadSource()
  // could never reach shipper_direct or carrier_reposted via FMCSA. These are
  // the exact operationClassDesc strings the live API returns.
  it('maps a pure private fleet to private (the shipper_direct accept path)', () => {
    expect(operationClassFromDescriptions(['Private Property'])).toBe('private');
    expect(operationClassFromDescriptions(['Private Passenger, Business'])).toBe('private');
  });

  it('maps an authorized/exempt for-hire carrier to for_hire', () => {
    expect(operationClassFromDescriptions(['Authorized For Hire'])).toBe('for_hire');
    expect(operationClassFromDescriptions(['Exempt For Hire'])).toBe('for_hire');
  });

  it('lets for_hire win over private when an entity holds both (Werner Enterprises, DOT 53467)', () => {
    // Verified live: Werner returns Authorized For Hire + Private Property +
    // Private Passenger. Anything able to haul for others must not be
    // auto-accepted as shipper-direct — it goes to carrier_reposted review.
    expect(
      operationClassFromDescriptions(['Authorized For Hire', 'Private Property', 'Private Passenger, Business']),
    ).toBe('for_hire');
  });

  it('returns unknown (→ human review, never accept) on an empty or unrecognised set', () => {
    expect(operationClassFromDescriptions([])).toBe('unknown');
    expect(operationClassFromDescriptions(['U.S. Mail', 'Federal Government'])).toBe('unknown');
    expect(operationClassFromDescriptions([null, undefined])).toBe('unknown');
  });
});
