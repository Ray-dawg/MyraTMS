/**
 * External authority-lookup client. Provider chain: cache → FMCSA QCMobile →
 * FMCSA SAFER (stub) → Ontario MTO CVOR (stub). First resolved wins.
 * See Engine 2/E2-01_Engine2_Expansion_PRD.md §4.3.
 *
 * No worker dependency — callable from anywhere (Session 2's Qualifier,
 * T-25's future carrier verification). Fails closed on every path: timeout,
 * 5xx after retries, ambiguous name match, or a stubbed provider all resolve
 * to status:'error'/'ambiguous', never to an accepted entityClass.
 */

import { db } from '@/lib/pipeline/db-adapter';
import type {
  AuthorityLookupInput,
  AuthorityLookupResult,
  EntityClass,
  LookupProvider,
  LookupStatus,
} from './authority-lookup-types';

export type { AuthorityLookupInput, AuthorityLookupResult, EntityClass, LookupProvider, LookupStatus };

// Live QCMobile is slow: measured 2026-10-08, /carriers/{dot} took 10.6s and
// 20.2s while /carriers/docket-number/{mc} answered in 1.9s. The previous 4000ms
// default aborted essentially every DOT lookup, which fails closed to
// 'unresolved' review - i.e. the gate would have flooded the review queue in
// enforce mode for a reason that looks nothing like its real cause. Every caller
// is a background worker or a batch script (Qualifier on Railway, the backfill
// script), never a user-facing request, so a generous ceiling is affordable.
// Timeouts do not retry, so this is also the worst case per lookup.
const TIMEOUT_MS = () => Number(process.env.AUTHORITY_LOOKUP_TIMEOUT_MS ?? 25_000);
const CACHE_DAYS = () => Number(process.env.AUTHORITY_LOOKUP_CACHE_DAYS ?? 30);
const QC_BASE_URL = () => process.env.FMCSA_QC_BASE_URL ?? 'https://mobile.fmcsa.dot.gov/qc/services';
const QC_WEBKEY = () => process.env.FMCSA_QC_WEBKEY;

const MIN_QC_INTERVAL_MS = 100; // conservative 10 req/s, in-process pacing (single-worker-host assumption)
let lastQcCallAt = 0;

function normalizeForKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\b(inc|ltd|ltee|corp|co|llc|limited)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKeyFor(input: AuthorityLookupInput): string {
  if (input.mcNumber) return `mc:${input.mcNumber}`;
  if (input.dotNumber) return `dot:${input.dotNumber}`;
  return `name:${input.companyName ? normalizeForKey(input.companyName) : ''}|${input.country}`;
}

async function readCache(key: string): Promise<AuthorityLookupResult | null> {
  const r = await db.query<{
    provider: LookupProvider; status: LookupStatus; entity_class: EntityClass | null; response: any; latency_ms: number;
  }>(
    `SELECT provider, status, entity_class, response, latency_ms FROM authority_lookups
     WHERE lookup_key = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
    [key],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const snapshot = row.response ?? {};
  return {
    entityClass: (row.entity_class ?? 'unknown') as EntityClass,
    legalName: snapshot.legalName ?? null,
    mcNumber: snapshot.mcNumber ?? null,
    dotNumber: snapshot.dotNumber ?? null,
    cvorNumber: snapshot.cvorNumber ?? null,
    provider: row.provider,
    authority: snapshot.authority ?? { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
    status: row.status,
    latencyMs: row.latency_ms,
    rawSnapshot: snapshot.rawSnapshot ?? snapshot,
  };
}

async function writeAudit(params: {
  lookupKey: string; provider: LookupProvider; status: LookupStatus; entityClass: EntityClass | null;
  request: unknown; response: unknown; latencyMs: number;
}): Promise<void> {
  const ttlDays = params.status === 'resolved' ? CACHE_DAYS() : params.status === 'not_found' ? 1 : 0;
  await db.query(
    `INSERT INTO authority_lookups (lookup_key, provider, status, entity_class, request, response, latency_ms, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::interval)`,
    [params.lookupKey, params.provider, params.status, params.entityClass, JSON.stringify(params.request),
     JSON.stringify(params.response), params.latencyMs, String(ttlDays)],
  );
}

export type OperationClassification = 'for_hire' | 'private' | 'unknown';

/**
 * The QCMobile `/carriers/{dot}` payload carries NO operation-classification
 * field - verified against live FMCSA on 2026-10-08. The earlier code read
 * `carrier.operatingStatus`, which is always undefined, so this value was
 * permanently 'unknown' and both the shipper_direct and carrier_reposted
 * branches of classifyLoadSource() were unreachable. The for-hire/private
 * split lives on a separate sub-resource, so a resolved carrier costs one
 * extra call.
 *
 * Descriptions observed live: 'Authorized For Hire', 'Exempt For Hire',
 * 'Private Property', 'Private Passenger, Business', 'Migrant', 'U.S. Mail',
 * 'Federal Government', 'State Government', 'Local Government', 'Indian Nation'.
 *
 * For-hire beats private when an entity holds both (Werner Enterprises holds
 * 'Authorized For Hire' AND 'Private Property'): anything legally able to haul
 * for others must not be auto-accepted as shipper-direct, so it routes to
 * carrier_reposted review instead. Fail closed, per PRD section 4.1.
 */
export function operationClassFromDescriptions(descs: Array<string | null | undefined>): OperationClassification {
  const d = descs.map((x) => (x ?? '').toLowerCase());
  if (d.some((x) => x.includes('for hire'))) return 'for_hire';
  if (d.some((x) => x.includes('private'))) return 'private';
  return 'unknown';
}

/**
 * Fails closed: any non-resolved response yields 'unknown', which routes the
 * load to human review rather than to an accept.
 */
async function fetchOperationClassification(dotNumber: string | number): Promise<OperationClassification> {
  const { status, content } = await fetchQcMobile(`/carriers/${dotNumber}/operation-classification`);
  if (status !== 'resolved') return 'unknown';
  return operationClassFromDescriptions(content.map((r: any) => r?.operationClassDesc));
}

function classifyFromQcCarrier(
  c: any,
  operationClassification: OperationClassification,
): { entityClass: EntityClass; authority: AuthorityLookupResult['authority'] } {
  const brokerActive = c.brokerAuthorityStatus === 'A';
  const commonActive = c.commonAuthorityStatus === 'A';
  const contractActive = c.contractAuthorityStatus === 'A';
  const carrierAuthority = commonActive || contractActive;

  let entityClass: EntityClass = 'unknown';
  if (brokerActive) entityClass = 'broker';
  else if (carrierAuthority && operationClassification === 'private') entityClass = 'carrier_private';
  else if (carrierAuthority && operationClassification === 'for_hire') entityClass = 'carrier_for_hire';
  else if (carrierAuthority) entityClass = 'unknown'; // authority exists but classification unknown — never guess

  return {
    entityClass,
    authority: {
      broker: c.brokerAuthorityStatus === 'A' ? 'active' : c.brokerAuthorityStatus === 'I' ? 'inactive' : c.brokerAuthorityStatus === 'N' ? 'none' : 'unknown',
      commonOrContract: carrierAuthority ? 'active' : (c.commonAuthorityStatus === 'I' || c.contractAuthorityStatus === 'I') ? 'inactive' : 'none',
      operationClassification,
    },
  };
}

async function fetchQcMobile(path: string): Promise<{ status: LookupStatus; content: any[]; raw: unknown }> {
  const now = Date.now();
  const wait = MIN_QC_INTERVAL_MS - (now - lastQcCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastQcCallAt = Date.now();

  const url = `${QC_BASE_URL()}${path}${path.includes('?') ? '&' : '?'}webKey=${QC_WEBKEY() ?? ''}`;
  let attempt = 0;
  const backoffsMs = [250, 500, 1000];

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < backoffsMs.length) {
          await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
          attempt += 1;
          continue;
        }
        return { status: 'error', content: [], raw: { httpStatus: res.status } };
      }
      if (!res.ok) return { status: 'error', content: [], raw: { httpStatus: res.status } };
      const body = await res.json();
      // QCMobile is not consistent about `content`: /carriers/docket-number/{mc},
      // /carriers/name/{n} and /operation-classification return an ARRAY, while
      // /carriers/{dot} returns a single OBJECT ({ _links, carrier }). Treating
      // only the array form as data made every DOT-number lookup resolve to
      // 'not_found' - verified against live FMCSA 2026-10-08. Normalise to an array.
      const rawContent: any = body?.content;
      const content: any[] = Array.isArray(rawContent)
        ? rawContent
        : rawContent && typeof rawContent === 'object' && rawContent.carrier
          ? [rawContent]
          : [];
      return { status: content.length === 0 ? 'not_found' : 'resolved', content, raw: body };
    } catch (err) {
      clearTimeout(timer);
      return { status: 'error', content: [], raw: { error: String(err) } };
    }
  }
}

async function lookupQcMobile(input: AuthorityLookupInput): Promise<AuthorityLookupResult> {
  const start = Date.now();
  let path: string | null = null;
  if (input.mcNumber) path = `/carriers/docket-number/${input.mcNumber}`;
  else if (input.dotNumber) path = `/carriers/${input.dotNumber}`;
  else if (input.companyName) path = `/carriers/name/${encodeURIComponent(normalizeForKey(input.companyName))}`;

  if (!path) {
    return {
      entityClass: 'unknown', legalName: null, mcNumber: null, dotNumber: null, cvorNumber: null,
      provider: 'none', authority: { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
      status: 'not_found', latencyMs: Date.now() - start, rawSnapshot: null,
    };
  }

  const { status, content, raw } = await fetchQcMobile(path);
  const latencyMs = Date.now() - start;

  if (status !== 'resolved') {
    return {
      entityClass: 'unknown', legalName: null, mcNumber: null, dotNumber: null, cvorNumber: null,
      provider: 'fmcsa_qcmobile', authority: { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
      status, latencyMs, rawSnapshot: raw,
    };
  }

  let matches = content;
  if (matches.length > 1 && input.provinceState) {
    const narrowed = matches.filter((m) => m.carrier?.phyState === input.provinceState);
    if (narrowed.length === 1) matches = narrowed;
  }
  if (matches.length > 1) {
    return {
      entityClass: 'unknown', legalName: null, mcNumber: null, dotNumber: null, cvorNumber: null,
      provider: 'fmcsa_qcmobile', authority: { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
      status: 'ambiguous', latencyMs, rawSnapshot: raw,
    };
  }

  const c = matches[0].carrier;
  const dotForOpClass = c.dotNumber ?? input.dotNumber;
  const operationClassification = dotForOpClass
    ? await fetchOperationClassification(dotForOpClass)
    : 'unknown';
  const { entityClass, authority } = classifyFromQcCarrier(c, operationClassification);
  return {
    entityClass,
    legalName: c.legalName ?? c.dbaName ?? null,
    mcNumber: input.mcNumber ?? null,
    dotNumber: c.dotNumber ?? input.dotNumber ?? null,
    cvorNumber: null,
    provider: 'fmcsa_qcmobile',
    authority,
    status: 'resolved',
    latencyMs,
    rawSnapshot: raw,
  };
}

/**
 * FMCSA SAFER company-snapshot fallback. NOT IMPLEMENTED in Session 1 —
 * requires Playwright, which is not a MyraTMS dependency (it lives only in
 * the sibling scraper/ project's separate deploy unit). Fails closed:
 * returns status:'error' so the classifier always routes to review, never
 * accept, on this path. Wire up a real implementation once a Playwright
 * strategy for MyraTMS (or a shared call into the scraper service) is
 * decided — deferred past this session by design, see plan Task 2.
 */
async function lookupSafer(_input: AuthorityLookupInput): Promise<AuthorityLookupResult> {
  return {
    entityClass: 'unknown', legalName: null, mcNumber: null, dotNumber: null, cvorNumber: null,
    provider: 'fmcsa_safer', authority: { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
    status: 'error', latencyMs: 0, rawSnapshot: { reason: 'not_implemented' },
  };
}

/**
 * Ontario MTO Carrier Safety Rating search. NOT IMPLEMENTED in Session 1 —
 * same Playwright constraint as lookupSafer above. Corroboration-only per
 * PRD §4.3 ("never sole accept evidence"), so stubbing this never causes a
 * false accept — it only means CVOR enrichment is unavailable until built.
 */
async function lookupMto(_input: AuthorityLookupInput): Promise<AuthorityLookupResult> {
  return {
    entityClass: 'unknown', legalName: null, mcNumber: null, dotNumber: null, cvorNumber: null,
    provider: 'on_cvor', authority: { broker: 'unknown', commonOrContract: 'unknown', operationClassification: 'unknown' },
    status: 'error', latencyMs: 0, rawSnapshot: { reason: 'not_implemented' },
  };
}

export async function lookupAuthority(input: AuthorityLookupInput): Promise<AuthorityLookupResult> {
  const key = cacheKeyFor(input);

  const cached = await readCache(key);
  if (cached) return cached;

  let result = await lookupQcMobile(input);

  const needsFallback = result.status === 'error' || (result.status === 'resolved' && result.authority.operationClassification === 'unknown');
  if (needsFallback) {
    const safer = await lookupSafer(input);
    await writeAudit({ lookupKey: key, provider: 'fmcsa_safer', status: safer.status, entityClass: null, request: input, response: safer.rawSnapshot, latencyMs: safer.latencyMs });
    if (safer.status === 'resolved') result = safer;
  }

  if (input.country === 'CA') {
    const mto = await lookupMto(input);
    await writeAudit({ lookupKey: key, provider: 'on_cvor', status: mto.status, entityClass: null, request: input, response: mto.rawSnapshot, latencyMs: mto.latencyMs });
    if (result.status !== 'resolved' && mto.status === 'resolved') result = mto;
  }

  await writeAudit({
    lookupKey: key, provider: result.provider, status: result.status, entityClass: result.status === 'resolved' ? result.entityClass : null,
    request: input, response: { legalName: result.legalName, mcNumber: result.mcNumber, dotNumber: result.dotNumber, cvorNumber: result.cvorNumber, authority: result.authority, rawSnapshot: result.rawSnapshot },
    latencyMs: result.latencyMs,
  });

  return result;
}
