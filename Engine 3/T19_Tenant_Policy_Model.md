---
title: Tenant & Policy Model
id: T-19
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-01, T-02, T-17, T-18, E3-00]
referenced_by: [T-20, T-21, T-22, T-23, T-24, T-25, T-26, T-28, T-29, T-30]
---

# T-19 — TENANT & POLICY MODEL

**Engine 3 · Phase 1 · Module 3 of 3 (with T-17, T-18)**
**Parent:** E3-00 Master PRD §4 (Tenant model), §7 (module table), T-00 R-8 (migration 030)
**Precondition:** T-17 and T-18 deployed — this module's policy evaluator is validated against T-17's `events` and slots into T-18's `authority_envelopes` pattern.
**Hard constraint:** Zero changes to the live call path until the Phase 0 handoff gate (E3-00 §9).

---

## 1. Objective

Give every tenant a real row, a real type, and a real versioned policy object — and formally close out T-00's R-8 (migration 030, staged and pending) by promoting it into this spec rather than leaving it undefined.

Three things must be true at the end of this module:

1. `tenants` exists with Myra as row 1, correctly typed as a **Broker**.
2. Every table that T-17 and T-18 already assumed carries `tenant_id` (they defaulted to `1`) actually has that column, added additively, with zero behavioural change to any existing query.
3. The double-brokering / load-source policy — Broker / Dispatcher / Carrier / Acquired Opco, as locked in E3-00 §4.2 — exists as a real, versioned, per-tenant policy object, and a shadow evaluator proves it reproduces the Qualifier's current hardcoded shipper-direct filter (T-05, "Filter 3") exactly, before anything is wired live.

---

## 2. Scope

**In scope:**

- `tenants` table
- `tenant_type_policy_templates` — the four default policy objects from E3-00 §4.2 (Broker, Dispatcher, Carrier, Acquired Opco)
- `tenant_policies` — versioned, per-tenant policy object (can override the type template)
- `tenant_users` — RBAC join between existing TMS users and tenants, with a tenant-scoped role
- `co_broker_agreements` — the bilateral agreement registry E3-00 §4.2 references for the Broker exception path
- The migration 030 promotion: additive `tenant_id` columns on `pipeline_loads`, `loads`, `carriers`, `shippers`, `agent_calls`, `consent_log`, all defaulting to `1`
- `evaluatePolicy()` — the load-source policy evaluator, run in shadow mode via a replay harness against T-17's `events`
- Read/write API for tenant and policy management

**Out of scope (explicitly deferred to T-19b):**

- Wiring `evaluatePolicy()` into the live Qualifier (`qualifier-worker.ts`) to actually gate load acceptance
- Removing or modifying the existing hardcoded shipper-direct filter in T-05
- Tenant-scoped authentication/login flows (T-29, Control Plane)
- Billing, metering, or usage tracking per tenant (T-29)
- Onboarding UX for a new external tenant (T-28)

---

## 3. Design decision: same pattern as T-17 and T-18

Migration 030 has been "staged and pending" since before Engine 3 was scoped, explicitly gated on prod stability (T-00 R-8). That gate hasn't changed — Pilot 1 still isn't validated. But three things can be true at once: the schema can be added safely now (additive columns, default value, no index rebuild, no lock risk on Neon for `ADD COLUMN ... DEFAULT`), the policy logic can be built and tested now, and none of it can be allowed to change what the Qualifier actually does until the same Phase 0 handoff gate that governs T-17b and T-18b is passed.

So T-19 follows the identical two-part shape:

- **Schema and policy objects: built now.** Additive only. `tenant_id INTEGER DEFAULT 1` on existing tables changes nothing for any existing query that doesn't reference the new column.
- **Enforcement: shadow only.** `evaluatePolicy()` is validated by replaying it against T-17's `events` and comparing its verdict to what the Qualifier's hardcoded filter actually did (visible in `pipeline_loads.qualification_reason` and the corresponding `load.qualified` / `load.disqualified` events). Agreement is measured, not assumed.

---

## 4. Data model

### 4.1 `tenants`

```sql
CREATE TABLE IF NOT EXISTS tenants (
    id                    SERIAL PRIMARY KEY,
    tenant_name           VARCHAR(200) NOT NULL,
    tenant_type           VARCHAR(20)  NOT NULL,   -- 'broker' | 'dispatcher' | 'carrier' | 'acquired_opco'
    parent_tenant_id      INTEGER REFERENCES tenants(id),  -- Penda & Co roll-up parent, if any

    status                VARCHAR(20)  NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'offboarded'
    onboarded_at          TIMESTAMP,

    -- Denormalized for quick reference; source of truth is tenant_type_policy_templates + tenant_policies
    active_policy_id      INTEGER,

    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed: Myra Logistics is tenant 1, type broker
INSERT INTO tenants (id, tenant_name, tenant_type, status, onboarded_at)
VALUES (1, 'Myra Logistics', 'broker', 'active', '2026-04-01')
ON CONFLICT (id) DO NOTHING;
```

### 4.2 `tenant_type_policy_templates` — the four defaults from E3-00 §4.2

```sql
CREATE TABLE IF NOT EXISTS tenant_type_policy_templates (
    id                    SERIAL PRIMARY KEY,
    tenant_type           VARCHAR(20)  UNIQUE NOT NULL,
    load_source_policy    VARCHAR(30)  NOT NULL,
    -- 'shipper_direct_only' | 'shipper_direct_or_coBroker' | 'broker_or_shipper_direct' | 'any'
    dispatch_agent_default VARCHAR(10) NOT NULL,   -- 'on' | 'opt_in'
    negotiation_directions VARCHAR(20) NOT NULL,   -- 'sell_only' | 'buy_only' | 'both'
    description            TEXT
);

INSERT INTO tenant_type_policy_templates (tenant_type, load_source_policy, dispatch_agent_default, negotiation_directions, description) VALUES
('broker',        'shipper_direct_or_coBroker', 'on',     'both',     'Non-asset brokerage. Shipper-direct only, or broker-posted with an executed co-broker agreement.'),
('dispatcher',    'broker_or_shipper_direct',   'on',     'buy_only', 'Dispatch service acting for owner-operators. Broker-posted and shipper-direct both permitted.'),
('carrier',       'any',                        'opt_in', 'sell_only','Asset trucking company. Any load source; dispatch agent is opt-in, default routes to in-house dispatch.'),
('acquired_opco',  'inherit',                    'inherit','inherit',  'Inherits broker or carrier template by the acquired entity''s actual type.')
ON CONFLICT (tenant_type) DO NOTHING;
```

### 4.3 `tenant_policies` — versioned, per-tenant, overridable

```sql
CREATE TABLE IF NOT EXISTS tenant_policies (
    id                     SERIAL PRIMARY KEY,
    tenant_id              INTEGER NOT NULL REFERENCES tenants(id),
    version                INTEGER NOT NULL DEFAULT 1,

    -- Copied from the type template at creation; overridable field-by-field thereafter
    load_source_policy      VARCHAR(30) NOT NULL,
    dispatch_agent_enabled   BOOLEAN NOT NULL,
    negotiation_directions   VARCHAR(20) NOT NULL,

    -- Additional tenant-specific fields
    geographic_scope         JSONB DEFAULT '{"domestic_only": true, "countries": ["CA"]}',
    margin_floor_pct          NUMERIC(5,2),

    is_active                BOOLEAN NOT NULL DEFAULT true,
    effective_from             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by                  VARCHAR(50) NOT NULL DEFAULT 'system',
    created_at                    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id, version)
);

CREATE INDEX idx_tenant_policies_active ON tenant_policies(tenant_id) WHERE is_active;
```

Seed for Myra (tenant 1): `load_source_policy = 'shipper_direct_or_coBroker'`, `dispatch_agent_enabled = true`, `negotiation_directions = 'both'`, `geographic_scope = {"domestic_only": true, "countries": ["CA"]}` — this must match T-05's Pilot 1 filter (shipper-direct, domestic Canada only) exactly. That match is acceptance criterion §8.2.

### 4.4 `co_broker_agreements`

```sql
CREATE TABLE IF NOT EXISTS co_broker_agreements (
    id                  SERIAL PRIMARY KEY,
    tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
    counterparty_name    VARCHAR(200) NOT NULL,
    counterparty_mc_number VARCHAR(20),

    agreement_executed_at  DATE NOT NULL,
    agreement_document_url  TEXT,

    status               VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'terminated'
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Empty at launch — Myra has none yet (T-05 confirms broker-posted is fully excluded in Pilot 1). This table exists so the moment a co-broker agreement is signed, `evaluatePolicy()` already knows how to use it, without a schema change.

### 4.5 `tenant_users` — RBAC join

```sql
CREATE TABLE IF NOT EXISTS tenant_users (
    id             SERIAL PRIMARY KEY,
    tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
    user_id        INTEGER NOT NULL,   -- references existing TMS users table
    tenant_role    VARCHAR(20) NOT NULL DEFAULT 'operator',  -- 'owner' | 'admin' | 'operator' | 'viewer'
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, user_id)
);
```

This does not replace or modify the existing JWT RBAC (`admin`/`broker`/`dispatcher`/`driver`) described in the TMS platform audit — that remains the in-app permission model for Myra's own team. `tenant_users` is the *cross-tenant* layer: which tenant a user's session is scoped to, relevant once T-29 supports more than one tenant logging in.

### 4.6 Migration 030 promotion — additive `tenant_id` columns

```sql
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pipeline_loads' AND column_name = 'tenant_id') THEN
        ALTER TABLE pipeline_loads ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loads' AND column_name = 'tenant_id') THEN
        ALTER TABLE loads ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'carriers' AND column_name = 'tenant_id') THEN
        ALTER TABLE carriers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shippers' AND column_name = 'tenant_id') THEN
        ALTER TABLE shippers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_calls' AND column_name = 'tenant_id') THEN
        ALTER TABLE agent_calls ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'consent_log' AND column_name = 'tenant_id') THEN
        ALTER TABLE consent_log ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pipeline_loads_tenant ON pipeline_loads(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_loads_tenant ON loads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_carriers_tenant ON carriers(tenant_id);
```

`ADD COLUMN ... NOT NULL DEFAULT 1` on Postgres 11+ (Neon runs current Postgres) does not rewrite the table or take a long lock — it's a metadata-only change. This is safe to run against production without a maintenance window, which is exactly why migration 030 can finally move from "staged, pending prod stability" to "done, enforcement still pending" — the risk T-00 R-8 was really flagging was behavioral (multi-tenant logic changing what loads get processed), not schema risk. This spec separates the two.

---

## 5. The policy evaluator

```typescript
interface PolicyEvaluationInput {
  tenantId: number;
  load: {
    isDirect: boolean;           // shipper-direct vs broker-posted, from existing classifier
    postingSource: string;        // e.g. 'dat', 'truckstop'
    postingCompanyMcNumber?: string;
    originCountry: string;
    destinationCountry: string;
  };
}

interface PolicyEvaluationResult {
  decision: 'accept' | 'reject';
  reason: string;
  policyId: number;
}

async function evaluatePolicy(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
  // 1. Load active tenant_policies row for tenantId
  // 2. Geographic scope check (domestic_only vs origin/destination country)
  // 3. Load-source check:
  //    - 'shipper_direct_or_coBroker': accept if isDirect, else check co_broker_agreements
  //      for an active row matching postingCompanyMcNumber
  //    - 'broker_or_shipper_direct': accept always
  //    - 'any': accept always
  // 4. Write evaluation result to authority_evaluations (T-18's table — this is a policy
  //    evaluation, logged the same way an authority evaluation is)
  // 5. Return result
}
```

This reuses T-18's `authority_evaluations` table rather than creating a parallel log — a policy decision and an authority decision are the same kind of record (agent-or-system evaluated something against a rule and logged it). `agent_id` in that row points to a new `policy_engine` row in T-18's `agents` registry.

---

## 6. Replay harness

`scripts/t19_replay_policy_evaluation.ts` — same shape as T-18's harness. Reads T-17's `events` for `load.qualified` and `load.disqualified` rows, reconstructs the `PolicyEvaluationInput` from the linked `pipeline_loads` row (specifically the `qualification_reason` field, which T-05 already populates with values like `shipper_direct_required` when the hardcoded filter rejects a broker-posted load), runs `evaluatePolicy()`, and compares.

**This is the acceptance bar:** for every load T-05's existing hardcoded filter rejected for being broker-posted, `evaluatePolicy()` must also reject it, for the same reason. Any mismatch is a bug in the new policy engine, found before it's ever live — not a difference to paper over.

---

## 7. Interfaces

```
GET    /api/tenants
GET    /api/tenants/:id
POST   /api/tenants                          (creates tenant, applies type template as v1 policy)
GET    /api/tenants/:id/policy
POST   /api/tenants/:id/policy                 (new version, requires human actor)
GET    /api/tenants/:id/co-broker-agreements
POST   /api/tenants/:id/co-broker-agreements
GET    /api/policy-evaluations?tenant_id=&decision=&since=
```

---

## 8. Acceptance criteria

1. `tenants` seeded with Myra as tenant 1, type `broker`, status `active`.
2. All four `tenant_type_policy_templates` rows match E3-00 §4.2 exactly.
3. Myra's `tenant_policies` v1 row matches T-05's actual Pilot 1 filter behavior: shipper-direct required, domestic Canada only, zero co-broker agreements.
4. Migration 030 promotion (§4.6) applied to a staging branch first; confirmed zero query plan changes on the 6 altered tables' existing hot paths (Qualifier's SELECT, Scanner's INSERT) via `EXPLAIN ANALYZE` before/after.
5. `evaluatePolicy()` unit tested against ≥15 scenarios: shipper-direct accept, broker-posted reject (no agreement), broker-posted accept (active agreement), cross-border reject, expired agreement reject.
6. Replay harness run against T-17's backfilled `events`: 100% agreement between `evaluatePolicy()` and T-05's actual historical `qualification_reason` values for load-source rejections. This is a hard 100%, not a "directionally correct" bar like T-18's — the underlying rule is a single hardcoded boolean today, so the model should reproduce it exactly.
7. Zero changes to `qualifier-worker.ts` or any live call-path file; T-16 suite green.
8. All API endpoints (§7) functional against seeded data.

---

## 9. Gate

**T-19 exit gate (unblocks T-20 onward, which all need a tenant to attach data to; and completes T-00 R-8):**

- All 8 acceptance criteria pass, including the 100% agreement bar in criterion 6.
- Migration 030 promotion run against production only after the staging `EXPLAIN ANALYZE` comparison (criterion 4) confirms no plan regression.
- T-00's risk register is updated: R-8 becomes "Schema complete, tenant_id present on all core tables. Enforcement (T-19b) still gated on Phase 0 handoff." — closed as schema risk, still open as an enforcement item, tracked honestly rather than marked fully done.

**T-19b (deferred):** wiring `evaluatePolicy()` into `qualifier-worker.ts`'s Filter 3 so tenant policy actually governs load acceptance, and building the tenant-aware query changes needed once a second tenant exists. Gated on the Phase 0 handoff (E3-00 §9), same as T-17b and T-18b.

---

## 10. Portability notes

- All new tables are plain Postgres, no Neon-specific features. Portable to any Postgres host.
- `evaluatePolicy()` has no dependency on the queue or worker framework — callable from anywhere, which is what makes T-19b a small, contained change later (one call inserted at Filter 3, not a rewrite).
- Tenant policy JSON shape intentionally mirrors T-18's envelope shape (versioned, `is_active`, `effective_from`) so a future admin UI can render both with the same component.

---

## 11. Claude Code build plan

1. Migration: `tenants`, `tenant_type_policy_templates`, `tenant_policies`, `co_broker_agreements`, `tenant_users` (§4.1–§4.5).
2. Migration 030 promotion (§4.6) — staging first, `EXPLAIN ANALYZE` comparison, then production.
3. Seed data: Myra as tenant 1; four type templates; Myra's v1 policy matching T-05 exactly.
4. `evaluatePolicy()` with the 15+ test scenarios (§8.5).
5. Replay harness (§6) against T-17's backfilled events — target 100% agreement on load-source decisions.
6. API endpoints (§7).
7. Run T-16 suite — confirm zero regressions.
8. Update T-00's risk register entry for R-8 as described in §9.

Do not let Claude Code modify `qualifier-worker.ts`'s Filter 3 in this session, and do not let it treat "T-19b would be easy, let's just do it now" as a reason to skip the shadow-validation step. The 100% agreement bar in criterion 6 exists specifically so that when T-19b does happen, it's a known-safe cutover, not a new risk.

---

*End of T-19.*
