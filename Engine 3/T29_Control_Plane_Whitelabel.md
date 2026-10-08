---
title: Enterprise Control Plane & White-label
id: T-29
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-17, T-18, T-19, T-24, T-27, T-28, E3-00]
referenced_by: []
---

# T-29 — ENTERPRISE CONTROL PLANE & WHITE-LABEL

**Engine 3 · Phase 5 (Core) and Phase 6 (White-label)**
**Parent:** E3-00 §7 (module table), original draft PRD Module 12 (Enterprise Control Plane)
**Precondition — stated plainly, because it's easy to understate:** T-19, T-24, T-27, T-28 being *specified*, or even built and tested against fixture tenants, is not the same as this module's real precondition. Multi-tenancy only means something once tenant-specific behavior is actually live for more than one real tenant — which requires the full chain of deferred cutovers this entire series has been building toward: T-17b (real-time event emission), T-18b (live authority enforcement), T-19b (live policy enforcement), T-20b (carrier score blended into ranking), T-21b/T-22b (pricing and negotiation services actually called instead of computed inline), T-23b (acceptance-gap closed), T-25b (halt enforcement live), T-27b (real money moving), T-28b (autonomous go-live). T-29 does not require every one of those to be flipped — but it requires enough of them live, for enough real tenants, that "data isolation verified across three tenants" (E3-00's own Phase 5 exit gate) is a statement about reality, not about fixtures. This spec builds what T-29 needs; it cannot itself manufacture the tenants or the live cutovers that make its own exit gate true.

---

## 1. Objective

This is the platformization capstone: the layer that turns "MyraOS, used by Myra" into "MyraOS, licensable to others." Most of the hard intelligence already exists — T-17's events are tenant-scoped from day one, T-18's authority evaluations are already an audit trail, T-19 already has the tenant/policy/RBAC foundation, T-24 already has one console. T-29's genuinely new work is narrower than the draft PRD's module list implies: usage metering, tenant billing, API keys, a formal data-isolation verification, and — once real tenants exist — white-label branding.

---

## 2. Scope

### Phase 5 — Core (in scope)

- **Usage metering** — computed from T-17's `events`, not a new instrumentation layer. Every event already carries `tenant_id`; metering is aggregation, not collection.
- **Tenant billing** — subscription (onboarding fee + platform fee, per E3-00 §11's revenue model) via Stripe Billing. **Explicitly a different Stripe integration than T-27's** — T-27 used Stripe Connect-style payouts to carriers (money going out); this is Stripe Billing/subscriptions charging tenants (money coming in). Same provider, different product, kept as separate adapters so they can't be confused or accidentally cross-wired.
- **API keys** — scoped, revocable, tenant-bound, for tenants integrating with MyraOS programmatically.
- **Audit log export** — a tenant-scoped, exportable surface over T-17's `events` and T-18's `authority_evaluations`. Not a new data store — a new *view* of existing ones.
- **Data isolation verification** — a real, enumerated test suite attempting cross-tenant access across every tenant-scoped table built across this entire series, confirming zero leakage. This is E3-00's own Phase 5 exit-gate language, and it's treated as the single most important deliverable in this half of the module.

### Phase 6 — White-label (in scope, sequenced after Phase 5)

- `tenant_branding` — logo, colors, display name, custom domain
- Custom domain verification and routing for tenant-facing surfaces (tracking page, at minimum)
- Agent display-name overrides (a tenant's Retell agents can introduce themselves under the tenant's brand, not Myra's)

**Out of scope (explicitly deferred):**

- SSO — the original draft PRD's own language calls this "SSO eventually." T-29 doesn't build it; noted here as roadmap, not silently dropped.
- Any change to Myra's own branding, domain, or billing as a byproduct of building multi-tenant billing/branding for others
- Actually executing the deferred `*b` cutovers listed in this document's precondition — those belong to their own specs, not this one

---

## 3. Design decisions

### 3.1 Metering and audit are views, not new collection

Every module in this series has emphasized computing from T-17's `events` rather than building parallel instrumentation. T-29 is where that discipline pays off most visibly: usage metering and audit export are both just different aggregations and projections of data that's already there, tenant-scoped, since T-17. If metering required new event collection at this stage, that would be a sign something upstream in the series was under-instrumented — it doesn't.

### 3.2 Data isolation is proven by attack, not by inspection

"Data isolation verified" is easy to write and easy to under-deliver on. The acceptance bar in §7 is specific: for every tenant-scoped table introduced from T-17 onward, an explicit test attempts to read or write across a tenant boundary using another tenant's credentials, and the test suite requires every one of those attempts to fail. A code review confirming `WHERE tenant_id = ?` appears in the right places is not sufficient evidence; the test suite has to actually try to break it.

---

## 4. Data model

### 4.1 Usage metering (computed, not stored)

```sql
CREATE OR REPLACE VIEW v_tenant_usage AS
SELECT tenant_id,
       DATE_TRUNC('month', occurred_at) AS period,
       COUNT(*) FILTER (WHERE event_type = 'load.scanned') AS loads_processed,
       COUNT(*) FILTER (WHERE event_type = 'call.initiated') AS calls_placed,
       COUNT(*) FILTER (WHERE event_type LIKE 'document.%') AS documents_processed
FROM events
GROUP BY tenant_id, DATE_TRUNC('month', occurred_at);
```

### 4.2 `tenant_subscriptions`

```sql
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id                     SERIAL PRIMARY KEY,
    tenant_id              INTEGER NOT NULL REFERENCES tenants(id),

    plan_tier                VARCHAR(30) NOT NULL,
    price_monthly               NUMERIC(10,2),
    stripe_subscription_id         VARCHAR(100),   -- Stripe Billing, distinct from T-27's Connect usage
    status                            VARCHAR(20) DEFAULT 'pending',
    environment                          VARCHAR(10) DEFAULT 'sandbox',   -- same discipline as T-27

    billing_cycle_start                    DATE,
    created_at                                TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.3 `tenant_api_keys`

```sql
CREATE TABLE IF NOT EXISTS tenant_api_keys (
    id                SERIAL PRIMARY KEY,
    tenant_id         INTEGER NOT NULL REFERENCES tenants(id),

    key_hash            VARCHAR(200) NOT NULL,   -- never store the raw key
    scopes                JSONB NOT NULL DEFAULT '[]',
    created_by               VARCHAR(100) NOT NULL,

    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at                   TIMESTAMP,
    revoked_at                        TIMESTAMP
);

CREATE INDEX idx_api_keys_active ON tenant_api_keys(tenant_id) WHERE revoked_at IS NULL;
```

### 4.4 `tenant_branding` (Phase 6)

```sql
CREATE TABLE IF NOT EXISTS tenant_branding (
    tenant_id                 INTEGER PRIMARY KEY REFERENCES tenants(id),

    display_name                 VARCHAR(200),
    logo_url                        TEXT,
    primary_color                      VARCHAR(7),
    custom_domain                         VARCHAR(200),
    domain_verified                          BOOLEAN DEFAULT false,
    agent_display_name_overrides                JSONB DEFAULT '{}',

    updated_at                                     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Data isolation test suite (the core deliverable of Phase 5)

```typescript
// For every tenant-scoped table introduced T-17 through T-28:
const TENANT_SCOPED_TABLES = [
  'pipeline_loads', 'loads', 'carriers', 'shippers', 'agent_calls', 'consent_log',  // T-19 migration 030
  'events',                                                                          // T-17
  'authority_envelopes', 'authority_evaluations', 'escalations',                     // T-18
  'tenant_policies', 'co_broker_agreements',                                          // T-19
  'financing_decisions', 'factoring_submissions', 'quick_pay_disbursements',           // T-27
  'tenant_onboarding_sessions',                                                          // T-28
  // ...enumerated exhaustively at build time, not approximated
];

async function testIsolation(tableA: string, tenantAKey: string, tenantBId: number) {
  // Attempt: read tenant B's rows in `tableA` using tenant A's API key / DB role.
  // Attempt: write/update a tenant B row using tenant A's credentials.
  // Both must fail. Zero exceptions, zero "usually" — this table is the actual proof.
}
```

Run against every table in the enumerated list, for every pair of fixture tenants. The list itself is a build-time artifact that has to be kept current — a table added by a future module without being added here is a real gap, not a documentation nit.

---

## 6. Interfaces

```
GET  /api/tenants/:id/usage?period=
GET  /api/tenants/:id/audit-log?since=&format=json|csv
POST /api/tenants/:id/api-keys
DELETE /api/tenants/:id/api-keys/:keyId
GET  /api/tenants/:id/subscription
POST /api/tenants/:id/subscription        (sandbox only in this build)
GET  /api/tenants/:id/branding
POST /api/tenants/:id/branding            (Phase 6)
POST /api/tenants/:id/branding/verify-domain   (Phase 6)
```

---

## 7. Acceptance criteria

### Phase 5 — Core

1. **Data isolation test suite (§5) passes with zero exceptions across every enumerated table**, for at least two fixture tenants. This is the acceptance criterion that matters most in this entire module.
2. `v_tenant_usage` computes correctly against known event volume for a fixture tenant, cross-checked by manual count.
3. API keys correctly scoped; a tenant A key cannot read or write tenant B data (directly tested, not just asserted — same suite as criterion 1).
4. Stripe Billing subscription flow works end-to-end against sandbox credentials only; zero code path capable of writing `environment = 'production'`, same discipline as T-27.
5. Audit log export produces a correct, tenant-scoped record for a fixture tenant, sourced from `events` and `authority_evaluations` without duplicating either.
6. T-16 suite green.

### Phase 6 — White-label

7. Branding correctly reflected on the tenant-facing tracking page for a fixture tenant.
8. Custom domain verification works against a test domain without altering Myra's own domain configuration.
9. Agent display-name overrides correctly surface in a fixture tenant's Retell call configuration without altering Myra's own agent identities.

---

## 8. Gate

**Important distinction, stated once more because it matters:** this spec's own acceptance criteria (§7) can be satisfied against fixture tenants and sandbox credentials — that makes the *module* done. It does not by itself satisfy E3-00's Phase 5 exit gate ("three tenants live, data isolation verified") or Phase 6's ("one tenant running under its own brand") — those require real tenants actually live on the platform, which depends on the full chain of `*b` cutovers named in this document's precondition. T-29 being built is necessary for those gates; it isn't sufficient.

**T-29b (deferred):** SSO. Any billing plan tier beyond what's needed for the first real external tenants. Full production Stripe Billing cutover, gated the same way T-27's was — sandbox, then a small live cohort, then wider rollout.

---

## 9. Portability notes

- Usage metering and audit export depend only on `events` and `authority_evaluations` existing — portable to any host those tables live on.
- API keys use a standard hash-and-compare pattern, no provider lock-in.
- Custom domain handling depends on Vercel's domain API today; the `tenant_branding` schema itself doesn't assume any particular hosting provider, so a future host migration wouldn't require a schema change, only a different domain-verification adapter.

---

## 10. Claude Code build plan

1. Enumerate every tenant-scoped table across T-17 through T-28 exhaustively — this list (§5) has to be built by actually reading the schema, not copied from this spec's illustrative example.
2. Migration: `tenant_subscriptions`, `tenant_api_keys`, `tenant_branding` (§4.2–4.4).
3. `v_tenant_usage` view (§4.1).
4. Data isolation test suite (§5) — this is the priority deliverable; build and run it before anything else in this module is considered meaningfully done.
5. API key issuance/revocation logic and middleware.
6. Stripe Billing sandbox integration, kept structurally separate from T-27's Stripe Connect adapter.
7. Audit log export endpoint.
8. Phase 6: branding storage, domain verification flow, agent display-name override wiring into Retell config generation (additive, doesn't touch Myra's own agent configs).
9. Run T-16 suite — confirm zero regressions.

Do not let Claude Code treat the illustrative table list in §5 as complete — it must be regenerated from the actual live schema. Do not let it wire real Stripe Billing production credentials in this session, same standing instruction as T-27.

---

*End of T-29.*
