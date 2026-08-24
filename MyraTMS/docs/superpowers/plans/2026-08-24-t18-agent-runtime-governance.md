# T-18 Agent Runtime & Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Recommended execution mode: Inline Execution**, same reasoning as the T-17 plan — a single Neon verification branch ID/connection string threads through nearly every task.

**Goal:** Build T-18 Agent Runtime & Governance — a versioned, database-backed authority-envelope system that shadow-judges Engine 2's real behavior (via T-17's `events` table) without ever influencing it, verified end-to-end on a disposable Neon branch.

**Architecture:** One migration (`034-agent-runtime-governance.sql`) adds `agents`, `authority_envelopes`, `authority_evaluations`, `escalations`. The decision logic is split into a pure core (`lib/governance/evaluate.ts::applyEnvelope`, no I/O, unit-testable) and a thin DB wrapper (`lib/governance/evaluate-authority.ts::evaluateAuthority`, the spec's exact external signature) that loads the active envelope, calls the pure core, and writes the audit trail. A seed script populates 10 agents + default envelopes from real env var values. A replay harness feeds T-17's backfilled `events` through `evaluateAuthority()`. A disagreement-report script compares shadow judgments against what Engine 2 actually did. Five read/write API routes expose all of it behind the same JWT-cookie + role-check pattern as T-17.

**Tech Stack:** PostgreSQL (Neon serverless), Next.js 16 App Router route handlers, TypeScript, Vitest, Neon MCP tools for branch provisioning.

## Global Constraints

- `evaluateAuthority()` has zero callers inside any existing worker file in this session — no wiring into `base-worker.ts`, `voice-worker.ts`, `dispatcher-worker.ts`, or `compiler-worker.ts`. That is T-18b, explicitly out of scope.
- `evaluateAuthority()` may only `INSERT` into `authority_evaluations` and `escalations`. No write access to `pipeline_loads`, `agent_calls`, or any Engine 2 table.
- The replay harness is read-only against `events` and `pipeline_loads`.
- Envelope write endpoints require an authenticated human actor (`user.userId`); no agent may modify its own envelope.
- This session applies the migration and all scripts only to a disposable Neon branch, never to production — same as T-17. Production apply is a manual step for Patrice.
- Auth on all new API routes: `getCurrentUser` + `requireRole(user, 'admin', 'ops')`, matching T-17's routes.
- Reference docs: `Engine 3/T18_Agent_Runtime_Governance.md` (base spec) and `MyraTMS/docs/superpowers/specs/2026-08-24-t18-agent-runtime-governance-design.md` (reconciliation + decisions).
- Update `Engine 3/docs/superpowers/plans/completion.md` as each task finishes — do not batch (standing rule, see that file's own instructions).

---

### Task 1: Provision a Neon verification branch

**Files:** None.

**Interfaces:**
- Produces: `PROJECT_ID` (`lingering-bar-21372774`, already known from T-17), `BRANCH_ID`, `BRANCH_DATABASE_URL`. Threaded through every later task exactly as in the T-17 plan.

- [ ] **Step 1: Create a disposable branch**

Call `mcp__Neon__create_branch` with `projectId: "lingering-bar-21372774"` and `branchName: "t18-verify"`. Record the returned branch `id` as `BRANCH_ID`.

- [ ] **Step 2: Get a connection string**

Call `mcp__Neon__get_connection_string` with `projectId` and `branchId: BRANCH_ID`. Record as `BRANCH_DATABASE_URL`.

- [ ] **Step 3: Confirm T-17 is present on the branch**

Call `mcp__Neon__run_sql` with the branch: `SELECT COUNT(*) FROM events;` — expect a non-zero count (proves the branch forked a copy of production with T-17 already live, since T-17 shipped before this task).

---

### Task 2: Write migration `034-agent-runtime-governance.sql`

**Files:**
- Create: `MyraTMS/scripts/034-agent-runtime-governance.sql`

**Interfaces:**
- Produces: tables `agents`, `authority_envelopes`, `authority_evaluations` (with a `UNIQUE (source_event_id)` constraint — see step 1 note), `escalations`. All of Task 3 onward depend on these exact names/columns.

- [ ] **Step 1: Write the full migration file**

```sql
-- ============================================================================
-- 034 — T-18 AGENT RUNTIME & GOVERNANCE
-- ============================================================================
-- Engine 3, Phase 1, Module 2 of 3. Spec: Engine 3/T18_Agent_Runtime_Governance.md
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-t18-agent-runtime-governance-design.md
--
-- Ships in shadow mode only: evaluateAuthority() has no callers inside any
-- live worker. This migration is purely additive — no triggers on, or
-- alterations to, any existing Engine 2 table.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout, safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- agents — registry. Seeded by scripts/t18_seed_governance.ts, not here
-- (the seed data must read live env vars, which SQL can't do).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
    id              SERIAL PRIMARY KEY,
    agent_key       VARCHAR(40)  UNIQUE NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    agent_type      VARCHAR(30)  NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'shadow',
    description     TEXT,
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────────────────────
-- authority_envelopes — versioned policy object per (agent, tenant).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_envelopes (
    id                    SERIAL PRIMARY KEY,
    agent_id              INTEGER NOT NULL REFERENCES agents(id),
    tenant_id             INTEGER NOT NULL DEFAULT 1,
    version               INTEGER NOT NULL DEFAULT 1,

    envelope_name         VARCHAR(100) NOT NULL,
    permissions           JSONB NOT NULL DEFAULT '{"can": [], "cannot": []}',
    tools                 JSONB NOT NULL DEFAULT '[]',
    budget                JSONB NOT NULL DEFAULT '{}',
    policies              JSONB NOT NULL DEFAULT '{}',
    confidence_threshold  NUMERIC(4,3) DEFAULT 0.700,
    autonomy_default      VARCHAR(2) NOT NULL DEFAULT 'L2',
    escalation_rules      JSONB NOT NULL DEFAULT '[]',

    is_active             BOOLEAN NOT NULL DEFAULT true,
    effective_from        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by            VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (agent_id, tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_envelopes_active ON authority_envelopes(agent_id, tenant_id) WHERE is_active;

-- ────────────────────────────────────────────────────────────────────────────
-- authority_evaluations — append-only decision log.
--
-- UNIQUE (source_event_id) is a correction, not a spec deviation: T-18 §7
-- says in prose "Idempotent via a source_event_id uniqueness check", but the
-- base spec's DDL (§4.3) never declares that constraint. Added here so the
-- replay harness's re-run safety is real, not just described. NULL values
-- (ad-hoc evaluateAuthority() calls with no source event) are never
-- considered duplicates of each other — standard SQL NULL semantics — so
-- this only dedupes actual replay-harness re-runs.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_evaluations (
    id                     BIGSERIAL PRIMARY KEY,
    envelope_id            INTEGER NOT NULL REFERENCES authority_envelopes(id),
    agent_id               INTEGER NOT NULL REFERENCES agents(id),
    tenant_id              INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    action                 VARCHAR(60) NOT NULL,
    context                JSONB NOT NULL DEFAULT '{}',

    autonomy_level_applied VARCHAR(2) NOT NULL,
    decision               VARCHAR(20) NOT NULL,
    reason                 TEXT,

    shadow_mode            BOOLEAN NOT NULL DEFAULT true,
    source_event_id        BIGINT REFERENCES events(id),

    evaluated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id         VARCHAR(100),

    UNIQUE (source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluations_agent_time ON authority_evaluations(agent_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_decision ON authority_evaluations(decision, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_load ON authority_evaluations(pipeline_load_id);

-- ────────────────────────────────────────────────────────────────────────────
-- escalations — L3 queue, seeds T-24's console. Informational only in
-- shadow mode; ON DELETE CASCADE on pipeline_load_id for the same reason
-- as T-17's events table (pipeline_loads is never deleted in production
-- code, only test/ops scripts).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
    id                  SERIAL PRIMARY KEY,
    evaluation_id       INTEGER NOT NULL REFERENCES authority_evaluations(id),
    tenant_id           INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id    INTEGER REFERENCES pipeline_loads(id) ON DELETE CASCADE,

    severity            VARCHAR(20) NOT NULL DEFAULT 'medium',
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',

    assigned_to         VARCHAR(100),
    resolution_note     TEXT,

    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(tenant_id, status, created_at);

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
cd MyraTMS
git add scripts/034-agent-runtime-governance.sql
git commit -m "T-18: add agent runtime & governance migration (agents, envelopes, evaluations, escalations)"
```

---

### Task 3: Apply the migration and verify schema objects exist

**Files:** None.

- [ ] **Step 1: Apply**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/apply-pipeline-migration.ts 034-agent-runtime-governance.sql
```

- [ ] **Step 2: Verify**

Call `mcp__Neon__run_sql` against the branch:

```sql
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN
     ('agents','authority_envelopes','authority_evaluations','escalations')) AS table_count,
  (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'authority_evaluations_source_event_id_key') AS source_event_unique;
```

Expected: `table_count=4`, `source_event_unique=1`.

- [ ] **Step 3: Re-apply to confirm idempotency**

Repeat Step 1 exactly — expect success with no errors.

---

### Task 4: Write shared governance types

**Files:**
- Create: `MyraTMS/lib/governance/types.ts`

**Interfaces:**
- Produces: `AuthorityEnvelopeRow`, `EscalationRule`, `EvaluationInput`, `EvaluationResult`. Consumed by every task from here on.

- [ ] **Step 1: Write the types**

```typescript
export interface EscalationRule {
  trigger: string;
  level: 'L1' | 'L2' | 'L3';
}

export interface AuthorityEnvelopeRow {
  id: number;
  agent_id: number;
  tenant_id: number;
  version: number;
  envelope_name: string;
  permissions: { can: string[]; cannot: string[] };
  tools: string[];
  budget: Record<string, number>;
  policies: Record<string, number>;
  confidence_threshold: number;
  autonomy_default: 'L1' | 'L2' | 'L3';
  escalation_rules: EscalationRule[];
  is_active: boolean;
  effective_from: string;
  created_by: string;
  created_at: string;
}

export interface EvaluationInput {
  agentKey: string;
  tenantId: number;
  action: string;
  context: Record<string, unknown>;
  sourceEventId?: number;
  pipelineLoadId?: number;
  correlationId?: string;
}

export interface EvaluationResult {
  decision: 'allow' | 'escalate' | 'deny';
  autonomyLevelApplied: 'L1' | 'L2' | 'L3';
  reason: string;
  envelopeId: number;
}
```

- [ ] **Step 2: Commit**

```bash
cd MyraTMS
git add lib/governance/types.ts
git commit -m "T-18: add shared governance types"
```

---

### Task 5: Write the pure evaluation core and its 24 test scenarios

**Files:**
- Create: `MyraTMS/lib/governance/evaluate.ts`
- Create: `MyraTMS/lib/governance/__tests__/evaluate.test.ts`

**Interfaces:**
- Consumes: types from Task 4.
- Produces: `applyEnvelope(envelope, action, context): EvaluationResult` — pure, no I/O. Consumed by Task 6's DB wrapper.

- [ ] **Step 1: Write `applyEnvelope` and its helpers**

```typescript
import type { AuthorityEnvelopeRow, EvaluationResult } from './types';

const BUDGET_CONTEXT_KEYS: Record<string, string> = {
  max_concurrent: 'concurrentCount',
  max_actions_per_day: 'actionsToday',
  max_spend_per_day_cad: 'spendTodayCad',
};

function checkBudget(budget: Record<string, number>, context: Record<string, unknown>): string | null {
  for (const [budgetKey, contextKey] of Object.entries(BUDGET_CONTEXT_KEYS)) {
    const limit = budget[budgetKey];
    const actual = context[contextKey];
    if (typeof limit === 'number' && typeof actual === 'number' && actual > limit) {
      return `budget exceeded: ${contextKey}=${actual} > ${budgetKey}=${limit}`;
    }
  }
  return null;
}

/**
 * Recognized escalation triggers, matching the worked example in T-18 §5.
 * An unrecognized trigger name never matches (fails safe) rather than
 * throwing, so a typo in an envelope's JSONB can't crash evaluation.
 */
function evaluateTrigger(
  trigger: string,
  envelope: AuthorityEnvelopeRow,
  context: Record<string, unknown>,
): boolean {
  switch (trigger) {
    case 'fraud_signal_detected':
      return context.fraudSignalDetected === true;
    case 'margin_below_floor': {
      const marginPct = context.marginPct;
      const floor = envelope.policies.margin_floor_pct;
      return typeof marginPct === 'number' && typeof floor === 'number' && marginPct < floor;
    }
    case 'confidence_below_threshold': {
      const confidence = context.confidence;
      return typeof confidence === 'number' && confidence < envelope.confidence_threshold;
    }
    case 'profit_above_auto_book_threshold': {
      const profit = context.profit;
      const threshold = envelope.policies.auto_book_profit_threshold_cad;
      return typeof profit === 'number' && typeof threshold === 'number' && profit > threshold;
    }
    default:
      return false;
  }
}

function levelToDecision(level: 'L1' | 'L2' | 'L3'): 'allow' | 'escalate' | 'deny' {
  return level === 'L3' ? 'escalate' : 'allow';
}

/**
 * Pure decision core (T-18 §6, steps 2-5). No I/O — loading the envelope
 * and persisting the result are the DB wrapper's job (evaluate-authority.ts).
 */
export function applyEnvelope(
  envelope: AuthorityEnvelopeRow,
  action: string,
  context: Record<string, unknown>,
): EvaluationResult {
  if (envelope.permissions.cannot.includes(action)) {
    return {
      decision: 'deny',
      autonomyLevelApplied: 'L3',
      reason: `action '${action}' is explicitly forbidden by envelope '${envelope.envelope_name}'`,
      envelopeId: envelope.id,
    };
  }

  const budgetBreach = checkBudget(envelope.budget, context);
  if (budgetBreach) {
    return {
      decision: 'escalate',
      autonomyLevelApplied: 'L3',
      reason: budgetBreach,
      envelopeId: envelope.id,
    };
  }

  for (const rule of envelope.escalation_rules) {
    if (evaluateTrigger(rule.trigger, envelope, context)) {
      return {
        decision: levelToDecision(rule.level),
        autonomyLevelApplied: rule.level,
        reason: `escalation rule matched: ${rule.trigger} -> ${rule.level}`,
        envelopeId: envelope.id,
      };
    }
  }

  return {
    decision: levelToDecision(envelope.autonomy_default),
    autonomyLevelApplied: envelope.autonomy_default,
    reason: 'no escalation rule matched; applied envelope autonomy_default',
    envelopeId: envelope.id,
  };
}
```

- [ ] **Step 2: Write the 24 test scenarios**

```typescript
import { describe, it, expect } from 'vitest';
import { applyEnvelope } from '../evaluate';
import type { AuthorityEnvelopeRow } from '../types';

function baseEnvelope(overrides: Partial<AuthorityEnvelopeRow> = {}): AuthorityEnvelopeRow {
  return {
    id: 1,
    agent_id: 1,
    tenant_id: 1,
    version: 1,
    envelope_name: 'test-envelope',
    permissions: { can: ['contact_carrier'], cannot: [] },
    tools: [],
    budget: {},
    policies: {},
    confidence_threshold: 0.7,
    autonomy_default: 'L2',
    escalation_rules: [],
    is_active: true,
    effective_from: new Date().toISOString(),
    created_by: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('applyEnvelope', () => {
  it('1. clean allow: no rules, autonomy_default L2', () => {
    const r = applyEnvelope(baseEnvelope(), 'contact_carrier', {});
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L2');
  });

  it('2. permission-list deny', () => {
    const envelope = baseEnvelope({ permissions: { can: [], cannot: ['modify_carrier_banking'] } });
    const r = applyEnvelope(envelope, 'modify_carrier_banking', {});
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('modify_carrier_banking');
  });

  it('3. budget exceeded: max_concurrent', () => {
    const envelope = baseEnvelope({ budget: { max_concurrent: 5 } });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 6 });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('max_concurrent');
  });

  it('4. budget exceeded: max_actions_per_day', () => {
    const envelope = baseEnvelope({ budget: { max_actions_per_day: 200 } });
    const r = applyEnvelope(envelope, 'place_call', { actionsToday: 201 });
    expect(r.decision).toBe('escalate');
  });

  it('5. budget exceeded: max_spend_per_day_cad', () => {
    const envelope = baseEnvelope({ budget: { max_spend_per_day_cad: 500 } });
    const r = applyEnvelope(envelope, 'place_call', { spendTodayCad: 501 });
    expect(r.decision).toBe('escalate');
  });

  it('6. budget within limits does not escalate', () => {
    const envelope = baseEnvelope({ budget: { max_concurrent: 5 } });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 3 });
    expect(r.decision).toBe('allow');
  });

  it('7. confidence_below_threshold matches -> L2, allow (with audit)', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [{ trigger: 'confidence_below_threshold', level: 'L2' }],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.5 });
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L2');
  });

  it('8. profit_above_auto_book_threshold matches -> L1, allow', () => {
    const envelope = baseEnvelope({
      policies: { auto_book_profit_threshold_cad: 1000 },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 1500 });
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L1');
  });

  it('9. margin_below_floor matches -> L3, escalate', () => {
    const envelope = baseEnvelope({
      policies: { margin_floor_pct: 8 },
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { marginPct: 5 });
    expect(r.decision).toBe('escalate');
    expect(r.autonomyLevelApplied).toBe('L3');
  });

  it('10. fraud_signal_detected matches -> L3, escalate', () => {
    const envelope = baseEnvelope({
      escalation_rules: [{ trigger: 'fraud_signal_detected', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
  });

  it('11. first-match-wins: earlier L2 rule beats a later L3 rule that also matches', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [
        { trigger: 'confidence_below_threshold', level: 'L2' },
        { trigger: 'fraud_signal_detected', level: 'L3' },
      ],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.5, fraudSignalDetected: true });
    expect(r.autonomyLevelApplied).toBe('L2');
    expect(r.decision).toBe('allow');
  });

  it('12. unrecognized trigger name never matches; falls through to next rule', () => {
    const envelope = baseEnvelope({
      escalation_rules: [
        { trigger: 'some_future_trigger_not_yet_implemented', level: 'L3' },
        { trigger: 'fraud_signal_detected', level: 'L3' },
      ],
    });
    const r = applyEnvelope(envelope, 'book_load', { fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('fraud_signal_detected');
  });

  it('13. empty escalation_rules falls back to autonomy_default', () => {
    const envelope = baseEnvelope({ escalation_rules: [], autonomy_default: 'L2' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.reason).toContain('autonomy_default');
  });

  it('14. autonomy_default L1 allows when no rules match', () => {
    const envelope = baseEnvelope({ autonomy_default: 'L1' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L1');
  });

  it('15. autonomy_default L3 escalates when no rules match', () => {
    const envelope = baseEnvelope({ autonomy_default: 'L3' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.decision).toBe('escalate');
  });

  it('16. permission deny takes precedence over an escalation rule that would otherwise allow', () => {
    const envelope = baseEnvelope({
      permissions: { can: [], cannot: ['auto_book'] },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
      policies: { auto_book_profit_threshold_cad: 100 },
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 500 });
    expect(r.decision).toBe('deny');
  });

  it('17. permission deny takes precedence over a budget breach', () => {
    const envelope = baseEnvelope({
      permissions: { can: [], cannot: ['place_call'] },
      budget: { max_concurrent: 1 },
    });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 99 });
    expect(r.decision).toBe('deny');
  });

  it('18. budget breach takes precedence over escalation rules', () => {
    const envelope = baseEnvelope({
      budget: { max_concurrent: 5 },
      escalation_rules: [{ trigger: 'fraud_signal_detected', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 10, fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('budget exceeded');
  });

  it('19. boundary: marginPct exactly equal to floor does not trigger (strict <)', () => {
    const envelope = baseEnvelope({
      policies: { margin_floor_pct: 8 },
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { marginPct: 8 });
    expect(r.decision).not.toBe('escalate');
  });

  it('20. boundary: confidence exactly equal to threshold does not trigger (strict <)', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [{ trigger: 'confidence_below_threshold', level: 'L2' }],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.7 });
    expect(r.reason).toContain('autonomy_default');
  });

  it('21. boundary: profit exactly equal to threshold does not trigger (strict >)', () => {
    const envelope = baseEnvelope({
      policies: { auto_book_profit_threshold_cad: 1000 },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 1000 });
    expect(r.reason).toContain('autonomy_default');
  });

  it('22. missing context field evaluates the trigger as false, does not throw', () => {
    const envelope = baseEnvelope({
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
      policies: { margin_floor_pct: 8 },
    });
    expect(() => applyEnvelope(envelope, 'book_load', {})).not.toThrow();
    expect(applyEnvelope(envelope, 'book_load', {}).decision).not.toBe('escalate');
  });

  it('23. deny reason references the action name', () => {
    const envelope = baseEnvelope({ permissions: { can: [], cannot: ['approve_high_risk_payer'] } });
    const r = applyEnvelope(envelope, 'approve_high_risk_payer', {});
    expect(r.reason).toContain('approve_high_risk_payer');
  });

  it('24. envelopeId is propagated regardless of decision path', () => {
    const envelope = baseEnvelope({ id: 42, permissions: { can: [], cannot: ['x'] } });
    expect(applyEnvelope(envelope, 'x', {}).envelopeId).toBe(42);
    expect(applyEnvelope(baseEnvelope({ id: 42 }), 'y', {}).envelopeId).toBe(42);
  });
});
```

- [ ] **Step 3: Run the tests (no DB needed)**

```bash
cd MyraTMS
pnpm vitest run lib/governance/__tests__/evaluate.test.ts
```

Expected: all 24 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/governance/evaluate.ts lib/governance/__tests__/evaluate.test.ts
git commit -m "T-18: add pure applyEnvelope() core with 24 unit test scenarios (acceptance criterion 3)"
```

---

### Task 6: Write the DB wrapper and its integration tests

**Files:**
- Create: `MyraTMS/lib/governance/evaluate-authority.ts`
- Create: `MyraTMS/__tests__/governance/evaluate-authority.test.ts`

**Interfaces:**
- Consumes: `applyEnvelope` (Task 5), `db` from `@/lib/pipeline/db-adapter`, tables from Task 2/3.
- Produces: `evaluateAuthority(input: EvaluationInput): Promise<EvaluationResult>` — the spec's exact external signature (§6). Consumed by Task 8 (replay harness) and Task 10 (API, indirectly via the evaluations it writes).

- [ ] **Step 1: Write the wrapper**

```typescript
import { db } from '@/lib/pipeline/db-adapter';
import { applyEnvelope } from './evaluate';
import type { AuthorityEnvelopeRow, EvaluationInput, EvaluationResult } from './types';

export async function evaluateAuthority(input: EvaluationInput): Promise<EvaluationResult> {
  const { agentKey, tenantId, action, context, sourceEventId, pipelineLoadId, correlationId } = input;

  const agentRow = await db.query<{ id: number }>(`SELECT id FROM agents WHERE agent_key = $1`, [agentKey]);
  if (agentRow.rows.length === 0) {
    throw new Error(`evaluateAuthority: unknown agent_key '${agentKey}'`);
  }
  const agentId = agentRow.rows[0].id;

  const envelopeRow = await db.query<AuthorityEnvelopeRow>(
    `SELECT id, agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
            confidence_threshold, autonomy_default, escalation_rules, is_active, effective_from,
            created_by, created_at
       FROM authority_envelopes
      WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true
      LIMIT 1`,
    [agentId, tenantId],
  );
  if (envelopeRow.rows.length === 0) {
    throw new Error(`evaluateAuthority: no active envelope for agent_key='${agentKey}' tenant_id=${tenantId}`);
  }
  const envelope = envelopeRow.rows[0];

  const result = applyEnvelope(envelope, action, context);

  const insertResult = await db.query<{ id: number }>(
    `INSERT INTO authority_evaluations (
       envelope_id, agent_id, tenant_id, pipeline_load_id, action, context,
       autonomy_level_applied, decision, reason, shadow_mode, source_event_id, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)
     ON CONFLICT (source_event_id) DO NOTHING
     RETURNING id`,
    [
      envelope.id, agentId, tenantId, pipelineLoadId ?? null, action, JSON.stringify(context),
      result.autonomyLevelApplied, result.decision, result.reason,
      sourceEventId ?? null, correlationId ?? null,
    ],
  );

  let evaluationId: number;
  if (insertResult.rows.length > 0) {
    evaluationId = insertResult.rows[0].id;
  } else if (sourceEventId != null) {
    // Already evaluated this source event in a prior replay run — idempotent no-op.
    const existing = await db.query<{
      id: number; decision: string; autonomy_level_applied: string; reason: string;
    }>(
      `SELECT id, decision, autonomy_level_applied, reason FROM authority_evaluations WHERE source_event_id = $1`,
      [sourceEventId],
    );
    const row = existing.rows[0];
    return {
      decision: row.decision as EvaluationResult['decision'],
      autonomyLevelApplied: row.autonomy_level_applied as EvaluationResult['autonomyLevelApplied'],
      reason: row.reason,
      envelopeId: envelope.id,
    };
  } else {
    throw new Error('evaluateAuthority: insert returned no row and sourceEventId is null — unexpected');
  }

  if (result.decision === 'escalate') {
    await db.query(
      `INSERT INTO escalations (evaluation_id, tenant_id, pipeline_load_id, severity, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [evaluationId, tenantId, pipelineLoadId ?? null, result.autonomyLevelApplied === 'L3' ? 'high' : 'medium'],
    );
  }

  return result;
}
```

- [ ] **Step 2: Write integration tests against the branch**

```typescript
/**
 * T-18 evaluateAuthority() integration tests — the DB wrapper around
 * applyEnvelope(). Point DATABASE_URL at the Neon verification branch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { evaluateAuthority } from '@/lib/governance/evaluate-authority';

const RUN_ID = `T18-EA-${Date.now()}`;
let agentId: number;
let envelopeId: number;

beforeAll(async () => {
  const agent = await db.query<{ id: number }>(
    `INSERT INTO agents (agent_key, display_name, agent_type, status)
     VALUES ($1, 'Test Agent', 'decision', 'shadow') RETURNING id`,
    [`${RUN_ID}-agent`],
  );
  agentId = agent.rows[0].id;

  const envelope = await db.query<{ id: number }>(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules
     ) VALUES ($1, 1, 1, $2, $3, $4, $5, 0.700, 'L2', $6)
     RETURNING id`,
    [
      agentId,
      `${RUN_ID}-envelope`,
      JSON.stringify({ can: ['test_action'], cannot: ['forbidden_action'] }),
      JSON.stringify({ max_concurrent: 5 }),
      JSON.stringify({ margin_floor_pct: 8 }),
      JSON.stringify([{ trigger: 'margin_below_floor', level: 'L3' }]),
    ],
  );
  envelopeId = envelope.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM escalations WHERE evaluation_id IN (SELECT id FROM authority_evaluations WHERE agent_id = $1)`, [agentId]);
  await db.query(`DELETE FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
  await db.query(`DELETE FROM authority_envelopes WHERE id = $1`, [envelopeId]);
  await db.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
});

describe('evaluateAuthority', () => {
  it('loads the active envelope, evaluates, and writes an authority_evaluations row', async () => {
    const result = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
    });
    expect(result.decision).toBe('allow');

    const rows = await db.query(`SELECT decision FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
    expect(rows.rows.length).toBe(1);
  });

  it('writes an escalations row when the decision is escalate', async () => {
    const result = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: { marginPct: 2 },
    });
    expect(result.decision).toBe('escalate');

    const esc = await db.query(
      `SELECT e.id FROM escalations e
         JOIN authority_evaluations ev ON ev.id = e.evaluation_id
        WHERE ev.agent_id = $1 AND ev.decision = 'escalate'`,
      [agentId],
    );
    expect(esc.rows.length).toBeGreaterThan(0);
  });

  it('is idempotent on source_event_id: a second call with the same sourceEventId does not duplicate', async () => {
    // source_event_id has an FK to events(id), so use a real row rather than a synthetic id.
    const realEvent = await db.query<{ id: number }>(
      `SELECT id FROM events ORDER BY id DESC LIMIT 1`,
    );
    const eventId = realEvent.rows[0].id;

    const first = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
      sourceEventId: eventId,
    });
    const second = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
      sourceEventId: eventId,
    });
    expect(second.decision).toBe(first.decision);

    const rows = await db.query(
      `SELECT id FROM authority_evaluations WHERE source_event_id = $1`,
      [eventId],
    );
    expect(rows.rows.length).toBe(1);
  });

  it('throws a clear error for an unknown agent_key', async () => {
    await expect(
      evaluateAuthority({ agentKey: 'does-not-exist', tenantId: 1, action: 'x', context: {} }),
    ).rejects.toThrow(/unknown agent_key/);
  });
});
```

- [ ] **Step 3: Run against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/governance/evaluate-authority.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/governance/evaluate-authority.ts __tests__/governance/evaluate-authority.test.ts
git commit -m "T-18: add evaluateAuthority() DB wrapper with idempotent source_event_id handling"
```

---

### Task 7: Write and run the seed script

**Files:**
- Create: `MyraTMS/scripts/t18_seed_governance.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter`, tables from Task 2/3.
- Produces: 10 seeded `agents` rows, 8 seeded `authority_envelopes` rows (one per existing worker; `negotiation`/`dispatch_one` get no envelope yet — future T-22/T-23 define their own).

- [ ] **Step 1: Write the seed script**

```typescript
/**
 * T-18 seed: 8 existing Engine 2 workers + 2 Phase-2 placeholders into
 * `agents` (all status='shadow' per T-18 §4.1 — no agent goes 'active'
 * until T-18b), plus default envelopes for the 8 existing workers.
 *
 * Reads the four kill-switch env vars from process.env at seed time (not
 * hardcoded), per the spec's own instruction, and prints the kill-switch
 * mapping table from T-18 §5.1 so Patrice can verify it field-by-field
 * (acceptance criterion 2).
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_seed_governance.ts
 */

import { db } from '../lib/pipeline/db-adapter';

interface AgentSeed {
  agent_key: string;
  display_name: string;
  agent_type: 'ingest' | 'decision' | 'communication' | 'financial' | 'orchestration';
  description: string;
}

const AGENTS: AgentSeed[] = [
  { agent_key: 'scanner', display_name: 'Scanner', agent_type: 'ingest', description: 'Pulls load candidates from load boards / CSV / scraper.' },
  { agent_key: 'qualifier', display_name: 'Qualifier', agent_type: 'decision', description: 'Filters loads for freshness, margin, equipment, DNC, fatigue.' },
  { agent_key: 'researcher', display_name: 'Researcher', agent_type: 'decision', description: 'Rate cascade + negotiation envelope calculation.' },
  { agent_key: 'ranker', display_name: 'Ranker', agent_type: 'decision', description: 'Carrier matching and scoring.' },
  { agent_key: 'compiler', display_name: 'Compiler', agent_type: 'decision', description: 'Compiles the negotiation brief and Retell payload.' },
  { agent_key: 'voice', display_name: 'Voice', agent_type: 'communication', description: 'Places carrier negotiation calls via Retell.' },
  { agent_key: 'dispatcher', display_name: 'Dispatcher', agent_type: 'orchestration', description: 'Books the load into the TMS and dispatches.' },
  { agent_key: 'feedback', display_name: 'Feedback', agent_type: 'decision', description: 'Scores outcomes, updates persona/shipper stats.' },
  { agent_key: 'negotiation', display_name: 'Negotiation (T-22, not yet built)', agent_type: 'communication', description: 'Placeholder for the bidirectional Negotiation Service.' },
  { agent_key: 'dispatch_one', display_name: 'Dispatch One (T-23, not yet built)', agent_type: 'orchestration', description: 'Placeholder for buy-side dispatch on behalf of owner-operators.' },
];

const VOICE_ENVELOPE_AGENT_KEY = 'voice';

async function seedAgents(): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const agent of AGENTS) {
    const r = await db.query<{ id: number }>(
      `INSERT INTO agents (agent_key, display_name, agent_type, status, description)
       VALUES ($1, $2, $3, 'shadow', $4)
       ON CONFLICT (agent_key) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [agent.agent_key, agent.display_name, agent.agent_type, agent.description],
    );
    ids.set(agent.agent_key, r.rows[0].id);
    console.log(`[t18-seed] agent '${agent.agent_key}' -> id ${r.rows[0].id}`);
  }
  return ids;
}

async function seedDefaultEnvelope(agentId: number, agentKey: string): Promise<void> {
  const existing = await db.query(
    `SELECT id FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = 1 AND is_active = true`,
    [agentId],
  );
  if (existing.rows.length > 0) {
    console.log(`[t18-seed] envelope for '${agentKey}' already exists — skipping`);
    return;
  }

  const isVoice = agentKey === VOICE_ENVELOPE_AGENT_KEY;
  const maxConcurrentCalls = Number(process.env.MAX_CONCURRENT_CALLS ?? '1');
  const autoBookThreshold = Number(process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999');

  const permissions = isVoice
    ? { can: ['contact_carrier', 'negotiate_rate', 'book_load'], cannot: ['override_fraud_flag', 'modify_carrier_banking', 'approve_high_risk_payer'] }
    : { can: [], cannot: [] };
  const tools = isVoice ? ['retell_api', 'pipeline_loads_read', 'negotiation_brief_read'] : [];
  const budget = isVoice ? { max_concurrent: maxConcurrentCalls, max_actions_per_day: 200 } : {};
  const policies = isVoice ? { margin_floor_pct: 8, auto_book_profit_threshold_cad: autoBookThreshold } : {};
  const escalationRules = isVoice
    ? [
        { trigger: 'fraud_signal_detected', level: 'L3' },
        { trigger: 'margin_below_floor', level: 'L3' },
        { trigger: 'confidence_below_threshold', level: 'L2' },
        { trigger: 'profit_above_auto_book_threshold', level: 'L1' },
      ]
    : [];

  await db.query(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules, created_by
     ) VALUES ($1, 1, 1, $2, $3, $4, $5, $6, 0.700, 'L2', $7, 'system')`,
    [
      agentId,
      `${agentKey}-myra-default`,
      JSON.stringify(permissions),
      JSON.stringify(tools),
      JSON.stringify(budget),
      JSON.stringify(policies),
      JSON.stringify(escalationRules),
    ],
  );
  console.log(`[t18-seed] default envelope created for '${agentKey}'`);
}

function printKillSwitchMapping(): void {
  const values = {
    PIPELINE_ENABLED: process.env.PIPELINE_ENABLED ?? '(unset)',
    SCANNER_ENABLED: process.env.SCANNER_ENABLED ?? '(unset)',
    MAX_CONCURRENT_CALLS: process.env.MAX_CONCURRENT_CALLS ?? '(unset)',
    AUTO_BOOK_PROFIT_THRESHOLD: process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '(unset)',
  };
  console.log('\n[t18-seed] kill-switch -> envelope mapping (T-18 §5.1), current values:');
  console.log(`  PIPELINE_ENABLED=${values.PIPELINE_ENABLED} -> platform-level all-agents is_active (documented parity only, not enforced by T-18)`);
  console.log(`  SCANNER_ENABLED=${values.SCANNER_ENABLED} -> agents.status for agent_key='scanner' (all agents seeded 'shadow' regardless, per spec §4.1)`);
  console.log(`  MAX_CONCURRENT_CALLS=${values.MAX_CONCURRENT_CALLS} -> voice envelope budget.max_concurrent (live value, seeded above)`);
  console.log(`  AUTO_BOOK_PROFIT_THRESHOLD=${values.AUTO_BOOK_PROFIT_THRESHOLD} -> voice envelope policies.auto_book_profit_threshold_cad`);
  console.log(`    *** NOTE: traced through lib/pipeline/retell-webhook.ts — this env var is only logged at`);
  console.log(`    *** worker-host startup, never actually read in the auto_book_eligible decision path`);
  console.log(`    *** (that uses brief.rates.minMargin instead). This mapping row is ASPIRATIONAL PARITY, not a live gate.`);
}

async function main(): Promise<void> {
  const agentIds = await seedAgents();
  for (const agent of AGENTS) {
    if (agent.agent_key === 'negotiation' || agent.agent_key === 'dispatch_one') continue; // no envelope yet — future modules define their own
    await seedDefaultEnvelope(agentIds.get(agent.agent_key)!, agent.agent_key);
  }
  printKillSwitchMapping();
}

main()
  .then(() => {
    console.log('\n[t18-seed] done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[t18-seed] failed:', err);
    process.exit(1);
  });
```

- [ ] **Step 2: Run against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/t18_seed_governance.ts
```

Expected: 10 agents logged, 8 envelopes created, kill-switch mapping table printed with real values.

- [ ] **Step 3: Verify via SQL**

Call `mcp__Neon__run_sql` against the branch:

```sql
SELECT
  (SELECT COUNT(*) FROM agents WHERE status = 'shadow') AS shadow_agent_count,
  (SELECT COUNT(*) FROM agents) AS total_agents,
  (SELECT COUNT(*) FROM authority_envelopes WHERE is_active = true) AS active_envelope_count;
```

Expected: `shadow_agent_count=10`, `total_agents=10`, `active_envelope_count=8`.

- [ ] **Step 4: Commit**

```bash
git add scripts/t18_seed_governance.ts
git commit -m "T-18: add seed script — 10 agents + 8 default envelopes from real env values (acceptance criteria 1, 2)"
```

---

### Task 8: Write and run the replay harness

**Files:**
- Create: `MyraTMS/scripts/t18_replay_shadow_evaluation.ts`

**Interfaces:**
- Consumes: `db`, `evaluateAuthority` (Task 6), `events` table (T-17).
- Produces: `runReplay(): Promise<{ processed: number; errors: number }>`.

- [ ] **Step 1: Write the replay harness**

```typescript
/**
 * T-18 replay harness: feeds T-17's `events` through evaluateAuthority()
 * in shadow mode, after the fact. Idempotent via authority_evaluations'
 * UNIQUE (source_event_id) — safe to re-run.
 *
 * Currently maps only 'call.initiated' events (the base spec's own worked
 * example, T-18 §3) to the 'voice' agent's 'place_call' action. Other event
 * types can be added to EVENT_TYPE_MAP as later modules define their own
 * agents/actions — this harness doesn't need to change shape to grow.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_replay_shadow_evaluation.ts
 */

import { db } from '../lib/pipeline/db-adapter';
import { evaluateAuthority } from '../lib/governance/evaluate-authority';

interface ReplayableEvent {
  id: number;
  tenant_id: number;
  pipeline_load_id: number | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
}

const EVENT_TYPE_MAP: Record<string, { agentKey: string; action: string }> = {
  'call.initiated': { agentKey: 'voice', action: 'place_call' },
};

export async function runReplay(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const [eventType, mapping] of Object.entries(EVENT_TYPE_MAP)) {
    const rows = await db.query<ReplayableEvent>(
      `SELECT e.id, e.tenant_id, e.pipeline_load_id, e.payload, e.correlation_id
         FROM events e
        WHERE e.event_type = $1
          AND NOT EXISTS (SELECT 1 FROM authority_evaluations ae WHERE ae.source_event_id = e.id)
        ORDER BY e.id`,
      [eventType],
    );

    for (const event of rows.rows) {
      try {
        await evaluateAuthority({
          agentKey: mapping.agentKey,
          tenantId: event.tenant_id,
          action: mapping.action,
          context: event.payload,
          sourceEventId: event.id,
          pipelineLoadId: event.pipeline_load_id ?? undefined,
          correlationId: event.correlation_id ?? undefined,
        });
        processed++;
      } catch (err) {
        errors++;
        console.error(`[t18-replay] failed on event ${event.id}:`, err);
      }
    }
    console.log(`[t18-replay] ${eventType}: ${rows.rows.length} events processed`);
  }

  return { processed, errors };
}

const isMainModule = process.argv[1]?.endsWith('t18_replay_shadow_evaluation.ts') ?? false;
if (isMainModule) {
  runReplay()
    .then(({ processed, errors }) => {
      console.log(`[t18-replay] done — ${processed} processed, ${errors} errors`);
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[t18-replay] fatal:', err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Run against the branch (must run after Task 7's seed and after T-17's backfill — both already present on this branch)**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/t18_replay_shadow_evaluation.ts
```

Expected: processes every `call.initiated` event from T-17's backfilled data, zero errors (acceptance criterion 4). If the branch's `agent_calls` table is empty (shadow-drain mode never placed real calls — confirmed true on the T-17 branch), this will legitimately process 0 events; that is not a failure, it's the same "shadow drain never called anyone" fact T-17 already established. If it processes 0 because of that, note it in Task 12's report rather than treating it as broken.

- [ ] **Step 3: Re-run to confirm idempotency**

Repeat Step 2 — expect the same `processed` count to be skipped (0 newly processed, since `NOT EXISTS` filters out already-evaluated events), zero errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/t18_replay_shadow_evaluation.ts
git commit -m "T-18: add replay harness (acceptance criterion 4)"
```

---

### Task 9: Write and run the disagreement report

**Files:**
- Create: `MyraTMS/scripts/t18_disagreement_report.ts`

**Interfaces:**
- Consumes: `db`, `events` and `authority_evaluations` tables.
- Produces: a printed report — not required to be a library function, this is a one-shot reporting script per spec §11 criterion 5.

- [ ] **Step 1: Write the report script**

```typescript
/**
 * T-18 disagreement report (acceptance criterion 5): for every load where
 * events shows load.escalated actually happened, checks whether the T-18
 * shadow judgment on that load's calls also said 'escalate'. Not required
 * to be 100% agreement — the spec explicitly expects disagreement early;
 * this script only has to measure and report it.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t18_disagreement_report.ts
 */

import { db } from '../lib/pipeline/db-adapter';

interface EscalatedLoad {
  pipeline_load_id: number;
}

async function main(): Promise<void> {
  const escalatedLoads = await db.query<EscalatedLoad>(
    `SELECT DISTINCT pipeline_load_id FROM events
      WHERE event_type = 'load.escalated' AND pipeline_load_id IS NOT NULL`,
  );

  let agree = 0;
  let disagree = 0;
  let noShadowJudgment = 0;

  for (const { pipeline_load_id } of escalatedLoads.rows) {
    const shadow = await db.query<{ decision: string }>(
      `SELECT decision FROM authority_evaluations WHERE pipeline_load_id = $1`,
      [pipeline_load_id],
    );
    if (shadow.rows.length === 0) {
      noShadowJudgment++;
      continue;
    }
    const anyEscalate = shadow.rows.some((r) => r.decision === 'escalate');
    if (anyEscalate) agree++;
    else disagree++;
  }

  const total = escalatedLoads.rows.length;
  console.log('[t18-disagreement-report] loads where Engine 2 actually escalated:', total);
  console.log(`  agree (T-18 shadow also said escalate):     ${agree}`);
  console.log(`  disagree (T-18 shadow said allow/deny):     ${disagree}`);
  console.log(`  no shadow judgment recorded for this load:  ${noShadowJudgment}`);
  console.log(
    total > 0
      ? `  agreement rate (of loads with a shadow judgment): ${
          agree + disagree > 0 ? ((agree / (agree + disagree)) * 100).toFixed(1) : 'n/a'
        }%`
      : '  no escalated loads found in this dataset',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[t18-disagreement-report] failed:', err);
    process.exit(1);
  });
```

- [ ] **Step 2: Run against the branch and record the output verbatim for Task 12's report**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/t18_disagreement_report.ts
```

Expected: a printed report with a measured rate (not a pass/fail assertion — acceptance criterion 5 requires measurement, not 100% agreement). If `total=0` (the 75-load shadow-drain dataset may have zero loads that reached `load.escalated`), report that honestly rather than fabricating a rate.

- [ ] **Step 3: Commit**

```bash
git add scripts/t18_disagreement_report.ts
git commit -m "T-18: add disagreement report script (acceptance criterion 5)"
```

---

### Task 10: Write the 5 API endpoints and their tests

**Files:**
- Create: `MyraTMS/lib/governance/api-helpers.ts`
- Create: `MyraTMS/app/api/agents/route.ts`
- Create: `MyraTMS/app/api/agents/[agentKey]/envelope/route.ts`
- Create: `MyraTMS/app/api/evaluations/route.ts`
- Create: `MyraTMS/app/api/escalations/route.ts`
- Create: `MyraTMS/app/api/escalations/[id]/route.ts`
- Create: `MyraTMS/__tests__/governance/api.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser`/`requireRole` from `@/lib/auth`, `apiError`, `db`, types from Task 4.

- [ ] **Step 1: Write shared API helpers**

```typescript
import type { NextRequest } from 'next/server';
import { getCurrentUser, requireRole, type JwtPayload } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

export function authorizeGovernanceRequest(req: NextRequest): { user: JwtPayload } | { error: Response } {
  const user = getCurrentUser(req);
  if (!user) return { error: apiError('Unauthorized', 401) };
  const denied = requireRole(user, 'admin', 'ops');
  if (denied) return { error: denied };
  return { user };
}

export function resolveTenantId(searchParams: URLSearchParams, user: JwtPayload): number {
  const requested = searchParams.get('tenant_id');
  if (requested && user.isSuperAdmin) {
    const parsed = Number(requested);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return user.tenantId;
}
```

- [ ] **Step 2: `GET /api/agents`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AgentRow {
  id: number;
  agent_key: string;
  display_name: string;
  agent_type: string;
  status: string;
  description: string | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  try {
    const r = await db.query<AgentRow>(
      `SELECT id, agent_key, display_name, agent_type, status, description FROM agents ORDER BY id`,
    );
    return NextResponse.json({ agents: r.rows });
  } catch (err) {
    logger.error('[agents GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 });
  }
}
```

- [ ] **Step 3: `GET`/`POST /api/agents/[agentKey]/envelope`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import type { AuthorityEnvelopeRow } from '@/lib/governance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getAgentId(agentKey: string): Promise<number | null> {
  const r = await db.query<{ id: number }>(`SELECT id FROM agents WHERE agent_key = $1`, [agentKey]);
  return r.rows[0]?.id ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentKey: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { agentKey } = await params;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  const agentId = await getAgentId(agentKey);
  if (agentId === null) return NextResponse.json({ error: 'unknown_agent' }, { status: 404 });

  try {
    const r = await db.query<AuthorityEnvelopeRow>(
      `SELECT * FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true`,
      [agentId, tenantId],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'no_active_envelope' }, { status: 404 });
    return NextResponse.json({ envelope: r.rows[0] });
  } catch (err) {
    logger.error('[agents/:agentKey/envelope GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load envelope' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentKey: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { agentKey } = await params;
  const agentId = await getAgentId(agentKey);
  if (agentId === null) return NextResponse.json({ error: 'unknown_agent' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Same gate as every other tenant-scoped write in this codebase: only a
  // super-admin may target a tenant_id other than their own, whether it
  // arrives via query string (resolveTenantId's normal path) or, here, the
  // body. A body.tenant_id from a non-super-admin is silently ignored
  // rather than trusted, so an ordinary admin/ops user can't write another
  // tenant's envelope by passing a different id in the payload.
  const bodyTenantParams = new URLSearchParams();
  if (typeof body.tenant_id === 'number') bodyTenantParams.set('tenant_id', String(body.tenant_id));
  const tenantId = resolveTenantId(bodyTenantParams, user);

  try {
    const current = await db.query<{ id: number; version: number }>(
      `SELECT id, version FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true`,
      [agentId, tenantId],
    );
    const nextVersion = (current.rows[0]?.version ?? 0) + 1;

    if (current.rows.length > 0) {
      await db.query(`UPDATE authority_envelopes SET is_active = false WHERE id = $1`, [current.rows[0].id]);
    }

    const inserted = await db.query<{ id: number }>(
      `INSERT INTO authority_envelopes (
         agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
         confidence_threshold, autonomy_default, escalation_rules, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        agentId, tenantId, nextVersion,
        body.envelope_name ?? `${agentKey}-v${nextVersion}`,
        JSON.stringify(body.permissions ?? { can: [], cannot: [] }),
        JSON.stringify(body.tools ?? []),
        JSON.stringify(body.budget ?? {}),
        JSON.stringify(body.policies ?? {}),
        typeof body.confidence_threshold === 'number' ? body.confidence_threshold : 0.7,
        body.autonomy_default ?? 'L2',
        JSON.stringify(body.escalation_rules ?? []),
        user.userId,
      ],
    );

    logger.info(`[agents/:agentKey/envelope POST] new envelope v${nextVersion} for agent=${agentKey} by user=${user.userId}`);
    return NextResponse.json({ envelope_id: inserted.rows[0].id, version: nextVersion }, { status: 201 });
  } catch (err) {
    logger.error('[agents/:agentKey/envelope POST] failed', err);
    return NextResponse.json({ error: 'Failed to create envelope version' }, { status: 500 });
  }
}
```

- [ ] **Step 4: `GET /api/evaluations`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const agentId = searchParams.get('agent_id');
  const decision = searchParams.get('decision');
  const since = searchParams.get('since');

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (agentId) {
    params.push(Number(agentId));
    conditions.push(`agent_id = $${params.length}`);
  }
  if (decision) {
    params.push(decision);
    conditions.push(`decision = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conditions.push(`evaluated_at >= $${params.length}`);
  }

  try {
    const r = await db.query(
      `SELECT id, envelope_id, agent_id, tenant_id, pipeline_load_id, action, context,
              autonomy_level_applied, decision, reason, shadow_mode, source_event_id,
              evaluated_at, correlation_id
         FROM authority_evaluations
        WHERE ${conditions.join(' AND ')}
        ORDER BY evaluated_at DESC
        LIMIT 200`,
      params,
    );
    return NextResponse.json({ evaluations: r.rows });
  } catch (err) {
    logger.error('[evaluations GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load evaluations' }, { status: 500 });
  }
}
```

- [ ] **Step 5: `GET /api/escalations` and `PATCH /api/escalations/[id]`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const status = searchParams.get('status') ?? 'pending';

  try {
    const r = await db.query(
      `SELECT id, evaluation_id, tenant_id, pipeline_load_id, severity, status,
              assigned_to, resolution_note, created_at, resolved_at
         FROM escalations
        WHERE tenant_id = $1 AND status = $2
        ORDER BY created_at DESC
        LIMIT 200`,
      [tenantId, status],
    );
    return NextResponse.json({ escalations: r.rows });
  } catch (err) {
    logger.error('[escalations GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load escalations' }, { status: 500 });
  }
}
```

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['pending', 'approved', 'rejected', 'expired'];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { status?: string; resolution_note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.status || !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  try {
    const r = await db.query<{ id: number }>(
      `UPDATE escalations
          SET status = $1, resolution_note = $2, assigned_to = $3,
              resolved_at = CASE WHEN $1 IN ('approved','rejected') THEN NOW() ELSE resolved_at END
        WHERE id = $4
        RETURNING id`,
      [body.status, body.resolution_note ?? null, user.userId, id],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    logger.info(`[escalations/:id PATCH] escalation=${id} -> ${body.status} by user=${user.userId} (shadow mode — no live consequence)`);
    return NextResponse.json({ id, status: body.status });
  } catch (err) {
    logger.error('[escalations/:id PATCH] failed', err);
    return NextResponse.json({ error: 'Failed to update escalation' }, { status: 500 });
  }
}
```

- [ ] **Step 6: Write the API test suite**

```typescript
/**
 * T-18 API verification — auth boundary and response shape for all 5 endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { db } from '@/lib/pipeline/db-adapter';
import { GET as agentsGet } from '@/app/api/agents/route';
import { GET as envelopeGet, POST as envelopePost } from '@/app/api/agents/[agentKey]/envelope/route';
import { GET as evaluationsGet } from '@/app/api/evaluations/route';
import { GET as escalationsGet } from '@/app/api/escalations/route';
import { PATCH as escalationPatch } from '@/app/api/escalations/[id]/route';

const RUN_ID = `T18-API-${Date.now()}`;

function tokenFor(role: string): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role,
    firstName: 'Test', lastName: 'User', tenantId: 1, tenantIds: [1],
  });
}

function requestWithCookie(path: string, token?: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  if (token) headers.set('cookie', `auth-token=${token}`);
  return new NextRequest(`http://localhost${path}`, { ...init, headers });
}

let escalationId: number;
let agentId: number;

beforeAll(async () => {
  const agent = await db.query<{ id: number }>(
    `INSERT INTO agents (agent_key, display_name, agent_type, status) VALUES ($1, 'API Test Agent', 'decision', 'shadow') RETURNING id`,
    [`${RUN_ID}-agent`],
  );
  agentId = agent.rows[0].id;
  const evaluation = await db.query<{ id: number }>(
    `INSERT INTO authority_evaluations (envelope_id, agent_id, tenant_id, action, autonomy_level_applied, decision, shadow_mode)
     VALUES (
       (SELECT id FROM authority_envelopes LIMIT 1),
       $1, 1, 'test_action', 'L3', 'escalate', true
     ) RETURNING id`,
    [agentId],
  );
  const escalation = await db.query<{ id: number }>(
    `INSERT INTO escalations (evaluation_id, tenant_id, severity, status) VALUES ($1, 1, 'medium', 'pending') RETURNING id`,
    [evaluation.rows[0].id],
  );
  escalationId = escalation.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM escalations WHERE id = $1`, [escalationId]);
  await db.query(`DELETE FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
  await db.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
});

describe('T-18 governance API', () => {
  it('GET /api/agents rejects unauthenticated requests', async () => {
    const res = await agentsGet(requestWithCookie('/api/agents'));
    expect(res.status).toBe(401);
  });

  it('GET /api/agents returns the seeded agents for an admin', async () => {
    const res = await agentsGet(requestWithCookie('/api/agents', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(10);
  });

  it('GET /api/agents/voice/envelope returns the seeded voice envelope', async () => {
    const res = await envelopeGet(requestWithCookie('/api/agents/voice/envelope', tokenFor('admin')), {
      params: Promise.resolve({ agentKey: 'voice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope.envelope_name).toContain('voice');
  });

  it('POST /api/agents/:agentKey/envelope creates a new version and deactivates the old one', async () => {
    const res = await envelopePost(
      requestWithCookie(`/api/agents/${RUN_ID}-agent/envelope`, tokenFor('admin'), {
        method: 'POST',
        body: JSON.stringify({ envelope_name: 'v2-test', autonomy_default: 'L1' }),
      }),
      { params: Promise.resolve({ agentKey: `${RUN_ID}-agent` }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version).toBe(1); // first envelope for this fresh test agent
  });

  it('GET /api/evaluations returns rows for an admin', async () => {
    const res = await evaluationsGet(requestWithCookie('/api/evaluations?decision=escalate', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.evaluations)).toBe(true);
  });

  it('GET /api/escalations?status=pending includes the seeded escalation', async () => {
    const res = await escalationsGet(requestWithCookie('/api/escalations?status=pending', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.escalations.some((e: { id: number }) => e.id === escalationId)).toBe(true);
  });

  it('PATCH /api/escalations/:id updates status (no live consequence, shadow mode)', async () => {
    const res = await escalationPatch(
      requestWithCookie(`/api/escalations/${escalationId}`, tokenFor('admin'), {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved', resolution_note: 'test approval' }),
      }),
      { params: Promise.resolve({ id: String(escalationId) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
  });
});
```

- [ ] **Step 7: Run against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/governance/api.test.ts
```

Expected: all 7 tests pass (acceptance criterion 7 — all five endpoints respond correctly against seeded data).

- [ ] **Step 8: Commit**

```bash
git add lib/governance/api-helpers.ts app/api/agents app/api/evaluations app/api/escalations __tests__/governance/api.test.ts
git commit -m "T-18: add 5 governance API endpoints and test suite (acceptance criterion 7)"
```

---

### Task 11: Run the full regression suite (T-16 + T-17 + T-18)

**Files:** None.

- [ ] **Step 1: Run everything against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/ __tests__/governance/ lib/governance/__tests__/
```

Expected: zero regressions in the existing worker suite (acceptance criterion 6), all T-17 tests still pass, all new T-18 tests pass. If `ranker.test.ts` times out again, that's the same pre-existing matching-engine characteristic against production-scale carrier data already diagnosed and documented during T-17 — not a new regression. Diagnose anything else that fails the same way T-17's Task 10 did: don't assume, reproduce directly against the branch via `mcp__Neon__run_sql` before concluding it's unrelated.

---

### Task 12: Final acceptance-criteria checklist and handoff

**Files:** None — update `Engine 3/docs/superpowers/plans/completion.md` with the final T-18 status (per the standing completion-tracker rule), but do not touch production.

- [ ] **Step 1: Walk all 7 acceptance criteria explicitly**

| # | Criterion | Verified by |
|---|---|---|
| 1 | `agents` seeded: 8 workers + `negotiation` + `dispatch_one`, all `status='shadow'` | Task 7 |
| 2 | Default envelopes for all 8 existing agents, kill-switch mapping verified field-by-field | Task 7 (includes the `AUTO_BOOK_PROFIT_THRESHOLD` inertness finding) |
| 3 | `evaluateAuthority()` (via `applyEnvelope`) tested against ≥20 scenarios | Task 5 — 24 scenarios |
| 4 | Replay harness runs against T-17 backfill, zero errors | Task 8 |
| 5 | Disagreement rate measured and reported | Task 9 |
| 6 | Zero live-call-path changes, T-16 suite green | Task 11 |
| 7 | All 5 API endpoints respond correctly | Task 10 |

- [ ] **Step 2: Update the Engine 3 completion tracker**

Mark T-18's remaining checklist items done in `Engine 3/docs/superpowers/plans/completion.md`, log the disagreement-report numbers from Task 9 inline (not just "measured" — the actual figures), and bump **Last updated**.

- [ ] **Step 3: Report to Patrice — do not apply to production**

Summarize: branch ID/name, all 7 acceptance criteria status, the disagreement report's actual numbers, and the production apply command:

```bash
cd MyraTMS
pnpm tsx scripts/apply-pipeline-migration.ts 034-agent-runtime-governance.sql
DATABASE_URL="<production DATABASE_URL>" pnpm tsx scripts/t18_seed_governance.ts
DATABASE_URL="<production DATABASE_URL>" pnpm tsx scripts/t18_replay_shadow_evaluation.ts
```

Per the design doc's session-scope decision, do not run these against production in this session — Patrice's call after reviewing the branch results, same as T-17.

No commit for this step beyond the completion-tracker update — this is a status report, not a code change.
