# E2-01 Shipper-Direct Gate — Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shadow-only shipper-direct classifier into a real top-of-pipeline gate so that no load posted by another brokerage or dispatcher ever reaches the Researcher, Compiler, or a phone call.

**Architecture:** E2-01 M1 Session 1 already shipped the classifier (`lib/pipeline/load-source-classifier.ts`), the FMCSA authority lookup (`lib/verification/authority-lookup.ts`), the `poster_registry` / `authority_lookups` / `co_broker_agreements` tables (migration 040), and a shadow hook in the Qualifier. What is missing is everything upstream and downstream of that hook: no ingest path captures the poster's company / MC / DOT, so every row classifies as `poster_identity_missing`; the Qualifier records the verdict but never acts on it; nothing routes a `review` verdict to a human; nothing asserts the class later in the pipeline. This plan closes those four gaps in order (capture → enforce → review loop → assert), each behind the existing `SHIPPER_DIRECT_GATE_ENABLED` flag plus a new `SHIPPER_DIRECT_GATE_MODE` (`shadow` | `enforce`) so production behaviour is unchanged until an operator flips both.

**Tech Stack:** TypeScript, Next.js 16 App Router API routes, BullMQ on ioredis, Neon Postgres via `lib/pipeline/db-adapter.ts` (`db.query(text, params)`), Vitest against a disposable Neon branch, Playwright (scraper only).

**Spec:** `Engine 2/E2-01_Engine2_Expansion_PRD.md` §4 (M1) and §5 (M2). Decisions D1–D6 in §8 are taken at their stated defaults. The one deliberate deviation: the gate ships with `SHIPPER_DIRECT_GATE_MODE=shadow` (PRD §4.11 says default `enforce`) because every Engine 2 flag in production today defaults off and flipping is an explicit, logged operator step (`Engine 2/CLAUDE.md` Kill Switches).

## Global Constraints

- Never hardcode a tenant id. Use `getMyraTenantId()` from `lib/tenants/get-myra-tenant-id.ts`; coerce BIGINT strings with `Number()`.
- Workers extend `BaseWorker` and use `db.query(text, params)` from `lib/pipeline/db-adapter.ts`. API routes may use either pattern; match the surrounding file.
- Kill switches are exact-match after `.trim().toLowerCase()`. Read them at call time, never cache at module load.
- Do not modify Filters 2–7 logic in `qualifier-worker.ts` (PRD §9). Changing the reason *string* they return is allowed; changing what they reject is not.
- `voice-worker.ts`, `carrier-voice-worker.ts`, `retell-webhook.ts`, `compiler-worker.ts`, `dispatcher-worker.ts`, `dispatch-gate.ts` are live-call-path files. Tasks 7 and 8 touch two of them and require Patrice's review before merge (risk E3-R1).
- Every new migration is a new numbered file (`060-…`), idempotent (`IF NOT EXISTS`), never an edit of 040. **Applying it to production is a separate, explicitly confirmed step, not part of any task.**
- Tests run against whatever `DATABASE_URL` is in `MyraTMS/.env.local`. Point it at a disposable Neon branch (`e2-01-verify`) before running anything in this plan.
- Fail closed everywhere: unknown is not neutral. Infra failure (missing `FMCSA_QC_WEBKEY`, lookup timeout) routes to review, never to accept.
- Every decision is a row: class, method, confidence, evidence, evaluated-at on `pipeline_loads`; every review is an `exceptions` row; every human answer is a `poster_registry` row.

## Review Focus

1. **A CSV row with `shipper_direct_attestation: "yes"` but no poster identity** must be accepted (attestation is authoritative, PRD §4.5 row 1) and must not fall through to `poster_identity_missing`. Pinned in Task 4.
2. **A broker that posts under a name variant** (`"Acme Logistics Inc."` vs `"ACME LOGISTICS"`) must hit the same registry row. Pinned in Task 1 via `normalizeCompanyName` on both the insert and the lookup path.
3. **`SHIPPER_DIRECT_GATE_ENABLED=true` with `MODE=shadow`** must behave exactly as production does today: classification written, stage decided only by Filters 2–7. Pinned in Task 4.
4. **A review resolved after the load's pickup window** must not re-enter the pipeline. `resolve-source` on an `expired` load returns 409. Pinned in Task 5.
5. **A load qualified before the enforcement timestamp** reaching the Compiler with `load_source_class = NULL` must not be escalated (PRD §4.14 step 3 tolerance). Pinned in Task 7.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `lib/pipeline/poster-identity.ts` (new) | Pure helpers: `normalizeIdNumber()`, `posterFromRawLoad()`, shared `PosterFields` type | 1 |
| `lib/workers/scanner-worker.ts` | `RawLoad` gains poster fields; both INSERTs write `poster_*` columns; `QualifyJobPayload` carries poster + attestation | 1, 2 |
| `app/api/pipeline/import/route.ts` | Attestation contract (§4.8) | 2 |
| `scraper/src/adapters/dat/{selectors,parse}.ts`, `scraper/src/pipeline/{normalize,db,enqueue}.ts` | Capture broker cell + optional MC/DOT, persist, enqueue | 3 |
| `lib/pipeline/gate-mode.ts` (new) | `getShipperDirectGateMode()` — single reader for the two flags + enforced-at timestamp | 4 |
| `lib/workers/qualifier-worker.ts` | F1 enforcement, reason codes, review routing, priority bonus | 4 |
| `lib/pipeline/resolve-load-source.ts` (new) + `app/api/pipeline/loads/[id]/resolve-source/route.ts` (new) | Human review resolution that writes the registry and re-queues | 5 |
| `lib/pipeline/health-checks.ts`, `app/api/cron/pipeline-health/route.ts` | Review SLA expiry | 6 |
| `lib/pipeline/load-source-assert.ts` (new), `compiler-worker.ts`, `dispatcher-worker.ts` | M2 assertions | 7 |
| `lib/pipeline/negotiation-brief.ts`, `compiler-worker.ts` | Brief fields `load_source_class`, `poster_legal_name`, `co_broker_counterparty` | 8 |
| `scripts/e2_source_calibration_report.ts` (new) | Calibration report before flag flip | 9 |
| `Engine 2/CLAUDE.md`, `Engine 2/docs/superpowers/plans/completion.md`, root `CLAUDE.md` | Flag docs, tracker, rollout record | 10 |

---

### Task 1: Poster identity capture in the MyraTMS scanner

**Files:**
- Create: `lib/pipeline/poster-identity.ts`
- Modify: `lib/workers/scanner-worker.ts` (RawLoad interface ~line 50; `ingestRawLoads` fill block ~line 126; INSERT ~line 177; qualify payload ~line 222; `pollSourceViaAPI` INSERT ~line 380 and its enqueue)
- Test: `__tests__/pipeline/poster-identity.test.ts`, `__tests__/pipeline/scanner-import.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PosterFields {
    posterCompanyRaw: string | null;
    posterMcNumber: string | null;   // digits only
    posterDotNumber: string | null;  // digits only
  }
  export function normalizeIdNumber(raw: string | null | undefined): string | null;
  export function posterFromRawLoad(load: { shipperCompany: string | null; posterCompanyRaw?: string | null; posterMcNumber?: string | null; posterDotNumber?: string | null }): PosterFields;
  ```
- `RawLoad` gains optional `posterCompanyRaw?`, `posterMcNumber?`, `posterDotNumber?`.
- `QualifyJobPayload` (already declares `posterCompanyRaw`, `posterMcNumber`, `posterDotNumber`, `isManualImport` as optional) is now always populated by the scanner.

- [ ] **Step 1: Write the failing unit test for the helpers**

```ts
// __tests__/pipeline/poster-identity.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeIdNumber, posterFromRawLoad } from '@/lib/pipeline/poster-identity';

describe('normalizeIdNumber', () => {
  it('strips prefixes and punctuation to digits', () => {
    expect(normalizeIdNumber('MC-123456')).toBe('123456');
    expect(normalizeIdNumber('USDOT 2,345,678')).toBe('2345678');
  });
  it('returns null for empty or non-numeric input', () => {
    expect(normalizeIdNumber('')).toBeNull();
    expect(normalizeIdNumber('n/a')).toBeNull();
    expect(normalizeIdNumber(undefined)).toBeNull();
  });
});

describe('posterFromRawLoad', () => {
  it('prefers explicit poster fields over shipperCompany', () => {
    expect(posterFromRawLoad({ shipperCompany: 'X', posterCompanyRaw: 'Acme Logistics Inc.', posterMcNumber: 'MC-1', posterDotNumber: null }))
      .toEqual({ posterCompanyRaw: 'Acme Logistics Inc.', posterMcNumber: '1', posterDotNumber: null });
  });
  it('falls back to shipperCompany when no poster company is given', () => {
    expect(posterFromRawLoad({ shipperCompany: 'Northern Mine Supply' }))
      .toEqual({ posterCompanyRaw: 'Northern Mine Supply', posterMcNumber: null, posterDotNumber: null });
  });
  it('returns all nulls when nothing is known', () => {
    expect(posterFromRawLoad({ shipperCompany: null })).toEqual({ posterCompanyRaw: null, posterMcNumber: null, posterDotNumber: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run __tests__/pipeline/poster-identity.test.ts`
Expected: FAIL, module `@/lib/pipeline/poster-identity` not found.

- [ ] **Step 3: Implement the helpers**

```ts
// lib/pipeline/poster-identity.ts
/**
 * Poster identity helpers (E2-01 §4.2). Pure; shared by the CSV/API scanner
 * and, by copy, the Railway scraper (which cannot import from MyraTMS).
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
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run __tests__/pipeline/poster-identity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing integration test for the scanner write path**

Add to `__tests__/pipeline/scanner-import.test.ts` (follow its existing `ScannerService` + cleanup pattern):

```ts
it('persists poster identity columns and carries them on the qualify payload', async () => {
  const loadId = `TEST-POSTER-${Date.now()}`;
  const res = await service.ingestRawLoads([{
    loadId, originCity: 'Sudbury', originState: 'ON', originCountry: 'CA',
    destinationCity: 'Toronto', destinationState: 'ON', destinationCountry: 'CA',
    pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
    shipperCompany: 'Ignored Co', posterCompanyRaw: 'Acme Logistics Inc.',
    posterMcNumber: 'MC-123456', posterDotNumber: 'USDOT 7890',
  }], 'manual');
  expect(res.inserted).toBe(1);
  const row = await db.query(
    `SELECT poster_company_raw, poster_company_normalized, poster_mc_number, poster_dot_number
       FROM pipeline_loads WHERE id = $1`, [res.insertedIds[0]]);
  expect(row.rows[0]).toEqual({
    poster_company_raw: 'Acme Logistics Inc.',
    poster_company_normalized: 'acme logistics',
    poster_mc_number: '123456',
    poster_dot_number: '7890',
  });
  const jobs = await qualifyQueue.getJobs(['waiting', 'prioritized']);
  const job = jobs.find((j) => j.data.pipelineLoadId === res.insertedIds[0]);
  expect(job?.data.posterMcNumber).toBe('123456');
  expect(job?.data.isManualImport).toBe(true);
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [res.insertedIds[0]]);
});
```

(`'acme logistics'` is what `normalizeCompanyName('Acme Logistics Inc.')` returns: lowercase, punctuation stripped, the legal suffix `inc` removed, whitespace collapsed. Confirm against `lib/pipeline/load-source-classifier.ts:16` before relying on it.)

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run __tests__/pipeline/scanner-import.test.ts -t "poster identity"`
Expected: FAIL, `poster_company_raw` is null.

- [ ] **Step 7: Extend RawLoad, the fill block, both INSERTs, and both enqueues**

In `lib/workers/scanner-worker.ts`:

1. Add to `RawLoad` after `shipperEmail`:
   ```ts
   // E2-01 §4.2 — poster identity. Optional on input; the scanner always
   // writes the normalized block to pipeline_loads.
   posterCompanyRaw?: string | null;
   posterMcNumber?: string | null;
   posterDotNumber?: string | null;
   ```
2. Import at top: `import { posterFromRawLoad } from '@/lib/pipeline/poster-identity';` and `import { normalizeCompanyName } from '@/lib/pipeline/load-source-classifier';`
3. In the `filled` object inside `ingestRawLoads`, add:
   ```ts
   posterCompanyRaw: row.posterCompanyRaw ?? null,
   posterMcNumber: row.posterMcNumber ?? null,
   posterDotNumber: row.posterDotNumber ?? null,
   ```
4. Replace the INSERT in `ingestRawLoads` (and identically in `pollSourceViaAPI`, keeping each one's `created_by` literal) so the column list ends:
   ```sql
   posted_rate, posted_rate_currency, rate_type,
   poster_company_raw, poster_company_normalized, poster_mc_number, poster_dot_number,
   stage, stage_updated_at, created_by
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
     $15, $16, $17, $18, $19, $20, $21,
     $22, $23, $24, $25,
     'scanned', NOW(), 'scanner-csv-v1'
   )
   ```
   and the params array ends:
   ```ts
   load.rateType,
   poster.posterCompanyRaw,
   poster.posterCompanyRaw ? normalizeCompanyName(poster.posterCompanyRaw) : null,
   poster.posterMcNumber,
   poster.posterDotNumber,
   ```
   where `const poster = posterFromRawLoad(load);` is computed just above the query.
5. In both `qualifyQueue.add('qualify', {...})` payloads add:
   ```ts
   posterCompanyRaw: poster.posterCompanyRaw,
   posterMcNumber: poster.posterMcNumber,
   posterDotNumber: poster.posterDotNumber,
   isManualImport: source === 'manual',   // in pollSourceViaAPI this is always false
   ```

- [ ] **Step 8: Run the scanner test and the type check**

Run: `pnpm vitest run __tests__/pipeline/scanner-import.test.ts __tests__/pipeline/poster-identity.test.ts && pnpm tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add lib/pipeline/poster-identity.ts lib/workers/scanner-worker.ts __tests__/pipeline/poster-identity.test.ts __tests__/pipeline/scanner-import.test.ts
git commit -m "feat(E2-01 M1): capture poster identity at CSV/API ingest and carry it to the Qualifier"
```

---

### Task 2: Manual-import attestation contract on `/api/pipeline/import`

**Files:**
- Modify: `app/api/pipeline/import/route.ts`, `lib/workers/scanner-worker.ts` (`ingestRawLoads` signature, INSERT, enqueue)
- Test: `__tests__/pipeline/scanner-import.test.ts`, `__tests__/api/pipeline-import-attestation.test.ts`

**Interfaces:**
- `ingestRawLoads(rawLoads, source, opts?: { attestation?: 'yes' | 'no' | 'unknown'; attestedBy?: string })`. When `opts.attestation` is set, each row's `shipper_direct_attestation`, `attested_by`, `attested_at` are written, `created_by` becomes `'scanner-csv-v2'`, and the qualify payload carries `attestation`.
- `QualifyJobPayload` gains `attestation?: 'yes' | 'no' | 'unknown' | null`.
- Route body: `{ loads, source?, shipper_direct_attestation?: 'yes'|'no'|'unknown' }`. Per-row `shipper_direct_attestation` overrides the file-level value. When `SHIPPER_DIRECT_GATE_ENABLED=true` and neither is present → `400 { error: 'attestation_required' }`. When the flag is off the field is optional (keeps `scripts/sprint6-shadow/02-generate-shadow-loads.ts` and `self-call.ts` working unchanged).

- [ ] **Step 1: Write the failing route test**

```ts
// __tests__/api/pipeline-import-attestation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/pipeline/import/route';

const TOKEN = process.env.PIPELINE_IMPORT_TOKEN || process.env.CRON_SECRET || 'test-token';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/pipeline/import', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pipeline/import attestation contract', () => {
  const prev = { gate: process.env.SHIPPER_DIRECT_GATE_ENABLED, pipe: process.env.PIPELINE_ENABLED, tok: process.env.PIPELINE_IMPORT_TOKEN };
  beforeEach(() => { process.env.PIPELINE_ENABLED = 'true'; process.env.PIPELINE_IMPORT_TOKEN = TOKEN; });
  afterEach(() => { process.env.SHIPPER_DIRECT_GATE_ENABLED = prev.gate; process.env.PIPELINE_ENABLED = prev.pipe; process.env.PIPELINE_IMPORT_TOKEN = prev.tok; });

  it('returns 400 attestation_required when the gate is on and no attestation is given', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';
    const res = await POST(req({ loads: [{ loadId: 'X' }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('attestation_required');
  });

  it('rejects an attestation value outside yes/no/unknown', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';
    const res = await POST(req({ loads: [{ loadId: 'X' }], shipper_direct_attestation: 'maybe' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_attestation');
  });

  it('does not require attestation when the gate is off', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'false';
    const res = await POST(req({ loads: [] }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run __tests__/api/pipeline-import-attestation.test.ts`
Expected: first two tests FAIL (status 200 / 500 instead of 400).

- [ ] **Step 3: Implement the route contract**

In `app/api/pipeline/import/route.ts`, after the `loads.length > 500` check and before `const source = …`:

```ts
const ATTESTATION_VALUES = new Set(['yes', 'no', 'unknown']);
const gateOn = (process.env.SHIPPER_DIRECT_GATE_ENABLED ?? '').trim().toLowerCase() === 'true';
const fileAttestation = body.shipper_direct_attestation;
if (fileAttestation !== undefined && !ATTESTATION_VALUES.has(String(fileAttestation))) {
  return NextResponse.json({ error: 'invalid_attestation', allowed: [...ATTESTATION_VALUES] }, { status: 400 });
}
const everyRowAttested = body.loads.every((l) => ATTESTATION_VALUES.has(String((l as any).shipper_direct_attestation ?? '')));
if (gateOn && fileAttestation === undefined && !everyRowAttested) {
  return NextResponse.json(
    { error: 'attestation_required', hint: "Set shipper_direct_attestation: 'yes' | 'no' | 'unknown' at file level or on every row (E2-01 §4.8)" },
    { status: 400 },
  );
}
```

Widen the `body` type to `{ loads?: Array<Partial<RawLoad> & { shipper_direct_attestation?: string }>; source?: string; shipper_direct_attestation?: string }` and pass the attestation through:

```ts
const result = await getService().ingestRawLoads(body.loads, source, {
  attestation: fileAttestation as 'yes' | 'no' | 'unknown' | undefined,
  attestedBy: 'pipeline-import-token',
});
```

Log the verbatim attestation sentence once per request when `fileAttestation === 'yes'` (PRD §4.8): `logger.info('[pipeline-import] attestation', { sentence: 'I confirm these loads were tendered to Myra directly by the shipper or under an executed co-broker agreement.', attestedBy: 'pipeline-import-token' })`.

- [ ] **Step 4: Implement the scanner side**

In `lib/workers/scanner-worker.ts`:

1. Add `shipper_direct_attestation?: 'yes' | 'no' | 'unknown' | null` to `RawLoad` and carry it through the `filled` object (`row.shipper_direct_attestation ?? null`).
2. Change the signature: `async ingestRawLoads(rawLoads: Array<Partial<RawLoad>>, source: RawLoad['loadBoardSource'] = 'manual', opts: { attestation?: 'yes' | 'no' | 'unknown'; attestedBy?: string } = {})`.
3. Per row: `const attestation = load.shipper_direct_attestation ?? opts.attestation ?? null;`
4. INSERT: add columns `shipper_direct_attestation, attested_by, attested_at` with params `attestation, attestation ? (opts.attestedBy ?? 'pipeline-import') : null, attestation ? new Date().toISOString() : null`, and make `created_by` a parameter: `attestation ? 'scanner-csv-v2' : 'scanner-csv-v1'`.
5. Enqueue payload: add `attestation`.
6. Add `attestation?: 'yes' | 'no' | 'unknown' | null;` to `QualifyJobPayload` in `qualifier-worker.ts`.

- [ ] **Step 5: Extend the scanner integration test**

Add to `__tests__/pipeline/scanner-import.test.ts`:

```ts
it('writes attestation columns and bumps created_by to scanner-csv-v2', async () => {
  const loadId = `TEST-ATTEST-${Date.now()}`;
  const res = await service.ingestRawLoads([{
    loadId, originCity: 'Sudbury', originState: 'ON', originCountry: 'CA',
    destinationCity: 'Toronto', destinationState: 'ON', destinationCountry: 'CA',
    pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
  }], 'manual', { attestation: 'yes', attestedBy: 'test' });
  const row = await db.query(
    `SELECT shipper_direct_attestation, attested_by, attested_at, created_by FROM pipeline_loads WHERE id = $1`,
    [res.insertedIds[0]]);
  expect(row.rows[0].shipper_direct_attestation).toBe('yes');
  expect(row.rows[0].attested_by).toBe('test');
  expect(row.rows[0].attested_at).not.toBeNull();
  expect(row.rows[0].created_by).toBe('scanner-csv-v2');
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [res.insertedIds[0]]);
});
```

- [ ] **Step 6: Run both test files and tsc**

Run: `pnpm vitest run __tests__/api/pipeline-import-attestation.test.ts __tests__/pipeline/scanner-import.test.ts && pnpm tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/pipeline/import/route.ts lib/workers/scanner-worker.ts lib/workers/qualifier-worker.ts __tests__/api/pipeline-import-attestation.test.ts __tests__/pipeline/scanner-import.test.ts
git commit -m "feat(E2-01 M1): manual-import attestation contract on /api/pipeline/import (§4.8)"
```

---

### Task 3: Poster identity capture in the Railway scraper (DAT)

**Files:**
- Modify: `scraper/src/adapters/dat/selectors.ts`, `scraper/src/adapters/dat/parse.ts`, `scraper/src/pipeline/normalize.ts`, `scraper/src/pipeline/db.ts`, `scraper/src/pipeline/enqueue.ts`
- Create: `scraper/src/pipeline/poster-identity.ts` (copy of the MyraTMS helper; the scraper cannot import across projects)
- Test: `scraper/test/parse.test.ts`, `scraper/test/poster-identity.test.ts`, `scraper/test/fixtures/dat-results-with-mc.html`

**Interfaces:**
- `DATParsedFields` gains `mcNumber: string | null; dotNumber: string | null;`
- Scraper `RawLoad` gains `posterCompanyRaw`, `posterMcNumber`, `posterDotNumber` (all `string | null`, required in the scraper's type since it always populates them).
- `QualifyJobPayload` in `enqueue.ts` gains the three poster fields plus `isManualImport: false`.
- New selectors `cellMc`, `cellDot` (env `DAT_SEL_CELL_MC`, `DAT_SEL_CELL_DOT`; default `[data-field="mcNumber"]`, `[data-field="dotNumber"]`). Detail-panel expansion (PRD D5) is **deferred** to a follow-up: the grid-cell path is implemented first because it costs nothing per row; if a live DAT session shows the grid has no MC column, add expansion then using the same env-selector pattern. Record this in the tracker.

- [ ] **Step 1: Copy the helper and write its test**

Create `scraper/src/pipeline/poster-identity.ts` with the exact contents of `MyraTMS/lib/pipeline/poster-identity.ts` from Task 1, plus a header comment: `// Mirror of MyraTMS/lib/pipeline/poster-identity.ts — keep byte-identical.` Create `scraper/test/poster-identity.test.ts` with the same three `normalizeIdNumber` / `posterFromRawLoad` cases as Task 1 Step 1 (adjust the import to `../src/pipeline/poster-identity.js`).

Run: `cd scraper && npm test -- poster-identity`
Expected: PASS.

- [ ] **Step 2: Write the failing parser test**

Add a fixture `scraper/test/fixtures/dat-results-with-mc.html`: copy the existing results fixture used by `parse.test.ts` and add `<td data-field="mcNumber">MC-123456</td><td data-field="dotNumber">USDOT 7890</td>` to the first row only. Then in `scraper/test/parse.test.ts`:

```ts
it('captures MC and DOT cells when present and nulls when absent', () => {
  const doc = loadFixture('dat-results-with-mc.html');
  const rows = parseDATResultsFromDocument(doc, DAT_SELECTORS);
  expect(rows[0].mcNumber).toBe('MC-123456');
  expect(rows[0].dotNumber).toBe('USDOT 7890');
  expect(rows[1].mcNumber).toBeNull();
});
```

Run: `cd scraper && npm test -- parse`
Expected: FAIL, `mcNumber` is undefined.

- [ ] **Step 3: Add selectors and parse fields**

`selectors.ts`:
```ts
cellMc:          process.env.DAT_SEL_CELL_MC         || '[data-field="mcNumber"]',
cellDot:         process.env.DAT_SEL_CELL_DOT        || '[data-field="dotNumber"]',
```
`parse.ts`: add `mcNumber: string | null; dotNumber: string | null;` to `DATParsedFields` and `mcNumber: text(sel.cellMc), dotNumber: text(sel.cellDot),` in `extractRow` (and in the second object literal at line ~108 that builds the same shape).

Run: `cd scraper && npm test -- parse`
Expected: PASS.

- [ ] **Step 4: Thread the fields through normalize, db, enqueue**

`normalize.ts`: add to `RawLoad` after `shipperEmail`:
```ts
posterCompanyRaw: string | null;
posterMcNumber: string | null;
posterDotNumber: string | null;
```
and in `normalizeDATRow`:
```ts
...posterFromRawLoad({
  shipperCompany: typeof dat.broker === 'string' ? dat.broker : null,
  posterMcNumber: typeof dat.mcNumber === 'string' ? dat.mcNumber : null,
  posterDotNumber: typeof dat.dotNumber === 'string' ? dat.dotNumber : null,
}),
```
`db.ts`: extend the INSERT exactly as Task 1 Step 7 item 4 (columns `poster_company_raw, poster_company_normalized, poster_mc_number, poster_dot_number, poster_raw_html`, params `$22..$26`, keep `'scraper-v1'`). `poster_raw_html` is `row.rowHTML` — thread it by adding `rawHtml: string | null` to `RawLoad` populated from `dat.rowHTML ?? null`. For `poster_company_normalized`, copy `normalizeCompanyName` into `scraper/src/pipeline/poster-identity.ts` as well (same byte-identical rule; it is 8 lines).
`enqueue.ts`: add the three poster fields and `isManualImport: false` to both the interface and `buildQualifyPayload`.

- [ ] **Step 5: Typecheck, build, test**

Run: `cd scraper && npm run typecheck && npm run build && npm test`
Expected: all clean; parse suite now 16+ tests.

- [ ] **Step 6: Commit**

```bash
git add scraper/src scraper/test
git commit -m "feat(E2-01 M1): DAT scraper captures poster company/MC/DOT and persists poster_raw_html"
```

---

### Task 4: Qualifier enforcement — F1 becomes a gate, reason codes, review routing

**Files:**
- Create: `lib/pipeline/gate-mode.ts`
- Modify: `lib/workers/qualifier-worker.ts` (`process()` ~line 150, `runShadowSourceClassification` ~line 249, `qualifyLoad` fail reasons ~lines 333–420, `updatePipelineLoad` ~line 487, `persistShadowClassification` ~line 535)
- Test: `__tests__/pipeline/gate-mode.test.ts`, `__tests__/pipeline/qualifier-source-gate.test.ts`, update `__tests__/pipeline/qualifier.test.ts` line 115 (`toMatch(/4 hours/)` → `toBe('pickup_too_soon')`)

**Interfaces:**
- Produces:
  ```ts
  // lib/pipeline/gate-mode.ts
  export type GateMode = 'off' | 'shadow' | 'enforce';
  export function getShipperDirectGateMode(env?: NodeJS.ProcessEnv): GateMode;
  export function getGateEnforcedAt(env?: NodeJS.ProcessEnv): Date | null; // from SHIPPER_DIRECT_GATE_ENFORCED_AT (ISO)
  ```
  `off` when `SHIPPER_DIRECT_GATE_ENABLED !== 'true'`; otherwise `SHIPPER_DIRECT_GATE_MODE` (`'enforce'` → enforce, anything else → shadow).
- `QualifierWorker.process()` outcome contract:
  - verdict `reject` (enforce) → `details.passed=false`, `details.reason=<reasonCode>`, stage `disqualified`.
  - verdict `review` (enforce) → `details.review=true`, `details.reason=<reasonCode>`, stage `escalated`, one `exceptions` row with `type='load_source_review'`, `source_module='load_source_review'`, `severity='medium'`, `sla_due_at = NOW() + 4h`, `pipeline_load_id` set, `detail` containing the evidence JSON.
  - verdict `accept` → Filters 2–7 run as today; priority gets `+100` when `method IN ('registry','manual_attestation') AND confidence >= 0.9`.
  - `shadow` / `off` → identical to today's behaviour.
- `qualification_reason` for every disqualification becomes a code from PRD §4.9; the human sentence moves to `qualification_detail`.

- [ ] **Step 1: Write the failing gate-mode unit test**

```ts
// __tests__/pipeline/gate-mode.test.ts
import { describe, it, expect } from 'vitest';
import { getShipperDirectGateMode, getGateEnforcedAt } from '@/lib/pipeline/gate-mode';

describe('getShipperDirectGateMode', () => {
  it('is off unless SHIPPER_DIRECT_GATE_ENABLED=true', () => {
    expect(getShipperDirectGateMode({})).toBe('off');
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'false', SHIPPER_DIRECT_GATE_MODE: 'enforce' })).toBe('off');
  });
  it('defaults to shadow when enabled without a mode', () => {
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'true' })).toBe('shadow');
  });
  it('enforces only on the exact word, trimmed and lowercased', () => {
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: ' TRUE\n', SHIPPER_DIRECT_GATE_MODE: ' Enforce ' })).toBe('enforce');
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'true', SHIPPER_DIRECT_GATE_MODE: 'enforced' })).toBe('shadow');
  });
});

describe('getGateEnforcedAt', () => {
  it('parses an ISO timestamp and returns null for garbage', () => {
    expect(getGateEnforcedAt({ SHIPPER_DIRECT_GATE_ENFORCED_AT: '2026-11-01T00:00:00Z' })?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(getGateEnforcedAt({ SHIPPER_DIRECT_GATE_ENFORCED_AT: 'soon' })).toBeNull();
    expect(getGateEnforcedAt({})).toBeNull();
  });
});
```

Run: `pnpm vitest run __tests__/pipeline/gate-mode.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 2: Implement `gate-mode.ts`**

```ts
// lib/pipeline/gate-mode.ts
/**
 * Single reader for the shipper-direct gate flags (E2-01 §4.11).
 * Exact-match, trimmed, lowercased — same discipline as every other Engine 2 kill switch.
 */
export type GateMode = 'off' | 'shadow' | 'enforce';

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();

export function getShipperDirectGateMode(env: NodeJS.ProcessEnv = process.env): GateMode {
  if (norm(env.SHIPPER_DIRECT_GATE_ENABLED) !== 'true') return 'off';
  return norm(env.SHIPPER_DIRECT_GATE_MODE) === 'enforce' ? 'enforce' : 'shadow';
}

/** Set by the operator at flip time (PRD §4.14 step 3). Rows created before it are tolerated by M2's assertions. */
export function getGateEnforcedAt(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env.SHIPPER_DIRECT_GATE_ENFORCED_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
```

Run the test — Expected: PASS.

- [ ] **Step 3: Write the failing Qualifier gate integration test**

```ts
// __tests__/pipeline/qualifier-source-gate.test.ts
/**
 * E2-01 M1 — F1 enforcement. Live Neon + Redis, like qualifier.test.ts.
 * Seeds poster_registry rows so no FMCSA call is ever made.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QualifierWorker, type QualifyJobPayload } from '@/lib/workers/qualifier-worker';

const RUN = Date.now();
const BROKER_MC = `9${String(RUN).slice(-6)}`;
const SHIPPER_NAME = `TEST Shipper ${RUN}`;

async function insertLoad(suffix: string, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country, pickup_date, equipment_type,
       posted_rate, posted_rate_currency, distance_miles, stage, created_by)
     VALUES ($1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US', NOW() + INTERVAL '3 days', 'Dry Van',
       2400, 'USD', 920, 'scanned', 'test')
     RETURNING id`, [`TEST-GATE-${suffix}-${RUN}`]);
  return r.rows[0].id;
}

function payload(id: number, loadId: string, poster: Partial<QualifyJobPayload>): QualifyJobPayload {
  return {
    pipelineLoadId: id, loadId, loadBoardSource: 'csv', enqueuedAt: new Date().toISOString(), priority: 0,
    origin: { city: 'Chicago', state: 'IL', country: 'US' }, destination: { city: 'Dallas', state: 'TX', country: 'US' },
    equipmentType: 'Dry Van', postedRate: 2400, postedRateCurrency: 'USD', distanceMiles: 920,
    pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(), shipperPhone: null, ...poster,
  };
}

describe('QualifierWorker shipper-direct gate (enforce)', () => {
  let worker: QualifierWorker; let researchQ: Queue; let matchQ: Queue;
  const ids: number[] = [];
  const prevEnv = { en: process.env.SHIPPER_DIRECT_GATE_ENABLED, mode: process.env.SHIPPER_DIRECT_GATE_MODE, pipe: process.env.PIPELINE_ENABLED };

  beforeAll(async () => {
    process.env.PIPELINE_ENABLED = 'true';
    researchQ = new Queue('research-queue-gate-test', { connection: redisConnection });
    matchQ = new Queue('match-queue-gate-test', { connection: redisConnection });
    worker = new QualifierWorker(redisConnection, researchQ, matchQ);
    await db.query(
      `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, country, entity_class, class_source, confidence)
       VALUES ('TEST Broker', 'test broker', $1, 'US', 'broker', 'human_review', 1.0),
              ($2, LOWER($2), NULL, 'US', 'shipper', 'human_review', 1.0)`, [BROKER_MC, SHIPPER_NAME]);
  });
  beforeEach(() => { process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true'; process.env.SHIPPER_DIRECT_GATE_MODE = 'enforce'; });
  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM poster_registry WHERE mc_number = $1 OR normalized_name = LOWER($2)`, [BROKER_MC, SHIPPER_NAME]);
    await researchQ.obliterate({ force: true }); await matchQ.obliterate({ force: true });
    await researchQ.close(); await matchQ.close(); await worker.shutdown();
    process.env.SHIPPER_DIRECT_GATE_ENABLED = prevEnv.en; process.env.SHIPPER_DIRECT_GATE_MODE = prevEnv.mode; process.env.PIPELINE_ENABLED = prevEnv.pipe;
  });

  it('rejects a registry-known broker with broker_posted_no_agreement before any other filter', async () => {
    const id = await insertLoad('broker'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-broker-${RUN}`, { posterCompanyRaw: 'TEST Broker', posterMcNumber: BROKER_MC }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason, load_source_class FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('disqualified');
    expect(row.qualification_reason).toBe('broker_posted_no_agreement');
    expect(row.load_source_class).toBe('broker_posted');
    expect((await researchQ.getJobs(['waiting', 'prioritized'])).length).toBe(0);
  });

  it('accepts a registry-known shipper and adds the +100 priority bonus', async () => {
    const id = await insertLoad('shipper'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-shipper-${RUN}`, { posterCompanyRaw: SHIPPER_NAME }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, load_source_class, load_source_method, priority_score FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('qualified');
    expect(row.load_source_class).toBe('shipper_direct');
    expect(row.load_source_method).toBe('registry');
    expect(Number(row.priority_score)).toBeGreaterThanOrEqual(100);
  });

  it('accepts a manual import attested yes even with no poster identity', async () => {
    const id = await insertLoad('attested'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-attested-${RUN}`, { isManualImport: true, attestation: 'yes' }));
    expect(res.details?.passed).toBe(true);
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT load_source_class, load_source_method FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ load_source_class: 'shipper_direct', load_source_method: 'manual_attestation' });
  });

  it('rejects a board row with no poster identity with poster_identity_missing', async () => {
    const id = await insertLoad('noid'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-noid-${RUN}`, {}));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ stage: 'disqualified', qualification_reason: 'poster_identity_missing' });
  });

  it('routes a registry-known for-hire carrier to review: escalated + exceptions row', async () => {
    await db.query(`INSERT INTO poster_registry (legal_name, normalized_name, country, entity_class, class_source, confidence)
                    VALUES ($1, LOWER($1), 'US', 'carrier_for_hire', 'human_review', 1.0)`, [`TEST Carrier ${RUN}`]);
    const id = await insertLoad('carrier'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-carrier-${RUN}`, { posterCompanyRaw: `TEST Carrier ${RUN}` }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, qualification_reason FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ stage: 'escalated', qualification_reason: 'poster_carrier_reposted_review' });
    const ex = (await db.query(`SELECT type, source_module, severity, sla_due_at FROM exceptions WHERE pipeline_load_id = $1`, [id])).rows[0];
    expect(ex.type).toBe('load_source_review');
    expect(ex.source_module).toBe('load_source_review');
    expect(ex.severity).toBe('medium');
    expect(ex.sla_due_at).not.toBeNull();
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = LOWER($1)`, [`TEST Carrier ${RUN}`]);
  });

  it('in shadow mode writes the class but lets a broker through to the normal filters', async () => {
    process.env.SHIPPER_DIRECT_GATE_MODE = 'shadow';
    const id = await insertLoad('shadow'); ids.push(id);
    const res = await worker.process(payload(id, `TEST-GATE-shadow-${RUN}`, { posterCompanyRaw: 'TEST Broker', posterMcNumber: BROKER_MC }));
    await (worker as any).updatePipelineLoad(id, res);
    const row = (await db.query(`SELECT stage, load_source_class FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(row.stage).toBe('qualified');
    expect(row.load_source_class).toBe('broker_posted');
  });
});
```

Run: `pnpm vitest run __tests__/pipeline/qualifier-source-gate.test.ts`
Expected: FAIL on the first five (stage is `qualified`, reason is prose).

- [ ] **Step 4: Rename the shadow hook and make it always classify when enabled**

In `qualifier-worker.ts`:
1. Rename `runShadowSourceClassification` → `classifyPosterSource` and `ShadowSourceClassification` → `SourceClassification`. Replace its first guard with:
   ```ts
   if (getShipperDirectGateMode() === 'off') return null;
   ```
   (import `getShipperDirectGateMode` from `@/lib/pipeline/gate-mode`).
2. Pass the attestation through instead of `null`:
   ```ts
   attestation: payload.attestation ? { value: payload.attestation } : null,
   ```
3. Update the class-level comment above `process()` to describe shadow vs enforce (replace the "This is intentionally shadow-only" paragraph with: "In `shadow` mode the classification is written but never gates. In `enforce` mode F1 runs first: reject → `disqualified`, review → `escalated` + Alert Center exception, accept → Filters 2–7 as before. See `lib/pipeline/gate-mode.ts`.").

- [ ] **Step 5: Add the enforcement branch to `process()`**

Immediately after `const sourceClassification = await this.classifyPosterSource(payload);` and before `const qualResult = await this.qualifyLoad(payload);`:

```ts
const gateMode = getShipperDirectGateMode();
if (gateMode === 'enforce' && sourceClassification) {
  const { classification } = sourceClassification;
  if (classification.verdict === 'reject') {
    logger.info(`[Qualifier] Load ${pipelineLoadId} rejected by F1: ${classification.reasonCode}`);
    return {
      success: true, pipelineLoadId, stage: this.config.expectedStage, duration: 0,
      details: { passed: false, reason: classification.reasonCode ?? 'poster_unresolved_review', detail: `F1 poster classification: class=${classification.class}`, sourceClassification },
    };
  }
  if (classification.verdict === 'review') {
    logger.info(`[Qualifier] Load ${pipelineLoadId} routed to review: ${classification.reasonCode}`);
    return {
      success: true, pipelineLoadId, stage: this.config.expectedStage, duration: 0,
      details: { passed: false, review: true, reason: classification.reasonCode ?? 'poster_unresolved_review', detail: `F1 poster classification needs a human: class=${classification.class}`, sourceClassification },
    };
  }
}
```

And after `const qualResult = await this.qualifyLoad(payload);`, before the `if (qualResult.passed)` block:

```ts
if (gateMode === 'enforce' && sourceClassification && qualResult.passed) {
  const { method, confidence } = sourceClassification.classification;
  if ((method === 'registry' || method === 'manual_attestation') && confidence >= 0.9) {
    qualResult.priorityScore += 100; // PRD §4.6 — verified-shipper freight to the front of the queue
  }
}
```

- [ ] **Step 6: Convert Filters 1–6 reasons to codes**

In `qualifyLoad()` change `fail(reason)` to `fail(code, detail)`:
```ts
const fail = (reason: string, detail: string): QualificationResult => ({ passed: false, reason, detail, priorityScore: 0, estimatedMarginLow: 0, estimatedMarginHigh: 0, carrierMatchCount: 0, isRepeatShipper: false });
```
Add `detail?: string` to `QualificationResult`. Replace the five call sites (logic untouched):
- freshness → `fail('pickup_too_soon', 'Pickup is in the past or less than 4 hours away')`
- equipment → `fail('no_equipment_match', \`No active insured carriers with ${normalizedEquip} equipment\`)`
- margin → `fail('margin_too_thin', \`Best-case margin $${estimatedMarginHigh.toFixed(0)} < 50% of minimum $${minMargin}\`)`
- DNC → `fail('dnc_listed', 'Shipper phone is on do-not-call list')`
- fatigue → `fail('shipper_fatigue', <existing sentence>)`

In `process()`'s disqualified return, add `detail: qualResult.detail`. In `qualifier.test.ts` line 115 change `toMatch(/4 hours/)` to `toBe('pickup_too_soon')`.

- [ ] **Step 7: Extend `updatePipelineLoad` with the review branch and fold the class write into the decision UPDATE**

Replace the body with three branches. The accept branch keeps its current UPDATE and adds `qualification_detail = NULL`. The reject branch:

```ts
} else if (result.details?.review) {
  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'escalated', stage_updated_at = NOW(),
         qualification_reason = $2, qualification_detail = $3, updated_at = NOW()
     WHERE id = $1`,
    [pipelineLoadId, result.details.reason, result.details.detail ?? null],
  );
  await this.insertReviewException(pipelineLoadId, result.details.sourceClassification);
} else {
  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'disqualified', stage_updated_at = NOW(),
         qualification_reason = $2, qualification_detail = $3, updated_at = NOW()
     WHERE id = $1`,
    [pipelineLoadId, result.details?.reason ?? 'unspecified', result.details?.detail ?? null],
  );
}
await this.persistSourceClassification(pipelineLoadId, result.details?.sourceClassification ?? null);
```

Rename `persistShadowClassification` → `persistSourceClassification`; keep its body but **stop overwriting `qualification_detail`** (remove `qualification_detail = $6` and the `detail` string; the evidence JSON already carries the policy result — add `policyResult`/`policyError` into the `load_source_evidence` object instead).

Add:

```ts
private async insertReviewException(pipelineLoadId: number, source: SourceClassification | null): Promise<void> {
  const load = (await db.query<{ origin_city: string; origin_state: string; destination_city: string; destination_state: string; poster_company_raw: string | null; pickup_date: Date | null }>(
    `SELECT origin_city, origin_state, destination_city, destination_state, poster_company_raw, pickup_date FROM pipeline_loads WHERE id = $1`,
    [pipelineLoadId])).rows[0];
  const poster = load?.poster_company_raw ?? 'unknown poster';
  const cls = source?.classification;
  const title = `Load source review: ${poster} — ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
  const suggestedAction = cls?.class === 'carrier_reposted'
    ? `${poster} holds for-hire carrier authority and is posting freight. Confirm this is their own private-fleet freight. The registry will remember your answer.`
    : `Confirm whether ${poster} is a direct shipper or a broker. The registry will remember your answer.`;
  const detail = JSON.stringify({ reasonCode: cls?.reasonCode, class: cls?.class, evidence: cls?.evidence ?? null });
  await db.query(
    `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, pipeline_load_id, source_module, suggested_action, sla_due_at)
     VALUES (NULL, NULL, 'load_source_review', 'medium', $1, $2, $3, 'load_source_review', $4, NOW() + INTERVAL '4 hours')`,
    [title, detail, pipelineLoadId, suggestedAction],
  );
}
```

(Business-hours SLA from PRD §4.7 is simplified to wall-clock 4 h here; Task 6's expiry rule is what actually bounds the wait.)

- [ ] **Step 8: Run the gate test, the existing qualifier test, and tsc**

Run: `pnpm vitest run __tests__/pipeline/qualifier-source-gate.test.ts __tests__/pipeline/qualifier.test.ts __tests__/pipeline/gate-mode.test.ts && pnpm tsc --noEmit`
Expected: PASS (6 + existing + 4); tsc clean. The pre-existing `qualifier.test.ts` shadow case still passes because `MODE` is unset there (→ shadow).

- [ ] **Step 9: Commit**

```bash
git add lib/pipeline/gate-mode.ts lib/workers/qualifier-worker.ts __tests__/pipeline/gate-mode.test.ts __tests__/pipeline/qualifier-source-gate.test.ts __tests__/pipeline/qualifier.test.ts
git commit -m "feat(E2-01 M1): Qualifier F1 shipper-direct gate — enforce mode, reason codes, review routing"
```

---

### Task 5: Human review resolution — `resolve-source`

**Files:**
- Create: `lib/pipeline/resolve-load-source.ts`, `app/api/pipeline/loads/[id]/resolve-source/route.ts`
- Test: `__tests__/pipeline/resolve-load-source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ResolveSourceInput {
    pipelineLoadId: number;
    entityClass: 'shipper' | 'broker' | 'carrier_for_hire' | 'carrier_private';
    appliesToPoster: boolean;   // true → upsert poster_registry
    note: string | null;
    resolvedBy: string;          // user id
  }
  export type ResolveSourceResult =
    | { ok: true; registryId: number | null; reEnqueued: true }
    | { ok: false; error: 'not_found' | 'not_in_review' | 'expired' | 'no_poster_identity' };
  export async function resolveLoadSource(input: ResolveSourceInput, qualifyQueue: Queue): Promise<ResolveSourceResult>;
  ```
- Route: `POST /api/pipeline/loads/[id]/resolve-source`, roles `admin | owner | service_admin | dispatcher`, body `{ entity_class, applies_to_poster, note? }`. 404 / 409 / 200 mapped from the result.
- Effects in one transaction: upsert `poster_registry` (keyed on MC if present else `(normalized_name, country)`; `class_source='human_review'`, `confidence=1.0`, `verified_by`), update the load's `poster_registry_id`, set `stage='scanned'`, `qualification_reason=NULL`, resolve the `load_source_review` exception (`status='resolved', resolved_at=NOW()`), then re-enqueue `qualify-queue` with a payload rebuilt from the row. The Qualifier then resolves it from the registry (method `registry`) — the human informs the filter, never bypasses it.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/pipeline/resolve-load-source.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { resolveLoadSource } from '@/lib/pipeline/resolve-load-source';

const RUN = Date.now();
const POSTER = `TEST Resolve Co ${RUN}`;

describe('resolveLoadSource', () => {
  let q: Queue; let id: number; let expiredId: number;
  beforeAll(async () => {
    q = new Queue('qualify-queue-resolve-test', { connection: redisConnection });
    const mk = async (suffix: string, pickup: string) => (await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country, destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency, distance_miles, stage, qualification_reason,
         poster_company_raw, poster_company_normalized, created_by)
       VALUES ($1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US', ${pickup}, 'Dry Van', 2400, 'USD', 920, 'escalated', 'poster_unresolved_review', $2, LOWER($2), 'test')
       RETURNING id`, [`TEST-RESOLVE-${suffix}-${RUN}`, POSTER])).rows[0].id;
    id = await mk('ok', `NOW() + INTERVAL '3 days'`);
    expiredId = await mk('expired', `NOW() - INTERVAL '1 day'`);
    await db.query(`INSERT INTO exceptions (type, severity, title, detail, pipeline_load_id, source_module, status) VALUES ('load_source_review','medium','t','{}',$1,'load_source_review','active')`, [id]);
  });
  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1::int[])`, [[id, expiredId]]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [[id, expiredId]]);
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = LOWER($1)`, [POSTER]);
    await q.obliterate({ force: true }); await q.close();
  });

  it('writes the registry, resolves the exception, resets to scanned, and re-enqueues', async () => {
    const res = await resolveLoadSource({ pipelineLoadId: id, entityClass: 'shipper', appliesToPoster: true, note: 'known customer', resolvedBy: 'user-1' }, q);
    expect(res.ok).toBe(true);
    const reg = (await db.query(`SELECT entity_class, class_source, confidence, verified_by FROM poster_registry WHERE normalized_name = LOWER($1)`, [POSTER])).rows[0];
    expect(reg).toMatchObject({ entity_class: 'shipper', class_source: 'human_review', verified_by: 'user-1' });
    expect(Number(reg.confidence)).toBe(1);
    const load = (await db.query(`SELECT stage, qualification_reason, poster_registry_id FROM pipeline_loads WHERE id = $1`, [id])).rows[0];
    expect(load.stage).toBe('scanned');
    expect(load.qualification_reason).toBeNull();
    expect(load.poster_registry_id).not.toBeNull();
    const ex = (await db.query(`SELECT status FROM exceptions WHERE pipeline_load_id = $1`, [id])).rows[0];
    expect(ex.status).toBe('resolved');
    const jobs = await q.getJobs(['waiting', 'prioritized']);
    expect(jobs.some((j) => j.data.pipelineLoadId === id && j.data.posterCompanyRaw === POSTER)).toBe(true);
  });

  it('refuses a load whose pickup window has passed', async () => {
    const res = await resolveLoadSource({ pipelineLoadId: expiredId, entityClass: 'shipper', appliesToPoster: false, note: null, resolvedBy: 'user-1' }, q);
    expect(res).toEqual({ ok: false, error: 'expired' });
  });

  it('refuses a load that is not in review', async () => {
    const res = await resolveLoadSource({ pipelineLoadId: id, entityClass: 'shipper', appliesToPoster: false, note: null, resolvedBy: 'user-1' }, q);
    expect(res).toEqual({ ok: false, error: 'not_in_review' }); // it is 'scanned' after the first test
  });
});
```

Run: `pnpm vitest run __tests__/pipeline/resolve-load-source.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 2: Implement `resolve-load-source.ts`**

```ts
// lib/pipeline/resolve-load-source.ts
import type { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

export interface ResolveSourceInput { /* as in Interfaces above */ }
export type ResolveSourceResult = /* as in Interfaces above */;

interface LoadRow {
  id: number; load_id: string; load_board_source: string; stage: string; qualification_reason: string | null;
  origin_city: string; origin_state: string; origin_country: string;
  destination_city: string; destination_state: string; destination_country: string;
  equipment_type: string; posted_rate: string | null; posted_rate_currency: string | null; distance_miles: string | null;
  pickup_date: Date; shipper_phone: string | null;
  poster_company_raw: string | null; poster_company_normalized: string | null; poster_mc_number: string | null; poster_dot_number: string | null;
  shipper_direct_attestation: string | null; created_by: string | null;
}

export async function resolveLoadSource(input: ResolveSourceInput, qualifyQueue: Queue): Promise<ResolveSourceResult> {
  const load = (await db.query<LoadRow>(`SELECT * FROM pipeline_loads WHERE id = $1`, [input.pipelineLoadId])).rows[0];
  if (!load) return { ok: false, error: 'not_found' };
  if (load.stage !== 'escalated' || !(load.qualification_reason ?? '').endsWith('_review')) return { ok: false, error: 'not_in_review' };
  if (new Date(load.pickup_date).getTime() < Date.now() + 4 * 3600_000) return { ok: false, error: 'expired' };
  if (input.appliesToPoster && !load.poster_mc_number && !load.poster_company_normalized) return { ok: false, error: 'no_poster_identity' };

  let registryId: number | null = null;
  await db.query('BEGIN');
  try {
    if (input.appliesToPoster) {
      const r = load.poster_mc_number
        ? await db.query<{ id: number }>(
            `INSERT INTO poster_registry (legal_name, normalized_name, mc_number, dot_number, country, entity_class, class_source, confidence, verified_by, last_verified_at, notes)
             VALUES ($1, $2, $3, $4, $5, $6, 'human_review', 1.0, $7, NOW(), $8)
             ON CONFLICT (mc_number) WHERE mc_number IS NOT NULL DO UPDATE
               SET entity_class = EXCLUDED.entity_class, class_source = 'human_review', confidence = 1.0,
                   verified_by = EXCLUDED.verified_by, last_verified_at = NOW(), notes = EXCLUDED.notes, updated_at = NOW()
             RETURNING id`,
            [load.poster_company_raw, load.poster_company_normalized, load.poster_mc_number, load.poster_dot_number, load.origin_country, input.entityClass, input.resolvedBy, input.note])
        : await upsertByName(load, input);
      registryId = r.rows[0].id;
    }
    await db.query(
      `UPDATE pipeline_loads SET stage = 'scanned', stage_updated_at = NOW(), qualification_reason = NULL, qualification_detail = NULL,
         poster_registry_id = COALESCE($2, poster_registry_id), updated_at = NOW() WHERE id = $1`,
      [load.id, registryId]);
    await db.query(
      `UPDATE exceptions SET status = 'resolved', resolved_at = NOW() WHERE pipeline_load_id = $1 AND type = 'load_source_review' AND status <> 'resolved'`,
      [load.id]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  await qualifyQueue.add('qualify', {
    pipelineLoadId: load.id, loadId: load.load_id, loadBoardSource: load.load_board_source,
    enqueuedAt: new Date().toISOString(), priority: 0,
    origin: { city: load.origin_city, state: load.origin_state, country: load.origin_country },
    destination: { city: load.destination_city, state: load.destination_state, country: load.destination_country },
    equipmentType: load.equipment_type, postedRate: load.posted_rate ? Number(load.posted_rate) : null,
    postedRateCurrency: load.posted_rate_currency ?? 'USD', distanceMiles: load.distance_miles ? Number(load.distance_miles) : 0,
    pickupDate: new Date(load.pickup_date).toISOString(), shipperPhone: load.shipper_phone,
    posterCompanyRaw: load.poster_company_raw, posterMcNumber: load.poster_mc_number, posterDotNumber: load.poster_dot_number,
    isManualImport: (load.created_by ?? '').startsWith('scanner-csv'),
    attestation: load.shipper_direct_attestation,
  });
  logger.info(`[resolve-source] load ${load.id} resolved as ${input.entityClass} by ${input.resolvedBy}; re-enqueued`);
  return { ok: true, registryId, reEnqueued: true };
}

async function upsertByName(load: LoadRow, input: ResolveSourceInput) {
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM poster_registry WHERE normalized_name = $1 AND country IS NOT DISTINCT FROM $2 AND mc_number IS NULL LIMIT 1`,
    [load.poster_company_normalized, load.origin_country]);
  if (existing.rows[0]) {
    await db.query(
      `UPDATE poster_registry SET entity_class = $2, class_source = 'human_review', confidence = 1.0, verified_by = $3, last_verified_at = NOW(), notes = $4, updated_at = NOW() WHERE id = $1`,
      [existing.rows[0].id, input.entityClass, input.resolvedBy, input.note]);
    return existing;
  }
  return db.query<{ id: number }>(
    `INSERT INTO poster_registry (legal_name, normalized_name, dot_number, country, entity_class, class_source, confidence, verified_by, last_verified_at, notes)
     VALUES ($1, $2, $3, $4, $5, 'human_review', 1.0, $6, NOW(), $7) RETURNING id`,
    [load.poster_company_raw, load.poster_company_normalized, load.poster_dot_number, load.origin_country, input.entityClass, input.resolvedBy, input.note]);
}
```

Note on transactions: `db-adapter.ts` wraps a single Neon HTTP client; confirm `BEGIN`/`COMMIT` work through it by reading the adapter. If it uses the HTTP (non-session) driver, replace the three statements with one `WITH … AS` CTE statement or use `withTenant()`'s pooled client from `lib/db/tenant-context.ts`, which does support transactions.

Run the test — Expected: PASS (3).

- [ ] **Step 3: Add the route**

```ts
// app/api/pipeline/loads/[id]/resolve-source/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { resolveLoadSource } from '@/lib/pipeline/resolve-load-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENTITY_CLASSES = new Set(['shipper', 'broker', 'carrier_for_hire', 'carrier_private']);
let queue: Queue | null = null;
const getQueue = () => (queue ??= new Queue('qualify-queue', { connection: redisConnection }));

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const denied = requireRole(user, 'admin', 'owner', 'service_admin', 'dispatcher');
  if (denied) return denied;

  const { id } = await params;
  const pipelineLoadId = Number(id);
  if (!Number.isInteger(pipelineLoadId)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });

  let body: { entity_class?: string; applies_to_poster?: boolean; note?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  if (!body.entity_class || !ENTITY_CLASSES.has(body.entity_class)) {
    return NextResponse.json({ error: 'invalid_entity_class', allowed: [...ENTITY_CLASSES] }, { status: 400 });
  }

  const result = await resolveLoadSource({
    pipelineLoadId, entityClass: body.entity_class as any, appliesToPoster: body.applies_to_poster !== false,
    note: body.note ?? null, resolvedBy: user.userId,
  }, getQueue());

  if (result.ok) return NextResponse.json(result);
  const status = result.error === 'not_found' ? 404 : 409;
  return NextResponse.json(result, { status });
}
```

Check `getCurrentUser`'s return shape in `lib/auth.ts` for the user-id field name (`userId` vs `id`) and use the real one.

- [ ] **Step 4: tsc and commit**

Run: `pnpm tsc --noEmit` — Expected: clean.

```bash
git add lib/pipeline/resolve-load-source.ts "app/api/pipeline/loads/[id]/resolve-source/route.ts" __tests__/pipeline/resolve-load-source.test.ts
git commit -m "feat(E2-01 M1): resolve-source — human review writes the poster registry and re-queues the load"
```

---

### Task 6: Review SLA expiry in the pipeline-health cron

**Files:**
- Modify: `lib/pipeline/health-checks.ts`, `app/api/cron/pipeline-health/route.ts`
- Test: `__tests__/pipeline/health-checks.test.ts`

**Interfaces:**
- Produces: `export async function expireUnresolvedSourceReviews(): Promise<{ found: number; expired: number }>` — moves every `pipeline_loads` row with `stage='escalated' AND qualification_reason LIKE '%\_review' AND pickup_date < NOW() + INTERVAL '4 hours'` to `stage='expired'`, appends `'; review SLA missed'` to `qualification_detail`, and resolves its `load_source_review` exception.

- [ ] **Step 1: Write the failing test** (append to `health-checks.test.ts`, following its existing insert/cleanup helpers)

```ts
describe('expireUnresolvedSourceReviews', () => {
  it('expires a review load whose pickup is inside 4h and resolves its exception, leaves a fresh one alone', async () => {
    const stale = await insertPipelineLoad({ stage: 'escalated', qualification_reason: 'poster_unresolved_review', pickup_date: `NOW() + INTERVAL '1 hour'` });
    const fresh = await insertPipelineLoad({ stage: 'escalated', qualification_reason: 'poster_unresolved_review', pickup_date: `NOW() + INTERVAL '2 days'` });
    await db.query(`INSERT INTO exceptions (type, severity, title, detail, pipeline_load_id, source_module, status) VALUES ('load_source_review','medium','t','{}',$1,'load_source_review','active')`, [stale]);
    const r = await expireUnresolvedSourceReviews();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT stage FROM pipeline_loads WHERE id = $1`, [stale])).rows[0].stage).toBe('expired');
    expect((await db.query(`SELECT stage FROM pipeline_loads WHERE id = $1`, [fresh])).rows[0].stage).toBe('escalated');
    expect((await db.query(`SELECT status FROM exceptions WHERE pipeline_load_id = $1`, [stale])).rows[0].status).toBe('resolved');
    await cleanup([stale, fresh]);
  });
});
```

(If `health-checks.test.ts` has no `insertPipelineLoad`/`cleanup` helpers, add them at the top of the file using the same INSERT shape as Task 4 Step 3 with `stage`, `qualification_reason`, and `pickup_date` parameterised.)

Run: `pnpm vitest run __tests__/pipeline/health-checks.test.ts -t expireUnresolvedSourceReviews` — Expected: FAIL, function not exported.

- [ ] **Step 2: Implement**

Append to `lib/pipeline/health-checks.ts`:

```ts
/**
 * E2-01 §4.7 step 4 — a load parked at 'escalated' for human source review
 * must not wait forever. Once its pickup is inside the 4-hour freshness
 * window the Qualifier would reject it anyway, so expire it and close the
 * Alert Center row.
 */
export async function expireUnresolvedSourceReviews(): Promise<{ found: number; expired: number }> {
  const found = await db.query<{ id: number }>(
    `SELECT id FROM pipeline_loads
      WHERE stage = 'escalated' AND qualification_reason LIKE '%\\_review'
        AND pickup_date < NOW() + INTERVAL '4 hours'`);
  const ids = found.rows.map((r) => r.id);
  if (ids.length === 0) return { found: 0, expired: 0 };
  await db.query(
    `UPDATE pipeline_loads SET stage = 'expired', stage_updated_at = NOW(),
       qualification_detail = COALESCE(qualification_detail, '') || '; review SLA missed', updated_at = NOW()
     WHERE id = ANY($1::int[])`, [ids]);
  await db.query(
    `UPDATE exceptions SET status = 'resolved', resolved_at = NOW()
     WHERE pipeline_load_id = ANY($1::int[]) AND type = 'load_source_review' AND status <> 'resolved'`, [ids]);
  return { found: ids.length, expired: ids.length };
}
```

In `app/api/cron/pipeline-health/route.ts`, import it and call it after `detectMissedPickupWindows()`, adding its result to the JSON response under `sourceReviewExpiry`.

Run the test — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/health-checks.ts app/api/cron/pipeline-health/route.ts __tests__/pipeline/health-checks.test.ts
git commit -m "feat(E2-01 M1): expire unresolved load-source reviews inside the pickup window"
```

---

### Task 7: M2 assertions in the Compiler and Dispatcher

**Files:**
- Create: `lib/pipeline/load-source-assert.ts`
- Modify: `lib/workers/compiler-worker.ts` (after `fetchPipelineLoad`, ~line 106), `lib/workers/dispatcher-worker.ts` (after `fetchPipelineLoad`, ~line 147)
- Test: `__tests__/pipeline/load-source-assert.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SourceAssertion = { ok: true } | { ok: false; reasonCode: 'source_assertion_failed_compiler' | 'source_assertion_failed_dispatcher'; detail: string };
  export function assertLoadSource(load: { load_source_class: string | null; created_at: Date | string | null }, stage: 'compiler' | 'dispatcher', env?: NodeJS.ProcessEnv): SourceAssertion;
  export async function escalateSourceAssertion(pipelineLoadId: number, assertion: Extract<SourceAssertion, { ok: false }>): Promise<void>;
  ```
- `assertLoadSource` returns `ok` when mode is not `enforce`, when the row predates `getGateEnforcedAt()` (or no timestamp is set), or when class is `shipper_direct` / `co_brokered`. Otherwise `ok:false`.
- `escalateSourceAssertion` sets `stage='escalated'`, `qualification_reason=<reasonCode>`, inserts a `critical` exception (`type='load_source_assertion'`, `source_module='load_source_assertion'`).

- [ ] **Step 1: Write the failing pure test**

```ts
// __tests__/pipeline/load-source-assert.test.ts
import { describe, it, expect } from 'vitest';
import { assertLoadSource } from '@/lib/pipeline/load-source-assert';

const ENFORCE = { SHIPPER_DIRECT_GATE_ENABLED: 'true', SHIPPER_DIRECT_GATE_MODE: 'enforce', SHIPPER_DIRECT_GATE_ENFORCED_AT: '2026-11-01T00:00:00Z' };

describe('assertLoadSource', () => {
  it('passes shipper_direct and co_brokered', () => {
    expect(assertLoadSource({ load_source_class: 'shipper_direct', created_at: '2026-11-02T00:00:00Z' }, 'compiler', ENFORCE).ok).toBe(true);
    expect(assertLoadSource({ load_source_class: 'co_brokered', created_at: '2026-11-02T00:00:00Z' }, 'dispatcher', ENFORCE).ok).toBe(true);
  });
  it('fails broker_posted and unresolved with a stage-specific code', () => {
    const r = assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', ENFORCE);
    expect(r).toMatchObject({ ok: false, reasonCode: 'source_assertion_failed_compiler' });
    expect(assertLoadSource({ load_source_class: null, created_at: '2026-11-02T00:00:00Z' }, 'dispatcher', ENFORCE)).toMatchObject({ ok: false, reasonCode: 'source_assertion_failed_dispatcher' });
  });
  it('tolerates NULL class on rows created before the enforcement timestamp', () => {
    expect(assertLoadSource({ load_source_class: null, created_at: '2026-10-01T00:00:00Z' }, 'compiler', ENFORCE).ok).toBe(true);
  });
  it('is a no-op in shadow or off mode', () => {
    expect(assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', { ...ENFORCE, SHIPPER_DIRECT_GATE_MODE: 'shadow' }).ok).toBe(true);
    expect(assertLoadSource({ load_source_class: 'broker_posted', created_at: '2026-11-02T00:00:00Z' }, 'compiler', {}).ok).toBe(true);
  });
});
```

Run: `pnpm vitest run __tests__/pipeline/load-source-assert.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// lib/pipeline/load-source-assert.ts
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getShipperDirectGateMode, getGateEnforcedAt } from '@/lib/pipeline/gate-mode';

const ACCEPTED = new Set(['shipper_direct', 'co_brokered']);

export type SourceAssertion = /* as in Interfaces */;

export function assertLoadSource(load, stage, env = process.env): SourceAssertion {
  if (getShipperDirectGateMode(env) !== 'enforce') return { ok: true };
  const enforcedAt = getGateEnforcedAt(env);
  const createdAt = load.created_at ? new Date(load.created_at) : null;
  if (enforcedAt && createdAt && createdAt < enforcedAt) return { ok: true }; // PRD §4.14 step 3 tolerance
  if (load.load_source_class && ACCEPTED.has(load.load_source_class)) return { ok: true };
  return {
    ok: false,
    reasonCode: stage === 'compiler' ? 'source_assertion_failed_compiler' : 'source_assertion_failed_dispatcher',
    detail: `load_source_class=${load.load_source_class ?? 'NULL'} reached the ${stage} under enforce mode — something injected a load mid-pipeline`,
  };
}

export async function escalateSourceAssertion(pipelineLoadId: number, a: Extract<SourceAssertion, { ok: false }>): Promise<void> {
  await db.query(
    `UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW(), qualification_reason = $2, qualification_detail = $3, updated_at = NOW() WHERE id = $1`,
    [pipelineLoadId, a.reasonCode, a.detail]);
  await db.query(
    `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, pipeline_load_id, source_module, suggested_action, sla_due_at)
     VALUES (NULL, NULL, 'load_source_assertion', 'critical', $1, $2, $3, 'load_source_assertion', 'Find out how this load bypassed the Qualifier gate. Do not release it.', NOW() + INTERVAL '1 hour')`,
    [`Source assertion failed: ${a.reasonCode}`, a.detail, pipelineLoadId]);
  logger.error(`[load-source-assert] load ${pipelineLoadId}: ${a.detail}`);
}
```

Run the test — Expected: PASS (4).

- [ ] **Step 3: Wire into both workers (live-path change — flag for Patrice's review)**

`compiler-worker.ts`, immediately after `const load = await this.fetchPipelineLoad(pipelineLoadId);`:
```ts
const sourceAssertion = assertLoadSource(load, 'compiler');
if (!sourceAssertion.ok) {
  await escalateSourceAssertion(pipelineLoadId, sourceAssertion);
  return { success: true, pipelineLoadId, stage: this.config.expectedStage, duration: 0, details: { escalated: true, reason: sourceAssertion.reasonCode } };
}
```
Confirm the Compiler's `fetchPipelineLoad` SELECT (`SELECT * FROM pipeline_loads WHERE id = $1`, line ~599) already returns `load_source_class` and `created_at`; it does because it is `SELECT *`. For the Dispatcher, add `load_source_class, created_at` to its `PipelineLoadRow` interface and its SELECT, then insert the identical block after its `fetchPipelineLoad` call with `'dispatcher'`. Make sure the early return does **not** trigger `BaseWorker`'s automatic stage advance — check how `dispatcher-worker.ts`'s existing `escalated: true` return (line ~183) suppresses it and mirror that exactly.

- [ ] **Step 4: Run the compiler and dispatcher suites and tsc**

Run: `pnpm vitest run __tests__/pipeline/compiler.test.ts __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts __tests__/pipeline/load-source-assert.test.ts && pnpm tsc --noEmit`
Expected: PASS (mode is unset in those suites → assertion is a no-op); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/load-source-assert.ts lib/workers/compiler-worker.ts lib/workers/dispatcher-worker.ts __tests__/pipeline/load-source-assert.test.ts
git commit -m "feat(E2-01 M2): assert load_source_class at Compiler and Dispatcher (three-point enforcement, E3-R2)"
```

---

### Task 8: Brief fields — `load_source_class`, `poster_legal_name`, `co_broker_counterparty`

**Files:**
- Modify: `lib/pipeline/negotiation-brief.ts` (brief interface ~line 250, `compileRetellPayload` ~line 537, `validateBrief` ~line 654), `lib/workers/compiler-worker.ts` (`assembleBrief`)
- Test: `__tests__/pipeline/compiler.test.ts`

**Interfaces:**
- `NegotiationBrief.load` gains `sourceClass: string | null; posterLegalName: string | null; coBrokerCounterparty: string | null`.
- `compileRetellPayload` emits three more string dynamic variables: `load_source_class` (default `'unknown'`), `poster_legal_name` (default `'the shipper'`), `co_broker_counterparty` (default `''`). **All must be strings** (Retell contract). The dynamic-variable count in the Sprint 3 checkpoint (63) becomes 66; update the Retell dashboard agents to declare them — operator task, recorded in the tracker.

- [ ] **Step 1: Write the failing test** (append to `compiler.test.ts`, using its existing brief fixture builder)

```ts
it('carries load source fields into the Retell payload as strings', () => {
  const brief = buildTestBrief({ load: { sourceClass: 'co_brokered', posterLegalName: 'Acme Logistics Inc.', coBrokerCounterparty: 'Acme Logistics Inc.' } });
  const payload = compileRetellPayload(brief);
  const vars = payload.retell_llm_dynamic_variables;
  expect(vars.load_source_class).toBe('co_brokered');
  expect(vars.poster_legal_name).toBe('Acme Logistics Inc.');
  expect(vars.co_broker_counterparty).toBe('Acme Logistics Inc.');
  expect(Object.values(vars).every((v) => typeof v === 'string')).toBe(true);
});
```

Run: `pnpm vitest run __tests__/pipeline/compiler.test.ts -t "load source fields"` — Expected: FAIL.

- [ ] **Step 2: Implement**

In `negotiation-brief.ts` add the three fields to the brief's `load` block and to `compileRetellPayload`:
```ts
load_source_class: brief.load.sourceClass ?? 'unknown',
poster_legal_name: brief.load.posterLegalName ?? (brief.shipper.companyName || 'the shipper'),
co_broker_counterparty: brief.load.coBrokerCounterparty ?? '',
```
In `validateBrief`, add a warning (not an error) when `sourceClass` is null: `'load_source_class missing — gate not enforced for this row'`.
In `compiler-worker.ts` `assembleBrief`, populate from the row: `sourceClass: load.load_source_class ?? null`, `posterLegalName: load.poster_company_raw ?? null`, `coBrokerCounterparty: load.load_source_class === 'co_brokered' ? (load.poster_company_raw ?? null) : null`. Add `poster_company_raw` and `load_source_class` to the Compiler's `PipelineLoadRow` interface.

Run the compiler suite — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/negotiation-brief.ts lib/workers/compiler-worker.ts __tests__/pipeline/compiler.test.ts
git commit -m "feat(E2-01 M2): brief carries load_source_class / poster_legal_name / co_broker_counterparty"
```

---

### Task 9: Calibration report before the flag flips

**Files:**
- Create: `scripts/e2_source_calibration_report.ts`
- Test: `__tests__/scripts/e2-source-calibration-report.test.ts`

**Interfaces:**
- Produces: `export async function buildCalibrationReport(): Promise<CalibrationReport>` where
  ```ts
  interface CalibrationReport {
    totalRows: number;
    byClass: Record<string, number>;
    byMethod: Record<string, number>;
    registryHitRate: number;            // rows with method='registry' / rows with any poster identity
    labelledBrokersAccepted: Array<{ pipelineLoadId: number; poster: string; class: string }>; // MUST be empty (PRD §4.12 step 4)
    unresolvedTopPosters: Array<{ poster: string; count: number }>; // top 50 for Patrice to label
  }
  ```
- CLI: `pnpm tsx --env-file=.env.local scripts/e2_source_calibration_report.ts` prints the report as JSON and exits 1 if `labelledBrokersAccepted.length > 0`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/scripts/e2-source-calibration-report.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { buildCalibrationReport } from '@/scripts/e2_source_calibration_report';

const RUN = Date.now();
describe('buildCalibrationReport', () => {
  let bad: number;
  beforeAll(async () => {
    await db.query(`INSERT INTO poster_registry (legal_name, normalized_name, country, entity_class, class_source, confidence) VALUES ($1, LOWER($1), 'US', 'broker', 'human_review', 1.0)`, [`TEST CalBroker ${RUN}`]);
    bad = (await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country, destination_city, destination_state, destination_country, pickup_date, equipment_type, stage,
         poster_company_raw, poster_company_normalized, load_source_class, load_source_method, created_by)
       VALUES ($1, 'csv', 'A', 'IL', 'US', 'B', 'TX', 'US', NOW() + INTERVAL '2 days', 'Dry Van', 'scanned', $2, LOWER($2), 'shipper_direct', 'heuristic', 'test') RETURNING id`,
      [`TEST-CAL-${RUN}`, `TEST CalBroker ${RUN}`])).rows[0].id;
  });
  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [bad]);
    await db.query(`DELETE FROM poster_registry WHERE normalized_name = LOWER($1)`, [`TEST CalBroker ${RUN}`]);
  });
  it('flags a labelled broker that was classified shipper_direct', async () => {
    const r = await buildCalibrationReport();
    expect(r.labelledBrokersAccepted.some((x) => x.pipelineLoadId === bad)).toBe(true);
    expect(r.byClass.shipper_direct).toBeGreaterThanOrEqual(1);
  });
});
```

Run: `pnpm vitest run __tests__/scripts/e2-source-calibration-report.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement the script**

```ts
// scripts/e2_source_calibration_report.ts
import { db } from '@/lib/pipeline/db-adapter';

export interface CalibrationReport { /* as in Interfaces */ }

export async function buildCalibrationReport(): Promise<CalibrationReport> {
  const total = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pipeline_loads`)).rows[0].n;
  const byClass = Object.fromEntries((await db.query<{ k: string; n: number }>(
    `SELECT COALESCE(load_source_class, 'NULL') AS k, COUNT(*)::int AS n FROM pipeline_loads GROUP BY 1`)).rows.map((r) => [r.k, r.n]));
  const byMethod = Object.fromEntries((await db.query<{ k: string; n: number }>(
    `SELECT COALESCE(load_source_method, 'NULL') AS k, COUNT(*)::int AS n FROM pipeline_loads GROUP BY 1`)).rows.map((r) => [r.k, r.n]));
  const ident = (await db.query<{ withId: number; registry: number }>(
    `SELECT COUNT(*) FILTER (WHERE poster_company_normalized IS NOT NULL OR poster_mc_number IS NOT NULL)::int AS "withId",
            COUNT(*) FILTER (WHERE load_source_method = 'registry')::int AS registry FROM pipeline_loads`)).rows[0];
  const labelledBrokersAccepted = (await db.query<{ pipelineLoadId: number; poster: string; class: string }>(
    `SELECT pl.id AS "pipelineLoadId", pl.poster_company_raw AS poster, pl.load_source_class AS class
       FROM pipeline_loads pl
       JOIN poster_registry pr ON (pr.mc_number IS NOT NULL AND pr.mc_number = pl.poster_mc_number)
                               OR (pr.mc_number IS NULL AND pr.normalized_name = pl.poster_company_normalized)
      WHERE pr.entity_class = 'broker' AND pr.class_source = 'human_review'
        AND pl.load_source_class IN ('shipper_direct', 'co_brokered')
        AND NOT EXISTS (SELECT 1 FROM co_broker_agreements a WHERE a.status = 'active'
                          AND (a.counterparty_mc_number = pl.poster_mc_number OR a.counterparty_name_normalized = pl.poster_company_normalized))`)).rows;
  const unresolvedTopPosters = (await db.query<{ poster: string; count: number }>(
    `SELECT poster_company_raw AS poster, COUNT(*)::int AS count FROM pipeline_loads
      WHERE load_source_class = 'unresolved' AND poster_company_raw IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 50`)).rows;
  return { totalRows: total, byClass, byMethod, registryHitRate: ident.withId ? ident.registry / ident.withId : 0, labelledBrokersAccepted, unresolvedTopPosters };
}

if (require.main === module) {
  buildCalibrationReport().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.labelledBrokersAccepted.length > 0 ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(2); });
}
```

(If the repo's scripts use ESM, replace the `require.main` guard with the pattern used in `scripts/e2_backfill_load_source.ts`.)

Run the test — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/e2_source_calibration_report.ts __tests__/scripts/e2-source-calibration-report.test.ts
git commit -m "feat(E2-01 M1): calibration report gating the shipper-direct enforce flip"
```

---

### Task 10: Docs, tracker, and the operator rollout record

**Files:**
- Modify: `Engine 2/CLAUDE.md` (Kill Switches table), root `CLAUDE.md` (Kill switches line under Environment Variables), `Engine 2/docs/superpowers/plans/completion.md` (Change Log), `docs/next-steps/ENGINE2.md`

- [ ] **Step 1: Document the new flags**

In both CLAUDE.md files add, next to `SHIPPER_DIRECT_GATE_ENABLED`:
- `SHIPPER_DIRECT_GATE_MODE` — `shadow` (default) | `enforce`. Only read when `SHIPPER_DIRECT_GATE_ENABLED=true`.
- `SHIPPER_DIRECT_GATE_ENFORCED_AT` — ISO timestamp written by the operator at the moment `MODE=enforce` goes live; M2 assertions tolerate `NULL` class on rows older than it.
- `FMCSA_QC_WEBKEY` — required for registry misses to resolve; missing key → every miss goes to review (fail closed).
- Scraper: `DAT_SEL_CELL_MC`, `DAT_SEL_CELL_DOT`.

- [ ] **Step 2: Append the Change Log entry**

One entry in `Engine 2/docs/superpowers/plans/completion.md` under `## Change Log`, dated, listing: Tasks 1–9 shipped, test counts, that `MODE` defaults to `shadow`, DAT detail-panel expansion deferred (PRD D5), Retell dashboard needs 3 new dynamic variables (operator), and the rollout order below. Mark PRD §4.13 criteria 1, 3, 6, 7, 8, 9 as PASS with the test that proves each; 2 (live FMCSA against three known entities), 4 (historical backfill with Patrice's labels), 5 (registry seed counts) and 10 (human review) as OPEN, operator-gated.

- [ ] **Step 3: Write the rollout checklist into `docs/next-steps/ENGINE2.md`** (new section "Shipper-direct gate flip", after the Pilot 1 section)

```
1. Register FMCSA QCMobile webKey; set FMCSA_QC_WEBKEY on Railway + Vercel.
2. Seed the registry: pnpm tsx --env-file=.env.local scripts/e2_seed_poster_registry.ts <patrice-labels.csv>
3. Backfill history in shadow: pnpm tsx --env-file=.env.local scripts/e2_backfill_load_source.ts
4. Calibrate: pnpm tsx --env-file=.env.local scripts/e2_source_calibration_report.ts  → must exit 0. Label unresolvedTopPosters, re-seed, re-run until it does.
5. Set SHIPPER_DIRECT_GATE_ENABLED=true, MODE=shadow on Railway. Watch 24h of real ingest: distribution of load_source_class, registry hit rate.
6. Flip: set SHIPPER_DIRECT_GATE_ENFORCED_AT=<now ISO>, then MODE=enforce on Railway (Qualifier) first, then Vercel (import route). Restart the worker host.
7. Watch the Alert Center for load_source_review rows; resolve each via POST /api/pipeline/loads/:id/resolve-source. Count per day; if >20/day after day 3, tighten STRONG_BROKER_TOKENS.
```

- [ ] **Step 4: Commit**

```bash
git add "Engine 2/CLAUDE.md" CLAUDE.md "Engine 2/docs/superpowers/plans/completion.md" docs/next-steps/ENGINE2.md
git commit -m "docs(E2-01): shipper-direct gate flags, tracker entry, rollout checklist"
```

---

## Self-review

**Spec coverage.** §4.2 capture → Tasks 1, 2, 3 (official-API mappers stay stubs; their `mapXLoad()` gains nothing until a client exists — noted, not a gap in live behaviour). §4.3 lookup and §4.4 registry → already shipped in Session 1, consumed unchanged. §4.5 decision table → `classifyLoadSource` unchanged; attestation rows 0–2 now reachable via Task 2. §4.6 filter order and priority bonus → Task 4. F0 geographic scope is **not** built: it is a separate Pilot 1 scope filter, not a double-brokering control, and this plan is scoped to the shipper-direct question. §4.7 review routing → Tasks 4, 5, 6. §4.8 attestation → Task 2 (UI radio group not built: no import UI exists in `app/`; the API contract is the record). §4.9 reason codes → Task 4 (historical prose backfill not included; `legacy_unmapped` rows are tolerated by every reader). §4.11 flags → Tasks 4, 10. §4.12 calibration → Task 9. §4.14 rollout → Task 10. §5 M2 assertions and brief fields → Tasks 7, 8. Dispatch One objection line is a Retell-dashboard edit, operator task.

**Placeholder scan.** None of the forbidden phrases remain. Two deliberate "confirm by reading" notes exist (Task 1 Step 5 normalized-name expectation, Task 5 Step 2 transaction support in `db-adapter.ts`, Task 5 Step 3 user-id field) — each names the exact file and line to check.

**Type consistency.** `PosterFields` (Task 1) ↔ `QualifyJobPayload.poster*` (Task 1/4) ↔ scraper `QualifyJobPayload` (Task 3) use identical names. `GateMode` (Task 4) is consumed by Task 7. `SourceClassification` (Task 4 rename) is referenced by `insertReviewException` in the same task. `resolveLoadSource` payload (Task 5) matches the scanner's enqueue shape plus the Task 2 `attestation` field.

**Review Focus.** Item 1 → Task 4 Step 3 test "attested yes". Item 2 → Task 1 Step 5 asserts `poster_company_normalized`. Item 3 → Task 4 Step 3 test "shadow mode". Item 4 → Task 5 Step 1 test "pickup window has passed". Item 5 → Task 7 Step 1 test "tolerates NULL class".
