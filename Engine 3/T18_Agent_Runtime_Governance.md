---
title: Agent Runtime & Governance
id: T-18
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-02, T-03, T-17, E3-00]
referenced_by: [T-19, T-20, T-21, T-22, T-23, T-24, T-25, T-26, T-29]
---

# T-18 — AGENT RUNTIME & GOVERNANCE

**Engine 3 · Phase 1 · Module 2 of 3 (with T-17, T-19)**
**Parent:** E3-00 Master PRD §5.3, §17 (Agent Governance)
**Precondition:** T-17 (Event & Data Layer) deployed — this module reads from `events`.
**Hard constraint:** Zero changes to the live call path until the Phase 0 handoff gate (E3-00 §9).

---

## 1. Objective

Turn the "authority envelope" concept from E3-00 §5.3 into a real, versioned, database-backed system — and prove it works against real Engine 2 behavior before it is ever allowed to block or approve anything live.

Today, Engine 2's authority model is four global environment variables: `PIPELINE_ENABLED`, `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS`, `AUTO_BOOK_PROFIT_THRESHOLD`. That works for one tenant and eight fixed agents. It does not work for a multi-tenant platform where a Broker tenant's Voice agent needs a different margin floor than a Carrier tenant's, or where a new agent (Negotiation, T-22) needs its own envelope without a code deploy.

T-18 replaces "blunt global switch" with "versioned per-agent, per-tenant policy object, evaluated by a runtime, every decision logged" — while running in **shadow mode**: it observes and records what it would have decided, using T-17's event stream, without being wired into any worker's actual control flow.

---

## 2. Scope

**In scope:**

- `agents` registry table — one row per agent type that exists or is planned
- `authority_envelopes` table — the versioned policy object per (agent, tenant)
- `authority_evaluations` table — append-only audit log of every evaluation
- `escalations` table — L3 candidates awaiting human decision (seeds T-24's console)
- `evaluateAuthority()` — the runtime library that applies an envelope to an action and returns a decision
- A **replay harness** that feeds T-17's `events` through `evaluateAuthority()` after the fact, in shadow mode, to validate the governance model against real Engine 2 behavior
- A documented mapping from the four existing env-var kill switches to their envelope equivalents
- Read/write API for envelope management and an audit query API

**Out of scope (explicitly deferred to T-18b):**

- Wiring `evaluateAuthority()` into any live worker (`base-worker.ts`, `voice-worker.ts`, `dispatcher-worker.ts`, `compiler-worker.ts`)
- Replacing the four existing env-var kill switches with live envelope enforcement
- The Human Escalation Console UI (T-24 builds the interface; T-18 only builds the `escalations` table it will read from)
- Budgets denominated in real spend limits enforced pre-transaction (T-27, Finance Orchestration, owns real spend gating)

---

## 3. Design decision: shadow governance, mirrored from T-17

The same constraint that shaped T-17 applies here: nothing in Phase 1 may touch the call path. A governance layer that *decides* whether the Voice agent is allowed to call is, by definition, in the call path if wired live.

T-18 therefore ships as a **shadow evaluator**. It runs `evaluateAuthority()` against events *after they already happened*, sourced from T-17's `events` table, and records what the decision would have been — allow, escalate, or deny — without that decision ever influencing Engine 2. This is the same pattern as the existing 75-load shadow drain referenced in T-00 §3: prove the model against real behavior before it's allowed to act.

Concretely: when `events` gets a `call.initiated` row, a background job (not a trigger — this one has real evaluation logic, so it runs as a polling worker outside any live queue) evaluates it against the Voice agent's active envelope and writes an `authority_evaluations` row. If Engine 2 already recorded the load as `escalated`, T-18's independent shadow judgment can be compared against what actually happened — that comparison is the validation.

**T-18b** (deferred, gated on the Phase 0 handoff, E3-00 §9) wires `evaluateAuthority()` into the real decision path so it can actually block or approve. That is a separate, explicitly scoped change with its own review — not part of this spec.

---

## 4. Data model

### 4.1 `agents` — registry

```sql
CREATE TABLE IF NOT EXISTS agents (
    id              SERIAL PRIMARY KEY,
    agent_key       VARCHAR(40)  UNIQUE NOT NULL,  -- 'scanner' | 'qualifier' | 'researcher' |
                                                     -- 'ranker' | 'compiler' | 'voice' |
                                                     -- 'dispatcher' | 'feedback' | 'negotiation' |
                                                     -- 'dispatch_one' | ...
    display_name    VARCHAR(100) NOT NULL,
    agent_type      VARCHAR(30)  NOT NULL,          -- 'ingest' | 'decision' | 'communication' |
                                                     -- 'financial' | 'orchestration'
    status          VARCHAR(20)  NOT NULL DEFAULT 'shadow',  -- 'shadow' | 'active' | 'disabled'
    description     TEXT,
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
```

Seeded with the 8 existing Engine 2 workers plus placeholders for `negotiation` (T-22) and `dispatch_one` — all at `status = 'shadow'`. No agent moves to `status = 'active'` until T-18b.

### 4.2 `authority_envelopes` — the policy object

```sql
CREATE TABLE IF NOT EXISTS authority_envelopes (
    id                    SERIAL PRIMARY KEY,
    agent_id              INTEGER NOT NULL REFERENCES agents(id),
    tenant_id             INTEGER NOT NULL DEFAULT 1,
    version               INTEGER NOT NULL DEFAULT 1,

    -- Identity
    envelope_name         VARCHAR(100) NOT NULL,

    -- Permissions: explicit CAN / CANNOT action lists
    permissions           JSONB NOT NULL DEFAULT '{"can": [], "cannot": []}',

    -- Tools this agent may invoke
    tools                 JSONB NOT NULL DEFAULT '[]',

    -- Budget: numeric ceilings, mirrors old env vars
    budget                JSONB NOT NULL DEFAULT '{}',
    -- e.g. {"max_concurrent": 5, "max_actions_per_day": 200, "max_spend_per_day_cad": 500}

    -- Policy: business-rule thresholds
    policies              JSONB NOT NULL DEFAULT '{}',
    -- e.g. {"margin_floor_pct": 8, "auto_book_profit_threshold_cad": 999999}

    confidence_threshold  NUMERIC(4,3) DEFAULT 0.700,

    -- Default autonomy level if no rule matches (E3-00 §5.1)
    autonomy_default      VARCHAR(2) NOT NULL DEFAULT 'L2',  -- 'L1' | 'L2' | 'L3'

    -- Escalation rules: ordered list of {trigger, level}
    escalation_rules      JSONB NOT NULL DEFAULT '[]',

    is_active             BOOLEAN NOT NULL DEFAULT true,
    effective_from        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by             VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (agent_id, tenant_id, version)
);

CREATE INDEX idx_envelopes_active ON authority_envelopes(agent_id, tenant_id) WHERE is_active;
```

Versioned, never mutated in place — a policy change inserts a new row and flips `is_active` on the old one. This gives a free audit trail of "what did the rules say on date X."

### 4.3 `authority_evaluations` — append-only decision log

```sql
CREATE TABLE IF NOT EXISTS authority_evaluations (
    id                     BIGSERIAL PRIMARY KEY,
    envelope_id            INTEGER NOT NULL REFERENCES authority_envelopes(id),
    agent_id               INTEGER NOT NULL REFERENCES agents(id),
    tenant_id              INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id),

    action                 VARCHAR(60) NOT NULL,   -- e.g. 'place_call', 'auto_book', 'dispatch'
    context                JSONB NOT NULL DEFAULT '{}',

    autonomy_level_applied VARCHAR(2) NOT NULL,     -- 'L1' | 'L2' | 'L3'
    decision               VARCHAR(20) NOT NULL,    -- 'allow' | 'escalate' | 'deny'
    reason                 TEXT,

    shadow_mode            BOOLEAN NOT NULL DEFAULT true,  -- always true until T-18b
    source_event_id        BIGINT REFERENCES events(id),   -- the T-17 event this was evaluated from

    evaluated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id            VARCHAR(100)
);

CREATE INDEX idx_evaluations_agent_time ON authority_evaluations(agent_id, evaluated_at DESC);
CREATE INDEX idx_evaluations_decision ON authority_evaluations(decision, evaluated_at DESC);
CREATE INDEX idx_evaluations_load ON authority_evaluations(pipeline_load_id);
```

### 4.4 `escalations` — L3 queue (seeds T-24)

```sql
CREATE TABLE IF NOT EXISTS escalations (
    id                  SERIAL PRIMARY KEY,
    evaluation_id        INTEGER NOT NULL REFERENCES authority_evaluations(id),
    tenant_id            INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id     INTEGER REFERENCES pipeline_loads(id),

    severity              VARCHAR(20) NOT NULL DEFAULT 'medium',  -- 'low' | 'medium' | 'high' | 'critical'
    status                 VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'expired'

    assigned_to             VARCHAR(100),
    resolution_note          TEXT,

    created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at                TIMESTAMP
);

CREATE INDEX idx_escalations_status ON escalations(tenant_id, status, created_at);
```

In shadow mode, rows here are informational only — nothing is actually waiting on them. T-24 gives them a real console and real consequence.

---

## 5. The authority envelope: worked example

Following E3-00 §17's format, this is what the Voice/Negotiation agent's envelope looks like once expressed concretely, mapped from today's env vars:

```json
{
  "envelope_name": "voice-agent-myra-default",
  "permissions": {
    "can": ["contact_carrier", "negotiate_rate", "book_load"],
    "cannot": ["override_fraud_flag", "modify_carrier_banking", "approve_high_risk_payer"]
  },
  "tools": ["retell_api", "pipeline_loads_read", "negotiation_brief_read"],
  "budget": {
    "max_concurrent": 5,
    "max_actions_per_day": 200
  },
  "policies": {
    "margin_floor_pct": 8,
    "auto_book_profit_threshold_cad": 999999
  },
  "confidence_threshold": 0.700,
  "autonomy_default": "L2",
  "escalation_rules": [
    { "trigger": "fraud_signal_detected", "level": "L3" },
    { "trigger": "margin_below_floor", "level": "L3" },
    { "trigger": "confidence_below_threshold", "level": "L2" },
    { "trigger": "profit_above_auto_book_threshold", "level": "L1" }
  ]
}
```

### 5.1 Kill-switch → envelope mapping

| Existing env var | Envelope field | Notes |
|---|---|---|
| `PIPELINE_ENABLED` | Platform-level: all agents' `is_active = false` for tenant | Still a real env var in T-18b; here it's documented parity only |
| `SCANNER_ENABLED` | `agents.status` for `agent_key = 'scanner'` | Same |
| `MAX_CONCURRENT_CALLS` | `voice` agent envelope, `budget.max_concurrent` | Same numeric value, now per-tenant |
| `AUTO_BOOK_PROFIT_THRESHOLD` | `voice` agent envelope, `policies.auto_book_profit_threshold_cad` | Same numeric value, drives the `L1` escalation rule |

This table is a deliverable of T-18, not just documentation — it is how Patrice verifies the new system agrees with the old one before anything is cut over.

---

## 6. The runtime

```typescript
interface EvaluationInput {
  agentKey: string;
  tenantId: number;
  action: string;
  context: Record<string, any>;   // e.g. { profit: 340, confidence: 0.82, pipelineLoadId: 1044 }
  sourceEventId?: number;
}

interface EvaluationResult {
  decision: 'allow' | 'escalate' | 'deny';
  autonomyLevelApplied: 'L1' | 'L2' | 'L3';
  reason: string;
  envelopeId: number;
}

async function evaluateAuthority(input: EvaluationInput): Promise<EvaluationResult> {
  // 1. Load active envelope for (agentKey, tenantId)
  // 2. Check permissions.cannot — if action is listed, decision = 'deny'
  // 3. Check budget — if a numeric limit in context exceeds budget, decision = 'escalate' or 'deny'
  // 4. Walk escalation_rules in order — first matching trigger sets autonomyLevelApplied
  // 5. Map level to decision: L1 -> allow, L2 -> allow (with audit), L3 -> escalate
  // 6. Write authority_evaluations row (shadow_mode = true)
  // 7. If decision === 'escalate', write escalations row
  // 8. Return result
}
```

This function has zero callers inside any existing worker in this spec. Its only caller in T-18 is the replay harness (§7).

---

## 7. Replay harness

`scripts/t18_replay_shadow_evaluation.ts` — polls `events` (from T-17) for new rows on a schedule (e.g., every 5 minutes, or run once against the full backfill), maps each relevant `event_type` to an `evaluateAuthority()` call, and writes the resulting evaluation. Idempotent via a `source_event_id` uniqueness check.

This is what proves the model: run it against the 75-load shadow drain and any real Pilot 1 calls once they exist, and compare T-18's shadow `decision` against what `events` shows actually happened (`load.booked`, `load.escalated`, etc.). Disagreements are expected early and are the point — they surface where the envelope's rules don't yet match how Patrice actually wants the business run, while zero risk exists because nothing is enforced.

---

## 8. Interfaces

```
GET   /api/agents
GET   /api/agents/:agentKey/envelope?tenant_id=
POST  /api/agents/:agentKey/envelope         (creates new version, deactivates old)
GET   /api/evaluations?agent_id=&tenant_id=&decision=&since=
GET   /api/escalations?tenant_id=&status=pending
PATCH /api/escalations/:id                    (status update only — no live consequence yet)
```

All write endpoints require `actor` in the payload (human identifier) — even in shadow mode, envelope changes are audited from day one.

---

## 9. Authority envelope (for T-18 itself)

T-18 is infrastructure, not an autonomous agent, so it does not carry its own envelope. The write boundary that applies:

- `evaluateAuthority()` may only `INSERT` into `authority_evaluations` and `escalations`. It has no write access to `pipeline_loads`, `agent_calls`, or any Engine 2 table.
- The replay harness is read-only against `events` and `pipeline_loads` (for the comparison in §7).
- Envelope write endpoints require a human actor; no agent may modify its own envelope.

---

## 10. Portability notes

- `evaluateAuthority()` is a pure function against its inputs and the loaded envelope — no host-specific dependency. Portable to any runtime that can reach Postgres.
- The replay harness runs as a standalone scheduled job (cron or worker), not coupled to any specific queue implementation — swappable from Vercel cron to a different scheduler later without touching the evaluation logic.
- Envelope JSON schema is intentionally generic (permissions/tools/budget/policies/escalation_rules) so it isn't Engine-2-specific; T-22's Negotiation agent and T-27's Finance agents use the same table and the same runtime.

---

## 11. Acceptance criteria

1. `agents` table seeded with all 8 existing workers + `negotiation` + `dispatch_one`, all `status = 'shadow'`.
2. Default envelopes created for all 8 existing agents, with the kill-switch mapping table (§5.1) verified field-by-field against current production env var values.
3. `evaluateAuthority()` unit tested against ≥20 scenarios covering: clean allow, permission-list deny, budget-exceeded escalate, confidence-below-threshold escalate, multiple matching escalation rules (first-match-wins verified).
4. Replay harness run against the T-17 backfill (75-load shadow drain minimum) produces one `authority_evaluations` row per relevant event, zero errors.
5. For every load where `events` shows `load.escalated` actually happened, the replay harness's independent shadow judgment is manually reviewed and the agreement/disagreement rate is reported to Patrice — not required to be 100%, but must be measured.
6. Zero changes to any file in the live call path; T-16 worker suite green.
7. All five API endpoints (§8) respond correctly against seeded data.

---

## 12. Gate

**T-18 exit gate (unblocks T-19 and gives T-20–T-26 a governance model to build against):**

- All 7 acceptance criteria pass.
- Patrice reviews the disagreement report from criterion 5 and confirms the envelope rules are directionally correct (not perfect — this is expected to be iterated).
- Confirmed zero live-path changes, same as T-17.

**T-18b (deferred):** wiring `evaluateAuthority()` into `base-worker.ts` (or a thin call at the point of action in `voice-worker.ts` / `dispatcher-worker.ts`) so shadow mode becomes real enforcement. Explicitly gated on the Phase 0 handoff (E3-00 §9) and its own scoped code review. At that point `shadow_mode` flips to `false` per agent as each is cut over — not all at once.

---

## 13. Claude Code build plan

1. Migration: `agents`, `authority_envelopes`, `authority_evaluations`, `escalations` (§4).
2. Seed script: 8 agents + 2 placeholders, default envelopes with the kill-switch mapping (§5.1) — read current env var values as input, don't hardcode.
3. `evaluateAuthority()` library with the 20+ test scenarios (§6, criterion 3).
4. Replay harness (§7), run against T-17's backfilled `events`.
5. API endpoints (§8).
6. Disagreement report script comparing shadow decisions to actual `load.escalated` / `load.booked` events — output as a simple table Patrice can read.
7. Run T-16 suite — confirm zero regressions.

Do not let Claude Code wire `evaluateAuthority()` into any worker file in this session. If it proposes "just adding one check in `voice-worker.ts` to make this useful now," reject it — that is T-18b.

---

*End of T-18.*
