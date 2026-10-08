# T-27 Finance Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build T-27's routing table, float governor, sandbox-only financial adapters (eCapital/Stripe/Persona), and treasury report, per `Engine 3/T27_Finance_Orchestration.md` v1.0 — with acceptance criteria 1 and 6 (exact match to Pilot 1's worked $12.00/$3.81/$91.28/self-funding example) explicitly deferred as OPEN, per direct user decision, because the source document those numbers come from does not exist anywhere in this repository.

**Architecture:** Pure-core/DB-wrapper split (same pattern as every module since T-18): `decideRoute()` and the capital-days formula are pure functions with no I/O, fully unit-testable; DB wrappers in `lib/finance/` read/write the new tables. Six API routes under `app/api/finance/` reuse T-18's `authorizeGovernanceRequest`/`resolveTenantId` helpers for auth and tenant scoping, same as T-23 through T-26.

**Tech Stack:** Next.js API routes, Neon Postgres (`lib/pipeline/db-adapter.ts`'s `db.query(text, params)`), Vitest, TypeScript literal types as a compile-time safety mechanism (criterion 4).

**Spec:** `Engine 3/T27_Finance_Orchestration.md`

## Global Constraints

- **Criteria 1 and 6 are explicitly OUT OF SCOPE for "passing" in this build.** The document T-27's own §1 cites as the source of its worked numbers ($12.00/$3.81/$91.28/self-funding per 1,000 capital-days) — "Pilot 1's own Financial Architecture §6" — does not exist anywhere in this repository (confirmed: searched `Engine 2/`, `Engine 3/`, and all root-level `.docx` files by name and by grep for "Financial Architecture", "capital-days", "Pilot 1"). Per the user's explicit choice, `lib/finance/capital-days.ts` implements a placeholder formula, clearly commented as unverified, tested only for internal consistency. Never claim these numbers match Pilot 1's real example in code, comments, tests, or the completion tracker.
- **Schema-reality correction — `financing_decisions.tenant_id`:** spec §4.2 writes `INTEGER NOT NULL DEFAULT 1`. That is the exact hardcoded-tenant-id anti-pattern documented in T-19/`Engine 3/wave1.md` (tenant `1` is `_system`, not Myra). Use `BIGINT NOT NULL REFERENCES tenants(id) DEFAULT fn_myra_tenant_id()`, matching `tenant_policies.tenant_id`'s real type (confirmed via `scripts/035-t19-tenant-policy-model.sql:328`).
- **Schema-reality correction — carrier payment preference:** spec §1/§5 assumes `carriers.payment_preference` exists. It does not (confirmed via `information_schema.columns` against production — zero rows for `carriers` with `column_name ILIKE '%payment%'`). Add `payment_preference VARCHAR(20)` to `carrier_registry` instead — the platform-level canonical carrier identity table T-20 introduced, and the same table T-25's `carrier_banking_details` keys off of for carrier-level financial attributes. Do not add a column to `carriers` itself.
- **Schema-reality correction — `route_selected` column width:** spec §4.2 sizes `route_selected VARCHAR(4)`, which cannot hold the literal `'DECLINE'` (7 characters) that §5's own `decideRoute()` returns. Use `VARCHAR(10)`.
- **`invoices.factoring_status` is confirmed real** (TEXT column, values `'N/A'|'Submitted'|'Approved'|'Funded'` per `scripts/001-create-tables.sql`) — criterion 5 syncs into this exact field via `pipeline_loads.tms_load_id` (confirmed as TEXT in production, matching `loads.id`/`invoices.load_id`, despite the original Engine 2 spec typing it `INTEGER` — see `lib/workers/dispatcher-worker.ts`'s own comments on this column). Never create a second factoring-status field.
- **`payer_credit_assessments.credit_level`** (from T-25) already uses the exact vocabulary `'unknown'|'weak'|'acceptable'|'strong'` that `decideRoute()`'s `payerCreditLevel` input expects — no correction needed, direct integration.
- **Zero changes** to `app/api/loads/[id]/pod/route.ts`, invoice creation, or any other existing invoice/load code path (criterion 7). All new code lives under `lib/finance/` and `app/api/finance/`.
- **No production credentials, ever, in this session.** Every adapter function's `environment` field is typed as the TypeScript literal `'sandbox'` (not `string`), and every `INSERT` hardcodes the SQL literal `'sandbox'` rather than parameterizing it — both facts must hold after every task, not just at the end.
- Follow the same disposable-Neon-branch-then-production-with-explicit-confirmation workflow as T-17 through T-26: verify each migration statement on a temporary branch first, then apply to production only after explicit user confirmation — a **separate** confirmation from pushing to `origin/master`.
- `pnpm vitest run` and `pnpm tsc --noEmit` must both stay green after every task.

---

### Task 1: Migration 057 — schema

**Files:**
- Create: `MyraTMS/scripts/057-t27-finance-orchestration.sql`

**Interfaces:**
- Produces: `tenant_policies.treasury_policy` (JSONB), `carrier_registry.payment_preference` (VARCHAR(20), values `'quick_pay'|'net_30'|NULL`), `financing_decisions` table, `v_float_exposure` view, `factoring_submissions`/`quick_pay_disbursements`/`kyc_verifications` tables — all consumed by every later task.

- [ ] **Step 1: Write the migration file**

```sql
-- ============================================================================
-- 057 — T-27 FINANCE ORCHESTRATION
-- ============================================================================
-- Engine 3 Phase 3, Module 1. See Engine 3/T27_Finance_Orchestration.md.
--
-- Schema-reality corrections (see this migration's implementation plan's
-- Global Constraints for full reasoning, not repeated here):
--   1. financing_decisions.tenant_id: spec's literal `INTEGER NOT NULL
--      DEFAULT 1` replaced with `BIGINT NOT NULL REFERENCES tenants(id)
--      DEFAULT fn_myra_tenant_id()` — the same T-19-documented
--      mislabeling-bug correction applied to every tenant-scoped table
--      added since T-20.
--   2. carriers.payment_preference does not exist anywhere in this schema.
--      Added instead on carrier_registry (T-20's platform-level canonical
--      carrier identity table), matching the precedent set by T-25's
--      carrier_banking_details.
--   3. financing_decisions.route_selected widened from the spec's
--      VARCHAR(4) to VARCHAR(10) — VARCHAR(4) cannot hold the literal
--      'DECLINE' (7 chars) that decideRoute() returns.
--   4. Acceptance criteria 1 and 6 (exact match to Pilot 1's worked
--      $12.00/$3.81/$91.28/self-funding example) are OPEN — the source
--      document (Pilot 1's Financial Architecture §6) does not exist
--      anywhere in this repository. See completion.md's T-27 entry.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'carrier_registry') THEN
        RAISE EXCEPTION 'carrier_registry not found — migration 044 (T-20) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payer_credit_assessments') THEN
        RAISE EXCEPTION 'payer_credit_assessments not found — migration 055 (T-25) must be applied first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_policies') THEN
        RAISE EXCEPTION 'tenant_policies not found — migration 035 (T-19) must be applied first';
    END IF;
END $$;

-- 1. treasury_policy — extends T-19's tenant_policies (spec §4.1, verbatim)
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS treasury_policy JSONB DEFAULT
  '{"quick_pay_discount_pct": 2.5, "factoring_fee_pct": 5.0, "float_cap_usd": null, "float_cap_cad": null}';

-- 2. carrier_registry.payment_preference — new (not in base spec, see finding #2)
ALTER TABLE carrier_registry ADD COLUMN IF NOT EXISTS payment_preference VARCHAR(20);
-- values: 'quick_pay' | 'net_30'; NULL = no preference recorded (treated as net_30/false)

-- 3. financing_decisions (spec §4.2, corrected per findings #1 and #3)
CREATE TABLE IF NOT EXISTS financing_decisions (
    id                       SERIAL PRIMARY KEY,
    pipeline_load_id         INTEGER NOT NULL REFERENCES pipeline_loads(id),
    tenant_id                BIGINT NOT NULL REFERENCES tenants(id) DEFAULT fn_myra_tenant_id(),

    payer_credit_level_at_decision        VARCHAR(20) NOT NULL,
    carrier_payment_preference            VARCHAR(20) NOT NULL,
    float_capacity_available_at_decision  BOOLEAN NOT NULL,

    route_selected           VARCHAR(10) NOT NULL,
    capital_days_projected   NUMERIC(10,2),
    yield_projected          NUMERIC(10,4),

    decided_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by               VARCHAR(20) NOT NULL DEFAULT 'system_auto',
    override_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_financing_decisions_load ON financing_decisions(pipeline_load_id);
CREATE INDEX IF NOT EXISTS idx_financing_decisions_tenant ON financing_decisions(tenant_id, decided_at DESC);

-- 4. v_float_exposure (spec §4.3, verbatim — fd.tenant_id is now correctly sourced)
CREATE OR REPLACE VIEW v_float_exposure AS
SELECT fd.tenant_id,
       SUM(CASE WHEN fd.route_selected IN ('T1', 'T2') THEN pl.agreed_rate ELSE 0 END) AS current_float_usd,
       (tp.treasury_policy->>'float_cap_usd')::numeric AS float_cap_usd
FROM financing_decisions fd
JOIN pipeline_loads pl ON pl.id = fd.pipeline_load_id
JOIN tenant_policies tp ON tp.tenant_id = fd.tenant_id AND tp.is_active
WHERE pl.stage IN ('booked', 'dispatched', 'delivered')
GROUP BY fd.tenant_id, tp.treasury_policy;

-- 5. Adapter records (spec §4.4, verbatim)
CREATE TABLE IF NOT EXISTS factoring_submissions (
    id SERIAL PRIMARY KEY, pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id),
    ecapital_reference_id VARCHAR(100), status VARCHAR(20) DEFAULT 'not_submitted',
    -- mirrors existing TMS field values: 'N/A' | 'Submitted' | 'Approved' | 'Funded'
    advance_rate NUMERIC(5,2), fee_pct NUMERIC(5,2), submitted_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);

CREATE TABLE IF NOT EXISTS quick_pay_disbursements (
    id SERIAL PRIMARY KEY, pipeline_load_id INTEGER NOT NULL REFERENCES pipeline_loads(id),
    carrier_registry_id INTEGER REFERENCES carrier_registry(id),
    amount NUMERIC(10,2), discount_applied NUMERIC(10,2), stripe_transfer_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending', disbursed_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);

CREATE TABLE IF NOT EXISTS kyc_verifications (
    id SERIAL PRIMARY KEY, entity_type VARCHAR(20) NOT NULL, entity_id INTEGER NOT NULL,
    verification_status VARCHAR(20) DEFAULT 'pending', persona_reference_id VARCHAR(100),
    verified_at TIMESTAMP, environment VARCHAR(10) DEFAULT 'sandbox'
);
```

- [ ] **Step 2: Create a disposable Neon branch and verify each statement**

Create branch `t27-verify` from the production branch via `mcp__Neon__create_branch` (`parent_id` = production branch id). Apply the migration to that branch **one statement at a time** via `mcp__Neon__run_sql` (the tool rejects multi-statement SQL) — including the `DO $$ ... $$` guard block as its own call, then each `ALTER`/`CREATE TABLE`/`CREATE INDEX`/`CREATE VIEW` as its own call.

- [ ] **Step 3: Verify on the branch**

Run against the `t27-verify` branch:
```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'financing_decisions' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns WHERE table_name = 'carrier_registry' AND column_name = 'payment_preference';
SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_policies' AND column_name = 'treasury_policy';
SELECT * FROM v_float_exposure;
```
Expected: `financing_decisions.tenant_id` is `bigint`; `carrier_registry.payment_preference` exists; `tenant_policies.treasury_policy` exists (and Myra's existing row now has the default JSON, since Postgres backfills a constant `ADD COLUMN ... DEFAULT` onto existing rows); `v_float_exposure` returns zero rows (empty — no `financing_decisions` rows yet) without error.

- [ ] **Step 4: Commit the migration file**

```bash
git add scripts/057-t27-finance-orchestration.sql
git commit -m "feat(T-27): add finance orchestration schema (migration 057)"
```

---

### Task 2: `decideRoute()` — pure routing function

**Files:**
- Create: `MyraTMS/lib/finance/routing.ts`
- Test: `MyraTMS/__tests__/finance/routing.test.ts`

**Interfaces:**
- Produces: `PayerCreditLevel`, `Route`, `RouteDecisionInput`, `RouteDecisionResult`, `decideRoute(input): RouteDecisionResult` — consumed by Task 9's API route.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/routing.test.ts
import { describe, it, expect } from 'vitest';
import { decideRoute } from '@/lib/finance/routing';

describe('decideRoute (T-27 §5/§6.3 routing table)', () => {
  it('declines on unknown payer credit regardless of other inputs', () => {
    expect(decideRoute({ payerCreditLevel: 'unknown', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('DECLINE');
    expect(decideRoute({ payerCreditLevel: 'unknown', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('DECLINE');
  });

  it('declines on weak payer credit regardless of other inputs', () => {
    expect(decideRoute({ payerCreditLevel: 'weak', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('DECLINE');
    expect(decideRoute({ payerCreditLevel: 'weak', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('DECLINE');
  });

  it('routes strong-credit, net-30 carrier to T1', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('T1');
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: false }).route).toBe('T1');
  });

  it('routes strong-credit, fast-pay carrier with float slack to T2', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: true, floatCapacityAvailable: true }).route).toBe('T2');
  });

  it('routes strong-credit, fast-pay carrier at float capacity to T3', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('T3');
  });

  it('treats acceptable credit the same as strong — the routing function only branches on weak/unknown, matching the spec code verbatim', () => {
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('T1');
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: true, floatCapacityAvailable: true }).route).toBe('T2');
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('T3');
  });

  it('every decision includes non-empty reasoning', () => {
    const r = decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: true });
    expect(r.reasoning.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/routing.test.ts`
Expected: FAIL — `Cannot find module '@/lib/finance/routing'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/routing.ts
//
// T-27 §5/§6.3 — reproduces Pilot 1's own T1-T4 routing table verbatim.
// Note: the routing table (§6.3) only lists 'Strong' payer credit for the
// non-decline routes, but the condition below (and the spec's own code)
// branches only on weak/unknown — 'acceptable' credit falls through to the
// same routes as 'strong'. Kept verbatim, not narrowed, since narrowing it
// would be inventing a rule Pilot 1's document doesn't state.
export type PayerCreditLevel = 'unknown' | 'weak' | 'acceptable' | 'strong';
export type Route = 'T1' | 'T2' | 'T3' | 'T4' | 'DECLINE';

export interface RouteDecisionInput {
  payerCreditLevel: PayerCreditLevel;
  carrierWantsQuickPay: boolean;
  floatCapacityAvailable: boolean;
}

export interface RouteDecisionResult {
  route: Route;
  reasoning: string;
}

export function decideRoute(input: RouteDecisionInput): RouteDecisionResult {
  if (input.payerCreditLevel === 'unknown' || input.payerCreditLevel === 'weak') {
    return { route: 'DECLINE', reasoning: 'Weak or unknown payer credit — neither floated nor factored, regardless of margin (Pilot 1 §6.3)' };
  }

  if (!input.carrierWantsQuickPay) {
    return { route: 'T1', reasoning: 'Strong payer, net-30 carrier — best margin and best facility use' };
  }

  if (input.floatCapacityAvailable) {
    return { route: 'T2', reasoning: 'Strong payer, fast-pay carrier, facility has slack — highest margin per load, deploy surplus capacity' };
  }
  return { route: 'T3', reasoning: 'Strong payer, fast-pay carrier, facility at capacity — factor to preserve capacity for T1 loads' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/routing.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/routing.ts __tests__/finance/routing.test.ts
git commit -m "feat(T-27): add decideRoute() pure routing function"
```

---

### Task 3: Credit-level and carrier-preference DB lookups

**Files:**
- Create: `MyraTMS/lib/finance/credit-lookup.ts`
- Test: `MyraTMS/__tests__/finance/credit-lookup.test.ts`

**Interfaces:**
- Consumes: `PayerCreditLevel` from `lib/finance/routing.ts` (Task 2); `db.query` from `@/lib/pipeline/db-adapter`.
- Produces: `getPayerCreditLevel(pipelineLoadId: number): Promise<PayerCreditLevel>`, `getCarrierWantsQuickPay(pipelineLoadId: number): Promise<boolean>` — consumed by Task 9's API route.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/credit-lookup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getPayerCreditLevel, getCarrierWantsQuickPay } from '@/lib/finance/credit-lookup';

describe('T-27 credit/preference lookups', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns the most recent payer credit_level for the load\'s payer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] });
    const level = await getPayerCreditLevel(42);
    expect(level).toBe('strong');
    expect(queryMock.mock.calls[0][1]).toEqual([42]);
  });

  it('defaults to unknown when no assessment exists — conservative default, matches decideRoute\'s decline branch', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getPayerCreditLevel(42)).toBe('unknown');
  });

  it('returns true when carrier_registry.payment_preference is quick_pay', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: 'quick_pay' }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(true);
  });

  it('returns false when payment_preference is net_30, null, or no carrier is matched', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: 'net_30' }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: null }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/credit-lookup.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/credit-lookup.ts
//
// T-27 §5 inputs, sourced from real tables rather than assumed fields.
// payerCreditLevel comes from T-25's payer_credit_assessments, joined via
// pipeline_loads.payer_registry_id (T-25's linkage column — pipeline_loads
// has no direct FK to payer_credit_assessments, so this is a point-in-time
// lookup of the latest assessment, not a live join).
// carrierWantsQuickPay comes from carrier_registry.payment_preference (new
// in migration 057 — carriers.payment_preference, which the base spec
// assumed, does not exist), joined via pipeline_loads.top_carrier_id ->
// carriers.carrier_registry_id.
import { db } from '@/lib/pipeline/db-adapter';
import type { PayerCreditLevel } from './routing';

export async function getPayerCreditLevel(pipelineLoadId: number): Promise<PayerCreditLevel> {
  const { rows } = await db.query<{ credit_level: string }>(
    `SELECT pca.credit_level
       FROM pipeline_loads pl
       JOIN payer_credit_assessments pca ON pca.payer_registry_id = pl.payer_registry_id
      WHERE pl.id = $1
      ORDER BY pca.assessed_at DESC
      LIMIT 1`,
    [pipelineLoadId],
  );
  return (rows[0]?.credit_level as PayerCreditLevel) ?? 'unknown';
}

export async function getCarrierWantsQuickPay(pipelineLoadId: number): Promise<boolean> {
  const { rows } = await db.query<{ payment_preference: string | null }>(
    `SELECT cr.payment_preference
       FROM pipeline_loads pl
       JOIN carriers c ON c.id = pl.top_carrier_id
       JOIN carrier_registry cr ON cr.id = c.carrier_registry_id
      WHERE pl.id = $1`,
    [pipelineLoadId],
  );
  return rows[0]?.payment_preference === 'quick_pay';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/credit-lookup.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/credit-lookup.ts __tests__/finance/credit-lookup.test.ts
git commit -m "feat(T-27): add payer-credit and carrier-preference lookups"
```

---

### Task 4: Float governor

**Files:**
- Create: `MyraTMS/lib/finance/float-governor.ts`
- Test: `MyraTMS/__tests__/finance/float-governor.test.ts`

**Interfaces:**
- Consumes: `db.query` from `@/lib/pipeline/db-adapter`; reads the `v_float_exposure` view from Task 1.
- Produces: `FloatExposure` type, `getFloatExposure(tenantId): Promise<FloatExposure>`, `isFloatCapacityAvailable(exposure, projectedAmount): boolean` — consumed by Task 9's API route.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/float-governor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getFloatExposure, isFloatCapacityAvailable } from '@/lib/finance/float-governor';

describe('T-27 float governor (criterion 3)', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns zero exposure and null cap when the tenant has no financing_decisions rows yet', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 0, floatCapUsd: null });
  });

  it('parses numeric strings from Neon into real numbers', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: '2', current_float_usd: '15000.50', float_cap_usd: '20000' }] });
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 15000.5, floatCapUsd: 20000 });
  });

  it('treats a null float cap as unlimited — Myra has not set a real cap yet (spec §4.1)', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 999999, floatCapUsd: null }, 500)).toBe(true);
  });

  it('forces capacity-unavailable once current + projected would exceed a configured cap', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 19800, floatCapUsd: 20000 }, 500)).toBe(false);
  });

  it('allows capacity when current + projected stays within a configured cap', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 10000, floatCapUsd: 20000 }, 500)).toBe(true);
  });

  it('allows capacity exactly at the cap boundary (<=, not <)', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 19500, floatCapUsd: 20000 }, 500)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/float-governor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/float-governor.ts
//
// T-27 §2/§7 criterion 3 — the piece Pilot 1's own checklist named as not
// yet built. v_float_exposure (migration 057) is computed live, same
// reasoning as T-25's v_payer_concentration_exposure: a stale float number
// defeats the point of a governor.
import { db } from '@/lib/pipeline/db-adapter';

export interface FloatExposure {
  tenantId: number;
  currentFloatUsd: number;
  floatCapUsd: number | null;
}

export async function getFloatExposure(tenantId: number): Promise<FloatExposure> {
  const { rows } = await db.query<{ tenant_id: string; current_float_usd: string; float_cap_usd: string | null }>(
    `SELECT tenant_id, current_float_usd, float_cap_usd FROM v_float_exposure WHERE tenant_id = $1`,
    [tenantId],
  );
  if (rows.length === 0) {
    return { tenantId, currentFloatUsd: 0, floatCapUsd: null };
  }
  return {
    tenantId,
    currentFloatUsd: Number(rows[0].current_float_usd),
    floatCapUsd: rows[0].float_cap_usd === null ? null : Number(rows[0].float_cap_usd),
  };
}

// A null cap means Myra hasn't set float_cap_usd yet (§4.1 — depends on the
// facility being papered by counsel, an explicit non-engineering
// prerequisite). Until it's set, nothing is enforced — T1/T2 stay
// selectable. This is a deliberate default, not a bug: enforcing an
// unconfigured cap of zero would force every load to DECLINE or T3.
export function isFloatCapacityAvailable(exposure: FloatExposure, projectedAmount: number): boolean {
  if (exposure.floatCapUsd === null) return true;
  return exposure.currentFloatUsd + projectedAmount <= exposure.floatCapUsd;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/float-governor.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/float-governor.ts __tests__/finance/float-governor.test.ts
git commit -m "feat(T-27): add float governor against v_float_exposure"
```

---

### Task 5: Capital-days placeholder formula (criteria 1/6 — explicitly deferred)

**Files:**
- Create: `MyraTMS/lib/finance/capital-days.ts`
- Test: `MyraTMS/__tests__/finance/capital-days.test.ts`

**Interfaces:**
- Produces: `CapitalDaysResult`, `computeCapitalDays(amount, daysHeld): CapitalDaysResult`, `computeYieldPer1000CapitalDays(marginDollars, capitalDays): number | null` — consumed by Task 8's treasury report.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/capital-days.test.ts
//
// These tests check INTERNAL CONSISTENCY only (sign handling, zero
// handling) — they do NOT assert the formula matches Pilot 1's real
// worked example ($12.00/$3.81/$91.28/self-funding). That document does
// not exist in this repository. Acceptance criteria 1 and 6 are OPEN.
import { describe, it, expect } from 'vitest';
import { computeCapitalDays, computeYieldPer1000CapitalDays } from '@/lib/finance/capital-days';

describe('capital-days placeholder formula (criteria 1/6 OPEN — see plan Global Constraints)', () => {
  it('computes positive capital-days for a load held before collection', () => {
    const result = computeCapitalDays(1000, 10);
    expect(result.capitalDays).toBe(10000);
    expect(result.selfFunding).toBe(false);
  });

  it('flags zero or negative capital-days as self-funding (T4-style: factored before net-30 would have paid)', () => {
    expect(computeCapitalDays(1000, -29).selfFunding).toBe(true);
    expect(computeCapitalDays(1000, 0).selfFunding).toBe(true);
  });

  it('returns null yield for self-funding cases rather than a divide-by-zero or negative number', () => {
    expect(computeYieldPer1000CapitalDays(50, 0)).toBeNull();
    expect(computeYieldPer1000CapitalDays(50, -10000)).toBeNull();
  });

  it('computes a positive yield for positive capital-days', () => {
    expect(computeYieldPer1000CapitalDays(120, 10000)).toBeCloseTo(12, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/capital-days.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/capital-days.ts
//
// PLACEHOLDER FORMULA — NOT verified against Pilot 1's real Financial
// Architecture document (§6), which does not exist anywhere in this
// repository (searched Engine 2/, Engine 3/, and all root-level .docx
// files). Do not claim these numbers reproduce Pilot 1's worked example
// ($12.00 / $3.81 / $91.28 / self-funding). T-27 acceptance criteria 1 and
// 6 are OPEN pending that document — see the T-27 completion tracker entry.
// Tested only for internal consistency (sign handling, zero handling).
export interface CapitalDaysResult {
  capitalDays: number;
  selfFunding: boolean;
}

export function computeCapitalDays(amount: number, daysHeld: number): CapitalDaysResult {
  const capitalDays = amount * daysHeld;
  return { capitalDays, selfFunding: capitalDays <= 0 };
}

export function computeYieldPer1000CapitalDays(marginDollars: number, capitalDays: number): number | null {
  if (capitalDays <= 0) return null;
  return marginDollars / (capitalDays / 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/capital-days.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/capital-days.ts __tests__/finance/capital-days.test.ts
git commit -m "feat(T-27): add placeholder capital-days formula (criteria 1/6 OPEN)"
```

---

### Task 6: Sandbox-only adapters (eCapital, Stripe, Persona)

**Files:**
- Create: `MyraTMS/lib/finance/adapters/ecapital.ts`
- Create: `MyraTMS/lib/finance/adapters/stripe.ts`
- Create: `MyraTMS/lib/finance/adapters/persona.ts`
- Test: `MyraTMS/__tests__/finance/adapters.test.ts`

**Interfaces:**
- Consumes: `db.query` from `@/lib/pipeline/db-adapter`.
- Produces: `FactoringSubmissionResult`, `submitToEcapitalSandbox(feePct): FactoringSubmissionResult`, `recordFactoringSubmission(pipelineLoadId, result): Promise<number>`; `QuickPayDisbursementResult`, `disburseQuickPaySandbox(amount, discountPct): QuickPayDisbursementResult`, `recordQuickPayDisbursement(pipelineLoadId, carrierRegistryId, amount, result): Promise<number>`; `KycVerificationResult`, `verifyKycSandbox(): KycVerificationResult`, `recordKycVerification(entityType, entityId, result): Promise<number>` — all consumed by Task 9's API routes.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/adapters.test.ts
//
// Criterion 4: zero code path in this build can write environment =
// 'production'. Proven two ways here: (1) runtime — every INSERT's SQL
// text hardcodes the literal 'sandbox', never a bound parameter, so no
// caller-supplied value can reach that column; (2) compile-time — each
// adapter result type declares `environment: 'sandbox'` as a string
// LITERAL type, not `string`, so assigning 'production' fails `tsc`. The
// @ts-expect-error block below is unreachable at runtime (`if (false)`)
// but IS type-checked by `tsc --noEmit`: if the literal type were ever
// loosened to `string`, this directive would report "unused
// @ts-expect-error" and the build would fail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FactoringSubmissionResult } from '@/lib/finance/adapters/ecapital';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { submitToEcapitalSandbox, recordFactoringSubmission } from '@/lib/finance/adapters/ecapital';
import { disburseQuickPaySandbox, recordQuickPayDisbursement } from '@/lib/finance/adapters/stripe';
import { verifyKycSandbox, recordKycVerification } from '@/lib/finance/adapters/persona';

if (false) {
  // @ts-expect-error - environment is the literal type 'sandbox'; assigning 'production' must fail tsc
  const bad: FactoringSubmissionResult = { environment: 'production', ecapitalReferenceId: 'x', status: 'Submitted', advanceRate: 95, feePct: 5 };
}

describe('T-27 sandbox-only adapters (criterion 4)', () => {
  beforeEach(() => queryMock.mockReset());

  it('eCapital sandbox submission is always environment: sandbox', () => {
    const result = submitToEcapitalSandbox(5);
    expect(result.environment).toBe('sandbox');
    expect(result.status).toBe('Submitted');
    expect(result.advanceRate).toBe(95);
  });

  it('recordFactoringSubmission hardcodes the sandbox literal in SQL, not as a bound parameter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = submitToEcapitalSandbox(5);
    await recordFactoringSubmission(42, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });

  it('Stripe sandbox disbursement is always environment: sandbox', () => {
    const result = disburseQuickPaySandbox(1000, 2.5);
    expect(result.environment).toBe('sandbox');
    expect(result.discountApplied).toBeCloseTo(25, 5);
  });

  it('recordQuickPayDisbursement hardcodes the sandbox literal in SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = disburseQuickPaySandbox(1000, 2.5);
    await recordQuickPayDisbursement(42, 7, 1000, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });

  it('Persona sandbox verification is always environment: sandbox', () => {
    const result = verifyKycSandbox();
    expect(result.environment).toBe('sandbox');
    expect(result.verificationStatus).toBe('pending');
  });

  it('recordKycVerification hardcodes the sandbox literal in SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const result = verifyKycSandbox();
    await recordKycVerification('carrier', 7, result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/'sandbox'/);
    expect(params).not.toContain('production');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/adapters.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// lib/finance/adapters/ecapital.ts
//
// Sandbox-only stub — no real eCapital API credentials are wired in this
// build (T-27 §10: production credentials must never be wired in this
// session). `environment` is typed as the literal 'sandbox', not `string`,
// so no code path in this file can produce 'production' without a compile
// error. The INSERT below also hardcodes the SQL literal 'sandbox' rather
// than binding it as a parameter — belt-and-suspenders for criterion 4.
import { db } from '@/lib/pipeline/db-adapter';

export interface FactoringSubmissionResult {
  environment: 'sandbox';
  ecapitalReferenceId: string;
  status: 'Submitted';
  advanceRate: number;
  feePct: number;
}

export function submitToEcapitalSandbox(feePct: number): FactoringSubmissionResult {
  return {
    environment: 'sandbox',
    ecapitalReferenceId: `SANDBOX-ECAP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    status: 'Submitted',
    advanceRate: 100 - feePct,
    feePct,
  };
}

export async function recordFactoringSubmission(
  pipelineLoadId: number,
  result: FactoringSubmissionResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO factoring_submissions
       (pipeline_load_id, ecapital_reference_id, status, advance_rate, fee_pct, submitted_at, environment)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, 'sandbox')
     RETURNING id`,
    [pipelineLoadId, result.ecapitalReferenceId, result.status, result.advanceRate, result.feePct],
  );
  return rows[0].id;
}
```

```typescript
// lib/finance/adapters/stripe.ts
import { db } from '@/lib/pipeline/db-adapter';

export interface QuickPayDisbursementResult {
  environment: 'sandbox';
  stripeTransferId: string;
  status: 'pending';
  discountApplied: number;
}

export function disburseQuickPaySandbox(amount: number, discountPct: number): QuickPayDisbursementResult {
  return {
    environment: 'sandbox',
    stripeTransferId: `SANDBOX-STRIPE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    status: 'pending',
    discountApplied: Math.round(amount * (discountPct / 100) * 100) / 100,
  };
}

export async function recordQuickPayDisbursement(
  pipelineLoadId: number,
  carrierRegistryId: number,
  amount: number,
  result: QuickPayDisbursementResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO quick_pay_disbursements
       (pipeline_load_id, carrier_registry_id, amount, discount_applied, stripe_transfer_id, status, disbursed_at, environment)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'sandbox')
     RETURNING id`,
    [pipelineLoadId, carrierRegistryId, amount, result.discountApplied, result.stripeTransferId, result.status],
  );
  return rows[0].id;
}
```

```typescript
// lib/finance/adapters/persona.ts
import { db } from '@/lib/pipeline/db-adapter';

export interface KycVerificationResult {
  environment: 'sandbox';
  personaReferenceId: string;
  verificationStatus: 'pending';
}

export function verifyKycSandbox(): KycVerificationResult {
  return {
    environment: 'sandbox',
    personaReferenceId: `SANDBOX-PERSONA-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    verificationStatus: 'pending',
  };
}

export async function recordKycVerification(
  entityType: 'carrier' | 'payer',
  entityId: number,
  result: KycVerificationResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO kyc_verifications
       (entity_type, entity_id, verification_status, persona_reference_id, environment)
     VALUES ($1, $2, $3, $4, 'sandbox')
     RETURNING id`,
    [entityType, entityId, result.verificationStatus, result.personaReferenceId],
  );
  return rows[0].id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/adapters.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the TypeScript compiler to confirm the literal-type guarantee actually holds**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: no new errors — confirms the `@ts-expect-error` directive in the test file is satisfied (an unsatisfied one would itself be a `tsc` error), proving `environment: 'production'` cannot compile against `FactoringSubmissionResult`.

- [ ] **Step 6: Commit**

```bash
git add lib/finance/adapters __tests__/finance/adapters.test.ts
git commit -m "feat(T-27): add sandbox-only eCapital/Stripe/Persona adapters"
```

---

### Task 7: Sync into the existing `invoices.factoring_status` field

**Files:**
- Create: `MyraTMS/lib/finance/factoring-sync.ts`
- Test: `MyraTMS/__tests__/finance/factoring-sync.test.ts`

**Interfaces:**
- Consumes: `db.query` from `@/lib/pipeline/db-adapter`.
- Produces: `syncInvoiceFactoringStatus(pipelineLoadId: number, status: string): Promise<boolean>` — consumed by Task 9's `factoring/submit` route.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/factoring-sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { syncInvoiceFactoringStatus } from '@/lib/finance/factoring-sync';

describe('T-27 invoice.factoring_status sync (criterion 5)', () => {
  beforeEach(() => queryMock.mockReset());

  it('updates the existing invoices.factoring_status field via the pipeline_loads.tms_load_id -> invoices.load_id join', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] });
    const updated = await syncInvoiceFactoringStatus(42, 'Submitted');
    expect(updated).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE invoices/);
    expect(sql).toMatch(/tms_load_id/);
    expect(params).toEqual(['Submitted', 42]);
  });

  it('returns false when the pipeline load has no dispatched TMS load or invoice yet — not an error', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await syncInvoiceFactoringStatus(42, 'Submitted')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/factoring-sync.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/factoring-sync.ts
//
// Syncs the NEW factoring_submissions.status into the EXISTING
// invoices.factoring_status field — same field, not a duplicate (T-27
// acceptance criterion 5). Joins pipeline_loads.tms_load_id to
// invoices.load_id. Despite the original Engine 2 spec typing tms_load_id
// as INTEGER, production has it as TEXT (confirmed via
// information_schema.columns) matching loads.id/invoices.load_id — see
// lib/workers/dispatcher-worker.ts's own comments on this column. A
// pipeline load with no dispatched TMS load yet (tms_load_id IS NULL) or
// no invoice yet has nothing to sync — not an error.
import { db } from '@/lib/pipeline/db-adapter';

export async function syncInvoiceFactoringStatus(pipelineLoadId: number, status: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE invoices
        SET factoring_status = $1
      WHERE load_id = (SELECT tms_load_id FROM pipeline_loads WHERE id = $2)
      RETURNING id`,
    [status, pipelineLoadId],
  );
  return rows.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/factoring-sync.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/factoring-sync.ts __tests__/finance/factoring-sync.test.ts
git commit -m "feat(T-27): sync factoring_submissions.status into existing invoices.factoring_status"
```

---

### Task 8: Treasury report (criterion 6 — explicitly labeled unverified)

**Files:**
- Create: `MyraTMS/lib/finance/treasury-report.ts`
- Test: `MyraTMS/__tests__/finance/treasury-report.test.ts`

**Interfaces:**
- Consumes: `db.query` from `@/lib/pipeline/db-adapter`.
- Produces: `TreasuryReport`, `getTreasuryReport(tenantId: number): Promise<TreasuryReport>` — consumed by Task 9's `treasury-report` route.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/treasury-report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getTreasuryReport } from '@/lib/finance/treasury-report';

describe('T-27 treasury report (criterion 6 — placeholder formula, OPEN)', () => {
  beforeEach(() => queryMock.mockReset());

  it('aggregates real financing_decisions rows, not placeholder counts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { route_selected: 'T1', capital_days_projected: '10000', yield_projected: '12.0' },
        { route_selected: 'T1', capital_days_projected: '5000', yield_projected: '10.0' },
        { route_selected: 'DECLINE', capital_days_projected: null, yield_projected: null },
      ],
    });
    const report = await getTreasuryReport(2);
    expect(report.decisionCount).toBe(3);
    expect(report.totalCapitalDaysProjected).toBe(15000);
    expect(report.averageYieldProjected).toBeCloseTo(11, 5);
    expect(report.routeCounts).toEqual({ T1: 2, DECLINE: 1 });
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });

  it('never claims a match to Pilot 1\'s real numbers in its note field', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const report = await getTreasuryReport(2);
    expect(report.note).toMatch(/not verified/i);
    expect(report.decisionCount).toBe(0);
    expect(report.averageYieldProjected).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/treasury-report.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/finance/treasury-report.ts
//
// Treasury report over financing_decisions — capital-days and
// yield-per-1000-capital-days, using the placeholder formula in
// capital-days.ts. NOT verified against Pilot 1's real Financial
// Architecture numbers — acceptance criteria 1 and 6 remain OPEN. This
// report reflects real financing_decisions rows only, never invented ones.
import { db } from '@/lib/pipeline/db-adapter';

export interface TreasuryReport {
  tenantId: number;
  decisionCount: number;
  totalCapitalDaysProjected: number;
  averageYieldProjected: number | null;
  routeCounts: Record<string, number>;
  note: string;
}

export async function getTreasuryReport(tenantId: number): Promise<TreasuryReport> {
  const { rows } = await db.query<{
    route_selected: string;
    capital_days_projected: string | null;
    yield_projected: string | null;
  }>(
    `SELECT route_selected, capital_days_projected, yield_projected
       FROM financing_decisions WHERE tenant_id = $1`,
    [tenantId],
  );

  const routeCounts: Record<string, number> = {};
  let totalCapitalDays = 0;
  let yieldSum = 0;
  let yieldCount = 0;

  for (const row of rows) {
    routeCounts[row.route_selected] = (routeCounts[row.route_selected] ?? 0) + 1;
    if (row.capital_days_projected !== null) totalCapitalDays += Number(row.capital_days_projected);
    if (row.yield_projected !== null) {
      yieldSum += Number(row.yield_projected);
      yieldCount += 1;
    }
  }

  return {
    tenantId,
    decisionCount: rows.length,
    totalCapitalDaysProjected: totalCapitalDays,
    averageYieldProjected: yieldCount === 0 ? null : yieldSum / yieldCount,
    routeCounts,
    note: "Uses a placeholder capital-days/yield formula, not verified against Pilot 1's real Financial Architecture numbers ($12.00/$3.81/$91.28/self-funding) — see the T-27 completion tracker entry for the missing-document finding.",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/treasury-report.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/treasury-report.ts __tests__/finance/treasury-report.test.ts
git commit -m "feat(T-27): add treasury report (criterion 6 OPEN — placeholder formula)"
```

---

### Task 9: API routes

**Files:**
- Create: `MyraTMS/app/api/finance/route-decision/route.ts`
- Create: `MyraTMS/app/api/finance/float-exposure/route.ts`
- Create: `MyraTMS/app/api/finance/factoring/submit/route.ts`
- Create: `MyraTMS/app/api/finance/quickpay/disburse/route.ts`
- Create: `MyraTMS/app/api/finance/kyc/verify/route.ts`
- Create: `MyraTMS/app/api/finance/treasury-report/route.ts`
- Test: `MyraTMS/__tests__/finance/t27-api.test.ts`

**Interfaces:**
- Consumes: `authorizeGovernanceRequest`/`resolveTenantId` from `@/lib/governance/api-helpers`; `decideRoute` (Task 2); `getPayerCreditLevel`/`getCarrierWantsQuickPay` (Task 3); `getFloatExposure`/`isFloatCapacityAvailable` (Task 4); adapters (Task 6); `syncInvoiceFactoringStatus` (Task 7); `getTreasuryReport` (Task 8); `db.query` from `@/lib/pipeline/db-adapter`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/finance/t27-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { POST as postRouteDecision } from '@/app/api/finance/route-decision/route';
import { GET as getFloatExposureRoute } from '@/app/api/finance/float-exposure/route';
import { POST as postFactoringSubmit } from '@/app/api/finance/factoring/submit/route';
import { POST as postQuickpayDisburse } from '@/app/api/finance/quickpay/disburse/route';
import { POST as postKycVerify } from '@/app/api/finance/kyc/verify/route';
import { GET as getTreasuryReportRoute } from '@/app/api/finance/treasury-report/route';

describe('T-27 finance API', () => {
  beforeEach(() => queryMock.mockReset());

  it('POST route-decision rejects an invalid pipelineLoadId', async () => {
    const req = new NextRequest('http://x/api/finance/route-decision', { method: 'POST', body: JSON.stringify({}) });
    const res = await postRouteDecision(req);
    expect(res.status).toBe(400);
  });

  it('POST route-decision computes and persists a decision, tenant-scoped', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] })       // getPayerCreditLevel
      .mockResolvedValueOnce({ rows: [{ payment_preference: 'net_30' }] }) // getCarrierWantsQuickPay
      .mockResolvedValueOnce({ rows: [{ agreed_rate: '1500.00' }] })        // pipeline_loads.agreed_rate
      .mockResolvedValueOnce({ rows: [] })                                 // getFloatExposure -> v_float_exposure
      .mockResolvedValueOnce({ rows: [{ id: 9 }] });                       // INSERT financing_decisions

    const req = new NextRequest('http://x/api/finance/route-decision', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42 }) });
    const res = await postRouteDecision(req);
    const body = await res.json();
    expect(body.route).toBe('T1');
    expect(body.financingDecisionId).toBe(9);
    const insertCall = queryMock.mock.calls[4];
    expect(insertCall[1]).toEqual([42, 2, 'strong', 'net_30', true, 'T1']);
  });

  it('GET float-exposure returns the tenant-scoped exposure', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: '2', current_float_usd: '1000', float_cap_usd: null }] });
    const req = new NextRequest('http://x/api/finance/float-exposure');
    const res = await getFloatExposureRoute(req);
    const body = await res.json();
    expect(body).toEqual({ tenantId: 2, currentFloatUsd: 1000, floatCapUsd: null });
  });

  it('POST factoring/submit records a sandbox submission and syncs invoices.factoring_status', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })       // recordFactoringSubmission INSERT
      .mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] }); // syncInvoiceFactoringStatus UPDATE
    const req = new NextRequest('http://x/api/finance/factoring/submit', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42, feePct: 5 }) });
    const res = await postFactoringSubmit(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(5);
  });

  it('POST quickpay/disburse rejects invalid input', async () => {
    const req = new NextRequest('http://x/api/finance/quickpay/disburse', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42 }) });
    const res = await postQuickpayDisburse(req);
    expect(res.status).toBe(400);
  });

  it('POST quickpay/disburse records a sandbox disbursement', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 3 }] });
    const req = new NextRequest('http://x/api/finance/quickpay/disburse', {
      method: 'POST',
      body: JSON.stringify({ pipelineLoadId: 42, carrierRegistryId: 7, amount: 1000, discountPct: 2.5 }),
    });
    const res = await postQuickpayDisburse(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(3);
  });

  it('POST kyc/verify rejects an invalid entityType', async () => {
    const req = new NextRequest('http://x/api/finance/kyc/verify', { method: 'POST', body: JSON.stringify({ entityType: 'shipper', entityId: 1 }) });
    const res = await postKycVerify(req);
    expect(res.status).toBe(400);
  });

  it('POST kyc/verify records a sandbox verification', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const req = new NextRequest('http://x/api/finance/kyc/verify', { method: 'POST', body: JSON.stringify({ entityType: 'carrier', entityId: 7 }) });
    const res = await postKycVerify(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(11);
  });

  it('GET treasury-report returns tenant-scoped aggregates', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ route_selected: 'T1', capital_days_projected: '1000', yield_projected: '5' }] });
    const req = new NextRequest('http://x/api/finance/treasury-report');
    const res = await getTreasuryReportRoute(req);
    const body = await res.json();
    expect(body.decisionCount).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/finance/t27-api.test.ts`
Expected: FAIL — route modules not found

- [ ] **Step 3: Write the route implementations**

```typescript
// app/api/finance/route-decision/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { decideRoute } from '@/lib/finance/routing';
import { getPayerCreditLevel, getCarrierWantsQuickPay } from '@/lib/finance/credit-lookup';
import { getFloatExposure, isFloatCapacityAvailable } from '@/lib/finance/float-governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  if (!Number.isInteger(pipelineLoadId)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId' }, { status: 400 });
  }
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const payerCreditLevel = await getPayerCreditLevel(pipelineLoadId);
    const carrierWantsQuickPay = await getCarrierWantsQuickPay(pipelineLoadId);
    const projectedRow = await db.query<{ agreed_rate: string | null }>(
      `SELECT agreed_rate FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    const projectedAmount = Number(projectedRow.rows[0]?.agreed_rate ?? 0);
    const exposure = await getFloatExposure(tenantId);
    const floatCapacityAvailable = isFloatCapacityAvailable(exposure, projectedAmount);

    const decision = decideRoute({ payerCreditLevel, carrierWantsQuickPay, floatCapacityAvailable });

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO financing_decisions
         (pipeline_load_id, tenant_id, payer_credit_level_at_decision, carrier_payment_preference,
          float_capacity_available_at_decision, route_selected)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [pipelineLoadId, tenantId, payerCreditLevel, carrierWantsQuickPay ? 'quick_pay' : 'net_30', floatCapacityAvailable, decision.route],
    );

    return NextResponse.json({ financingDecisionId: rows[0].id, ...decision });
  } catch (err) {
    logger.error('[finance/route-decision POST] failed', err);
    return NextResponse.json({ error: 'Failed to compute route decision' }, { status: 500 });
  }
}
```

```typescript
// app/api/finance/float-exposure/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getFloatExposure } from '@/lib/finance/float-governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);
  try {
    const exposure = await getFloatExposure(tenantId);
    return NextResponse.json(exposure);
  } catch (err) {
    logger.error('[finance/float-exposure GET] failed', err);
    return NextResponse.json({ error: 'Failed to load float exposure' }, { status: 500 });
  }
}
```

```typescript
// app/api/finance/factoring/submit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { submitToEcapitalSandbox, recordFactoringSubmission } from '@/lib/finance/adapters/ecapital';
import { syncInvoiceFactoringStatus } from '@/lib/finance/factoring-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  const feePct = Number(body?.feePct);
  if (!Number.isInteger(pipelineLoadId) || !Number.isFinite(feePct)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId or feePct' }, { status: 400 });
  }

  try {
    const result = submitToEcapitalSandbox(feePct);
    const id = await recordFactoringSubmission(pipelineLoadId, result);
    await syncInvoiceFactoringStatus(pipelineLoadId, result.status);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/factoring/submit POST] failed', err);
    return NextResponse.json({ error: 'Failed to submit factoring request' }, { status: 500 });
  }
}
```

```typescript
// app/api/finance/quickpay/disburse/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { disburseQuickPaySandbox, recordQuickPayDisbursement } from '@/lib/finance/adapters/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  const carrierRegistryId = Number(body?.carrierRegistryId);
  const amount = Number(body?.amount);
  const discountPct = Number(body?.discountPct);
  if (![pipelineLoadId, carrierRegistryId, amount, discountPct].every(Number.isFinite)) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  try {
    const result = disburseQuickPaySandbox(amount, discountPct);
    const id = await recordQuickPayDisbursement(pipelineLoadId, carrierRegistryId, amount, result);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/quickpay/disburse POST] failed', err);
    return NextResponse.json({ error: 'Failed to disburse quick pay' }, { status: 500 });
  }
}
```

```typescript
// app/api/finance/kyc/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { verifyKycSandbox, recordKycVerification } from '@/lib/finance/adapters/persona';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const entityType = body?.entityType;
  const entityId = Number(body?.entityId);
  if ((entityType !== 'carrier' && entityType !== 'payer') || !Number.isInteger(entityId)) {
    return NextResponse.json({ error: 'Invalid entityType or entityId' }, { status: 400 });
  }

  try {
    const result = verifyKycSandbox();
    const id = await recordKycVerification(entityType, entityId, result);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/kyc/verify POST] failed', err);
    return NextResponse.json({ error: 'Failed to verify KYC' }, { status: 500 });
  }
}
```

```typescript
// app/api/finance/treasury-report/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getTreasuryReport } from '@/lib/finance/treasury-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);
  try {
    const report = await getTreasuryReport(tenantId);
    return NextResponse.json(report);
  } catch (err) {
    logger.error('[finance/treasury-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute treasury report' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/finance/t27-api.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/finance __tests__/finance/t27-api.test.ts
git commit -m "feat(T-27): add 6 finance orchestration API routes"
```

---

### Task 10: Full regression pass, production apply, completion tracker, push

**Files:**
- Modify: `Engine 3/docs/superpowers/plans/completion.md`

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: all tests pass, including every pre-existing T-16/T-23–T-26 suite — zero regressions (criterion 7).

- [ ] **Step 2: Run the TypeScript compiler**

Run (background): `pnpm tsc --noEmit -p tsconfig.json`
Expected: no new errors versus the pre-T-27 baseline (check any pre-existing errors against `git log` on the affected file before assuming a T-27 regression).

- [ ] **Step 3: Read the tail of the completion tracker to match its existing format exactly**

Read `Engine 3/docs/superpowers/plans/completion.md`'s T-26 entry (and the summary table it's part of) to copy its exact heading structure, field names, and tone before writing T-27's entry — do not invent a new format.

- [ ] **Step 4: Append the T-27 entry**

Add a section following the same structure as the T-26 entry, stating explicitly:
- Migration 057 applied (once production apply is confirmed in Step 6) — `tenant_policies.treasury_policy`, `carrier_registry.payment_preference` (schema-reality addition, spec assumed `carriers.payment_preference`), `financing_decisions` (tenant_id corrected to `fn_myra_tenant_id()`, `route_selected` widened to VARCHAR(10)), `v_float_exposure`, `factoring_submissions`, `quick_pay_disbursements`, `kyc_verifications`.
- Criteria 2, 3, 4, 5, 7: PASS, each with the specific test file/count backing it.
- **Criteria 1 and 6: OPEN.** State plainly that Pilot 1's Financial Architecture document (§6, containing the $12.00/$3.81/$91.28/self-funding worked example) does not exist anywhere in this repository — searched `Engine 2/`, `Engine 3/`, all root `.docx` files — and that this was a deliberate, user-confirmed scope decision, not an oversight. `lib/finance/capital-days.ts` implements a placeholder formula tested only for internal consistency.
- The `carrier_registry.payment_preference` and `financing_decisions.tenant_id`/`route_selected` schema-reality findings, in the same terse style as prior entries.

- [ ] **Step 5: Commit the tracker update**

```bash
git add "../Engine 3/docs/superpowers/plans/completion.md"
git commit -m "docs(T-27): completion tracker entry — criteria 2/3/4/5/7 pass, 1/6 OPEN pending Pilot 1 document"
```

- [ ] **Step 6: Ask the user, separately, before each remaining step**

Ask explicit confirmation (two separate questions, not bundled) before:
1. Applying migration 057 to the production Neon branch (statement-by-statement, same as Task 1's branch verification, then re-verify with the same `SELECT` queries directly against production).
2. Pushing the commits to `origin/master`.

Delete the `t27-verify` Neon branch (with confirmation) once production apply is confirmed clean, following the same cleanup pattern as prior modules.

---

## Self-Review Notes

- **Spec coverage:** §4.1 → Task 1. §4.2 (corrected) → Task 1. §4.3 → Task 1. §4.4 → Task 1. §5 → Task 2. §6 (6 endpoints) → Task 9. §7 criteria: 1/6 → Task 5/8 (explicitly OPEN, not attempted), 2 → Task 2, 3 → Task 4, 4 → Task 6, 5 → Task 7, 7 → Task 10. §8 gate confirmation and §10 sandbox-only constraint → Global Constraints + Task 6/10.
- **Placeholder scan:** no TBD/TODO; every step has runnable code. The one deliberately "placeholder" piece (capital-days formula) is a real, tested implementation — just honestly labeled as unverified against the missing source document, which is the point of this plan, not a gap in it.
- **Type consistency:** `PayerCreditLevel`/`Route`/`RouteDecisionInput`/`RouteDecisionResult` (Task 2) reused verbatim in Task 3 and Task 9. `FloatExposure` (Task 4) reused in Task 9. `FactoringSubmissionResult`/`QuickPayDisbursementResult`/`KycVerificationResult` (Task 6) reused in Task 9. `TreasuryReport` (Task 8) reused in Task 9.
