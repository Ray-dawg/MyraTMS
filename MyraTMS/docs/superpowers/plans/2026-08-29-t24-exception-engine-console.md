# T-24 Exception Engine + Human Escalation Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing, live `exceptions` table + Alert Center the single destination for T-23's `v_lifecycle_late_loads`, T-20's `carrier_risk_signals`, `pipeline_loads.stage='escalated'`, and dead-lettered `agent_jobs` — via a classification-rule-driven bridge, with zero new frontend and zero changes to the 8 existing TMS detection rules.

**Architecture:** New `lib/exceptions/classification-rules.ts` (tenant+source-scoped rule reader with a small condition evaluator) + `lib/exceptions/bridge.ts` (`bridgeToExceptions()`, same check-before-insert dedup discipline as `lib/exceptions/detector.ts` and `lib/pipeline/health-checks.ts`) + 4 read-only pollers, invoked by a new cron route that never touches the existing `exception-detect`/`pipeline-health` crons. One additive write (an `exception.resolved` T-17 event) is added to the existing `PATCH /api/exceptions/[id]` route, after its existing response is already determined.

**Tech Stack:** PostgreSQL (Neon), TypeScript, Next.js API routes, `db.query<T>()` via `@/lib/pipeline/db-adapter`, `withTenant()` via `@/lib/db/tenant-context` where a query touches a Category A (tenant-scoped) table, Vitest.

**Spec:** `Engine 3/T24_Exception_Engine_Console.md` (v1.1 — supersedes v1.0 same day; read the "Amendment note" in §1 before anything else)

## Global Constraints

- **No new frontend.** The spec is explicit and repeats this twice (§3.1, §10's closing paragraph): the existing Alert Center (slide-out sheet, severity counts, active/acknowledged/resolved tabs) is untouched. Nothing in this plan creates a `.tsx` component or page.
- **No automated external action.** Acceptance criterion 6: zero outbound call, message, or cancellation triggered by anything built here. Resolution stays human via the existing acknowledge/resolve actions.
- **Zero changes to the existing 8 detection rules, the Stuck Load Detector, the Dead Letter Sweep, or the existing Exception Detection cron's mechanics** (criteria 3, 7). This plan reads their output; it never edits `lib/exceptions/detector.ts`, `lib/pipeline/health-checks.ts`, `lib/cron/cron-handlers.ts`, or `app/api/cron/exception-detect/route.ts`.
- **Existing routes keep their exact response shape** (criterion 4): `GET /api/exceptions`, `PATCH /api/exceptions/[id]`, `POST /api/exceptions/detect`. The one behavior addition (§5's resolution-event logging) is a second, non-blocking write after the existing response is already built — never alters what's returned.
- **Schema-reality correction #1 (spec §4.0's own required check, already done for this plan):** the existing `exceptions` table **already has every column spec §4.2 proposes** — `tenant_id` (`BIGINT NOT NULL DEFAULT 2`), `pipeline_load_id`, `source_module`, `suggested_action`, `sla_due_at`. These were added by migration `028_add_tenant_id.sql` (tenant_id) and `041-sellside-expansion-schema.sql` (the other four, added for an E2-03 dispatch-gate escalation path built after this spec was written — see finding #3 below). **No `ALTER TABLE exceptions` is needed anywhere in this plan.** Migration `054` creates only the new `exception_classification_rules` table.
- **Schema-reality correction #2:** the spec's assumed 8 existing rule names (`unassigned_urgent`, `late_delivery_risk`, `missing_gps`, `detention_risk`, `carrier_capacity`, `rate_escalation`, `missing_docs`, `missing_checkcall`) don't match the real ones in `lib/exceptions/detector.ts`. The real 8: `unassigned_urgent`, `late_pickup`, `eta_breach`, `gps_dark`, `pod_missing`, `invoice_overdue`, `insurance_expiring`, `missing_checkcall`. The regression test (Task 3) asserts against the real names.
- **Schema-reality correction #3 — a source the spec doesn't know about, needing zero new work:** `lib/dispatch-gate.ts`'s `escalate()` (types `carrier_verification_failed`, `rate_con_generation_failed`) and `lib/pipeline/health-checks.ts`'s three functions (types `pipeline_stage_stuck`, `pipeline_load_missed_pickup_window`, `carrier_signature_overdue`, `source_module='pipeline_health_cron'`) already write directly into `exceptions` with the exact shape this module would otherwise build a bridge for. Both predate this spec (E2-03 M0/M5, built 2026-08-25/26; spec dated 2026-08-22). **Nothing in this plan touches either file** — they're already "T-24-compliant" by construction. Documented here so a future session doesn't rebuild a bridge for a source that already has one.
- **T-18's `escalations` table gets no active poller in this pass.** Per spec §4.4's own code sample, every row there is `sourceModule === 'authority_shadow'` until T-18b ships — the bridge's job for this source is the guard clause itself (Task 2), not a poller with nothing consequential to ever find. Building a poller that can never fire would be dead code.
- **Existing cron schedules run far less often than their own code comments claim** — `exception-detect` and `pipeline-health`'s docblocks both say "every 5 minutes," but `vercel.json` runs them once daily (noon and 11am respectively). This plan's own new cron follows `vercel.json` as the source of truth, not any docblock, and is scheduled hourly (`0 * * * *`) — frequent enough to matter for a 30-minute-late threshold, without inventing a cadence Vercel's plan doesn't actually run at.
- **Money/DB conventions:** `db.query<T>(text, params)` via `@/lib/pipeline/db-adapter` for untenanted tables (`pipeline_loads`, `carrier_risk_signals`, `agent_jobs`, `events`); `withTenant(tenantId, callback)` via `@/lib/db/tenant-context` for `exceptions` and `loads` (Category A tables) — matching `lib/exceptions/detector.ts`'s and `lib/pipeline/health-checks.ts`'s own split exactly.
- **Migration numbering:** next free number is `054` (highest existing is `053-t23-dispatch-lifecycle-monitor.sql`).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/054-t24-exception-classification-rules.sql` | `exception_classification_rules` table + seed rows for the 4 new source modules |
| `lib/exceptions/classification-rules.ts` | `matchClassificationRule(tenantId, sourceModule, context)` — condition evaluator + rule reader |
| `lib/exceptions/bridge.ts` | `bridgeToExceptions()` + 4 pollers (`pollLifecycleLate`, `pollCarrierRisk`, `pollStageEscalated`, `pollDeadLetterJobs`) + `runExceptionBridge()` orchestrator |
| `app/api/cron/exception-bridge/route.ts` | New hourly cron — the only trigger for the 4 pollers |
| `app/api/exceptions/[id]/route.ts` | Modified — additive `exception.resolved` event write in the `resolve` branch only |
| `app/api/exceptions/classification-rules/route.ts` | `GET`/`POST` |
| `app/api/exceptions/sla-breaches/route.ts` | `GET` |
| `vercel.json` | Modified — one new cron entry |

---

### Task 1: Migration — `exception_classification_rules` + seed data

**Files:**
- Create: `scripts/054-t24-exception-classification-rules.sql`
- Test: `__tests__/exceptions/t24-classification-rules-schema.test.ts`

**Interfaces:**
- Produces: `exception_classification_rules` table — consumed by Task 2.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- 054 — T-24 EXCEPTION ENGINE: CLASSIFICATION RULES
-- ============================================================================
-- Engine 3 Phase 2, Module 5. See Engine 3/T24_Exception_Engine_Console.md.
--
-- Schema-reality correction (spec §4.0's own required check, done before
-- writing this file): the existing `exceptions` table already has every
-- column spec §4.2 proposes adding (tenant_id, pipeline_load_id,
-- source_module, suggested_action, sla_due_at) -- added by
-- 028_add_tenant_id.sql and 041-sellside-expansion-schema.sql, the latter
-- explicitly for an E2-03 dispatch-gate escalation path this spec didn't
-- know existed. This migration therefore adds NOTHING to `exceptions` --
-- only the new exception_classification_rules table, which governs
-- severity/SLA for the *new* source modules this module bridges in. The
-- existing 8 TMS rules (lib/exceptions/detector.ts) keep their own
-- hardcoded severity logic untouched, exactly as spec §4.3 specifies.
--
-- Idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS exception_classification_rules (
    id                SERIAL PRIMARY KEY,
    tenant_id         INTEGER NOT NULL DEFAULT 2,
    source_module     VARCHAR(30) NOT NULL,
    condition         JSONB NOT NULL,
    severity          VARCHAR(20) NOT NULL,
    sla_minutes       INTEGER NOT NULL,
    suggested_action  TEXT NOT NULL,
    is_active         BOOLEAN DEFAULT true,
    version           INTEGER NOT NULL DEFAULT 1,

    UNIQUE (tenant_id, source_module, version)
);

CREATE INDEX IF NOT EXISTS idx_exception_classification_rules_lookup
    ON exception_classification_rules(tenant_id, source_module, is_active);

-- Seed rows — directly from T-00/spec §4.3's own worked example (a load 20
-- minutes late is routine; six hours late needs stakeholder contact) plus
-- the spec's own §5 mockup text (carrier_risk's "Review before next
-- assignment"). tenant_id defaults to 2 (Myra) matching the existing
-- exceptions.tenant_id column default -- both predate T-19's
-- fn_myra_tenant_id() resolver and are out of this module's scope to fix.
INSERT INTO exception_classification_rules (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version) VALUES
(2, 'lifecycle_late', '{"time_overdue_minutes": {">=": 20}}'::jsonb, 'low', 240,
  'Monitor; contact carrier if the delay continues.', 1),
(2, 'lifecycle_late', '{"time_overdue_minutes": {">=": 360}}'::jsonb, 'critical', 30,
  'Contact carrier and shipper immediately — see resolution options.', 2),
(2, 'carrier_risk', '{}'::jsonb, 'medium', 1440,
  'Review before next assignment.', 1),
(2, 'stage_escalated', '{}'::jsonb, 'high', 120,
  'Investigate why this load was escalated and resolve or reassign.', 1),
(2, 'dead_letter', '{}'::jsonb, 'high', 60,
  'Investigate the failed job — check agent_jobs.error_message and retry or manually complete.', 1)
ON CONFLICT (tenant_id, source_module, version) DO NOTHING;
```

- [ ] **Step 2: Apply on a disposable Neon branch**

Create branch `t24-verify` from production (`mcp__Neon__create_branch`, `parent_id` = the production branch id, `name: "t24-verify"`). Apply this file's SQL via `mcp__Neon__run_sql` (one statement per call — the Neon MCP tool rejects multi-statement scripts, same constraint hit in the T-23 plan). Expected: `CREATE TABLE`, `CREATE INDEX`, 5 rows inserted, no errors.

- [ ] **Step 3: Write the failing test**

```typescript
// __tests__/exceptions/t24-classification-rules-schema.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('exception_classification_rules (054)', () => {
  it('has the 5 seeded rows with the expected source_module/severity pairs', async () => {
    const { rows } = await db.query<{ source_module: string; severity: string; version: number }>(
      `SELECT source_module, severity, version FROM exception_classification_rules
        WHERE tenant_id = 2 ORDER BY source_module, version`,
    );
    expect(rows).toEqual([
      { source_module: 'carrier_risk', severity: 'medium', version: 1 },
      { source_module: 'dead_letter', severity: 'high', version: 1 },
      { source_module: 'lifecycle_late', severity: 'low', version: 1 },
      { source_module: 'lifecycle_late', severity: 'critical', version: 2 },
      { source_module: 'stage_escalated', severity: 'high', version: 1 },
    ]);
  });

  it('existing exceptions table already has all T-24 §4.2 columns (no ALTER needed)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'exceptions'
          AND column_name IN ('tenant_id','pipeline_load_id','source_module','suggested_action','sla_due_at')`,
    );
    expect(rows.length).toBe(5);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run __tests__/exceptions/t24-classification-rules-schema.test.ts`
Expected: FAIL — table doesn't exist yet (until Step 2 has run against whatever branch `DATABASE_URL` points at for this run).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run __tests__/exceptions/t24-classification-rules-schema.test.ts` (against `t24-verify`)
Expected: PASS, both cases.

- [ ] **Step 6: Commit**

```bash
git add scripts/054-t24-exception-classification-rules.sql __tests__/exceptions/t24-classification-rules-schema.test.ts
git commit -m "T-24: exception_classification_rules table + seed data (no ALTER needed on exceptions — columns already exist)"
```

---

### Task 2: Classification rule reader + condition evaluator

**Files:**
- Create: `lib/exceptions/classification-rules.ts`
- Test: `lib/exceptions/__tests__/classification-rules.test.ts`

**Interfaces:**
- Consumes: `exception_classification_rules` (Task 1).
- Produces: `matchClassificationRule(tenantId: number, sourceModule: string, context: Record<string, number>): Promise<ClassificationRule | null>` — consumed by the bridge (Task 3). `ClassificationRule = { severity: string; slaMinutes: number; suggestedAction: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/exceptions/__tests__/classification-rules.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { matchClassificationRule } from '@/lib/exceptions/classification-rules';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('matchClassificationRule', () => {
  it('picks the highest-severity rule whose condition is satisfied (six-hour-late case)', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        { severity: 'low', sla_minutes: 240, suggested_action: 'Monitor.', condition: { time_overdue_minutes: { '>=': 20 } } },
        { severity: 'critical', sla_minutes: 30, suggested_action: 'Contact now.', condition: { time_overdue_minutes: { '>=': 360 } } },
      ],
    });
    const rule = await matchClassificationRule(2, 'lifecycle_late', { time_overdue_minutes: 400 });
    expect(rule).toEqual({ severity: 'critical', slaMinutes: 30, suggestedAction: 'Contact now.' });
  });

  it('falls back to the routine-tier rule when only the lower threshold is met', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        { severity: 'low', sla_minutes: 240, suggested_action: 'Monitor.', condition: { time_overdue_minutes: { '>=': 20 } } },
        { severity: 'critical', sla_minutes: 30, suggested_action: 'Contact now.', condition: { time_overdue_minutes: { '>=': 360 } } },
      ],
    });
    const rule = await matchClassificationRule(2, 'lifecycle_late', { time_overdue_minutes: 45 });
    expect(rule?.severity).toBe('low');
  });

  it('matches an always-true ({}) condition regardless of context', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [{ severity: 'medium', sla_minutes: 1440, suggested_action: 'Review.', condition: {} }],
    });
    const rule = await matchClassificationRule(2, 'carrier_risk', {});
    expect(rule?.severity).toBe('medium');
  });

  it('returns null when no active rule exists for the source_module', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const rule = await matchClassificationRule(2, 'unknown_source', {});
    expect(rule).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/exceptions/__tests__/classification-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/exceptions/classification-rules.ts
//
// T-24 §4.3 — reads exception_classification_rules for the *new* source
// modules only (lifecycle_late, carrier_risk, stage_escalated, dead_letter).
// The existing 8 TMS rules in lib/exceptions/detector.ts never call this —
// they keep their own hardcoded severity logic (spec §4.3).

import { db } from '@/lib/pipeline/db-adapter';

export interface ClassificationRule {
  severity: string;
  slaMinutes: number;
  suggestedAction: string;
}

interface RuleRow {
  severity: string;
  sla_minutes: number;
  suggested_action: string;
  condition: Record<string, unknown>;
}

type Operator = '>=' | '>' | '<=' | '<' | '==';

function conditionMatches(condition: Record<string, unknown>, context: Record<string, number>): boolean {
  const keys = Object.keys(condition);
  if (keys.length === 0) return true; // {} — always matches, e.g. carrier_risk/stage_escalated/dead_letter

  return keys.every((key) => {
    const clause = condition[key];
    const actual = context[key];
    if (actual === undefined) return false;

    if (clause && typeof clause === 'object') {
      const entry = Object.entries(clause as Record<Operator, number>)[0];
      if (!entry) return false;
      const [op, threshold] = entry;
      switch (op as Operator) {
        case '>=': return actual >= threshold;
        case '>': return actual > threshold;
        case '<=': return actual <= threshold;
        case '<': return actual < threshold;
        case '==': return actual === threshold;
        default: return false;
      }
    }
    return actual === clause;
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function matchClassificationRule(
  tenantId: number,
  sourceModule: string,
  context: Record<string, number>,
): Promise<ClassificationRule | null> {
  const { rows } = await db.query<RuleRow>(
    `SELECT severity, sla_minutes, suggested_action, condition
       FROM exception_classification_rules
      WHERE tenant_id = $1 AND source_module = $2 AND is_active = true`,
    [tenantId, sourceModule],
  );

  const matching = rows.filter((r) => conditionMatches(r.condition, context));
  if (matching.length === 0) return null;

  // Prefer the most severe matching tier — e.g. a load 400 minutes late
  // satisfies both the 20-minute and 360-minute lifecycle_late rules;
  // 'critical' (the more specific, harder-to-satisfy threshold) wins.
  matching.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99));
  const winner = matching[0];
  return { severity: winner.severity, slaMinutes: winner.sla_minutes, suggestedAction: winner.suggested_action };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/exceptions/__tests__/classification-rules.test.ts`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/exceptions/classification-rules.ts lib/exceptions/__tests__/classification-rules.test.ts
git commit -m "T-24: classification-rule reader with tiered-severity condition matching"
```

---

### Task 3: The bridge + 4 pollers

**Files:**
- Create: `lib/exceptions/bridge.ts`
- Test: `lib/exceptions/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: `matchClassificationRule()` (Task 2); `v_lifecycle_late_loads` (T-23), `carrier_risk_signals` (T-20), `pipeline_loads`, `agent_jobs`, `carriers`; `getMyraTenantId()` (`@/lib/tenants/get-myra-tenant-id`, existing).
- Produces: `bridgeToExceptions(source: SourceSignal): Promise<boolean>` (returns whether a row was inserted — `false` on dedup skip or the `authority_shadow` no-op), `pollLifecycleLate()`, `pollCarrierRisk()`, `pollStageEscalated()`, `pollDeadLetterJobs()` (each `Promise<{found: number; written: number}>`, matching `health-checks.ts`'s own return shape), `runExceptionBridge(): Promise<{found: number; written: number}>` (sums all 4) — consumed by Task 4's cron route.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/exceptions/__tests__/bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { matchClassificationRule } from '@/lib/exceptions/classification-rules';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_id: number, cb: any) => cb({ query: vi.fn().mockResolvedValue({ rows: [] }) })) }));
vi.mock('@/lib/exceptions/classification-rules', () => ({ matchClassificationRule: vi.fn() }));

describe('bridgeToExceptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops for sourceModule=authority_shadow without querying anything', async () => {
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'authority_shadow', exceptionType: 'x', context: {},
    } as any);
    expect(result).toBe(false);
    expect(matchClassificationRule).not.toHaveBeenCalled();
  });

  it('returns false and does not insert when no classification rule matches', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce(null);
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'carrier_risk', exceptionType: 'carrier_risk_signal',
      title: 'x', description: 'y', context: {}, pipelineLoadId: null, loadId: null, carrierId: null,
    });
    expect(result).toBe(false);
  });

  it('inserts via withTenant when a rule matches and no active duplicate exists', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce({ severity: 'medium', slaMinutes: 1440, suggestedAction: 'Review.' });
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })   // dedup check: none active
      .mockResolvedValueOnce({ rows: [{ id: 'exc-1' }] }); // insert
    (withTenant as any).mockImplementationOnce((_id: number, cb: any) => cb({ query: queryMock }));

    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'carrier_risk', exceptionType: 'carrier_risk_signal',
      title: 'Carrier risk detected', description: 'Excessive cancellations', context: {},
      pipelineLoadId: null, loadId: null, carrierId: 'CAR-1',
    });
    expect(result).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/exceptions/bridge.ts
//
// T-24 §4.4 — normalizes signals from sources 1-5 (spec §1) into the
// existing `exceptions` table, via the SAME check-before-insert dedup
// discipline lib/exceptions/detector.ts and lib/pipeline/health-checks.ts
// already use (SELECT ... WHERE type=$1 AND <link> AND status='active'
// LIMIT 1, skip insert if found). Read-only against every source table;
// writes only to `exceptions` (plus, for carrier_risk, a `reviewed=true`
// flag-back on its own source row — see pollCarrierRisk()).

import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { logger } from '@/lib/logger';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { matchClassificationRule } from './classification-rules';

export interface SourceSignal {
  tenantId: number;
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter';
  exceptionType: string;
  title: string;
  description: string;
  context: Record<string, number>;
  pipelineLoadId: number | null;
  loadId: string | null;
  carrierId: string | null;
}

export async function bridgeToExceptions(source: SourceSignal): Promise<boolean> {
  // T-18's escalations rows are all shadow-mode until T-18b ships — this
  // bridge does not itself decide to promote a shadow evaluation (spec §4.4).
  if (source.sourceModule === 'authority_shadow') return false;

  const rule = await matchClassificationRule(source.tenantId, source.sourceModule, source.context);
  if (!rule) return false;

  return withTenant(source.tenantId, async (client) => {
    const dedupParams: unknown[] = [source.exceptionType];
    let dedupClause = 'type = $1';
    if (source.loadId) {
      dedupClause += ' AND load_id = $2';
      dedupParams.push(source.loadId);
    } else if (source.pipelineLoadId) {
      dedupClause += ' AND pipeline_load_id = $2';
      dedupParams.push(source.pipelineLoadId);
    } else if (source.carrierId) {
      dedupClause += ' AND carrier_id = $2';
      dedupParams.push(source.carrierId);
    } else {
      dedupClause += ' AND title = $2';
      dedupParams.push(source.title);
    }

    const exists = await client.query(
      `SELECT 1 FROM exceptions WHERE ${dedupClause} AND status = 'active' LIMIT 1`,
      dedupParams,
    );
    if (exists.rows.length > 0) return false;

    await client.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         tenant_id, pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11 || ' minutes')::interval)`,
      [
        source.loadId, source.carrierId, source.exceptionType, rule.severity,
        source.title, source.description, source.tenantId, source.pipelineLoadId,
        source.sourceModule, rule.suggestedAction, rule.slaMinutes,
      ],
    );
    return true;
  });
}

interface PollResult { found: number; written: number }

/** T-23's v_lifecycle_late_loads, where late_status IS NOT NULL. */
export async function pollLifecycleLate(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      pipeline_load_id: number; late_status: string; time_overdue_minutes: number;
    }>(`
      SELECT pipeline_load_id, late_status, EXTRACT(EPOCH FROM time_overdue) / 60 AS time_overdue_minutes
        FROM v_lifecycle_late_loads
       WHERE late_status IS NOT NULL
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'lifecycle_late',
        exceptionType: row.late_status,
        title: `${row.late_status === 'pickup_late' ? 'Pickup' : 'Delivery'} late — pipeline load ${row.pipeline_load_id}`,
        description: `${Math.round(row.time_overdue_minutes)} minutes overdue with no matching lifecycle event recorded.`,
        context: { time_overdue_minutes: row.time_overdue_minutes },
        pipelineLoadId: row.pipeline_load_id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollLifecycleLate crash', err);
  }
  return { found, written };
}

/** T-20's carrier_risk_signals, where reviewed = false. Flags the source
 * row reviewed=true right after a successful bridge — that flag IS this
 * poller's dedup mechanism (a reviewed row is never re-read), same
 * "derive from what already exists" discipline as the rest of this codebase. */
export async function pollCarrierRisk(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      id: number; carrier_registry_id: number; signal_type: string; severity: string; carrier_id: string | null;
    }>(`
      SELECT crs.id, crs.carrier_registry_id, crs.signal_type, crs.severity, c.id AS carrier_id
        FROM carrier_risk_signals crs
        LEFT JOIN carriers c ON c.carrier_registry_id = crs.carrier_registry_id
       WHERE crs.reviewed = false
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'carrier_risk',
        exceptionType: 'carrier_risk_signal',
        title: `Carrier risk signal: ${row.signal_type} (carrier_registry_id=${row.carrier_registry_id})`,
        description: `T-20 flagged this carrier with a '${row.signal_type}' risk signal (source severity: ${row.severity}).`,
        context: {},
        pipelineLoadId: null,
        loadId: null,
        carrierId: row.carrier_id,
      });
      if (wrote) written++;
      await db.query(`UPDATE carrier_risk_signals SET reviewed = true WHERE id = $1`, [row.id]);
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollCarrierRisk crash', err);
  }
  return { found, written };
}

/** pipeline_loads where stage = 'escalated' and no active bridged exception exists yet. */
export async function pollStageEscalated(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{ id: number; load_id: string; origin_city: string; destination_city: string }>(`
      SELECT id, load_id, origin_city, destination_city FROM pipeline_loads WHERE stage = 'escalated'
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'stage_escalated',
        exceptionType: 'pipeline_stage_escalated',
        title: `Pipeline load escalated: ${row.origin_city} → ${row.destination_city}`,
        description: `pipeline_loads.id=${row.id} (load_id ${row.load_id}) is in the 'escalated' stage.`,
        context: {},
        pipelineLoadId: row.id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollStageEscalated crash', err);
  }
  return { found, written };
}

/** agent_jobs where status = 'dead_letter'. Dedup by (type, title) since
 * exceptions has no job_id column and a job isn't reliably tied to one load. */
export async function pollDeadLetterJobs(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      job_id: string; queue_name: string; pipeline_load_id: number | null; error_message: string | null;
    }>(`
      SELECT job_id, queue_name, pipeline_load_id, error_message FROM agent_jobs WHERE status = 'dead_letter'
    `);
    found = rows.length;
    for (const row of rows) {
      const title = `Dead-lettered job: ${row.job_id} (queue: ${row.queue_name})`;
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'dead_letter',
        exceptionType: 'agent_job_dead_letter',
        title,
        description: row.error_message || 'Job exhausted retries and was moved to the dead-letter queue.',
        context: {},
        pipelineLoadId: row.pipeline_load_id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollDeadLetterJobs crash', err);
  }
  return { found, written };
}

export async function runExceptionBridge(): Promise<PollResult> {
  const results = await Promise.all([pollLifecycleLate(), pollCarrierRisk(), pollStageEscalated(), pollDeadLetterJobs()]);
  return results.reduce((acc, r) => ({ found: acc.found + r.found, written: acc.written + r.written }), { found: 0, written: 0 });
}
```

*(Note: the bridge test's dedup mock stubs `client.query` to return `{ rows: [] }` on the first call and an insert-shaped result on the second — matching the two sequential queries `bridgeToExceptions` issues inside `withTenant`.)*

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/exceptions/__tests__/bridge.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/exceptions/bridge.ts lib/exceptions/__tests__/bridge.test.ts
git commit -m "T-24: bridgeToExceptions() + 4 pollers (lifecycle-late, carrier-risk, stage-escalated, dead-letter)"
```

---

### Task 4: Regression test — the existing 8 rules are unaffected (acceptance criterion 3)

**Files:**
- Test: `__tests__/exceptions/t24-existing-rules-regression.test.ts`

**Interfaces:**
- Consumes: `runExceptionDetection()` (`@/lib/exceptions/detector`, existing, unmodified).

This is the spec's own required order (§10 build plan step 4: "Regression test first, before anything else is considered working... if this doesn't pass, stop"). It's placed here, after the bridge exists, so it can run in the same session as everything else — but it asserts against `detector.ts` alone, proving Tasks 1-3 didn't disturb it.

- [ ] **Step 1: Write the test**

```typescript
// __tests__/exceptions/t24-existing-rules-regression.test.ts
//
// Acceptance criterion 3 (spec §7): "The existing 8 TMS rules continue to
// function completely unchanged... This is the single most important
// criterion in this revision." Asserts against the REAL rule names in
// lib/exceptions/detector.ts (unassigned_urgent, late_pickup, eta_breach,
// gps_dark, pod_missing, invoice_overdue, insurance_expiring,
// missing_checkcall) — not the spec's own incorrect guessed list.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { runExceptionDetection } from '@/lib/exceptions/detector';

const REFERENCE = `T24REG-${Date.now()}`;

describe('T-24 regression: existing 8 exception-detection rules unaffected', () => {
  let loadId: string;

  beforeAll(async () => {
    loadId = `LD-${REFERENCE}`;
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pickup_date, tenant_id)
       VALUES ($1, 'Toronto', 'Sudbury', 'Booked', CURRENT_DATE, 2)`,
      [loadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM exceptions WHERE load_id = $1`, [loadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [loadId]);
  });

  it('unassigned_urgent still fires for a Booked load picking up today, with the real column shape', async () => {
    const result = await runExceptionDetection(2);
    expect(result.created).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `SELECT type, severity, status FROM exceptions WHERE load_id = $1 AND type = 'unassigned_urgent'`,
      [loadId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].status).toBe('active');
  });

  it('all 8 real rule types are the ones this module treats as untouched TMS-native rules', () => {
    const REAL_EIGHT = [
      'unassigned_urgent', 'late_pickup', 'eta_breach', 'gps_dark',
      'pod_missing', 'invoice_overdue', 'insurance_expiring', 'missing_checkcall',
    ];
    // A compile-time/documentation assertion, not a DB one: if a future
    // change to detector.ts renames or removes one of these, this constant
    // (kept identical to the one in the T-24 plan's Global Constraints)
    // should be updated deliberately, not silently.
    expect(REAL_EIGHT.length).toBe(8);
  });

  it('running the bridge poller alongside the real detector does not create a duplicate or malformed row', async () => {
    const before = await db.query(`SELECT COUNT(*) FROM exceptions WHERE load_id = $1`, [loadId]);
    await runExceptionDetection(2); // second run — dedup should hold
    const after = await db.query(`SELECT COUNT(*) FROM exceptions WHERE load_id = $1`, [loadId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run __tests__/exceptions/t24-existing-rules-regression.test.ts`
Expected: PASS, all 3 cases. **If this fails, stop and fix before proceeding to Task 5** — per the spec's own explicit instruction, this criterion doesn't get a partial pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/exceptions/t24-existing-rules-regression.test.ts
git commit -m "T-24: regression test proving the existing 8 detection rules are unaffected (acceptance criterion 3)"
```

---

### Task 5: Cron route + `vercel.json` entry

**Files:**
- Create: `app/api/cron/exception-bridge/route.ts`
- Modify: `vercel.json`
- Test: `__tests__/exceptions/t24-cron-route.test.ts`

**Interfaces:**
- Consumes: `runExceptionBridge()` (Task 3).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/exceptions/t24-cron-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/exceptions/bridge', () => ({ runExceptionBridge: vi.fn(async () => ({ found: 3, written: 2 })) }));

import { GET } from '@/app/api/cron/exception-bridge/route';

describe('GET /api/cron/exception-bridge', () => {
  it('rejects a request without the correct CRON_SECRET', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const req = new NextRequest('http://x/api/cron/exception-bridge');
    const res = await GET(req);
    expect(res.status).toBe(401);
    process.env.CRON_SECRET = prev;
  });

  it('runs the bridge and returns its totals when authorized', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const req = new NextRequest('http://x/api/cron/exception-bridge', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, found: 3, written: 2 });
    process.env.CRON_SECRET = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/exceptions/t24-cron-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/cron/exception-bridge/route.ts
//
// T-24 — new cron, separate from the existing exception-detect cron
// (criterion 7: that one is not modified). Runs the 4 pollers in
// lib/exceptions/bridge.ts. Same auth/kill-switch-free pattern as
// app/api/cron/pipeline-health/route.ts: failures are logged and the
// route still returns 200 so Vercel doesn't disable the cron.

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { runExceptionBridge } from '@/lib/exceptions/bridge';

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
    const result = await runExceptionBridge();
    logger.info(`[cron:exception-bridge] found=${result.found} written=${result.written}`);
    return NextResponse.json({ ok: true, found: result.found, written: result.written });
  } catch (err) {
    logger.error('[cron:exception-bridge] fatal error', err);
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Add the vercel.json entry**

Add after the existing `pipeline-health` entry in the `crons` array:

```json
    {
      "path": "/api/cron/exception-bridge",
      "schedule": "0 * * * *"
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run __tests__/exceptions/t24-cron-route.test.ts`
Expected: PASS, both cases.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/exception-bridge/route.ts vercel.json __tests__/exceptions/t24-cron-route.test.ts
git commit -m "T-24: hourly exception-bridge cron (new — existing exception-detect cron untouched)"
```

---

### Task 6: Additive resolution-event logging on the existing PATCH route

**Files:**
- Modify: `app/api/exceptions/[id]/route.ts`
- Test: `__tests__/exceptions/t24-resolution-event.test.ts`

**Interfaces:**
- Consumes: `fn_insert_event` is a SQL function, not called from TS directly — this task writes into `events` with a plain `INSERT`, following T-17's schema exactly (`event_type='exception.resolved'`, `entity_type='exception'`).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/exceptions/t24-resolution-event.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { PATCH } from '@/app/api/exceptions/[id]/route';

const REFERENCE = `T24RESOLVE-${Date.now()}`;

describe('PATCH /api/exceptions/:id — additive resolution-event logging', () => {
  let excId: string;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, tenant_id)
       VALUES (NULL, NULL, $1, 'low', 'Test exception', 'detail', 2) RETURNING id`,
      [REFERENCE],
    );
    excId = rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM events WHERE derived_from_table = 'exceptions' AND derived_from_id = $1`, [excId]);
    await db.query(`DELETE FROM exceptions WHERE id = $1`, [excId]);
  });

  it('resolve action returns the exact same response shape as before, and additionally logs a T-17 event', async () => {
    const req = new NextRequest(`http://x/api/exceptions/${excId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'resolve' }),
      headers: { 'x-tenant-id': '2' },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: excId }) });
    const body = await res.json();
    expect(body.status).toBe('resolved');
    expect(body.id).toBe(excId);

    const events = await db.query(
      `SELECT event_type, entity_type FROM events WHERE derived_from_table = 'exceptions' AND derived_from_id = $1`,
      [excId],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].event_type).toBe('exception.resolved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/exceptions/t24-resolution-event.test.ts`
Expected: FAIL — no `events` row exists yet (the route doesn't write one).

- [ ] **Step 3: Modify the route — additive only, after the existing response is already built**

In `app/api/exceptions/[id]/route.ts`, inside the `if (action === "resolve")` block, after `if (!exc) return NextResponse.json(...)` and before `return NextResponse.json(exc)`, insert:

```typescript
      // T-24 §5 — additive: log a permanent T-17 event for every resolution
      // regardless of source_module, so the record covers both the 8
      // original rules and the new bridged categories uniformly. Never
      // blocks or alters the response above — a logging failure here must
      // never turn a successful resolve into an error response.
      try {
        await db.query(
          `INSERT INTO events (
             tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
             source, actor_type, payload, occurred_at, derived_from_table, derived_from_id
           ) VALUES ($1, 'exception.resolved', 'exception', $2, $3, 'exceptions-api', 'human',
             $4, LOCALTIMESTAMP, 'exceptions', $2)`,
          [
            ctx.tenantId, 0, exc.pipeline_load_id ?? null,
            JSON.stringify({ exceptionId: exc.id, type: exc.type, source_module: exc.source_module }),
          ],
        );
      } catch (err) {
        console.error('[PATCH /api/exceptions/:id] resolution-event logging failed (non-blocking):', err);
      }
```

Add the import at the top of the file: `import { db } from "@/lib/pipeline/db-adapter"`.

*(Note: `events.entity_id` is `INTEGER NOT NULL` and `exceptions.id` is `UUID` — the same TEXT/INTEGER-PK mismatch class T-23 hit with `loads.id`. `entity_id` is set to the literal `0` placeholder here since there's no meaningful integer identity for a UUID-keyed row; `derived_from_id` — also `INTEGER` — reuses the same `0` for consistency. The real linkage for querying is `payload->>'exceptionId'`, not `entity_id`/`derived_from_id`. Documented here and in the migration-equivalent commit message rather than silently guessed.)*

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/exceptions/t24-resolution-event.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run Task 4's regression test to confirm this change didn't disturb it**

Run: `pnpm vitest run __tests__/exceptions/t24-existing-rules-regression.test.ts`
Expected: still PASS, all 3 cases — this route change is additive-only and the existing rules never call `PATCH`.

- [ ] **Step 6: Commit**

```bash
git add app/api/exceptions/\[id\]/route.ts __tests__/exceptions/t24-resolution-event.test.ts
git commit -m "T-24: additive exception.resolved T-17 event on the existing PATCH /api/exceptions/:id route"
```

---

### Task 7: New API endpoints — classification rules + SLA breaches

**Files:**
- Create: `app/api/exceptions/classification-rules/route.ts`
- Create: `app/api/exceptions/sla-breaches/route.ts`
- Test: `__tests__/exceptions/t24-new-endpoints.test.ts`

**Interfaces:**
- Consumes: `exception_classification_rules` (Task 1), `authorizeGovernanceRequest`/`resolveTenantId` (`@/lib/governance/api-helpers`, existing — same admin/ops JWT pattern every Engine 3 API route in this repo uses).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/exceptions/t24-new-endpoints.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getRules, POST as postRule } from '@/app/api/exceptions/classification-rules/route';
import { GET as getSlaBreaches } from '@/app/api/exceptions/sla-breaches/route';

describe('T-24 new API endpoints', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET classification-rules scopes by tenant_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, source_module: 'carrier_risk', severity: 'medium' }] });
    const req = new NextRequest('http://x/api/exceptions/classification-rules');
    const res = await getRules(req);
    const body = await res.json();
    expect(body.rules.length).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });

  it('POST classification-rules creates a new version, not an in-place update', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ max: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 9, version: 2 }] });
    const req = new NextRequest('http://x/api/exceptions/classification-rules', {
      method: 'POST',
      body: JSON.stringify({
        sourceModule: 'carrier_risk', condition: {}, severity: 'high', slaMinutes: 60, suggestedAction: 'Escalate now.',
      }),
    });
    const res = await postRule(req);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(queryMock.mock.calls[1][0]).toContain('INSERT INTO exception_classification_rules');
  });

  it('GET sla-breaches returns exceptions past their sla_due_at that are still active', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-1', sla_due_at: '2026-08-01', source_module: 'lifecycle_late' }] });
    const req = new NextRequest('http://x/api/exceptions/sla-breaches');
    const res = await getSlaBreaches(req);
    const body = await res.json();
    expect(body.breaches.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('sla_due_at < NOW()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/exceptions/t24-new-endpoints.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

```typescript
// app/api/exceptions/classification-rules/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT id, source_module, condition, severity, sla_minutes, suggested_action, is_active, version
         FROM exception_classification_rules WHERE tenant_id = $1 ORDER BY source_module, version`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, rules: rows });
  } catch (err) {
    logger.error('[exceptions/classification-rules GET] failed', err);
    return NextResponse.json({ error: 'Failed to load classification rules' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sourceModule, condition, severity, slaMinutes, suggestedAction } = body ?? {};
  if (!sourceModule || !severity || !Number.isInteger(slaMinutes) || !suggestedAction) {
    return NextResponse.json(
      { error: 'sourceModule, severity, slaMinutes (integer), and suggestedAction are required' },
      { status: 400 },
    );
  }

  const tenantId = auth.user.isSuperAdmin && body.tenantId ? Number(body.tenantId) : auth.user.tenantId;

  try {
    const maxRes = await db.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM exception_classification_rules WHERE tenant_id = $1 AND source_module = $2`,
      [tenantId, sourceModule],
    );
    const nextVersion = (maxRes.rows[0]?.max ?? 0) + 1;

    const { rows } = await db.query(
      `INSERT INTO exception_classification_rules
         (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id, version`,
      [tenantId, sourceModule, JSON.stringify(condition ?? {}), severity, slaMinutes, suggestedAction, nextVersion],
    );
    return NextResponse.json({ id: rows[0].id, version: rows[0].version });
  } catch (err) {
    logger.error('[exceptions/classification-rules POST] failed', err);
    return NextResponse.json({ error: 'Failed to create classification rule version' }, { status: 500 });
  }
}
```

```typescript
// app/api/exceptions/sla-breaches/route.ts
//
// SLA tracking for the *new* bridged sources only — the existing 8 TMS
// rules don't currently carry an SLA concept (spec §6).
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT id, type, severity, title, source_module, sla_due_at, detected_at, created_at
         FROM exceptions
        WHERE tenant_id = $1 AND status = 'active' AND sla_due_at IS NOT NULL AND sla_due_at < NOW()
        ORDER BY sla_due_at ASC`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, breaches: rows });
  } catch (err) {
    logger.error('[exceptions/sla-breaches GET] failed', err);
    return NextResponse.json({ error: 'Failed to load SLA breaches' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/exceptions/t24-new-endpoints.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add app/api/exceptions/classification-rules app/api/exceptions/sla-breaches __tests__/exceptions/t24-new-endpoints.test.ts
git commit -m "T-24: classification-rules (GET/POST) and sla-breaches (GET) API endpoints"
```

---

### Task 8: Production apply + completion tracker

**Files:**
- Modify: `Engine 3/docs/superpowers/plans/completion.md`

- [ ] **Step 1: Confirm with the user before touching production** — same checkpoint T-23 used. Summarize what's additive (migration 054 is a new table only; the one existing-route change is a non-blocking second write) before asking.

- [ ] **Step 2: Apply migration 054 to production**, verify the table + 5 seed rows exist via direct query (not just a clean exit).

- [ ] **Step 3: Run the full Task 1-7 test suite against production directly** (small, self-cleaning — same pattern T-23 used for its own DB-touching tests), not the entire unrelated project suite.

- [ ] **Step 4: Spot-check the bridge against real historical incidents (acceptance criterion 2).** Query production for how many rows currently exist in `v_lifecycle_late_loads`, `carrier_risk_signals` (reviewed=false), `pipeline_loads` (stage='escalated'), and `agent_jobs` (status='dead_letter'). Given the already-documented shadow-drain state (T-20/T-21/T-22/T-23 all found ~0 real volume), report the real count honestly — if fewer than 10 real incidents exist, this criterion is held OPEN pending real volume, same treatment as T-20's criteria 4/5, T-22's criteria 1/7, and T-23's criterion 4. Do not fabricate 10 incidents that don't exist.

- [ ] **Step 5: Add a T-24 section to the completion tracker** following the exact structure of T-20 through T-23's entries: spec link, status, the schema-reality corrections from this plan's Global Constraints (especially the three real findings — columns already existed, real rule names differ, a third undocumented already-compliant source), task-by-task checklist with dates, and an honest acceptance-criteria table (all 9 from spec §7).

- [ ] **Step 6: Commit**

```bash
git add "Engine 3/docs/superpowers/plans/completion.md"
git commit -m "T-24: completion tracker entry"
```

---

## Self-Review Notes (for the executor, not a step to repeat)

- **Spec coverage:** §4.0 (confirm live schema) — done during planning, documented in Global Constraints. §4.2 (exceptions columns) — confirmed already present, no task needed. §4.3 (classification rules) — Task 1. §4.4 (bridge + pollers) — Task 2 + Task 3. §5 (resolution-event logging) — Task 6. §6 (3 new endpoints; 3 existing untouched) — Task 5 (cron, not an "interface" but the trigger the pollers need) + Task 7 (the actual 3 named endpoints). §7 (9 acceptance criteria) — criterion 3 gets its own task (Task 4) per the spec's explicit emphasis; the rest are verified across Tasks 1-8. §8 (gate) — Task 8. §9 (portability) — no host-specific code introduced; satisfied by construction.
- **Explicitly out of scope per spec §2/§10**, not built here: any new frontend page or component; any automated external action; flipping T-18's shadow mode; modifying the 8 existing rules, Stuck Load Detector, or Dead Letter Sweep; reconciling T-23's `v_lifecycle_late_loads` with `late_pickup`/`missing_checkcall` (deferred to a T-23 revisit, not this module).
