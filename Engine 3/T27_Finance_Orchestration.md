---
title: Finance Orchestration
id: T-27
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-17, T-19, T-20, T-25, E3-00]
referenced_by: [T-28, T-29]
---

# T-27 — FINANCE ORCHESTRATION

**Engine 3 · Phase 3 (Financialize)**
**Parent:** E3-00 §7 (module table), Pilot 1's own Financial Architecture (§6) and its "Open before load one" checklist
**Precondition:** Phase 2 exit gate passed (E3-00 §8 — 100 consecutive loads, ≥80% zero-touch). T-19, T-20, T-25 deployed.
**Stakes:** Real money moves through this module once T-27b is live. Higher than T-25's detection-only stakes, not lower — everything here defaults to sandbox until explicitly proven.

---

## 1. Objective — this is not a generic adapter spec, Pilot 1 already worked out the model

E3-00's module table describes this as "adapters for eCapital, Stripe, Persona, accounting SaaS." That undersells what already exists: Pilot 1's own Financial Architecture section (§6) is a fully worked treasury model — four financing routes, an explicit routing rule table, and worked numbers down to the capital-day. T-27's job is to turn that existing model into software, not invent a new one.

**The core insight, already established in Pilot 1's own document:** quick pay and factoring move in opposite directions. Quick pay is a discount the carrier accepts for immediate payment — it *increases* margin and *consumes* working capital. Factoring sells the receivable to a third party — it *reduces* margin and *releases* working capital. Because they're independent per load, they combine into four routes:

| Route | Carrier paid | Receivable | Days tied up | Yield / 1k capital-days |
|---|---|---|---|---|
| **T1** | Net 30 | Held to collection | 10 | **$12.00** (best use of facility) |
| **T2** | Quick pay, day 1 | Held to collection | 39 | $3.81 (worst use — highest margin, worst capital efficiency) |
| **T3** | Quick pay, day 1 | Factored, day 1 | 1 | **$91.28** |
| **T4** | Net 30 | Factored, day 1 | −29 (self-funding) | self-funding |

And the routing rule, also already established, correcting the intuitive-but-wrong version of it — a factor underwrites the *payer*, not Myra, so "float the strong payers" would concentrate the float facility in the worst credit on the book if applied backwards:

| Payer credit | Carrier wants | Route |
|---|---|---|
| Strong | Net 30 | T1 — float |
| Strong | Fast pay | T3 — factor |
| Strong | Fast pay, facility has slack | T2 — float |
| Weak or unknown | Anything | **Decline** — neither floated nor factored |

T-27 formalizes exactly this table, connects "payer credit" to T-25's `payer_credit_assessments`, connects "carrier wants" to the existing `carriers.payment_preference` field, and builds the one piece Pilot 1's own checklist says is still missing: **the float governor, "implemented and cap enforced in software."**

---

## 2. Scope

**In scope:**

- The routing decision function — reproduces Pilot 1's own T1–T4 table exactly, tenant-configurable (quick pay discount %, factoring %, float cap) via a `treasury_policy` extension of T-19's `tenant_policies`
- **The float governor** — real-time computation of current float exposure against the tenant's cap, forcing a factor route when float capacity is exhausted even if the routing table would otherwise prefer float
- Adapter interfaces for eCapital (factoring submission/status — replacing the existing email-only path), Stripe (quick-pay disbursement), and Persona (KYC verification for carrier/payer onboarding into the fintech layer)
- Integration with the **existing** TMS factoring status field (`N/A`/`Submitted`/`Approved`/`Funded`) rather than a parallel one
- A treasury report using Pilot 1's own metric — capital-days and yield per 1,000 capital-days — computed, not estimated

**Out of scope (explicitly deferred to T-27b):**

- Any real production money movement — real eCapital submissions, real Stripe payouts, real KYC decisions with consequence. This build runs entirely against sandbox/test credentials.
- Connecting real API credentials at all, which depends on non-engineering prerequisites Pilot 1's own checklist already names: eCapital terms confirmed (rate, advance, recourse), float facility and advisory grant papered by counsel. T-27 doesn't wait on those to be *built*, but does wait on them to go *live*.
- Building any native ledger, AR, or AP system — this module orchestrates third parties, permanently, not just until some future gate. That's a standing decision, not a temporary scope cut.
- Accounting SaaS integration (QuickBooks/Xero) — T-01 confirms none exists today; this is a follow-on adapter, not part of this spec's build

---

## 3. Design decisions

### 3.1 Formalize Pilot 1's model; build the governor that's explicitly still missing

Same posture as T-25 and T-26: most of this module's intelligence already exists as a well-argued document, not as code. The routing table and the four-route logic get relocated into software with an exact-match bar against Pilot 1's own worked example (§1) — if the software doesn't reproduce $12.00, $3.81, $91.28, and self-funding for the same inputs, that's a bug. The float governor is different — Pilot 1's own checklist lists it as not yet built, so it's tested against seeded scenarios, not a historical baseline, same honesty distinction made in every module that built something genuinely new.

### 3.2 Real money is a stricter bar than real risk detection

T-25 argued that an automatic halt was the rare case where automating something immediately was the conservative choice. T-27 is the opposite case, stated plainly: nothing here should move real money automatically until it has been proven, because unlike a halt, a disbursement or a factoring submission is not reversible by just not acting. T-27b's gate (§8) is accordingly the strictest in this series — sandbox first, then a dollar-capped live pilot, not a volume-based canary like earlier modules.

---

## 4. Data model

### 4.1 `treasury_policy` — extends T-19's tenant policy pattern

```sql
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS treasury_policy JSONB DEFAULT
  '{"quick_pay_discount_pct": 2.5, "factoring_fee_pct": 5.0, "float_cap_usd": null, "float_cap_cad": null}';
```

Myra's own tenant seeded with Pilot 1's own assumed values (2.5% quick pay, 5% factoring) as defaults — `float_cap` left `NULL` until Patrice sets a real number, since that figure depends on the facility being papered by counsel, an explicit non-engineering prerequisite (§2).

### 4.2 `financing_decisions`

```sql
CREATE TABLE IF NOT EXISTS financing_decisions (
    id                       SERIAL PRIMARY KEY,
    pipeline_load_id         INTEGER NOT NULL REFERENCES pipeline_loads(id),
    tenant_id                INTEGER NOT NULL DEFAULT 1,

    payer_credit_level_at_decision  VARCHAR(20) NOT NULL,   -- from T-25, at time of decision
    carrier_payment_preference        VARCHAR(20) NOT NULL,   -- from carriers.payment_preference
    float_capacity_available_at_decision  BOOLEAN NOT NULL,

    route_selected                       VARCHAR(4) NOT NULL,   -- 'T1' | 'T2' | 'T3' | 'T4' | 'DECLINE'
    capital_days_projected                  NUMERIC(10,2),
    yield_projected                            NUMERIC(10,4),

    decided_at                                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by                                       VARCHAR(20) NOT NULL DEFAULT 'system_auto',
    override_reason                                     TEXT
);
```

### 4.3 Float exposure (computed, mirrors T-25's concentration exposure pattern)

```sql
CREATE OR REPLACE VIEW v_float_exposure AS
SELECT fd.tenant_id,
       SUM(CASE WHEN fd.route_selected IN ('T1', 'T2') THEN pl.agreed_rate ELSE 0 END) AS current_float_usd,
       (tp.treasury_policy->>'float_cap_usd')::numeric AS float_cap_usd
FROM financing_decisions fd
JOIN pipeline_loads pl ON pl.id = fd.pipeline_load_id
JOIN tenant_policies tp ON tp.tenant_id = fd.tenant_id AND tp.is_active
WHERE pl.stage IN ('booked', 'dispatched', 'delivered')  -- not yet collected
GROUP BY fd.tenant_id, tp.treasury_policy;
```

Computed live, same reasoning as T-25's concentration view — a stale float number defeats the entire point of a governor.

### 4.4 Adapter records

```sql
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

Every adapter record carries `environment`, defaulting to `'sandbox'`. Nothing in this build ever writes `'production'` — that value only becomes reachable in T-27b, and only after the gate in §8.

---

## 5. The routing function

```typescript
function decideRoute(input: {
  payerCreditLevel: 'unknown' | 'weak' | 'acceptable' | 'strong';
  carrierWantsQuickPay: boolean;
  floatCapacityAvailable: boolean;
}): { route: 'T1' | 'T2' | 'T3' | 'T4' | 'DECLINE'; reasoning: string } {

  if (input.payerCreditLevel === 'unknown' || input.payerCreditLevel === 'weak') {
    return { route: 'DECLINE', reasoning: 'Weak or unknown payer credit — neither floated nor factored, regardless of margin (Pilot 1 §6.3)' };
  }

  if (!input.carrierWantsQuickPay) {
    return { route: 'T1', reasoning: 'Strong payer, net-30 carrier — best margin and best facility use' };
  }

  // Carrier wants quick pay
  if (input.floatCapacityAvailable) {
    return { route: 'T2', reasoning: 'Strong payer, fast-pay carrier, facility has slack — highest margin per load, deploy surplus capacity' };
  }
  return { route: 'T3', reasoning: 'Strong payer, fast-pay carrier, facility at capacity — factor to preserve capacity for T1 loads' };
}
```

T4 (net-30 carrier, factored anyway) isn't in the default decision tree — Pilot 1's own table doesn't route to it automatically either; it's a manual override case (e.g., forcing early liquidity on an otherwise-fine T1 load), available via `decided_by = 'human_override'` in `financing_decisions`, not something the automatic function selects.

---

## 6. Interfaces

```
POST /api/finance/route-decision       { pipelineLoadId } → decision, does NOT execute anything
GET  /api/finance/float-exposure?tenant_id=
POST /api/finance/factoring/submit      (sandbox only in this build)
POST /api/finance/quickpay/disburse      (sandbox only in this build)
POST /api/finance/kyc/verify              (sandbox only in this build)
GET  /api/finance/treasury-report          (capital-days, yield — Pilot 1's own metrics)
```

---

## 7. Acceptance criteria

1. `decideRoute()` reproduces Pilot 1's own worked example (§1 table) exactly for the same inputs — capital-days and yield calculations match $12.00 / $3.81 / $91.28 / self-funding within rounding tolerance. 100% bar, same as every deterministic-math module in this series.
2. Routing rule table matches Pilot 1's §6.3 exactly, including the decline rule for weak/unknown credit — tested against all four payer-credit × carrier-preference combinations.
3. Float governor correctly forces T3 instead of T2 when `v_float_exposure` shows the tenant at or above `float_cap_usd` — tested against seeded exposure scenarios, since Myra's own cap isn't set yet.
4. All three adapters functional against sandbox credentials; zero code path in this build capable of writing `environment = 'production'`.
5. `factoring_submissions.status` values match the existing TMS factoring field's exact vocabulary (`N/A`/`Submitted`/`Approved`/`Funded`) — confirmed as the same field, not a duplicate.
6. Treasury report computes capital-days and yield-per-1000-capital-days correctly against test data, matching Pilot 1's own formula.
7. T-16 suite green. Zero changes to existing invoice creation or POD-triggered invoice flow.

---

## 8. Gate

**T-27 exit gate (unblocks T-28's billing needs and T-29's platform-level billing/metering):**

- All 7 acceptance criteria pass.
- Patrice confirms the treasury policy defaults (quick pay %, factoring %) and reviews the routing logic against the Pilot 1 document it's built from.

**T-27b (deferred — the strictest gate in this series, given real money is involved):**
1. Non-engineering prerequisites cleared first, outside this module's control: eCapital terms confirmed (rate/advance/recourse), float facility and advisory grant papered by counsel, actual `float_cap` set by Patrice.
2. Sandbox-to-live is not a volume canary like earlier modules — it's a **dollar-capped live pilot**: a small number of real loads, small real dollar amounts, explicitly approved per-transaction by Patrice before `environment = 'production'` is ever written, expanding only after that initial set completes cleanly.
3. Only after that does automatic (unattended) routing execution become appropriate — until then, `decideRoute()`'s output is a recommendation a human acts on, even once real credentials exist.

---

## 9. Portability notes

- Adapter interfaces are thin wrappers around eCapital/Stripe/Persona's own APIs — swappable if any provider relationship changes, since the routing and governor logic doesn't depend on provider-specific details.
- `treasury_policy` living inside `tenant_policies` keeps the "policy without a deploy" principle intact — a tenant's float cap or discount rates can change without touching code.

---

## 10. Claude Code build plan

1. Migration: `treasury_policy` extension (§4.1), `financing_decisions`, `factoring_submissions`, `quick_pay_disbursements`, `kyc_verifications` (§4.2, §4.4).
2. `v_float_exposure` view (§4.3).
3. `decideRoute()` (§5), tested against Pilot 1's exact worked example first — this is the acceptance bar that matters most in this module.
4. Three adapter interfaces, wired to sandbox credentials only. Confirm no code path can write `environment = 'production'`.
5. Integration with the existing TMS factoring status field — extend, don't duplicate.
6. Treasury report (§6) using Pilot 1's own capital-days/yield formula.
7. Run T-16 suite — confirm zero regressions in invoice creation.

Do not let Claude Code wire production credentials for eCapital, Stripe, or Persona in this session under any circumstance, even if they're available in the environment. This module builds the logic and proves it in sandbox; going live is a separate, explicitly authorized step described in §8, not a natural next line of code.

---

*End of T-27.*
