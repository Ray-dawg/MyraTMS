---
title: Customer OS & Onboarding
id: T-28
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-19, T-24, T-27, E3-00]
referenced_by: [T-29, T-30]
---

# T-28 — CUSTOMER OS & ONBOARDING

**Engine 3 · Phase 4 (Commercialize)**
**Parent:** E3-00 §7 (module table), original draft PRD Modules 9–10 (Customer Operating System, Customer Onboarding)
**Precondition:** Phase 3 exit gate passed. T-19 (tenants/policy), T-24 (console), T-27 (finance) deployed.

---

## 1. Objective — and a distinction worth being precise about before writing anything

Myra already has two onboarding processes, both real, both unrelated to what this module builds:

1. **Shipper onboarding** (C-06's SOP) — a freight customer of Myra's own brokerage. Manual today: Patrice personally runs the checklist, sends the welcome email, executes the first load with zero-error tolerance. Backed by the existing `shippers` table and its Prospect → One-off → Contracted pipeline stages.
2. **Carrier recruitment** — an existing Retell voice agent (`retell_config_carrier_onboarding.jsx`) that cold-calls or receives calls from carriers, pitches them, and captures MC/CVOR number, payment preference, and lanes to grow Myra's own carrier pool.

**Neither of these is what T-28 builds.** This module's "customer" is a **tenant** — a company licensing MyraOS itself (E3-00's T2 rollout: external trucking companies and brokerages). Onboarding a shipper means getting freight into Myra's pipeline. Onboarding a tenant means standing up a new instance of the whole platform — tenant row, policy, users, agent configuration — for someone else's business to run on. T-28 does not touch the `shippers` table, does not touch the carrier recruitment agent, and does not change C-06's SOP. Getting this boundary wrong would mean quietly building "shipper CRM automation" under a module named for something else entirely.

---

## 2. Scope

**In scope:**

- The tenant signup and provisioning flow: sign up → company created → users created → billing intent captured → load sources selected → policy confirmed → agents configured → tested → go-live requested
- `tenant_onboarding_sessions` — tracks progress through the flow
- Reuse of T-19's existing tenant infrastructure (`tenants`, `tenant_type_policy_templates`, `tenant_policies`, `tenant_users`) — T-28 orchestrates it, doesn't rebuild it
- A sandboxed test/dry-run step against synthetic loads before a new tenant can request go-live
- Routing the go-live request through T-24's **existing** console (a new `source_module = 'tenant_onboarding'`), reusing the established human-review pattern instead of building a fourth one
- A human-approval gate on go-live for at least the first several tenants (§3.2)

**Out of scope (explicitly deferred):**

- Anything involving the `shippers` table, C-06's SOP, or the carrier recruitment voice agent — different systems, permanently, not just for this build
- Real billing/payment collection — T-28 captures plan intent only; actual billing infrastructure is T-29's explicit scope
- White-label branding — T-29
- Fully autonomous go-live with zero human review (T-28b, once the pattern is proven)
- Where the tenant signup flow is linked from publicly (a distinct "license our platform" entry point vs. the existing consumer-facing `/get-started` shipper/carrier lead form) — that's a commercial/marketing decision outside this engineering spec's scope; T-28 builds the flow and its API, not its marketing placement

---

## 3. Design decisions

### 3.1 Two "customers," two systems, on purpose

The existing `/get-started` marketing form already gets the right instinct — it branches by type (shipper vs. carrier) at step zero. T-28's tenant signup follows the same pattern of branching early (by tenant type, per T-19's Broker/Dispatcher/Carrier/Acquired Opco categories) but is a structurally different flow serving a structurally different purpose, and the spec keeps that separation explicit throughout rather than trying to generalize one system to cover both.

### 3.2 Onboarding a stranger's business onto the platform is a trust decision, not just a data-entry flow

E3-00's own module vision describes this with "minimal human involvement." That's the target, not the starting point. The first several tenants onboarded onto MyraOS are, by definition, unproven — the platform has no track record with them yet, and their agents will be acting under Myra's infrastructure and, indirectly, its reputation. Same staged-trust arc as every module before it: T-28 builds and tests the full self-serve flow, but "go live" — the point where a new tenant's agents start acting on real freight — requires a human sign-off, routed through the same console every other exception in this series routes through. T-28b removes that requirement once enough tenants have gone through it safely to justify the removal.

---

## 4. Data model

### 4.1 `tenant_onboarding_sessions`

```sql
CREATE TABLE IF NOT EXISTS tenant_onboarding_sessions (
    id                 SERIAL PRIMARY KEY,
    tenant_id          INTEGER REFERENCES tenants(id),   -- NULL until step 1 (company creation) completes

    current_step         VARCHAR(30) NOT NULL DEFAULT 'sign_up',
    -- 'sign_up' | 'company_created' | 'users_created' | 'billing_captured' |
    -- 'load_sources_selected' | 'policy_confirmed' | 'agents_configured' |
    -- 'tested' | 'go_live_requested' | 'live'

    step_data              JSONB NOT NULL DEFAULT '{}',   -- accumulated answers, keyed by step
    status                    VARCHAR(20) NOT NULL DEFAULT 'in_progress',  -- 'in_progress' | 'completed' | 'abandoned'

    started_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at                  TIMESTAMP
);
```

### 4.2 Provisioning — calls T-19's existing endpoints, doesn't reimplement them

```typescript
async function provisionTenant(session: TenantOnboardingSession): Promise<Tenant> {
  // Uses T-19's POST /api/tenants — already builds the tenant row and applies
  // the correct tenant_type_policy_templates as v1 tenant_policies. T-28 does
  // not duplicate that logic; it collects the inputs and calls it.
  const tenant = await createTenant({
    tenantName: session.stepData.companyName,
    tenantType: session.stepData.tenantType,   // 'broker' | 'dispatcher' | 'carrier' | 'acquired_opco'
  });
  await addTenantUser(tenant.id, session.stepData.ownerUserId, 'owner');   // T-19's tenant_users
  return tenant;
}
```

### 4.3 Test/dry-run

A new tenant's configuration is exercised against a small set of **synthetic** loads (not real `pipeline_loads` rows) before go-live can be requested — confirming policy resolution, dispatch routing (T-19/T-23), and pricing (T-21) all behave sanely for that tenant's specific type and overrides, without ever touching production data or a real counterparty.

### 4.4 Go-live request — routed through the existing console, not a new one

```typescript
async function requestGoLive(session: TenantOnboardingSession): Promise<void> {
  // Reuses T-24's bridge into the existing `exceptions` table — same console,
  // same acknowledge/resolve mechanism, new source_module value.
  await bridgeToExceptions({
    tenantId: session.tenantId,
    sourceModule: 'tenant_onboarding',
    exceptionType: 'go_live_requested',
    severity: 'medium',
    pipelineLoadId: null,
  });
}
```

No new approval table, no new UI — the same Alert Center a dispatcher already has open shows "Tenant X has completed onboarding and is requesting go-live," and resolution (approve) flips `tenants.status` to fully active via the existing `PATCH` mechanism's pattern.

---

## 5. Interfaces

```
POST  /api/tenant-onboarding/start
PATCH /api/tenant-onboarding/:sessionId          (step data, advances current_step)
POST  /api/tenant-onboarding/:sessionId/test      (dry-run against synthetic loads)
POST  /api/tenant-onboarding/:sessionId/request-go-live
GET   /api/tenants/:id/onboarding-status
```

---

## 6. Acceptance criteria

1. Full flow tested end-to-end with a fixture tenant of each type (Broker, Dispatcher, Carrier), producing correct `tenants`/`tenant_policies`/`tenant_users` rows via T-19's existing endpoints — zero duplicated schema or logic.
2. Explicit regression test confirms the onboarding flow makes **zero writes** to `shippers`, `carriers`, or any table belonging to Myra's own commercial CRM — proving the boundary in §1 actually holds in code, not just in the spec's prose.
3. The dry-run step (§4.3) exercises a fixture tenant's policy, dispatch routing, and pricing resolution against synthetic loads with zero writes to real `pipeline_loads`.
4. Go-live requests correctly appear in the existing Alert Center as `source_module = 'tenant_onboarding'`, and approval correctly activates the tenant — no new approval mechanism built.
5. T-16 suite green. Zero changes to the existing `/get-started` marketing form, C-06's SOP, or the carrier recruitment agent.

---

## 7. Gate

**T-28 exit gate (unblocks T-29's billing and control-plane work, which needs a real onboarded tenant to bill):**

- All 5 acceptance criteria pass.
- Patrice reviews the full flow against a fixture tenant of each type before it's used on a real external company.

**T-28b (deferred):** removing the human go-live review once several real tenants have completed it safely; real billing collection (T-29); white-label configuration (T-29).

---

## 8. Portability notes

- The onboarding flow has no dependency beyond T-19's existing tenant APIs and T-24's existing console bridge — no new infrastructure class introduced.
- `tenant_onboarding_sessions` is disposable state (a session can be abandoned and restarted) rather than something other modules need to depend on, keeping it low-coupling by design.

---

## 9. Claude Code build plan

1. Migration: `tenant_onboarding_sessions` (§4.1).
2. Provisioning function (§4.2), calling T-19's existing tenant-creation endpoint rather than reimplementing it.
3. Dry-run/test step (§4.3) against synthetic load fixtures.
4. Go-live request bridge into T-24's existing console (§4.4).
5. API endpoints (§5).
6. Regression test proving zero writes to `shippers`/`carriers` tables (criterion 2) — this is the test that protects the boundary this entire spec is built around.
7. Run T-16 suite — confirm zero regressions in existing onboarding-adjacent flows.

Do not let Claude Code build a new approval UI for go-live requests, and do not let it touch `shippers`, `carriers`, the `/get-started` form, or the carrier recruitment agent config in this session — those boundaries are the point of this module, not incidental to it.

---

*End of T-28.*
