# T-28 Customer OS & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant self-serve onboarding session flow (sign-up → provisioned tenant → dry-run → human-approved go-live), reusing the existing super-admin tenant-provisioning system instead of duplicating it, and closing the one real gap that system has today: new tenants never get a T-19 governance policy.

**Architecture:** A new `tenant_onboarding_sessions` table drives a staged flow. A new shared library (`lib/tenants/provision.ts`) extracts tenant-creation/config-clone/owner-seat logic out of the two existing `app/api/admin/tenants/**` routes (refactored to call it, behavior-preserving) and adds the two genuinely new pieces those routes never had: applying a `tenant_type_policy_templates` row as `tenant_policies`, and capturing billing intent into the existing `tenant_subscriptions` table. A session-orchestration layer (`lib/tenants/onboarding-session.ts`) sequences these calls, runs a side-effect-free dry-run against T-19/T-21/T-23, and routes the go-live request through T-24's existing exception console (one new classification-rule seed row + one `SourceSignal` union member + one additive branch in the existing exception-resolution route).

**Tech Stack:** Next.js 16 App Router API routes, TypeScript, Zod validation, `pg` `Pool`/`PoolClient` (`lib/db/tenant-context.ts`) for the admin-tenant subsystem, Neon serverless `db.query()` (`lib/pipeline/db-adapter`) for Engine 3 governance/exceptions code, Vitest.

**Spec:** [T28_Customer_OS_Onboarding.md](../../../../Engine%203/T28_Customer_OS_Onboarding.md), design doc [2026-08-30-t28-customer-os-onboarding-design.md](../specs/2026-08-30-t28-customer-os-onboarding-design.md) — **read the design doc before starting any task.** It documents why the spec's own §4.2 pseudocode (`createTenant()` calling "T-19's existing `POST /api/tenants`") does not match reality, and what actually exists instead.

## Global Constraints

- Do not touch `shippers`, `carriers`, the `/get-started` marketing form, or the carrier recruitment Retell config, in any task (spec §2, criterion 2 exists specifically to prove this in code).
- Do not build a new go-live approval UI — go-live requests route through T-24's existing Alert Center only (spec §4.4).
- Every new/changed API route that touches tenant data is `requireSuperAdmin`-gated, same trust boundary as the existing `app/api/admin/tenants/**` routes (design doc §3.4 — v1 is Patrice-operated on behalf of a prospect, not public self-serve).
- The two existing `app/api/admin/tenants/route.ts` / `[id]/onboard/route.ts` routes' external request/response contracts must not change — only their internals move into `lib/tenants/provision.ts`.
- No production apply in this plan's tasks — migration `058` is verified on a disposable Neon branch only; production apply is a separate, explicitly-confirmed step after the full plan is reviewed, per every prior Engine 3 module's standing discipline.

---

## Task 1: Migration `058-t28-customer-os-onboarding.sql`

**Files:**
- Create: `scripts/058-t28-customer-os-onboarding.sql`
- Test: `__tests__/tenants/t28-schema.test.ts`

**Interfaces:**
- Produces: `tenant_onboarding_sessions` table (columns: `id`, `tenant_id`, `current_step`, `step_data`, `status`, `started_at`, `completed_at`), one new row in `exception_classification_rules` for `source_module='tenant_onboarding'`.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- 058: T-28 Customer OS & Onboarding
-- ============================================================================
-- tenant_onboarding_sessions tracks a prospective tenant through the staged
-- signup flow. tenant_id is NULL until the 'company_created' step provisions
-- the real tenants row (design doc §3.3).
--
-- Also seeds one exception_classification_rules row for source_module=
-- 'tenant_onboarding' — without it, bridgeToExceptions() silently no-ops
-- for every go-live request (design doc finding #5; same mechanism T-18's
-- authority_shadow sourceModule uses to be deliberately suppressed).
--
-- Idempotent: yes. Rollback: 058-t28-customer-os-onboarding_rollback.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_onboarding_sessions (
    id                 SERIAL PRIMARY KEY,
    tenant_id          INTEGER REFERENCES tenants(id),

    current_step       VARCHAR(30) NOT NULL DEFAULT 'sign_up'
                        CHECK (current_step IN (
                            'sign_up', 'company_created', 'users_created', 'billing_captured',
                            'load_sources_selected', 'policy_confirmed', 'agents_configured',
                            'tested', 'go_live_requested', 'live'
                        )),

    step_data           JSONB NOT NULL DEFAULT '{}',
    status               VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                         CHECK (status IN ('in_progress', 'completed', 'abandoned')),

    started_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at                TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_onboarding_sessions_tenant ON tenant_onboarding_sessions(tenant_id) WHERE tenant_id IS NOT NULL;

INSERT INTO exception_classification_rules (source_module, condition_type, condition_value, severity, suggested_action, sla_minutes)
SELECT 'tenant_onboarding', 'always', NULL, 'medium', 'Review onboarding session and approve or reject go-live', 1440
WHERE NOT EXISTS (
    SELECT 1 FROM exception_classification_rules WHERE source_module = 'tenant_onboarding'
);

COMMIT;
```

- [ ] **Step 2: Check the real `exception_classification_rules` column shape before running this**

Run: read `scripts/054-t24-exception-classification-rules.sql` and `scripts/055-t25-risk-fraud-scoring.sql`'s seed INSERT statements directly — confirm the exact column list and any `condition_type`/`condition_value` vocabulary those two modules already established (e.g. whether `'always'` or a different sentinel is the existing convention for "always fires regardless of context", and whether `condition_value` is `NULL`-able or requires a JSON default like `'{}'`). Adjust the `INSERT` above to match exactly — do not guess a new vocabulary when T-24/T-25 already picked one.

- [ ] **Step 3: Apply to a disposable Neon branch**

Run: create branch `t28-verify` off production (same precedent as `t20-t21-verify`/`t23-verify`), apply `058-t28-customer-os-onboarding.sql`, confirm both objects exist:
```sql
SELECT * FROM tenant_onboarding_sessions LIMIT 1;
SELECT * FROM exception_classification_rules WHERE source_module = 'tenant_onboarding';
```
Expected: table exists (0 rows), exactly 1 classification-rule row.

- [ ] **Step 4: Write the schema test**

```typescript
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('T-28 schema', () => {
  it('tenant_onboarding_sessions accepts a minimal insert and defaults correctly', async () => {
    const { rows } = await db.query<{
      id: number; current_step: string; status: string; step_data: object;
    }>(`INSERT INTO tenant_onboarding_sessions DEFAULT VALUES RETURNING id, current_step, status, step_data`);
    expect(rows[0].current_step).toBe('sign_up');
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].step_data).toEqual({});
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [rows[0].id]);
  });

  it('rejects an invalid current_step', async () => {
    await expect(
      db.query(`INSERT INTO tenant_onboarding_sessions (current_step) VALUES ('not_a_real_step')`),
    ).rejects.toThrow();
  });

  it('seeded exactly one tenant_onboarding classification rule', async () => {
    const { rows } = await db.query<{ severity: string }>(
      `SELECT severity FROM exception_classification_rules WHERE source_module = 'tenant_onboarding'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('medium');
  });
});
```

- [ ] **Step 5: Run against `t28-verify` and confirm passing**

Run: `pnpm vitest run __tests__/tenants/t28-schema.test.ts` (pointed at `t28-verify` via `DATABASE_URL`)
Expected: 3/3 PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/058-t28-customer-os-onboarding.sql __tests__/tenants/t28-schema.test.ts
git commit -m "feat(T-28): add tenant_onboarding_sessions schema + go-live classification rule"
```

---

## Task 2: `lib/tenants/provision.ts` — shared provisioning functions

**Files:**
- Create: `lib/tenants/provision.ts`
- Test: `lib/tenants/__tests__/provision.test.ts`

**Interfaces:**
- Consumes: `tenant_type_policy_templates`/`tenant_policies` (migration `035`), `tenant_config`/`tenant_subscriptions`/`tenant_users` (migration `027`), `DEFAULT_TENANT_CONFIG` (`lib/tenants/defaults.ts`), `assertValidTenantSlug` (`lib/tenants/validators.ts`).
- Produces (consumed by Task 3 and Task 4):
  - `type Queryable = { query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }> }`
  - `createTenantRow(q: Queryable, input: { slug: string; name: string; type: 'operating_company'|'saas_customer'|'internal'; freightBusinessType?: 'broker'|'dispatcher'|'carrier'|'acquired_opco'|null; parentTenantId?: number|null; billingEmail?: string|null; status?: string }): Promise<{ tenantId: number; createdAt: string }>`
  - `cloneDefaultTenantConfig(q: Queryable, tenantId: number): Promise<{ configRowsAdded: number }>`
  - `seatTenantOwner(q: Queryable, tenantId: number, userId: string): Promise<{ ownerSeated: boolean }>`
  - `applyTenantTypePolicyTemplate(q: Queryable, tenantId: number, freightBusinessType: 'broker'|'dispatcher'|'carrier'): Promise<{ policyId: number }>` — throws on `'acquired_opco'` (unresolved `'inherit'` semantics, never built anywhere in this codebase; out of scope, matching criterion 1's fixture list of Broker/Dispatcher/Carrier only).
  - `captureBillingIntent(q: Queryable, tenantId: number, tier: 'starter'|'pro'|'enterprise'): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import {
  createTenantRow, cloneDefaultTenantConfig, seatTenantOwner,
  applyTenantTypePolicyTemplate, captureBillingIntent,
} from '../provision';

const createdTenantIds: number[] = [];

afterEach(async () => {
  for (const id of createdTenantIds.splice(0)) {
    await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
});

describe('lib/tenants/provision', () => {
  it('createTenantRow inserts a tenant with both type axes set', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Test Co',
      type: 'saas_customer', freightBusinessType: 'broker',
    });
    createdTenantIds.push(tenantId);
    const { rows } = await db.query<{ type: string; freight_business_type: string }>(
      `SELECT type, freight_business_type FROM tenants WHERE id = $1`, [tenantId],
    );
    expect(rows[0].type).toBe('saas_customer');
    expect(rows[0].freight_business_type).toBe('broker');
  });

  it('cloneDefaultTenantConfig is idempotent — second call adds zero rows', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Test Co 2', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    const first = await cloneDefaultTenantConfig(db, tenantId);
    const second = await cloneDefaultTenantConfig(db, tenantId);
    expect(first.configRowsAdded).toBeGreaterThan(0);
    expect(second.configRowsAdded).toBe(0);
  });

  it('applyTenantTypePolicyTemplate maps dispatch_agent_default correctly per type', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Carrier Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    await applyTenantTypePolicyTemplate(db, tenantId, 'carrier');
    const { rows } = await db.query<{ dispatch_agent_enabled: boolean; load_source_policy: string }>(
      `SELECT dispatch_agent_enabled, load_source_policy FROM tenant_policies WHERE tenant_id = $1 AND is_active = true`,
      [tenantId],
    );
    expect(rows[0].dispatch_agent_enabled).toBe(false); // 'opt_in' template maps to false-by-default
    expect(rows[0].load_source_policy).toBe('any');
  });

  it('applyTenantTypePolicyTemplate rejects acquired_opco — inherit semantics are unresolved', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Opco', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    // @ts-expect-error — acquired_opco is intentionally not in the accepted type union
    await expect(applyTenantTypePolicyTemplate(db, tenantId, 'acquired_opco')).rejects.toThrow(/inherit/i);
  });

  it('captureBillingIntent upserts tenant_subscriptions.tier without touching billing_provider', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Billing Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    await captureBillingIntent(db, tenantId, 'pro');
    const { rows } = await db.query<{ tier: string; billing_provider: string | null }>(
      `SELECT tier, billing_provider FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId],
    );
    expect(rows[0].tier).toBe('pro');
    expect(rows[0].billing_provider).toBeNull();
  });

  it('seatTenantOwner clears is_primary on the user\'s other tenants before setting the new one', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Owner Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    const { rows: users } = await db.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const userId = users[0].id;
    const { ownerSeated } = await seatTenantOwner(db, tenantId, userId);
    expect(ownerSeated).toBe(true);
    const { rows: primaryRows } = await db.query<{ tenant_id: number }>(
      `SELECT tenant_id FROM tenant_users WHERE user_id = $1 AND is_primary = true`, [userId],
    );
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0].tenant_id).toBe(tenantId);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/tenants/__tests__/provision.test.ts`
Expected: FAIL — `Cannot find module '../provision'`

- [ ] **Step 3: Implement**

```typescript
// lib/tenants/provision.ts
//
// Shared tenant-provisioning functions. Extracted so app/api/admin/tenants/
// route.ts and .../[id]/onboard/route.ts (the existing, already-shipped
// super-admin tenant tooling) and T-28's new self-serve session flow call
// the SAME code — see design doc §1/§3.2 for why this extraction exists
// instead of two independent implementations.

import { DEFAULT_TENANT_CONFIG } from './defaults';
import { assertValidTenantSlug } from './validators';

export type Queryable = {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface CreateTenantInput {
  slug: string;
  name: string;
  type: 'operating_company' | 'saas_customer' | 'internal';
  freightBusinessType?: 'broker' | 'dispatcher' | 'carrier' | 'acquired_opco' | null;
  parentTenantId?: number | null;
  billingEmail?: string | null;
  status?: string;
}

export async function createTenantRow(
  q: Queryable,
  input: CreateTenantInput,
): Promise<{ tenantId: number; createdAt: string }> {
  const slug = input.slug.trim().toLowerCase();
  assertValidTenantSlug(slug);

  const { rows: existing } = await q.query<{ id: number }>(
    `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (existing.length > 0) {
    throw new Error(`Tenant slug '${slug}' already exists`);
  }

  const { rows } = await q.query<{ id: number; created_at: string }>(
    `INSERT INTO tenants (slug, name, type, freight_business_type, parent_tenant_id, billing_email, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      slug, input.name, input.type, input.freightBusinessType ?? null,
      input.parentTenantId ?? null, input.billingEmail ?? null, input.status ?? 'trial',
    ],
  );
  return { tenantId: rows[0].id, createdAt: rows[0].created_at };
}

export async function cloneDefaultTenantConfig(
  q: Queryable,
  tenantId: number,
): Promise<{ configRowsAdded: number }> {
  const { rows: existingConfig } = await q.query<{ key: string }>(
    `SELECT key FROM tenant_config WHERE tenant_id = $1`,
    [tenantId],
  );
  const existingKeys = new Set(existingConfig.map((r) => r.key));

  let configRowsAdded = 0;
  for (const def of DEFAULT_TENANT_CONFIG) {
    if (existingKeys.has(def.key)) continue;
    await q.query(
      `INSERT INTO tenant_config (tenant_id, key, value, encrypted, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [tenantId, def.key, JSON.stringify(def.value), def.encrypted, 'system:t28-provision'],
    );
    configRowsAdded++;
  }
  return { configRowsAdded };
}

export async function seatTenantOwner(
  q: Queryable,
  tenantId: number,
  userId: string,
): Promise<{ ownerSeated: boolean }> {
  const { rows: existingMembership } = await q.query(
    `SELECT user_id FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
    [tenantId, userId],
  );
  if (existingMembership.length > 0) {
    return { ownerSeated: false };
  }
  await q.query(
    `UPDATE tenant_users SET is_primary = false WHERE user_id = $1 AND is_primary = true`,
    [userId],
  );
  await q.query(
    `INSERT INTO tenant_users (tenant_id, user_id, role, is_primary, joined_at)
     VALUES ($1, $2, 'owner', true, NOW())`,
    [tenantId, userId],
  );
  return { ownerSeated: true };
}

/** Maps a template's dispatch_agent_default vocabulary onto tenant_policies'
 *  boolean column. 'on' -> true, 'opt_in' -> false (off by default, tenant
 *  can enable later), 'inherit' has no defined resolution anywhere in this
 *  codebase (T-19 never built it either) -- rejected outright rather than
 *  guessed. */
export async function applyTenantTypePolicyTemplate(
  q: Queryable,
  tenantId: number,
  freightBusinessType: 'broker' | 'dispatcher' | 'carrier',
): Promise<{ policyId: number }> {
  if ((freightBusinessType as string) === 'acquired_opco') {
    throw new Error(
      "applyTenantTypePolicyTemplate: 'acquired_opco' uses 'inherit' semantics that are not resolved anywhere in this codebase — pass the acquired entity's actual broker/dispatcher/carrier type instead.",
    );
  }
  const { rows: templateRows } = await q.query<{
    load_source_policy: string; dispatch_agent_default: string; negotiation_directions: string;
  }>(
    `SELECT load_source_policy, dispatch_agent_default, negotiation_directions
       FROM tenant_type_policy_templates WHERE freight_business_type = $1`,
    [freightBusinessType],
  );
  if (templateRows.length === 0) {
    throw new Error(`No tenant_type_policy_templates row for freight_business_type='${freightBusinessType}'`);
  }
  const template = templateRows[0];
  const dispatchAgentEnabled = template.dispatch_agent_default === 'on';

  await q.query(`UPDATE tenants SET freight_business_type = $1 WHERE id = $2`, [freightBusinessType, tenantId]);

  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO tenant_policies (tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions, created_by)
     VALUES ($1, 1, $2, $3, $4, 'system:t28-provision')
     RETURNING id`,
    [tenantId, template.load_source_policy, dispatchAgentEnabled, template.negotiation_directions],
  );
  return { policyId: rows[0].id };
}

export async function captureBillingIntent(
  q: Queryable,
  tenantId: number,
  tier: 'starter' | 'pro' | 'enterprise',
): Promise<void> {
  await q.query(
    `INSERT INTO tenant_subscriptions (tenant_id, tier, status)
     VALUES ($1, $2, 'trial')
     ON CONFLICT (tenant_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = NOW()`,
    [tenantId, tier],
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/tenants/__tests__/provision.test.ts`
Expected: 6/6 PASS. If `freight_business_type` column doesn't accept the insert in `createTenantRow`, confirm migration `035` (which adds that column) is applied on the same branch/database this test runs against.

- [ ] **Step 5: Commit**

```bash
git add lib/tenants/provision.ts lib/tenants/__tests__/provision.test.ts
git commit -m "feat(T-28): add shared tenant-provisioning functions (create/config/owner/policy/billing)"
```

---

## Task 3: Refactor the two existing admin routes to call the shared functions

**Files:**
- Modify: `app/api/admin/tenants/route.ts`
- Modify: `app/api/admin/tenants/[id]/onboard/route.ts`
- Test: existing tests for these routes if present; otherwise add `app/api/admin/tenants/__tests__/route.test.ts` asserting response shape.

**Interfaces:**
- Consumes: `createTenantRow`, `cloneDefaultTenantConfig`, `seatTenantOwner` from Task 2.

- [ ] **Step 1: Confirm current behavior with a request/response snapshot test (if no test exists yet)**

```typescript
// app/api/admin/tenants/__tests__/route.test.ts
import { describe, it, expect } from 'vitest';
import { POST } from '../route';
import { NextRequest } from 'next/server';

describe('POST /api/admin/tenants (pre-refactor baseline)', () => {
  it('creates a tenant and returns the same response shape as today', async () => {
    // NOTE: this test requires a super-admin session cookie/mock matching
    // this route's existing auth pattern (requireSuperAdmin). Wire it the
    // same way other admin-route tests in this repo already do -- check
    // __tests__/governance/api.test.ts's mock-session helper and reuse it,
    // don't invent a second one.
    const slug = `t28-refactor-check-${Date.now()}`;
    const req = new NextRequest('http://localhost/api/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({ slug, name: 'Refactor Check Co', type: 'saas_customer' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.tenant.slug).toBe(slug);
    expect(body.onboardUrl).toBe(`/api/admin/tenants/${body.tenant.id}/onboard`);
  });
});
```

- [ ] **Step 2: Run to verify it currently passes against the un-refactored route**

Run: `pnpm vitest run app/api/admin/tenants/__tests__/route.test.ts`
Expected: PASS (this is the baseline — refactor must not change this).

- [ ] **Step 3: Refactor `POST /api/admin/tenants` to call `createTenantRow`**

Replace the inline `INSERT INTO tenants ...` block in `app/api/admin/tenants/route.ts` with a call to the shared function, keeping the slug-conflict 409 response and the `tenant_audit_log` insert exactly as they are today:

```typescript
import { createTenantRow } from '@/lib/tenants/provision';
// ... existing imports stay

// Inside the asServiceAdmin callback, replace the manual slug-uniqueness
// check + INSERT with:
let tenantId: number;
let createdAt: string;
try {
  const result = await createTenantRow(client, {
    slug, name: body.name, type: body.type,
    parentTenantId: body.parentTenantId ?? null,
    billingEmail: body.billingEmail ?? null,
    status: body.status,
  });
  tenantId = result.tenantId;
  createdAt = result.createdAt;
} catch (err) {
  if (err instanceof Error && err.message.includes('already exists')) {
    return { conflict: true as const };
  }
  throw err;
}
// ... rest of the audit-log insert + return unchanged
```

- [ ] **Step 4: Refactor `POST /api/admin/tenants/[id]/onboard` to call `cloneDefaultTenantConfig` and `seatTenantOwner`**

Replace the manual clone-loop (`for (const def of DEFAULT_TENANT_CONFIG) { ... }`) with `const { configRowsAdded } = await cloneDefaultTenantConfig(client, tenantId);`, and replace the manual owner-seat block with `const { ownerSeated } = await seatTenantOwner(client, tenantId, body.ownerUserId);`. Keep the `configOverrides` upsert loop, the `primary_admin_user_id`/status-flip `UPDATE`, and the audit-log insert exactly as they are today — those are not part of what Task 2 extracted.

- [ ] **Step 5: Run the baseline test again to confirm zero behavior change**

Run: `pnpm vitest run app/api/admin/tenants/__tests__/route.test.ts`
Expected: still PASS, identical assertions, now exercising the refactored code path.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/tenants/route.ts app/api/admin/tenants/[id]/onboard/route.ts app/api/admin/tenants/__tests__/route.test.ts
git commit -m "refactor(T-28): route existing admin tenant creation/onboard through shared provision.ts"
```

---

## Task 4: `lib/tenants/onboarding-session.ts` — session state machine

**Files:**
- Create: `lib/tenants/onboarding-session.ts`
- Test: `lib/tenants/__tests__/onboarding-session.test.ts`

**Interfaces:**
- Consumes: `createTenantRow`, `applyTenantTypePolicyTemplate`, `captureBillingIntent`, `seatTenantOwner` (Task 2); `db` from `lib/pipeline/db-adapter`.
- Produces (consumed by Task 8's API routes):
  - `startSession(): Promise<{ sessionId: number }>`
  - `advanceSession(sessionId: number, step: OnboardingStep, stepData: Record<string, unknown>): Promise<SessionRow>`
  - `provisionTenantFromSession(sessionId: number): Promise<{ tenantId: number }>` — reads `step_data.company_created`, calls `createTenantRow`, stamps `tenant_onboarding_sessions.tenant_id`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { startSession, advanceSession, provisionTenantFromSession } from '../onboarding-session';

const createdTenantIds: number[] = [];
const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [id]);
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
});

describe('lib/tenants/onboarding-session', () => {
  it('starts a session at sign_up with an empty step_data', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const { rows } = await db.query(`SELECT current_step, step_data FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].current_step).toBe('sign_up');
  });

  it('advanceSession merges step_data and moves current_step forward', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const row = await advanceSession(sessionId, 'company_created', {
      companyName: 'Advance Test Co', slug: `t28-advance-${Date.now()}`, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    expect(row.current_step).toBe('company_created');
    expect((row.step_data as any).company_created.companyName).toBe('Advance Test Co');
  });

  it('provisionTenantFromSession creates the tenant and stamps tenant_id on the session', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const slug = `t28-provision-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Provision Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const { tenantId } = await provisionTenantFromSession(sessionId);
    createdTenantIds.push(tenantId);
    const { rows } = await db.query<{ tenant_id: number }>(`SELECT tenant_id FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].tenant_id).toBe(tenantId);
  });

  it('provisionTenantFromSession throws if company_created step data is missing', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    await expect(provisionTenantFromSession(sessionId)).rejects.toThrow(/company_created/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// lib/tenants/onboarding-session.ts
import { db } from '@/lib/pipeline/db-adapter';
import { createTenantRow } from './provision';

export type OnboardingStep =
  | 'sign_up' | 'company_created' | 'users_created' | 'billing_captured'
  | 'load_sources_selected' | 'policy_confirmed' | 'agents_configured'
  | 'tested' | 'go_live_requested' | 'live';

export interface SessionRow {
  id: number;
  tenant_id: number | null;
  current_step: OnboardingStep;
  step_data: Record<string, any>;
  status: 'in_progress' | 'completed' | 'abandoned';
}

export async function startSession(): Promise<{ sessionId: number }> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO tenant_onboarding_sessions DEFAULT VALUES RETURNING id`,
  );
  return { sessionId: rows[0].id };
}

export async function advanceSession(
  sessionId: number,
  step: OnboardingStep,
  stepData: Record<string, unknown>,
): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `UPDATE tenant_onboarding_sessions
        SET current_step = $2,
            step_data = jsonb_set(step_data, ARRAY[$2], $3::jsonb, true)
      WHERE id = $1
      RETURNING id, tenant_id, current_step, step_data, status`,
    [sessionId, step, JSON.stringify(stepData)],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  return rows[0];
}

export async function provisionTenantFromSession(sessionId: number): Promise<{ tenantId: number }> {
  const { rows } = await db.query<{ step_data: Record<string, any> }>(
    `SELECT step_data FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  const companyData = rows[0].step_data.company_created;
  if (!companyData) {
    throw new Error(`provisionTenantFromSession: session ${sessionId} has no 'company_created' step data yet`);
  }
  const { tenantId } = await createTenantRow(db, {
    slug: companyData.slug,
    name: companyData.companyName,
    type: 'saas_customer',
    freightBusinessType: companyData.freightBusinessType ?? null,
    status: 'trial',
  });
  await db.query(`UPDATE tenant_onboarding_sessions SET tenant_id = $1 WHERE id = $2`, [tenantId, sessionId]);
  return { tenantId };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/tenants/onboarding-session.ts lib/tenants/__tests__/onboarding-session.test.ts
git commit -m "feat(T-28): add onboarding session state machine + tenant provisioning trigger"
```

---

## Task 5: Dry-run against synthetic loads (spec §4.3, criterion 3)

**Files:**
- Modify: `lib/tenants/onboarding-session.ts` (add `runDryRun`)
- Test: `lib/tenants/__tests__/onboarding-session.test.ts` (extend)

**Interfaces:**
- Consumes: `evaluatePolicy` (`lib/governance/evaluate-policy-db.ts`), `resolveDispatchRouting` (`lib/dispatch/routing.ts`), `quotePricing` (`lib/pricing/pricing-engine.ts`).
- Produces: `runDryRun(sessionId: number): Promise<{ policyOk: boolean; dispatchMode: string; pricingOk: boolean }>`

- [ ] **Step 1: Write the failing test**

```typescript
it('runDryRun exercises policy/dispatch/pricing against a synthetic load with zero pipeline_loads writes', async () => {
  const { sessionId } = await startSession();
  createdSessionIds.push(sessionId);
  const slug = `t28-dryrun-${Date.now()}`;
  await advanceSession(sessionId, 'company_created', {
    companyName: 'Dry Run Co', slug, tenantType: 'saas_customer', freightBusinessType: 'carrier',
  });
  const { tenantId } = await provisionTenantFromSession(sessionId);
  createdTenantIds.push(tenantId);
  await applyTenantTypePolicyTemplate(db, tenantId, 'carrier');

  const { rows: beforeCount } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM pipeline_loads`);

  const result = await runDryRun(sessionId);
  expect(result.policyOk).toBe(true);
  expect(typeof result.dispatchMode).toBe('string');
  expect(typeof result.pricingOk).toBe('boolean');

  const { rows: afterCount } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM pipeline_loads`);
  expect(afterCount[0].count).toBe(beforeCount[0].count);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: FAIL — `runDryRun is not a function`

- [ ] **Step 3: Implement — add to `lib/tenants/onboarding-session.ts`**

```typescript
import { evaluatePolicy } from '@/lib/governance/evaluate-policy-db';
import { resolveDispatchRouting } from '@/lib/dispatch/routing';
import { quotePricing } from '@/lib/pricing/pricing-engine';

/** A synthetic fixture load — never written to pipeline_loads. Shape matches
 *  what evaluatePolicy/quotePricing already expect from real pipeline rows,
 *  trimmed to the fields those two functions actually read. */
function syntheticFixtureLoad() {
  return {
    originCity: 'Toronto', originState: 'ON', originCountry: 'CA',
    destinationCity: 'Montreal', destinationState: 'QC', destinationCountry: 'CA',
    equipmentType: 'Dry Van', postedRate: null,
  };
}

export async function runDryRun(sessionId: number): Promise<{ policyOk: boolean; dispatchMode: string; pricingOk: boolean }> {
  const { rows } = await db.query<{ tenant_id: number | null }>(
    `SELECT tenant_id FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  const tenantId = rows[0].tenant_id;
  if (tenantId === null) {
    throw new Error(`runDryRun: session ${sessionId} has no provisioned tenant yet — call provisionTenantFromSession first`);
  }

  const policyResult = await evaluatePolicy({
    tenantId, load: syntheticFixtureLoad() as any, pipelineLoadId: null, sourceEventId: null, correlationId: `t28-dryrun-${sessionId}`,
  });
  const dispatchResult = await resolveDispatchRouting(tenantId);
  const pricingResult = await quotePricing({ tenantId, load: syntheticFixtureLoad() as any });

  await advanceSession(sessionId, 'tested', {
    policyOk: policyResult.allowed, dispatchMode: dispatchResult.mode, pricingOk: pricingResult != null,
  });

  return { policyOk: policyResult.allowed, dispatchMode: dispatchResult.mode, pricingOk: pricingResult != null };
}
```

**Note for the implementer:** `evaluatePolicy`'s exact input shape (`PolicyEvaluationInput`) and return field name for "allowed" must be confirmed against `lib/governance/policy-types.ts` before finalizing this — the field above is written as `.allowed` based on the pattern other T-19 consumers use, but verify against the actual type definition rather than assuming. Same for `quotePricing`'s `PricingQuoteRequest`/`PricingQuoteResult` shape (`lib/pricing/pricing-engine.ts` top of file) — confirm the exact field names for `load` before compiling.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/tenants/onboarding-session.ts lib/tenants/__tests__/onboarding-session.test.ts
git commit -m "feat(T-28): add dry-run step exercising T-19/T-21/T-23 against a synthetic load"
```

---

## Task 6: Go-live bridge — `SourceSignal` widening + `requestGoLive`

**Files:**
- Modify: `lib/exceptions/bridge.ts` (one line — `SourceSignal.sourceModule` union)
- Modify: `lib/tenants/onboarding-session.ts` (add `requestGoLive`)
- Test: `lib/tenants/__tests__/onboarding-session.test.ts` (extend)

**Interfaces:**
- Consumes: `bridgeToExceptions` (`lib/exceptions/bridge.ts`).
- Produces: `requestGoLive(sessionId: number): Promise<{ bridged: boolean }>`

- [ ] **Step 1: Write the failing test**

```typescript
it('requestGoLive bridges into the existing exceptions table with source_module=tenant_onboarding', async () => {
  const { sessionId } = await startSession();
  createdSessionIds.push(sessionId);
  const slug = `t28-golive-${Date.now()}`;
  await advanceSession(sessionId, 'company_created', {
    companyName: 'Go Live Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
  });
  const { tenantId } = await provisionTenantFromSession(sessionId);
  createdTenantIds.push(tenantId);

  const result = await requestGoLive(sessionId);
  expect(result.bridged).toBe(true);

  const { rows } = await db.query<{ type: string; source_module: string; tenant_id: number }>(
    `SELECT type, source_module, tenant_id FROM exceptions WHERE source_module = 'tenant_onboarding' AND tenant_id = $1`,
    [tenantId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe('go_live_requested');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: FAIL (both because `requestGoLive` doesn't exist, and because `SourceSignal.sourceModule` doesn't accept `'tenant_onboarding'` yet — TypeScript compile error, not just a runtime one).

- [ ] **Step 3: Widen `SourceSignal.sourceModule` in `lib/exceptions/bridge.ts`**

```typescript
export interface SourceSignal {
  tenantId: number;
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt' // T-25 extension
    | 'document_terms_mismatch' // T-26 extension
    | 'tenant_onboarding'; // T-28 extension — no other line in this file changes
  // ... rest unchanged
```

- [ ] **Step 4: Implement `requestGoLive` in `lib/tenants/onboarding-session.ts`**

```typescript
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

export async function requestGoLive(sessionId: number): Promise<{ bridged: boolean }> {
  const { rows } = await db.query<{ tenant_id: number | null; step_data: Record<string, any> }>(
    `SELECT tenant_id, step_data FROM tenant_onboarding_sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`No tenant_onboarding_sessions row with id=${sessionId}`);
  const tenantId = rows[0].tenant_id;
  if (tenantId === null) {
    throw new Error(`requestGoLive: session ${sessionId} has no provisioned tenant yet`);
  }
  const companyName = rows[0].step_data.company_created?.companyName ?? `tenant ${tenantId}`;

  const bridged = await bridgeToExceptions({
    tenantId,
    sourceModule: 'tenant_onboarding',
    exceptionType: 'go_live_requested',
    title: `${companyName} has completed onboarding and is requesting go-live`,
    description: `Onboarding session ${sessionId} has completed all steps and is ready for the go-live human review (T-28 spec §3.2).`,
    context: { sessionId },
    pipelineLoadId: null,
    loadId: null,
    carrierId: null,
  });

  await advanceSession(sessionId, 'go_live_requested', { requestedAt: new Date().toISOString() });
  return { bridged };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run lib/tenants/__tests__/onboarding-session.test.ts`
Expected: 6/6 PASS. If `bridged` is `false`, the classification rule from Task 1 is missing or its `condition_type`/`condition_value` doesn't match what `matchClassificationRule` expects — re-check against T-24/T-25's real seed pattern (Task 1 Step 2's note), don't just re-run.

- [ ] **Step 6: Commit**

```bash
git add lib/exceptions/bridge.ts lib/tenants/onboarding-session.ts lib/tenants/__tests__/onboarding-session.test.ts
git commit -m "feat(T-28): route go-live requests through T-24's existing exception console"
```

---

## Task 7: Approval flips tenant status — additive branch in `PATCH /api/exceptions/[id]`

**Files:**
- Modify: `app/api/exceptions/[id]/route.ts`
- Test: `__tests__/exceptions/tenant-onboarding-resolve.test.ts`

**Interfaces:**
- Consumes: nothing new — reads `exceptions.source_module`/`type` already selected by the existing `resolve` action's `UPDATE ... RETURNING *`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { PATCH } from '@/app/api/exceptions/[id]/route';
import { NextRequest } from 'next/server';
import { startSession, advanceSession, provisionTenantFromSession, requestGoLive } from '@/lib/tenants/onboarding-session';

describe('PATCH /api/exceptions/:id resolves a tenant_onboarding go-live request', () => {
  let tenantId: number;
  let sessionId: number;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('flips tenants.status to active and session to live on resolve', async () => {
    const started = await startSession();
    sessionId = started.sessionId;
    const slug = `t28-resolve-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Resolve Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const provisioned = await provisionTenantFromSession(sessionId);
    tenantId = provisioned.tenantId;
    await requestGoLive(sessionId);

    const { rows: excRows } = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE tenant_id = $1 AND source_module = 'tenant_onboarding'`, [tenantId],
    );
    const exceptionId = excRows[0].id;

    // NOTE: wire this request's auth the same way this route's existing
    // tests already mock requireTenantContext/getCurrentUser -- check
    // __tests__/exceptions or __tests__/pipeline for the established helper,
    // don't invent a new one.
    const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
      method: 'PATCH', body: JSON.stringify({ action: 'resolve' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
    expect(res.status).toBe(200);

    const { rows: tenantRows } = await db.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenantRows[0].status).toBe('active');

    const { rows: sessionRows } = await db.query<{ current_step: string; status: string }>(
      `SELECT current_step, status FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId],
    );
    expect(sessionRows[0].current_step).toBe('live');
    expect(sessionRows[0].status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run __tests__/exceptions/tenant-onboarding-resolve.test.ts`
Expected: FAIL — `tenants.status` stays whatever it was, session stays at `go_live_requested`.

- [ ] **Step 3: Add the additive branch to `app/api/exceptions/[id]/route.ts`**

Insert this immediately after the existing "log a permanent T-17 event" `try { await db.query(... 'exception.resolved' ...) } catch { ... }` block, before `return NextResponse.json(exc)`:

```typescript
      // T-28 — additive: a resolved tenant_onboarding/go_live_requested
      // exception is this module's only approval mechanism (spec §4.4 —
      // no new approval table or UI). Never blocks or alters the response
      // above, same discipline as the T-17 event-logging block just above.
      if (exc.source_module === 'tenant_onboarding' && exc.type === 'go_live_requested') {
        try {
          await db.query(`UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = $1`, [exc.tenant_id]);
          await db.query(
            `UPDATE tenant_onboarding_sessions
                SET current_step = 'live', status = 'completed', completed_at = NOW()
              WHERE tenant_id = $1`,
            [exc.tenant_id],
          );
        } catch (err) {
          console.error("[PATCH /api/exceptions/:id] tenant go-live activation failed (non-blocking):", err);
        }
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run __tests__/exceptions/tenant-onboarding-resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Re-run T-24's own resolve-action regression test to confirm no disturbance**

Run: `pnpm vitest run __tests__/exceptions -t "resolve"` (or the specific file T-24 added for this route)
Expected: still green — the new branch only fires for `source_module === 'tenant_onboarding'`, every other resolve path is untouched.

- [ ] **Step 6: Commit**

```bash
git add app/api/exceptions/[id]/route.ts __tests__/exceptions/tenant-onboarding-resolve.test.ts
git commit -m "feat(T-28): activate tenant on go-live exception resolve — the only approval path"
```

---

## Task 8: API routes (spec §5)

**Files:**
- Create: `app/api/tenant-onboarding/start/route.ts`
- Create: `app/api/tenant-onboarding/[sessionId]/route.ts` (PATCH)
- Create: `app/api/tenant-onboarding/[sessionId]/test/route.ts`
- Create: `app/api/tenant-onboarding/[sessionId]/request-go-live/route.ts`
- Create: `app/api/tenants/[id]/onboarding-status/route.ts`
- Test: `app/api/tenant-onboarding/__tests__/flow.test.ts`

**Interfaces:**
- Consumes: `startSession`, `advanceSession`, `provisionTenantFromSession`, `runDryRun`, `requestGoLive` (Task 4/5/6), `captureBillingIntent`/`applyTenantTypePolicyTemplate`/`seatTenantOwner` (Task 2), `requireSuperAdmin` (`lib/auth.ts`), `apiError` (`lib/api-error.ts`).

- [ ] **Step 1: Write the failing end-to-end test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { POST as startRoute } from '../start/route';
import { PATCH as advanceRoute } from '../[sessionId]/route';
import { POST as testRoute } from '../[sessionId]/test/route';
import { POST as goLiveRoute } from '../[sessionId]/request-go-live/route';
import { NextRequest } from 'next/server';

describe('tenant-onboarding API — full flow (fixture: broker)', () => {
  let tenantId: number | undefined;
  let sessionId: number | undefined;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('walks a fixture broker tenant from sign_up to go_live_requested', async () => {
    // NOTE: every request below needs the same super-admin auth mock used
    // elsewhere in this repo's admin-route tests (see Task 3's baseline test).
    const startRes = await startRoute(new NextRequest('http://localhost/api/tenant-onboarding/start', { method: 'POST' }));
    const startBody = await startRes.json();
    sessionId = startBody.sessionId;

    const slug = `t28-e2e-broker-${Date.now()}`;
    const companyRes = await advanceRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          step: 'company_created',
          stepData: { companyName: 'E2E Broker Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker' },
        }),
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    const companyBody = await companyRes.json();
    tenantId = companyBody.tenantId;
    expect(tenantId).toBeTypeOf('number');

    const testRes = await testRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}/test`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(testRes.status).toBe(200);

    const goLiveRes = await goLiveRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}/request-go-live`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(goLiveRes.status).toBe(200);

    const { rows } = await db.query<{ current_step: string }>(
      `SELECT current_step FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId],
    );
    expect(rows[0].current_step).toBe('go_live_requested');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/api/tenant-onboarding/__tests__/flow.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement `POST /api/tenant-onboarding/start`**

```typescript
// app/api/tenant-onboarding/start/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { startSession } from '@/lib/tenants/onboarding-session';

export async function POST(req: NextRequest) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { sessionId } = await startSession();
  return NextResponse.json({ sessionId }, { status: 201 });
}
```

- [ ] **Step 4: Implement `PATCH /api/tenant-onboarding/[sessionId]`**

```typescript
// app/api/tenant-onboarding/[sessionId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { advanceSession, provisionTenantFromSession, type OnboardingStep } from '@/lib/tenants/onboarding-session';
import { applyTenantTypePolicyTemplate, captureBillingIntent, seatTenantOwner } from '@/lib/tenants/provision';
import { db } from '@/lib/pipeline/db-adapter';

const STEP_VALUES = [
  'sign_up', 'company_created', 'users_created', 'billing_captured',
  'load_sources_selected', 'policy_confirmed', 'agents_configured',
  'tested', 'go_live_requested', 'live',
] as const;

const BODY = z.object({
  step: z.enum(STEP_VALUES),
  stepData: z.record(z.string(), z.unknown()),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;

  const { sessionId: rawId } = await params;
  const sessionId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return apiError('Invalid session id', 400);

  let body: z.infer<typeof BODY>;
  try {
    body = BODY.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(`Invalid body: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }
    return apiError('Invalid JSON body', 400);
  }

  const session = await advanceSession(sessionId, body.step as OnboardingStep, body.stepData);

  let tenantId: number | null = session.tenant_id;

  // Each step that has a real provisioning side effect fires it here,
  // immediately after the session row itself advances (spec §4's flow).
  if (body.step === 'company_created') {
    const result = await provisionTenantFromSession(sessionId);
    tenantId = result.tenantId;
  } else if (body.step === 'users_created' && tenantId !== null) {
    const ownerUserId = body.stepData.ownerUserId as string | undefined;
    if (!ownerUserId) return apiError("stepData.ownerUserId is required for the 'users_created' step", 400);
    await seatTenantOwner(db, tenantId, ownerUserId);
  } else if (body.step === 'billing_captured' && tenantId !== null) {
    const tier = body.stepData.tier as 'starter' | 'pro' | 'enterprise' | undefined;
    if (!tier) return apiError("stepData.tier is required for the 'billing_captured' step", 400);
    await captureBillingIntent(db, tenantId, tier);
  } else if (body.step === 'policy_confirmed' && tenantId !== null) {
    const freightBusinessType = body.stepData.freightBusinessType as 'broker' | 'dispatcher' | 'carrier' | undefined;
    if (!freightBusinessType) return apiError("stepData.freightBusinessType is required for the 'policy_confirmed' step", 400);
    await applyTenantTypePolicyTemplate(db, tenantId, freightBusinessType);
  }

  return NextResponse.json({ sessionId, tenantId, currentStep: session.current_step });
}
```

- [ ] **Step 5: Implement `POST /api/tenant-onboarding/[sessionId]/test`**

```typescript
// app/api/tenant-onboarding/[sessionId]/test/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { runDryRun } from '@/lib/tenants/onboarding-session';

export async function POST(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { sessionId: rawId } = await params;
  const sessionId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return apiError('Invalid session id', 400);

  try {
    const result = await runDryRun(sessionId);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'Dry-run failed', 400);
  }
}
```

- [ ] **Step 6: Implement `POST /api/tenant-onboarding/[sessionId]/request-go-live`**

```typescript
// app/api/tenant-onboarding/[sessionId]/request-go-live/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { requestGoLive } from '@/lib/tenants/onboarding-session';

export async function POST(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const denied = requireSuperAdmin(req);
  if (denied) return denied;
  const { sessionId: rawId } = await params;
  const sessionId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return apiError('Invalid session id', 400);

  try {
    const result = await requestGoLive(sessionId);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'Go-live request failed', 400);
  }
}
```

- [ ] **Step 7: Implement `GET /api/tenants/[id]/onboarding-status`**

```typescript
// app/api/tenants/[id]/onboarding-status/route.ts
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
    `SELECT id, current_step, status, started_at, completed_at
       FROM tenant_onboarding_sessions
      WHERE tenant_id = $1
      ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) return apiError('No onboarding session found for this tenant', 404);
  return NextResponse.json(rows[0]);
}
```

- [ ] **Step 8: Run the full flow test to verify pass**

Run: `pnpm vitest run app/api/tenant-onboarding/__tests__/flow.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add app/api/tenant-onboarding app/api/tenants/[id]/onboarding-status
git commit -m "feat(T-28): add tenant-onboarding API routes (start/advance/test/go-live/status)"
```

---

## Task 9: Regression test — zero writes to `shippers`/`carriers` (criterion 2)

**Files:**
- Create: `app/api/tenant-onboarding/__tests__/boundary.test.ts`

**Interfaces:**
- Consumes: the full flow from Task 8's routes.

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { POST as startRoute } from '../start/route';
import { PATCH as advanceRoute } from '../[sessionId]/route';
import { POST as testRoute } from '../[sessionId]/test/route';
import { POST as goLiveRoute } from '../[sessionId]/request-go-live/route';
import { NextRequest } from 'next/server';

describe('T-28 boundary — zero writes to shippers/carriers or Myra CRM tables', () => {
  let tenantId: number | undefined;
  let sessionId: number | undefined;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('running the full onboarding flow makes zero writes to shippers or carriers', async () => {
    const { rows: shippersBefore } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM shippers`);
    const { rows: carriersBefore } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM carriers`);

    const startRes = await startRoute(new NextRequest('http://localhost/api/tenant-onboarding/start', { method: 'POST' }));
    sessionId = (await startRes.json()).sessionId;

    const slug = `t28-boundary-${Date.now()}`;
    const companyRes = await advanceRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ step: 'company_created', stepData: { companyName: 'Boundary Co', slug, tenantType: 'saas_customer', freightBusinessType: 'dispatcher' } }),
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    tenantId = (await companyRes.json()).tenantId;

    await testRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}/test`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    await goLiveRoute(
      new NextRequest(`http://localhost/api/tenant-onboarding/${sessionId}/request-go-live`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );

    const { rows: shippersAfter } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM shippers`);
    const { rows: carriersAfter } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM carriers`);
    expect(shippersAfter[0].count).toBe(shippersBefore[0].count);
    expect(carriersAfter[0].count).toBe(carriersBefore[0].count);
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm vitest run app/api/tenant-onboarding/__tests__/boundary.test.ts`
Expected: PASS. If either count changed, stop and find which line in Tasks 2–8 wrote to that table before fixing anything else — this criterion is the one the spec's §1 boundary argument depends on being true in code, not just prose.

- [ ] **Step 3: Commit**

```bash
git add app/api/tenant-onboarding/__tests__/boundary.test.ts
git commit -m "test(T-28): pin zero writes to shippers/carriers (acceptance criterion 2)"
```

---

## Task 10: Full regression suite + typecheck

**Files:** none created — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: same pre-existing flaky baseline already documented in the T-27 completion-tracker entry (rotating 30s-timeout live-DB integration tests — `cost-calculator.test.ts`'s 5 stable failures plus whichever of `carrier-brief-compiler-worker`/`retell-webhook-carrier-cascade`/`sellside-autonomous-loop.e2e` rotate this run), zero new failures anywhere under `lib/tenants/`, `app/api/tenant-onboarding/`, or `app/api/admin/tenants/`. Confirm via `git log`/`git diff` that any failing file was not touched by this plan's commits before concluding it's pre-existing.

- [ ] **Step 2: Run the project-wide typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: clean, aside from the one pre-existing, unrelated error already documented in T-27's tracker entry (`dispatch-routing-api.test.ts`, predates T-27).

- [ ] **Step 3: Re-run this module's own DB-touching tests one more time in isolation**

Run: `pnpm vitest run lib/tenants __tests__/tenants app/api/tenant-onboarding app/api/admin/tenants __tests__/exceptions/tenant-onboarding-resolve.test.ts`
Expected: all green, confirming no cross-test-file interference from the full-suite run above.

- [ ] **Step 4: No commit for this task** — it's a verification checkpoint. If Steps 1–3 are clean, the plan is ready for the completion-tracker entry and, separately, an explicit production-apply decision (out of scope for this plan itself, per every prior module's standing discipline).

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** All 5 acceptance criteria (spec §6) map to tasks — criterion 1 → Tasks 2–4/8, criterion 2 → Task 9, criterion 3 → Task 5, criterion 4 → Tasks 1/6/7, criterion 5 → Task 10.
- **The two riskiest tasks are 3 and 7** — both touch existing, already-shipped code paths (the admin tenant routes; the shared exception-resolve route). Task 3's refactor must be verified behavior-preserving before moving on; Task 7's branch must be proven not to affect any non-`tenant_onboarding` resolve path.
- **Confirm exact field names before compiling Task 5** — `evaluatePolicy`'s `PolicyEvaluationInput`/result shape and `quotePricing`'s `PricingQuoteRequest`/`PricingQuoteResult` shape are referenced by best-guess field names (`.allowed`, `{ tenantId, load }`) based on patterns seen elsewhere in this codebase, not verified against the literal type definitions in `lib/governance/policy-types.ts` / `lib/pricing/pricing-engine.ts`. This is flagged explicitly in Task 5's own steps — do not skip that verification.
- **Confirm `exception_classification_rules`' real column/vocabulary before Task 1's migration** — flagged explicitly in that task's Step 2.
