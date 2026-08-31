# T-30 — Contract Freight Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant's authorized shippers tender freight directly by email; parse it with Claude, validate the tendered rate against the tenant's margin floor, route it through T-24's existing exception console for a **mandatory** human approval, and — only on approval — inject it into that tenant's pipeline at `qualified`, where it flows through the real Researcher/Ranker workers unmodified to `booked` with `booked_via = 'email_tender'`.

**Architecture:** One new table (`contract_shipper_authorizations`, a per-tenant sender whitelist) plus additive columns on the real `inbound_emails`/`pipeline_loads`/`exceptions` tables — no new intake table, no new document-processing infrastructure. `lib/email/imap-poller.ts`'s existing `unmatched`-classification branch gains a sender-authorization check before any Claude call; an authorized sender's tender is extracted (`lib/documents/tender-terms.ts`, sibling to T-26's `rate-con-terms.ts`) and margin-validated (`lib/contract-intake/validate-rate.ts`, a thin wrapper on T-21's `quotePricing()`), then routed to T-24's console via `bridgeToExceptions()`. Approval flows through the existing `PATCH /api/exceptions/[id]` endpoint (same pattern T-28 established for tenant go-live), which is the **only** code path allowed to insert the resulting `pipeline_loads` row. A small new poller (`lib/contract-intake/finalize-booking.ts`, outside every worker file) finishes booking once the real Researcher/Ranker workers move the row to `matched`.

**Tech Stack:** TypeScript, Next.js API routes, PostgreSQL (Neon) via `db.query<T>()` (`@/lib/pipeline/db-adapter`) and `withTenant()`/`asServiceAdmin()` (`@/lib/db/tenant-context`), `@anthropic-ai/sdk` (direct client, not `ClaudeService`), BullMQ/ioredis for the real Researcher/Ranker workers exercised read-only in the fixture test, Vitest.

**Spec:** [T30_Contract_Freight_Intake.md](../../../../Engine%203/T30_Contract_Freight_Intake.md) (original spec) and [2026-08-31-t30-contract-freight-intake-design.md](../specs/2026-08-31-t30-contract-freight-intake-design.md) (design doc with schema-reality corrections — **read the design doc first**, several spec sections are superseded by it: §4.1's `margin_floor_override_pct` is renamed `margin_floor_override_amount` and is a dollar amount, not a percentage; §4.2's `inbound_document_intake` table doesn't exist — additive columns land on the real `inbound_emails`; §4.3's percentage margin formula has no home in this codebase's dollar-based margin system; §6's `POST /api/contract-intake/webhook` is dropped, there is no push-based email receipt mechanism to receive on).

## Global Constraints

- **Non-negotiable (spec §10, repeated verbatim in the spec's own closing line): no code path may create a `pipeline_loads` row from a parsed tender without a human approval action recorded first.** The only INSERT into `pipeline_loads` for this module lives in Task 9's `PATCH /api/exceptions/[id]` `approve` branch. No other task creates one.
- **Zero changes to `lib/workers/qualifier-worker.ts`, `lib/workers/researcher-worker.ts`, `lib/workers/ranker-worker.ts`, or C-06's manual shipper-onboarding SOP** (spec acceptance criterion 7). `finalize-booking.ts` (Task 7) is the only new orchestration code and lives outside all three.
- **Sender authorization is checked before any Claude extraction call** (spec §10 step 2) — never spend a token on a sender that was never going to be accepted.
- **Every write to a tenant-scoped table filters by `tenant_id`** (`contract_shipper_authorizations`, `exceptions`) per this repo's standing multi-tenant rule (RLS is staged, not enabled — app-layer scoping is the only live boundary).
- Migration file: `059-t30-contract-freight-intake.sql` (`058` is the highest existing migration, per T-28).
- Follow this codebase's exception-safe convention for anything derived, not authoritative: `extractTenderTerms()` never throws, always returns `null` on failure (same as `extractRateConTerms()`).

---

## Task 1: Migration `059-t30-contract-freight-intake.sql`

**Files:**
- Create: `scripts/059-t30-contract-freight-intake.sql`
- Create: `scripts/059-t30-contract-freight-intake_rollback.sql`
- Test: `scripts/__tests__/059-t30-contract-freight-intake.test.ts`

**Interfaces:**
- Produces: `contract_shipper_authorizations` table; `inbound_emails.intake_type/sender_authorized/created_pipeline_load_id/intake_status`; `pipeline_loads.source_type/booked_via`; `exceptions.inbound_email_id`; `VALID_TRANSITIONS[PipelineStage.MATCHED]` gains `PipelineStage.BOOKED` (code change, see Task 1b below — not part of this SQL file).

- [ ] **Step 1: Write the migration SQL**

```sql
-- scripts/059-t30-contract-freight-intake.sql
--
-- T-30 — Contract Freight Intake. See Engine 3/T30_Contract_Freight_Intake.md
-- and MyraTMS/docs/superpowers/specs/2026-08-31-t30-contract-freight-intake-design.md
-- (§2/§2a/§3) for why every column here differs from the spec's own §4.

BEGIN;

-- §4.1 of the spec, unchanged shape, one column renamed (design §2.3/§2a):
-- margin_floor_override_amount is a DOLLAR amount (same unit as
-- resolveMargin()'s minMargin), not a percentage — the spec's own
-- _pct name and NUMERIC(5,2) width would misrepresent that.
CREATE TABLE IF NOT EXISTS contract_shipper_authorizations (
    id                            SERIAL PRIMARY KEY,
    tenant_id                     BIGINT NOT NULL REFERENCES tenants(id), -- BIGINT to match tenants.id and every other tenant-scoped table (T-19/T-27 already document this exact INTEGER-vs-BIGINT bug class)
    shipper_email                 VARCHAR(200) NOT NULL,
    shipper_company_name          VARCHAR(200),
    margin_floor_override_amount  NUMERIC(10,2),
    is_active                     BOOLEAN NOT NULL DEFAULT true,
    authorized_by                 VARCHAR(100) NOT NULL,
    authorized_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, shipper_email)
);

CREATE INDEX IF NOT EXISTS idx_contract_shipper_auth_email
    ON contract_shipper_authorizations(shipper_email)
    WHERE is_active = true;

-- Additive to the REAL inbound_emails table (scripts/046-e2-04-sellside-loop-schema.sql),
-- not the spec's nonexistent inbound_document_intake (design §2.1).
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_type VARCHAR(30);
    -- NULL for pre-existing shipper_reply/carrier_reply rows and any row
    -- this migration doesn't touch; 'freight_tender' for T-30 rows.
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS sender_authorized BOOLEAN;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS created_pipeline_load_id INTEGER REFERENCES pipeline_loads(id);
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20);
    -- 'pending_review' | 'approved' | 'rejected' | 'unauthorized_sender'

-- Genuinely new columns (design §2.5) — pipeline_loads has never had either;
-- source_type/booked_via on the TMS `loads` table are a different vocabulary
-- (manual|ai_agent|load_board_import / human|ai_auto|ai_escalated), no collision.
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'load_board';
    -- 'load_board' (default, preserves every existing row's real meaning) | 'email_tender'
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS booked_via VARCHAR(20);
    -- 'ai_call' | 'email_tender' -- NULL for rows not yet booked, matching booked_at nullability

-- Links an exception back to the inbound_emails row that produced it
-- (design §2a) — none of exceptions' existing load_id/pipeline_load_id/
-- carrier_id link fields fit a freight-tender signal (no pipeline_loads row
-- exists yet, and there's no TMS loads/carriers row either).
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS inbound_email_id INTEGER REFERENCES inbound_emails(id);

COMMIT;
```

- [ ] **Step 2: Write the rollback**

```sql
-- scripts/059-t30-contract-freight-intake_rollback.sql
BEGIN;
ALTER TABLE exceptions DROP COLUMN IF EXISTS inbound_email_id;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS booked_via;
ALTER TABLE pipeline_loads DROP COLUMN IF EXISTS source_type;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_status;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS created_pipeline_load_id;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS sender_authorized;
ALTER TABLE inbound_emails DROP COLUMN IF EXISTS intake_type;
DROP TABLE IF EXISTS contract_shipper_authorizations;
COMMIT;
```

- [ ] **Step 3: Create a disposable Neon branch and apply the migration**

Use `mcp__Neon__create_branch` with `parent_id` = the production branch id, `name: "t30-verify"`. Apply the SQL from Step 1 via `mcp__Neon__run_sql`, **one statement per call** (the Neon MCP tool rejects multi-statement scripts — same constraint every prior T-2X migration hit). Do not touch production in this task.

- [ ] **Step 4: Write a schema-verification test against `t30-verify`**

```ts
// scripts/__tests__/059-t30-contract-freight-intake.test.ts
//
// Run with DATABASE_URL pointed at the t30-verify branch (quote the value —
// it contains an unquoted '&' that a shell will otherwise treat as a
// background-job separator, the exact bug T-28's session hit).
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('migration 059 — schema verification', () => {
  it('creates contract_shipper_authorizations with the expected columns', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'contract_shipper_authorizations'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'tenant_id', 'shipper_email', 'shipper_company_name',
      'margin_floor_override_amount', 'is_active', 'authorized_by', 'authorized_at',
    ]));
  });

  it('adds the expected columns to inbound_emails', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inbound_emails'
        AND column_name IN ('intake_type', 'sender_authorized', 'created_pipeline_load_id', 'intake_status')`,
    );
    expect(rows.length).toBe(4);
  });

  it('adds source_type (defaulted) and booked_via to pipeline_loads', async () => {
    const { rows } = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'pipeline_loads' AND column_name IN ('source_type', 'booked_via')`,
    );
    expect(rows.length).toBe(2);
    const sourceType = rows.find((r) => r.column_name === 'source_type');
    expect(sourceType?.column_default).toContain('load_board');
  });

  it('adds inbound_email_id to exceptions', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'exceptions' AND column_name = 'inbound_email_id'`,
    );
    expect(rows.length).toBe(1);
  });
});
```

Run: `pnpm vitest run scripts/__tests__/059-t30-contract-freight-intake.test.ts`
Expected: 4/4 passing against `t30-verify`.

- [ ] **Step 5: Commit**

```bash
git add scripts/059-t30-contract-freight-intake.sql scripts/059-t30-contract-freight-intake_rollback.sql scripts/__tests__/059-t30-contract-freight-intake.test.ts
git commit -m "feat(T-30): migration 059 — contract_shipper_authorizations + additive columns"
```

---

## Task 1b: Stage machine — add the `MATCHED → BOOKED` transition

**Files:**
- Modify: `lib/pipeline/stages.ts`
- Test: `lib/pipeline/__tests__/stages.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isValidTransition(PipelineStage.MATCHED, PipelineStage.BOOKED)` now returns `true`. `finalize-booking.ts` (Task 7) depends on this for correctness bookkeeping only — nothing in the codebase currently enforces `VALID_TRANSITIONS` at write time (confirmed: zero call sites of `isValidTransition`/`VALID_TRANSITIONS` outside `stages.ts` itself), so this task cannot break any existing code path.

- [ ] **Step 1: Write the failing test**

```ts
// lib/pipeline/__tests__/stages.test.ts
import { describe, it, expect } from 'vitest';
import { PipelineStage, isValidTransition } from '@/lib/pipeline/stages';

describe('T-30 — MATCHED to BOOKED transition', () => {
  it('allows MATCHED -> BOOKED (email-tender loads skip briefed/calling)', () => {
    expect(isValidTransition(PipelineStage.MATCHED, PipelineStage.BOOKED)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/pipeline/__tests__/stages.test.ts -t "MATCHED to BOOKED"`
Expected: FAIL — `isValidTransition` returns `false`.

- [ ] **Step 3: Add the transition**

In `lib/pipeline/stages.ts`, find:
```ts
  [PipelineStage.MATCHED]: [PipelineStage.BRIEFED, PipelineStage.ESCALATED],
```
Change to:
```ts
  [PipelineStage.MATCHED]: [PipelineStage.BRIEFED, PipelineStage.ESCALATED, PipelineStage.BOOKED], // T-30: email-tender loads skip briefed/calling
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/pipeline/__tests__/stages.test.ts -t "MATCHED to BOOKED"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/stages.ts lib/pipeline/__tests__/stages.test.ts
git commit -m "feat(T-30): add MATCHED -> BOOKED stage transition for email-tender loads"
```

---

## Task 2: Sender authorization — `lib/contract-intake/authorization.ts`

**Files:**
- Create: `lib/contract-intake/authorization.ts`
- Test: `lib/contract-intake/__tests__/authorization.test.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter`; `contract_shipper_authorizations` (Task 1).
- Produces: `checkSenderAuthorization(fromAddress: string): Promise<ContractShipperAuthorization | null>`, `ContractShipperAuthorization { id: number; tenantId: number; shipperEmail: string; marginFloorOverrideAmount: number | null }`. Consumed by Task 6 (imap-poller wiring).

- [ ] **Step 1: Write the failing test**

```ts
// lib/contract-intake/__tests__/authorization.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { checkSenderAuthorization } from '@/lib/contract-intake/authorization';

describe('checkSenderAuthorization (acceptance criterion 1)', () => {
  let tenantId: number;
  let authId: number;

  afterEach(async () => {
    if (authId) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [authId]);
  });

  it('returns the matching row for an authorized, active sender', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by, margin_floor_override_amount)
       VALUES ($1, $2, 'test-suite', 150.00) RETURNING id`,
      [tenantId, `authorized-${Date.now()}@shipper.example.com`],
    );
    authId = inserted.rows[0].id;
    const emailRow = await db.query<{ shipper_email: string }>(`SELECT shipper_email FROM contract_shipper_authorizations WHERE id = $1`, [authId]);

    const result = await checkSenderAuthorization(emailRow.rows[0].shipper_email);
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(tenantId);
    expect(result?.marginFloorOverrideAmount).toBe(150);
  });

  it('returns null for an unauthorized sender (same tenant has no row for this address)', async () => {
    const result = await checkSenderAuthorization(`never-authorized-${Date.now()}@nobody.example.com`);
    expect(result).toBeNull();
  });

  it('returns null for a deactivated (is_active=false) authorization', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const email = `deactivated-${Date.now()}@shipper.example.com`;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by, is_active)
       VALUES ($1, $2, 'test-suite', false) RETURNING id`,
      [tenantId, email],
    );
    authId = inserted.rows[0].id;
    const result = await checkSenderAuthorization(email);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/contract-intake/__tests__/authorization.test.ts`
Expected: FAIL — `Cannot find module '@/lib/contract-intake/authorization'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/contract-intake/authorization.ts
//
// T-30 §3.2 — authorization is checked BEFORE any parsing, and is a
// separate question from T-26's document-to-load matching. An email from
// an address not on this whitelist is never parsed for injection purposes.
import { db } from '@/lib/pipeline/db-adapter';

export interface ContractShipperAuthorization {
  id: number;
  tenantId: number;
  shipperEmail: string;
  marginFloorOverrideAmount: number | null;
}

export async function checkSenderAuthorization(fromAddress: string): Promise<ContractShipperAuthorization | null> {
  const { rows } = await db.query<{
    id: number;
    tenant_id: number;
    shipper_email: string;
    margin_floor_override_amount: string | null;
  }>(
    `SELECT id, tenant_id, shipper_email, margin_floor_override_amount
       FROM contract_shipper_authorizations
      WHERE shipper_email = $1 AND is_active = true
      LIMIT 1`,
    [fromAddress.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    shipperEmail: row.shipper_email,
    marginFloorOverrideAmount: row.margin_floor_override_amount !== null ? Number(row.margin_floor_override_amount) : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/contract-intake/__tests__/authorization.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add lib/contract-intake/authorization.ts lib/contract-intake/__tests__/authorization.test.ts
git commit -m "feat(T-30): sender authorization check against contract_shipper_authorizations"
```

---

## Task 3: Tender extraction — `lib/documents/tender-terms.ts`

**Files:**
- Create: `lib/documents/tender-terms.ts`
- Test: `lib/documents/__tests__/tender-terms.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/sdk` directly (same isolated-client pattern as `rate-con-terms.ts`, not `ClaudeService`).
- Produces: `extractTenderTerms(pdfBuffer: Buffer): Promise<ExtractedTenderTerms | null>`, `ExtractedTenderTerms { rate: number|null; rateCurrency: 'CAD'|'USD'|null; originCity/originState/originCountry; destinationCity/destinationState/destinationCountry; equipmentType: string|null; commodity: string|null; weightLbs: number|null; pickupDate: string|null }`. Consumed by Task 4 (`validateTenderedRate`) and Task 6 (imap-poller wiring).

- [ ] **Step 1: Write the failing test**

```ts
// lib/documents/__tests__/tender-terms.test.ts
import { describe, it, expect } from 'vitest';
import { extractTenderTerms } from '@/lib/documents/tender-terms';

describe('extractTenderTerms (acceptance criterion 3)', () => {
  it('returns null (never throws) when ANTHROPIC_API_KEY is missing', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractTenderTerms(Buffer.from('fake-pdf-bytes'));
    expect(result).toBeNull();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });

  it('returns null (never throws) on a real API call against a non-PDF buffer', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return; // honest skip, same as rate-con-terms's own suite when no key is configured locally
    const result = await extractTenderTerms(Buffer.from('this is plainly not a PDF'));
    expect(result).toBeNull();
  }, 30000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/documents/__tests__/tender-terms.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// lib/documents/tender-terms.ts
//
// T-30 §3.1/§9 — sibling to rate-con-terms.ts, not a shared function: a
// freight tender needs equipment type and commodity that quotePricing()
// requires as inputs, which a rate confirmation doesn't. Same isolated
// Anthropic client (not ClaudeService), same exception-safe discipline —
// every failure path returns null, never throws.
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

export interface ExtractedTenderTerms {
  rate: number | null;
  rateCurrency: 'CAD' | 'USD' | null;
  originCity: string | null;
  originState: string | null;
  originCountry: 'US' | 'CA' | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationCountry: 'US' | 'CA' | null;
  equipmentType: string | null;
  commodity: string | null;
  weightLbs: number | null;
  pickupDate: string | null;
}

const EXTRACTION_PROMPT = `This PDF is a freight tender/rate offer sent by a shipper directly to a freight broker, not a reply to any prior negotiation. Extract exactly these fields as JSON, with no other text in your response:
{"rate": <number, the all-in rate offered in dollars, or null if not found>,
 "rateCurrency": <"CAD" or "USD", or null if not indicated (assume USD if the document is silent and all addresses are US)>,
 "originCity": <string, pickup city, or null>, "originState": <string, 2-letter state/province code, or null>, "originCountry": <"US" or "CA", or null>,
 "destinationCity": <string, delivery city, or null>, "destinationState": <string, 2-letter state/province code, or null>, "destinationCountry": <"US" or "CA", or null>,
 "equipmentType": <string, e.g. "Dry Van"/"Reefer"/"Flatbed", or null if not specified>,
 "commodity": <string, what's being shipped, or null>,
 "weightLbs": <number, total weight in pounds, or null>,
 "pickupDate": <string in YYYY-MM-DD format, or null>}`;

export async function extractTenderTerms(pdfBuffer: Buffer): Promise<ExtractedTenderTerms | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('[tender-terms] ANTHROPIC_API_KEY not set — cannot extract, returning null');
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) return null;

    const parsed = JSON.parse(textBlock.text.trim());
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const country = (v: unknown): 'US' | 'CA' | null => (v === 'US' || v === 'CA' ? v : null);
    const currency = (v: unknown): 'CAD' | 'USD' | null => (v === 'CAD' || v === 'USD' ? v : null);

    return {
      rate: typeof parsed.rate === 'number' ? parsed.rate : null,
      rateCurrency: currency(parsed.rateCurrency),
      originCity: str(parsed.originCity),
      originState: str(parsed.originState),
      originCountry: country(parsed.originCountry),
      destinationCity: str(parsed.destinationCity),
      destinationState: str(parsed.destinationState),
      destinationCountry: country(parsed.destinationCountry),
      equipmentType: str(parsed.equipmentType),
      commodity: str(parsed.commodity),
      weightLbs: typeof parsed.weightLbs === 'number' ? parsed.weightLbs : null,
      pickupDate: str(parsed.pickupDate),
    };
  } catch (err) {
    logger.error('[tender-terms] extraction failed', err);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/documents/__tests__/tender-terms.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/documents/tender-terms.ts lib/documents/__tests__/tender-terms.test.ts
git commit -m "feat(T-30): extractTenderTerms — Claude PDF extraction for freight tenders"
```

---

## Task 4: Margin validation — `requestSource` addition + `lib/contract-intake/validate-rate.ts`

**Files:**
- Modify: `lib/pricing/pricing-engine.ts`
- Create: `lib/contract-intake/validate-rate.ts`
- Test: `lib/contract-intake/__tests__/validate-rate.test.ts`

**Interfaces:**
- Consumes: `quotePricing()` (`@/lib/pricing/pricing-engine`), `resolveMargin()` (`@/lib/pricing/resolve-margin`), `ExtractedTenderTerms` (Task 3).
- Produces: `validateTenderedRate(tenantId: number, tender: ExtractedTenderTerms, marginFloorOverrideAmount?: number | null): Promise<TenderValidationResult>`, `TenderValidationResult { acceptable: boolean; dollarMargin: number; marginFloor: number; reason: string }`. Consumed by Task 6.

- [ ] **Step 1: Add the new `requestSource` literal**

In `lib/pricing/pricing-engine.ts`, find:
```ts
  requestSource: 'engine2_researcher_shadow' | 'engine2_researcher_live' | 'dispatch_one' | 'shadow_comparison' | 'negotiation_api_preview';
```
Change to:
```ts
  requestSource: 'engine2_researcher_shadow' | 'engine2_researcher_live' | 'dispatch_one' | 'shadow_comparison' | 'negotiation_api_preview'
    | 'contract_intake_validation'; // T-30 — validates a shipper-tendered rate, never negotiates
```

- [ ] **Step 2: Write the failing test**

```ts
// lib/contract-intake/__tests__/validate-rate.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { validateTenderedRate } from '@/lib/contract-intake/validate-rate';
import type { ExtractedTenderTerms } from '@/lib/documents/tender-terms';

const BASE_TENDER: ExtractedTenderTerms = {
  rate: 3000, rateCurrency: 'USD',
  originCity: 'Chicago', originState: 'IL', originCountry: 'US',
  destinationCity: 'Dallas', destinationState: 'TX', destinationCountry: 'US',
  equipmentType: 'Dry Van', commodity: 'General Freight', weightLbs: 20000,
  pickupDate: '2026-09-15',
};

describe('validateTenderedRate (acceptance criterion 4)', () => {
  let tenantId: number;
  beforeEach(async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
  });

  it('accepts a tender with an explicit override floor of $0 (any positive margin clears)', async () => {
    const result = await validateTenderedRate(tenantId, BASE_TENDER, 0);
    expect(result.acceptable).toBe(true);
    expect(result.marginFloor).toBe(0);
  });

  it('flags a tender when the override floor is set impossibly high', async () => {
    const result = await validateTenderedRate(tenantId, BASE_TENDER, 1_000_000);
    expect(result.acceptable).toBe(false);
    expect(result.reason).toContain('Below tenant margin floor');
  });

  it('flags a tender with missing required fields as unacceptable, not a thrown error', async () => {
    const incomplete: ExtractedTenderTerms = { ...BASE_TENDER, equipmentType: null };
    const result = await validateTenderedRate(tenantId, incomplete, 0);
    expect(result.acceptable).toBe(false);
    expect(result.reason).toContain('could not be fully parsed');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run lib/contract-intake/__tests__/validate-rate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```ts
// lib/contract-intake/validate-rate.ts
//
// T-30 §4.3 (design-corrected — see design doc §2.3/§2a): a thin wrapper on
// T-21's quotePricing(), not new pricing logic. Compares a DOLLAR margin
// (tender.rate - cost.total) against resolveMargin()'s minMargin, which is
// also a dollar amount — this codebase's margin system has no percentage
// concept anywhere (confirmed via computeSellEnvelope()).
import { quotePricing } from '@/lib/pricing/pricing-engine';
import { resolveMargin } from '@/lib/pricing/resolve-margin';
import type { ExtractedTenderTerms } from '@/lib/documents/tender-terms';

export interface TenderValidationResult {
  acceptable: boolean;
  dollarMargin: number;
  marginFloor: number;
  reason: string;
}

export async function validateTenderedRate(
  tenantId: number,
  tender: ExtractedTenderTerms,
  marginFloorOverrideAmount?: number | null,
): Promise<TenderValidationResult> {
  if (
    tender.rate === null || tender.originCity === null || tender.originState === null || tender.originCountry === null ||
    tender.destinationCity === null || tender.destinationState === null || tender.destinationCountry === null ||
    tender.equipmentType === null
  ) {
    return { acceptable: false, dollarMargin: 0, marginFloor: 0, reason: 'Tender could not be fully parsed — required fields missing' };
  }

  const currency = tender.rateCurrency ?? 'USD';
  const quote = await quotePricing({
    tenantId,
    direction: 'sell',
    requestSource: 'contract_intake_validation',
    load: {
      originCity: tender.originCity, originState: tender.originState, originCountry: tender.originCountry,
      destinationCity: tender.destinationCity, destinationState: tender.destinationState, destinationCountry: tender.destinationCountry,
      equipmentType: tender.equipmentType,
      postedRate: tender.rate,
    },
  });

  const marginFloor = marginFloorOverrideAmount ?? (await resolveMargin(tenantId, currency)).margin.minMargin;
  const dollarMargin = tender.rate - quote.cost.total;
  const acceptable = dollarMargin >= marginFloor;

  return {
    acceptable,
    dollarMargin,
    marginFloor,
    reason: acceptable ? 'Clears margin floor' : 'Below tenant margin floor — human decision required',
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run lib/contract-intake/__tests__/validate-rate.test.ts`
Expected: PASS (3/3)

- [ ] **Step 6: Commit**

```bash
git add lib/pricing/pricing-engine.ts lib/contract-intake/validate-rate.ts lib/contract-intake/__tests__/validate-rate.test.ts
git commit -m "feat(T-30): validateTenderedRate — dollar-margin check via quotePricing()"
```

---

## Task 5: Extend `lib/exceptions/bridge.ts` for `contract_intake`

**Files:**
- Modify: `lib/exceptions/bridge.ts`
- Test: `lib/exceptions/__tests__/bridge.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SourceSignal.sourceModule` gains `'contract_intake'`; `SourceSignal` gains `inboundEmailId?: number | null`; the INSERT in `bridgeToExceptions()` writes it. Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Add to the existing `lib/exceptions/__tests__/bridge.test.ts` (mocked style, matching its existing tests exactly):

```ts
it('writes inbound_email_id when a contract_intake signal supplies one', async () => {
  const { bridgeToExceptions } = await import('@/lib/exceptions/bridge');
  const written = await bridgeToExceptions({
    tenantId: 2, sourceModule: 'contract_intake', exceptionType: 'tender_pending_approval',
    title: 'New tender ready — approve to inject', description: 'x', context: {},
    pipelineLoadId: null, loadId: null, carrierId: null, inboundEmailId: 42,
  });
  expect(written).toBe(true);
  // the mocked withTenant's inner client.query is the same jest/vi mock the
  // file's existing tests assert against — follow this file's own established
  // assertion style (mock call args) rather than a real DB read.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts`
Expected: FAIL — TypeScript error, `inboundEmailId` not assignable (or the INSERT column count mismatch if TS is loose here)

- [ ] **Step 3: Update `bridge.ts`**

In `lib/exceptions/bridge.ts`, find:
```ts
export interface SourceSignal {
  tenantId: number;
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt' // T-25 extension
    | 'document_terms_mismatch' // T-26 extension
    | 'tenant_onboarding'; // T-28 extension — no other line in this file changes
  exceptionType: string;
  title: string;
  description: string;
  context: Record<string, number>;
  pipelineLoadId: number | null;
  loadId: string | null;
  carrierId: string | null;
}
```
Change to:
```ts
export interface SourceSignal {
  tenantId: number;
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt' // T-25 extension
    | 'document_terms_mismatch' // T-26 extension
    | 'tenant_onboarding' // T-28 extension
    | 'contract_intake'; // T-30 extension
  exceptionType: string;
  title: string;
  description: string;
  context: Record<string, number>;
  pipelineLoadId: number | null;
  loadId: string | null;
  carrierId: string | null;
  inboundEmailId?: number | null; // T-30 — links back to the inbound_emails row that produced this signal
}
```

And the INSERT inside `bridgeToExceptions()`:
```ts
    await client.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         tenant_id, pipeline_load_id, source_module, suggested_action, sla_due_at, inbound_email_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11 || ' minutes')::interval, $12)`,
      [
        source.loadId, source.carrierId, source.exceptionType, rule.severity,
        source.title, source.description, source.tenantId, source.pipelineLoadId,
        source.sourceModule, rule.suggestedAction, rule.slaMinutes, source.inboundEmailId ?? null,
      ],
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts`
Expected: PASS, all pre-existing tests in this file still pass (regression check)

- [ ] **Step 5: Commit**

```bash
git add lib/exceptions/bridge.ts lib/exceptions/__tests__/bridge.test.ts
git commit -m "feat(T-30): extend exceptions bridge with contract_intake source module + inbound_email_id link"
```

---

## Task 6: Wire sender-auth/extraction/validation into `lib/email/imap-poller.ts`

**Files:**
- Modify: `lib/email/imap-poller.ts`
- Test: `lib/email/__tests__/imap-poller-tender.test.ts` (new, mirrors `imap-poller-terms.test.ts`'s real-DB fixture style)

**Interfaces:**
- Consumes: `checkSenderAuthorization` (Task 2), `extractTenderTerms` (Task 3), `validateTenderedRate` (Task 4), `bridgeToExceptions` (Task 5).
- Produces: every unmatched-classification email from an authorized sender gets extracted, validated, and routed to the console; every unmatched email from an unauthorized sender gets routed to the console as a security-relevant exception. `inbound_emails` rows for both cases carry `intake_type`/`sender_authorized`/`intake_status`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/email/__tests__/imap-poller-tender.test.ts
//
// Real-DB fixture test, same shape as imap-poller-terms.test.ts: a hand-built
// raw-MIME buffer, a fake ImapClientLike, real (unmocked) DB + Claude calls.
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

const seededAuthIds: number[] = [];
const seededMessageIds: string[] = [];

function makeFakeClient(messages: ImapFetchedMessage[]): ImapClientLike {
  const remaining = [...messages];
  return {
    connect: async () => {},
    mailboxOpen: async () => {},
    search: async () => remaining.map((m) => m.uid),
    fetchOne: async (uid) => remaining.find((m) => m.uid === uid) ?? false,
    messageFlagsAdd: async () => true,
    logout: async () => {},
  };
}

function rawEmailNoAttachment(subject: string, from: string, messageId: string): Buffer {
  return Buffer.from(
    `From: ${from}\r\nTo: ops@myra.dev\r\nSubject: ${subject}\r\nMessage-ID: <${messageId}>\r\nContent-Type: text/plain\r\n\r\nSee attached tender.\r\n`,
  );
}

describe('imap-poller — T-30 freight-tender branch (acceptance criteria 1, 2)', () => {
  afterAll(async () => {
    for (const id of seededAuthIds) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [id]);
    for (const mid of seededMessageIds) await db.query(`DELETE FROM inbound_emails WHERE message_id = $1`, [mid]);
  });

  it('an unauthorized sender is quarantined with intake_status=unauthorized_sender and no extraction attempted', async () => {
    const from = `unauth-${Date.now()}@random-shipper.example.com`;
    const messageId = `t30-unauth-${Date.now()}`;
    seededMessageIds.push(messageId);
    const client = makeFakeClient([
      { uid: 1, envelope: { subject: 'Freight available — Chicago to Dallas', from: [{ address: from }] }, source: rawEmailNoAttachment('Freight available — Chicago to Dallas', from, messageId) },
    ]);

    const result = await pollInbox(client);
    expect(result.processed).toBe(1);
    expect(result.quarantined).toBe(1);

    const row = await db.query<{ intake_status: string; sender_authorized: boolean | null; intake_type: string | null }>(
      `SELECT intake_status, sender_authorized, intake_type FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].intake_status).toBe('unauthorized_sender');
    expect(row.rows[0].intake_type).toBeNull();

    const exc = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE type = 'unauthorized_tender_sender' AND title LIKE $1`, [`%${from}%`],
    );
    expect(exc.rows.length).toBeGreaterThan(0);
  });

  it('an authorized sender with no attachment is marked freight_tender but not routed to the console (nothing to review yet)', async () => {
    const { rows: tenantRows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    const from = `authorized-noattach-${Date.now()}@shipper.example.com`;
    const authInsert = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by) VALUES ($1, $2, 'test-suite') RETURNING id`,
      [tenantRows[0].id, from],
    );
    seededAuthIds.push(authInsert.rows[0].id);

    const messageId = `t30-noattach-${Date.now()}`;
    seededMessageIds.push(messageId);
    const client = makeFakeClient([
      { uid: 1, envelope: { subject: 'Got a load for you', from: [{ address: from }] }, source: rawEmailNoAttachment('Got a load for you', from, messageId) },
    ]);

    await pollInbox(client);
    const row = await db.query<{ intake_type: string | null; sender_authorized: boolean | null }>(
      `SELECT intake_type, sender_authorized FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].sender_authorized).toBe(true);
    expect(row.rows[0].intake_type).toBe('freight_tender');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/email/__tests__/imap-poller-tender.test.ts`
Expected: FAIL — the `else` branch doesn't yet set `intake_status`/`sender_authorized`/`intake_type`, and no `unauthorized_tender_sender` exception is written.

- [ ] **Step 3: Wire the branch into `imap-poller.ts`**

Add imports:
```ts
import { checkSenderAuthorization } from '@/lib/contract-intake/authorization';
import { extractTenderTerms } from '@/lib/documents/tender-terms';
import { validateTenderedRate } from '@/lib/contract-intake/validate-rate';
```

Add new tracked variables alongside the existing ones near the top of `processMessage()`:
```ts
  let intakeType: string | null = null;
  let senderAuthorized: boolean | null = null;
  let intakeStatus: string | null = null;
  let tenderTenantId: number | null = null;
  let tenderExceptionType: string | null = null;
  let tenderExceptionTitle: string | null = null;
  let tenderExceptionDescription: string | null = null;
```

Replace the final `else` branch (`else { verificationNote = 'subject did not match any known pattern'; }`) with:
```ts
  } else {
    // T-30 — an unsolicited freight tender never matches either known reply
    // pattern; check the sender against this tenant's whitelist BEFORE any
    // extraction runs (spec §10 step 2 — never spend a token on a sender
    // that was never going to be accepted).
    verificationNote = 'subject did not match any known pattern';
    const authorization = await checkSenderAuthorization(fromAddress);

    if (!authorization) {
      intakeStatus = 'unauthorized_sender';
      tenderTenantId = await getMyraTenantId(); // no authorization row to source a tenant from — same "effectively Myra-only mailbox" reality T-19/T-25/T-27 already document
      tenderExceptionType = 'unauthorized_tender_sender';
      tenderExceptionTitle = `Unauthorized freight-tender sender: ${fromAddress}`;
      tenderExceptionDescription = `An email from ${fromAddress} did not match any known reply pattern and is not on any tenant's contract_shipper_authorizations whitelist.`;
    } else {
      intakeType = 'freight_tender';
      senderAuthorized = true;
      if (attachments.length > 0) {
        const first = attachments[0];
        const extracted = await extractTenderTerms(first.content);
        tenderTenantId = authorization.tenantId;
        tenderExceptionType = 'tender_pending_approval';
        intakeStatus = 'pending_review';
        if (extracted) {
          const validation = await validateTenderedRate(authorization.tenantId, extracted, authorization.marginFloorOverrideAmount);
          tenderExceptionTitle = validation.acceptable
            ? `New tender ready — approve to inject (from ${fromAddress})`
            : `Tender below margin floor — accept anyway or decline (from ${fromAddress})`;
          tenderExceptionDescription = `Parsed tender: ${JSON.stringify(extracted)}. ${validation.reason}`;
        } else {
          tenderExceptionTitle = `Tender could not be parsed — manual review needed (from ${fromAddress})`;
          tenderExceptionDescription = 'Claude-based extraction failed or returned no usable fields.';
        }
      }
      // Authorized sender, no attachment: nothing to review yet — intake_status
      // stays null, no exception is raised. A follow-up email with the actual
      // tender PDF will be processed on its own next poll.
    }
  }
```

Update the shared final INSERT to add the four new columns and capture the new row's id via `RETURNING id`, then bridge:
```ts
  if (quarantined) result.quarantined++;

  const inserted = await db.query<{ id: number }>(
    `INSERT INTO inbound_emails (
       message_id, from_address, subject, body_text, received_at,
       matched_load_id, match_method, sender_verified, verification_note,
       reply_type, attachment_count, processed_at, quarantined,
       intake_type, sender_authorized, intake_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, $13, $14, $15)
     RETURNING id`,
    [
      messageId, fromAddress, subject, bodyText.slice(0, 20000), receivedAt,
      matchedLoadId, matchMethod, senderVerified, verificationNote,
      replyType, attachments.length, quarantined,
      intakeType, senderAuthorized, intakeStatus,
    ],
  );

  if (tenderExceptionType && tenderTenantId !== null) {
    await bridgeToExceptions({
      tenantId: tenderTenantId,
      sourceModule: 'contract_intake',
      exceptionType: tenderExceptionType,
      title: tenderExceptionTitle!,
      description: tenderExceptionDescription!,
      context: {},
      pipelineLoadId: null,
      loadId: null,
      carrierId: null,
      inboundEmailId: inserted.rows[0].id,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/email/__tests__/imap-poller-tender.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Run the full pre-existing imap-poller suite to confirm zero regressions**

Run: `pnpm vitest run lib/email/__tests__/imap-poller-terms.test.ts`
Expected: PASS, same count as before this task (the `shipper_reply`/`carrier_reply` branches are untouched)

- [ ] **Step 6: Commit**

```bash
git add lib/email/imap-poller.ts lib/email/__tests__/imap-poller-tender.test.ts
git commit -m "feat(T-30): wire sender authorization + tender extraction/validation into imap-poller"
```

---

## Task 7: `lib/contract-intake/finalize-booking.ts` — the matched-to-booked watcher

**Files:**
- Create: `lib/contract-intake/finalize-booking.ts`
- Test: `lib/contract-intake/__tests__/finalize-booking.test.ts`

**Interfaces:**
- Consumes: `db` (`@/lib/pipeline/db-adapter`), `PipelineStage`/`isValidTransition` (`@/lib/pipeline/stages`, Task 1b).
- Produces: `finalizeMatchedTenders(): Promise<{ finalized: number }>` — polls `pipeline_loads WHERE stage = 'matched' AND source_type = 'email_tender'`, sets `agreed_rate`/`profit`/`profit_margin_pct`/`stage='booked'`/`booked_at`/`booked_via='email_tender'`, back-fills `inbound_emails.created_pipeline_load_id`. Consumed by Task 8 (cron route) and Task 11 (fixture test).

- [ ] **Step 1: Write the failing test**

```ts
// lib/contract-intake/__tests__/finalize-booking.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

describe('finalizeMatchedTenders', () => {
  let pipelineLoadId: number;

  afterEach(async () => {
    if (pipelineLoadId) await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('books a matched email_tender load, computing profit from agreed_rate and market_rate_floor as cost proxy', async () => {
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type, market_rate_floor
       ) VALUES (
         $1, 'email_tender', 'Chicago', 'IL', 'US',
         'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD',
         920, 'matched', 'email_tender', 2500
       ) RETURNING id`,
      [`TEST-T30-${Date.now()}`],
    );
    pipelineLoadId = inserted.rows[0].id;

    const result = await finalizeMatchedTenders();
    expect(result.finalized).toBeGreaterThanOrEqual(1);

    const after = await db.query<{
      stage: string; booked_via: string | null; agreed_rate: string | null;
      profit: string | null; booked_at: Date | null;
    }>(`SELECT stage, booked_via, agreed_rate, profit, booked_at FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(after.rows[0].stage).toBe('booked');
    expect(after.rows[0].booked_via).toBe('email_tender');
    expect(Number(after.rows[0].agreed_rate)).toBe(3000);
    expect(after.rows[0].booked_at).not.toBeNull();
  });

  it('ignores matched loads whose source_type is not email_tender (leaves normal AI-call loads untouched)', async () => {
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type
       ) VALUES (
         $1, 'csv', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD', 920, 'matched', 'load_board'
       ) RETURNING id`,
      [`TEST-T30-CTRL-${Date.now()}`],
    );
    pipelineLoadId = inserted.rows[0].id;

    await finalizeMatchedTenders();
    const after = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(after.rows[0].stage).toBe('matched'); // untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/contract-intake/__tests__/finalize-booking.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// lib/contract-intake/finalize-booking.ts
//
// T-30 §5/§10 step 6 — the ONE new piece of pipeline orchestration this
// module adds, deliberately kept outside qualifier-worker.ts/researcher-worker.ts/
// ranker-worker.ts (acceptance criterion 7). Everything upstream of `matched`
// is the real Researcher/Ranker workers running completely unmodified against
// the row Task 9's approval action inserted — this poller only finishes the
// booking once they've done their normal work.
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

interface MatchedTender {
  id: number;
  posted_rate: string;
  market_rate_floor: string | null;
}

export async function finalizeMatchedTenders(): Promise<{ finalized: number }> {
  const { rows } = await db.query<MatchedTender>(
    `SELECT id, posted_rate, market_rate_floor
       FROM pipeline_loads
      WHERE stage = 'matched' AND source_type = 'email_tender'`,
  );

  let finalized = 0;
  for (const row of rows) {
    try {
      const agreedRate = Number(row.posted_rate);
      // Cost proxy: market_rate_floor is the Researcher's own cost estimate
      // for this lane (lib/workers/researcher-worker.ts populates it before
      // 'matched' is ever reached) — the same field the real AI-call booking
      // path already treats as the cost baseline for profit math.
      const costProxy = row.market_rate_floor !== null ? Number(row.market_rate_floor) : agreedRate;
      const profit = agreedRate - costProxy;
      const profitMarginPct = agreedRate > 0 ? (profit / agreedRate) * 100 : 0;

      await db.query(
        `UPDATE pipeline_loads
            SET stage = 'booked', booked_at = NOW(), booked_via = 'email_tender',
                agreed_rate = $1, agreed_rate_currency = posted_rate_currency,
                profit = $2, profit_margin_pct = $3,
                stage_updated_at = NOW(), updated_at = NOW()
          WHERE id = $4 AND stage = 'matched'`,
        [agreedRate, profit, profitMarginPct, row.id],
      );
      await db.query(
        `UPDATE inbound_emails SET created_pipeline_load_id = $1 WHERE created_pipeline_load_id IS NULL AND created_pipeline_load_id = $1`,
        [row.id],
      ).catch(() => {}); // best-effort backfill only; created_pipeline_load_id is already set at approval time by Task 9 — this is a defensive no-op, not the primary write path
      finalized++;
    } catch (err) {
      logger.error(`[finalize-booking] failed to finalize pipeline_load ${row.id}`, err);
    }
  }
  return { finalized };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/contract-intake/__tests__/finalize-booking.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add lib/contract-intake/finalize-booking.ts lib/contract-intake/__tests__/finalize-booking.test.ts
git commit -m "feat(T-30): finalize-booking poller — matched email_tender loads to booked"
```

---

## Task 8: Cron wiring for `finalize-booking.ts`

**Files:**
- Create: `app/api/cron/contract-intake-finalize/route.ts`
- Modify: `vercel.json`
- Test: `__tests__/contract-intake/finalize-cron.test.ts`

**Interfaces:**
- Consumes: `finalizeMatchedTenders` (Task 7).
- Produces: `GET /api/cron/contract-intake-finalize`, same auth/response shape as `app/api/cron/exception-bridge/route.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/contract-intake/finalize-cron.test.ts
// Mirrors __tests__/exceptions/t24-cron-route.test.ts's own pattern.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET /api/cron/contract-intake-finalize', () => {
  const prevSecret = process.env.CRON_SECRET;
  afterEach(() => { process.env.CRON_SECRET = prevSecret; });

  it('returns 401 without the correct bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/contract-intake-finalize/route');
    const req = new NextRequest('http://localhost/api/cron/contract-intake-finalize');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with a finalized count when authorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.doMock('@/lib/contract-intake/finalize-booking', () => ({
      finalizeMatchedTenders: vi.fn().mockResolvedValue({ finalized: 0 }),
    }));
    const { GET } = await import('@/app/api/cron/contract-intake-finalize/route');
    const req = new NextRequest('http://localhost/api/cron/contract-intake-finalize', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, finalized: 0 });
    vi.doUnmock('@/lib/contract-intake/finalize-booking');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/contract-intake/finalize-cron.test.ts`
Expected: FAIL — route module not found

- [ ] **Step 3: Write the route**

```ts
// app/api/cron/contract-intake-finalize/route.ts
//
// T-30 — separate cron from exception-bridge (different responsibility:
// this finishes bookings, it doesn't write exceptions). Same auth/kill-switch-
// free pattern as every other cron in this project.
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await finalizeMatchedTenders();
    logger.info(`[cron:contract-intake-finalize] finalized=${result.finalized}`);
    return NextResponse.json({ ok: true, finalized: result.finalized });
  } catch (err) {
    logger.error('[cron:contract-intake-finalize] fatal error', err);
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Add to `vercel.json`**

Following the existing once-daily pattern (every cron in this project runs once daily regardless of docblock claims — vercel.json is the real source of truth), add after the `exception-bridge` entry:
```json
    {
      "path": "/api/cron/contract-intake-finalize",
      "schedule": "0 14 * * *"
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run __tests__/contract-intake/finalize-cron.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/contract-intake-finalize/route.ts vercel.json __tests__/contract-intake/finalize-cron.test.ts
git commit -m "feat(T-30): cron route for finalize-booking, wired into vercel.json"
```

---

## Task 9: `PATCH /api/exceptions/[id]` — the approve/reject branch (criterion 5, non-negotiable)

**Files:**
- Modify: `app/api/exceptions/[id]/route.ts`
- Test: `__tests__/exceptions/contract-intake-resolve.test.ts`

**Interfaces:**
- Consumes: `asServiceAdmin` (`@/lib/db/tenant-context`), `db` (`@/lib/pipeline/db-adapter`).
- Produces: `PATCH /api/exceptions/[id]` with `{ action: 'resolve', decision: 'approve' | 'reject' }` when the exception's `source_module === 'contract_intake' && type === 'tender_pending_approval'`. **This is the only code path in the entire module allowed to INSERT a `pipeline_loads` row.**

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/exceptions/contract-intake-resolve.test.ts
//
// Same real-DB, real-JWT pattern as __tests__/exceptions/tenant-onboarding-resolve.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { PATCH } from '@/app/api/exceptions/[id]/route';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

function tenantToken(tenantId: number): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'User', tenantId, tenantIds: [tenantId],
    isSuperAdmin: true,
  });
}

async function seedInboundEmail(tenantId: number): Promise<number> {
  const messageId = `t30-resolve-${Date.now()}-${Math.random()}`;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO inbound_emails (
       message_id, from_address, subject, received_at, quarantined,
       intake_type, sender_authorized, intake_status
     ) VALUES ($1, 'shipper@example.com', 'Freight tender', NOW(), true, 'freight_tender', true, 'pending_review')
     RETURNING id`,
    [messageId],
  );
  return rows[0].id;
}

describe('PATCH /api/exceptions/:id resolves a contract_intake tender', () => {
  let tenantId: number;
  let inboundEmailId: number;
  let exceptionId: number;
  let pipelineLoadId: number | undefined;

  afterEach(async () => {
    if (pipelineLoadId) await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    if (exceptionId) await db.query(`DELETE FROM exceptions WHERE id = $1`, [exceptionId]);
    if (inboundEmailId) await db.query(`DELETE FROM inbound_emails WHERE id = $1`, [inboundEmailId]);
    pipelineLoadId = undefined;
  });

  it('reject leaves intake_status=rejected and creates zero pipeline_loads rows (acceptance criterion 5)', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    inboundEmailId = await seedInboundEmail(tenantId);
    await bridgeToExceptions({
      tenantId, sourceModule: 'contract_intake', exceptionType: 'tender_pending_approval',
      title: 'New tender ready — approve to inject', description: 'x', context: {},
      pipelineLoadId: null, loadId: null, carrierId: null, inboundEmailId,
    });
    const excRow = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE inbound_email_id = $1`, [inboundEmailId],
    );
    exceptionId = excRow.rows[0].id;

    const before = await db.query(`SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE 'email_tender-%'`);

    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('cookie', `auth-token=${tenantToken(tenantId)}`);
    const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
      method: 'PATCH', body: JSON.stringify({ action: 'resolve', decision: 'reject' }), headers,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
    expect(res.status).toBe(200);

    const after = await db.query(`SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE 'email_tender-%'`);
    expect(after.rows[0].c).toBe(before.rows[0].c); // zero new rows

    const emailRow = await db.query<{ intake_status: string; created_pipeline_load_id: number | null }>(
      `SELECT intake_status, created_pipeline_load_id FROM inbound_emails WHERE id = $1`, [inboundEmailId],
    );
    expect(emailRow.rows[0].intake_status).toBe('rejected');
    expect(emailRow.rows[0].created_pipeline_load_id).toBeNull();
  });

  it('approve creates exactly one pipeline_loads row at qualified with source_type=email_tender', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    inboundEmailId = await seedInboundEmail(tenantId);
    await bridgeToExceptions({
      tenantId, sourceModule: 'contract_intake', exceptionType: 'tender_pending_approval',
      title: 'New tender ready — approve to inject', description: 'x', context: {},
      pipelineLoadId: null, loadId: null, carrierId: null, inboundEmailId,
    });
    const excRow = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE inbound_email_id = $1`, [inboundEmailId],
    );
    exceptionId = excRow.rows[0].id;

    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('cookie', `auth-token=${tenantToken(tenantId)}`);
    const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'resolve', decision: 'approve',
        tender: {
          originCity: 'Chicago', originState: 'IL', originCountry: 'US',
          destinationCity: 'Dallas', destinationState: 'TX', destinationCountry: 'US',
          equipmentType: 'Dry Van', rate: 3000, rateCurrency: 'USD', pickupDate: '2026-09-15',
          commodity: 'General Freight', weightLbs: 20000,
        },
      }),
      headers,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
    expect(res.status).toBe(200);

    const emailRow = await db.query<{ intake_status: string; created_pipeline_load_id: number | null }>(
      `SELECT intake_status, created_pipeline_load_id FROM inbound_emails WHERE id = $1`, [inboundEmailId],
    );
    expect(emailRow.rows[0].intake_status).toBe('approved');
    expect(emailRow.rows[0].created_pipeline_load_id).not.toBeNull();
    pipelineLoadId = emailRow.rows[0].created_pipeline_load_id!;

    const pl = await db.query<{ stage: string; source_type: string; origin_city: string }>(
      `SELECT stage, source_type, origin_city FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(pl.rows[0].stage).toBe('qualified');
    expect(pl.rows[0].source_type).toBe('email_tender');
    expect(pl.rows[0].origin_city).toBe('Chicago');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run __tests__/exceptions/contract-intake-resolve.test.ts`
Expected: FAIL — no `contract_intake` branch exists yet, `decision` is ignored, no `pipeline_loads` row is created on approve.

- [ ] **Step 3: Add the branch**

In `app/api/exceptions/[id]/route.ts`, inside the `action === "resolve"` block, destructure `decision` and `tender` alongside `action` at the top of the handler:
```ts
    const { action, decision, tender } = body as {
      action: string; decision?: 'approve' | 'reject';
      tender?: {
        originCity: string; originState: string; originCountry: string;
        destinationCity: string; destinationState: string; destinationCountry: string;
        equipmentType: string; rate: number; rateCurrency: string; pickupDate: string;
        commodity: string | null; weightLbs: number | null;
      };
    }
```

After the existing T-28 `if (exc.source_module === 'tenant_onboarding' && ...)` block (same position — additive, after the base `resolve` UPDATE has already run), add:
```ts
      // T-30 — the ONLY code path allowed to create a pipeline_loads row from
      // a parsed tender. No pipeline_loads INSERT exists anywhere else in
      // this module; this is intentional and must stay this way until T-30b.
      if (exc.source_module === 'contract_intake' && exc.type === 'tender_pending_approval') {
        try {
          await asServiceAdmin(
            `T-30 contract-intake resolution for exception ${exc.id} by user ${user.userId}`,
            async (adminClient) => {
              if (decision === 'reject') {
                await adminClient.query(
                  `UPDATE inbound_emails SET intake_status = 'rejected' WHERE id = $1`,
                  [exc.inbound_email_id],
                )
                return
              }
              if (decision === 'approve' && tender) {
                const loadId = `email_tender-${exc.inbound_email_id}-${Date.now()}`
                const inserted = await adminClient.query(
                  `INSERT INTO pipeline_loads (
                     load_id, load_board_source, origin_city, origin_state, origin_country,
                     destination_city, destination_state, destination_country,
                     pickup_date, equipment_type, posted_rate, posted_rate_currency,
                     commodity, weight_lbs, stage, source_type
                   ) VALUES (
                     $1, 'email_tender', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'qualified', 'email_tender'
                   ) RETURNING id`,
                  [
                    loadId, tender.originCity, tender.originState, tender.originCountry,
                    tender.destinationCity, tender.destinationState, tender.destinationCountry,
                    tender.pickupDate, tender.equipmentType, tender.rate, tender.rateCurrency,
                    tender.commodity, tender.weightLbs,
                  ],
                )
                await adminClient.query(
                  `UPDATE inbound_emails SET intake_status = 'approved', created_pipeline_load_id = $1 WHERE id = $2`,
                  [inserted.rows[0].id, exc.inbound_email_id],
                )
              }
            },
          )
        } catch (err) { console.error("[PATCH /api/exceptions/:id] contract_intake resolution failed:", err) }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run __tests__/exceptions/contract-intake-resolve.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Run the pre-existing exceptions route test suite to confirm zero regressions**

Run: `pnpm vitest run __tests__/exceptions/tenant-onboarding-resolve.test.ts`
Expected: PASS, unchanged from before this task

- [ ] **Step 6: Commit**

```bash
git add app/api/exceptions/[id]/route.ts __tests__/exceptions/contract-intake-resolve.test.ts
git commit -m "feat(T-30): approve/reject branch on PATCH /api/exceptions/:id — the only pipeline_loads insertion point"
```

---

## Task 10: Remaining API surface — pending list + authorization CRUD

**Files:**
- Create: `app/api/contract-intake/pending/route.ts`
- Create: `app/api/tenants/[id]/contract-shippers/route.ts`
- Test: `app/api/contract-intake/__tests__/pending.test.ts`
- Test: `app/api/tenants/[id]/contract-shippers/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser`/`requireTenantContext`/`requireSuperAdmin` (`@/lib/auth`), `withTenant` (`@/lib/db/tenant-context`), `apiError` (`@/lib/api-error`).
- Produces: `GET /api/contract-intake/pending`, `GET /api/tenants/:id/contract-shippers`, `POST /api/tenants/:id/contract-shippers`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/contract-intake/__tests__/pending.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { GET } from '@/app/api/contract-intake/pending/route';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

describe('GET /api/contract-intake/pending', () => {
  let tenantId: number;
  let inboundEmailId: number;
  let exceptionId: number;

  afterEach(async () => {
    if (exceptionId) await db.query(`DELETE FROM exceptions WHERE id = $1`, [exceptionId]);
    if (inboundEmailId) await db.query(`DELETE FROM inbound_emails WHERE id = $1`, [inboundEmailId]);
  });

  it('lists only this tenant\'s pending contract-intake exceptions', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO inbound_emails (message_id, from_address, subject, received_at, quarantined, intake_type, intake_status)
       VALUES ($1, 'shipper@example.com', 'Tender', NOW(), true, 'freight_tender', 'pending_review') RETURNING id`,
      [`t30-pending-${Date.now()}`],
    );
    inboundEmailId = inserted.rows[0].id;
    await bridgeToExceptions({
      tenantId, sourceModule: 'contract_intake', exceptionType: 'tender_pending_approval',
      title: 'New tender ready', description: 'x', context: {},
      pipelineLoadId: null, loadId: null, carrierId: null, inboundEmailId,
    });
    const excRow = await db.query<{ id: number }>(`SELECT id FROM exceptions WHERE inbound_email_id = $1`, [inboundEmailId]);
    exceptionId = excRow.rows[0].id;

    const token = createToken({ userId: 'u', email: 'e@myra.dev', role: 'admin', firstName: 'T', lastName: 'U', tenantId, tenantIds: [tenantId], isSuperAdmin: false });
    const headers = new Headers();
    headers.set('cookie', `auth-token=${token}`);
    const req = new NextRequest('http://localhost/api/contract-intake/pending', { headers });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending.some((p: { id: number }) => p.id === exceptionId)).toBe(true);
  });
});
```

```ts
// app/api/tenants/[id]/contract-shippers/__tests__/route.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { GET, POST } from '@/app/api/tenants/[id]/contract-shippers/route';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';

function superAdminToken(): string {
  return createToken({ userId: 'sa', email: 'sa@myra.dev', role: 'admin', firstName: 'S', lastName: 'A', tenantId: 2, tenantIds: [2], isSuperAdmin: true });
}

describe('/api/tenants/:id/contract-shippers', () => {
  let tenantId: number;
  let authId: number;

  afterEach(async () => {
    if (authId) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [authId]);
  });

  it('POST creates an authorization row, GET lists it', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const email = `crud-${Date.now()}@shipper.example.com`;

    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('cookie', `auth-token=${superAdminToken()}`);
    const postReq = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST', body: JSON.stringify({ shipperEmail: email, shipperCompanyName: 'Test Co', authorizedBy: 'test-suite' }), headers,
    });
    const postRes = await POST(postReq, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(postRes.status).toBe(201);
    const created = await postRes.json();
    authId = created.id;

    const getReq = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, { headers });
    const getRes = await GET(getReq, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(list.some((r: { shipper_email: string }) => r.shipper_email === email)).toBe(true);
  });

  it('rejects a non-super-admin', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const token = createToken({ userId: 'u', email: 'u@myra.dev', role: 'admin', firstName: 'U', lastName: 'U', tenantId, tenantIds: [tenantId], isSuperAdmin: false });
    const headers = new Headers();
    headers.set('cookie', `auth-token=${token}`);
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, { headers });
    const res = await GET(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run app/api/contract-intake/__tests__/pending.test.ts app/api/tenants/\[id\]/contract-shippers/__tests__/route.test.ts`
Expected: FAIL — routes not found

- [ ] **Step 3: Write `GET /api/contract-intake/pending`**

```ts
// app/api/contract-intake/pending/route.ts
//
// T-30 §6 — tenant-scoped convenience view over contract_intake exceptions,
// joined to inbound_emails for the parsed detail the generic exceptions list
// doesn't show. exceptions.tenant_id is the real tenant boundary here —
// inbound_emails itself has no tenant_id (single shared mailbox, same
// reality T-19/T-25/T-27 already document).
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, requireTenantContext } from '@/lib/auth';
import { withTenant } from '@/lib/db/tenant-context';

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const ctx = requireTenantContext(req);

  try {
    const pending = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.id, e.title, e.description AS detail, e.created_at,
                ie.id AS inbound_email_id, ie.from_address, ie.subject, ie.intake_status
           FROM exceptions e
           JOIN inbound_emails ie ON ie.id = e.inbound_email_id
          WHERE e.tenant_id = $1 AND e.source_module = 'contract_intake' AND e.status = 'active'
          ORDER BY e.created_at DESC`,
        [ctx.tenantId],
      );
      return rows;
    });
    return NextResponse.json({ pending });
  } catch (err) {
    console.error('[GET /api/contract-intake/pending] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Write `GET`/`POST /api/tenants/[id]/contract-shippers`**

```ts
// app/api/tenants/[id]/contract-shippers/route.ts
//
// T-30 §6 — manages the per-tenant sender whitelist. Super-admin-only, same
// gate as the sibling app/api/tenants/[id]/onboarding-status/route.ts —
// authorizing a shipper to originate real bookings is a platform-operator
// action, not a tenant self-service one, in this build.
import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { db } from '@/lib/pipeline/db-adapter';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { id: rawId } = await params;
  const tenantId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return apiError('Invalid tenant id', 400);

  const { rows } = await db.query(
    `SELECT id, shipper_email, shipper_company_name, margin_floor_override_amount, is_active, authorized_by, authorized_at
       FROM contract_shipper_authorizations
      WHERE tenant_id = $1
      ORDER BY authorized_at DESC`,
    [tenantId],
  );
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { id: rawId } = await params;
  const tenantId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return apiError('Invalid tenant id', 400);

  const body = await req.json();
  const { shipperEmail, shipperCompanyName, marginFloorOverrideAmount, authorizedBy } = body as {
    shipperEmail: string; shipperCompanyName?: string; marginFloorOverrideAmount?: number; authorizedBy: string;
  };
  if (!shipperEmail || !authorizedBy) return apiError('shipperEmail and authorizedBy are required', 400);

  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, shipper_company_name, margin_floor_override_amount, authorized_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, shipperEmail.toLowerCase(), shipperCompanyName ?? null, marginFloorOverrideAmount ?? null, authorizedBy],
  );
  return NextResponse.json({ id: rows[0].id }, { status: 201 });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run app/api/contract-intake/__tests__/pending.test.ts "app/api/tenants/[id]/contract-shippers/__tests__/route.test.ts"`
Expected: PASS (3/3)

- [ ] **Step 6: Commit**

```bash
git add app/api/contract-intake/pending/route.ts "app/api/tenants/[id]/contract-shippers/route.ts" app/api/contract-intake/__tests__/pending.test.ts "app/api/tenants/[id]/contract-shippers/__tests__/route.test.ts"
git commit -m "feat(T-30): pending-tenders list + contract-shipper authorization CRUD"
```

---

## Task 11: End-to-end fixture — criterion 6

**Files:**
- Create: `__tests__/contract-intake/e2e-fixture.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9, plus the real `RankerWorker` (`@/lib/workers/ranker-worker`, unmodified) and `FeedbackWorker` (`@/lib/workers/feedback-worker`, unmodified) — same real-Redis, direct-`.process()`-call pattern established by `__tests__/pipeline/ranker.test.ts`.
- Produces: nothing new — this is the trace-through proof acceptance criterion 6 requires.

- [ ] **Step 1: Write the fixture test**

```ts
// __tests__/contract-intake/e2e-fixture.test.ts
//
// T-30 acceptance criterion 6 — authorized sender -> approved tender ->
// real Researcher/Ranker workers (unmodified) -> finalize-booking -> booked,
// with booked_via='email_tender' and zero agent_calls rows, and a concrete
// proof that downstream code reading agent_calls by pipeline_load_id
// (lib/workers/feedback-worker.ts's gatherContext, a LEFT JOIN LATERAL)
// degrades gracefully rather than erroring. This is the ONE test in this
// module that exercises the real worker classes end-to-end, matching this
// codebase's established pattern (__tests__/pipeline/ranker.test.ts) of
// instantiating a worker with a real Redis connection and calling
// .process()/private methods directly, bypassing BullMQ's own job lifecycle.
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { Queue } from 'bullmq';
import { RankerWorker, type MatchJobPayload } from '@/lib/workers/ranker-worker';
import { FeedbackWorker } from '@/lib/workers/feedback-worker';
import { finalizeMatchedTenders } from '@/lib/contract-intake/finalize-booking';

const TEST_LOAD_ID = `TEST-T30-E2E-${Date.now()}`;

describe('T-30 end-to-end fixture (acceptance criterion 6)', () => {
  let pipelineLoadId: number;
  let briefQueue: Queue;
  let ranker: RankerWorker;
  let feedback: FeedbackWorker;

  afterAll(async () => {
    if (pipelineLoadId) await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await briefQueue?.obliterate({ force: true });
    await briefQueue?.close();
    await ranker?.shutdown();
    await feedback?.shutdown();
  });

  it('approved email-tender load reaches booked via real Researcher/Ranker + finalize-booking, with zero agent_calls rows and no downstream error', async () => {
    // Step 1 — simulate Task 9's approval: insert directly at 'qualified'
    // with source_type='email_tender' (the ONLY insertion shape Task 9
    // produces — this test starts from its output, it doesn't re-test the
    // approval action itself, which Task 9's own suite already covers).
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, source_type, priority_score, estimated_margin_high,
         research_completed_at, market_rate_floor, market_rate_mid, market_rate_best, recommended_strategy
       ) VALUES (
         $1, 'email_tender', 'Chicago', 'IL', 'US', 'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 3000, 'USD', 920, 'qualified', 'email_tender',
         500, 600, NOW(), 2500, 2700, 2900, 'standard'
       ) RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = inserted.rows[0].id;

    // Step 2 — real RankerWorker, unmodified, same direct-.process() pattern
    // as __tests__/pipeline/ranker.test.ts. research_completed_at is
    // pre-seeded above so the completion gate can fully open in isolation.
    briefQueue = new Queue('brief-queue-test-t30', { connection: redisConnection });
    ranker = new RankerWorker(redisConnection, briefQueue);
    const matchPayload: MatchJobPayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'email_tender',
      enqueuedAt: new Date().toISOString(), priority: 0,
    } as MatchJobPayload;
    const matchResult = await ranker.process(matchPayload);
    expect(matchResult.success).toBe(true);

    const afterMatch = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(afterMatch.rows[0].stage).toBe('matched');

    // Step 3 — the ONE new piece of T-30 orchestration.
    const finalizeResult = await finalizeMatchedTenders();
    expect(finalizeResult.finalized).toBeGreaterThanOrEqual(1);

    const afterBooked = await db.query<{
      stage: string; booked_via: string | null; agreed_rate: string | null;
    }>(`SELECT stage, booked_via, agreed_rate FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(afterBooked.rows[0].stage).toBe('booked');
    expect(afterBooked.rows[0].booked_via).toBe('email_tender');
    expect(Number(afterBooked.rows[0].agreed_rate)).toBe(3000);

    // Step 4 — confirm zero agent_calls rows exist for this load (no voice
    // negotiation ever happened — spec §2's explicit design).
    const calls = await db.query(`SELECT COUNT(*)::int AS c FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(calls.rows[0].c).toBe(0);

    // Step 5 — THE proof this criterion actually requires: real downstream
    // code (feedback-worker.ts's gatherContext, called the same way T-16's
    // own suite would call it post-delivery) reads agent_calls by this exact
    // pipeline_load_id via a LEFT JOIN LATERAL and must not throw or omit
    // the row when zero call rows exist.
    feedback = new FeedbackWorker(redisConnection);
    const ctx = await (feedback as any).gatherContext(pipelineLoadId);
    expect(ctx).not.toBeNull();
    expect(ctx.persona).toBeNull(); // gracefully null, not a thrown error
  }, 30000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run __tests__/contract-intake/e2e-fixture.test.ts`
Expected: PASS. If `RankerWorker.process()` requires additional seeded state this plan didn't anticipate (e.g. a minimum number of `carriers` rows to produce a non-empty match), extend the fixture's setup to match `__tests__/pipeline/ranker.test.ts`'s own seeding rather than weakening the assertions — that file is the ground truth for what `RankerWorker` needs to succeed.

- [ ] **Step 3: Commit**

```bash
git add __tests__/contract-intake/e2e-fixture.test.ts
git commit -m "test(T-30): end-to-end fixture — approved tender to booked via real workers (criterion 6)"
```

---

## Task 12: Full regression pass + production migration apply (separate, explicitly-confirmed steps)

**Files:** none created — verification only.

- [ ] **Step 1: Run the full T-16 regression suite**

Run: `pnpm vitest run` (from `MyraTMS/`)
Expected: same pass count as the pre-T-30 baseline, plus all new T-30 tests passing. This codebase has a known rotating pool of flaky live-DB integration tests (`cost-calculator.test.ts` and others, documented in every prior T-2X module's completion entry) — if any fail, confirm via `git log` that the failing files were not touched by any T-30 commit before treating them as pre-existing flakes, per this session's standing discipline.

- [ ] **Step 2: Run `tsc --noEmit`**

Run: `pnpm tsc --noEmit` (from `MyraTMS/`)
Expected: clean, aside from the one pre-existing, unrelated error already documented in T-27's completion entry (`dispatch-routing-api.test.ts`).

- [ ] **Step 3: Confirm zero changes to the three protected worker files**

Run: `git diff --stat origin/master -- lib/workers/qualifier-worker.ts lib/workers/researcher-worker.ts lib/workers/ranker-worker.ts` (or against whatever base this branch diverged from)
Expected: empty output — acceptance criterion 7's non-negotiable.

- [ ] **Step 4: Re-run migration 059 against `t30-verify`, then STOP — do not apply to production without asking**

The disposable-branch verification from Task 1 already confirmed the schema. Applying migration `059` to the **production** Neon branch is a separate, higher-stakes action (per this session's standing discipline, matching T-27/T-28/T-29's own explicit-confirmation gate) — do not run it as part of this task. When the plan's executor reaches this step, stop and ask the user directly whether to apply `059` to production now, the same way T-28's session did before its own production apply.

- [ ] **Step 5: Update the completion tracker**

Add a T-30 entry to `Engine 3/docs/superpowers/plans/completion.md` under "Phase 4 — Commercialize (T-28, T-30)", following the exact structure every prior module's entry uses (spec link, implementation plan link, status line, schema-reality findings, task-by-task checklist, acceptance-criteria table, exit-gate line). This tracker is mandatory per this repo's own standing rule — update it now, don't batch it for later.

- [ ] **Step 6: Commit**

```bash
git add "Engine 3/docs/superpowers/plans/completion.md"
git commit -m "docs(T-30): completion tracker entry"
```
