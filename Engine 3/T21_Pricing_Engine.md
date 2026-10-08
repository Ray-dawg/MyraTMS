---
title: Pricing Engine
id: T-21
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-02, T-06, T-17, T-19, T-20, E3-00]
referenced_by: [T-22, T-23, T-25]
---

# T-21 — PRICING ENGINE

**Engine 3 · Phase 2 · Module 2 of 7 (parallel with T-20)**
**Parent:** E3-00 §7 (module table), original draft PRD Module 2 (Pricing Intelligence)
**Precondition:** Phase 0 handoff gate passed. T-19 deployed (tenant policy source for margin overrides).
**Constraint:** Same as T-20 — Engine 2's rate cascade is live, carrying real revenue. Extraction must not touch it until proven identical.

---

## 1. Objective

T-06 (Researcher) already contains a complete, working pricing brain: a 6-source rate cascade, a cost model, and margin-envelope/negotiation-parameter math. It is currently inlined inside one worker, computed only for sell-side (shipper-facing) loads, with Myra's hardcoded margin constants ($270/$470/$675 CAD).

T-21 extracts that logic into a standalone, callable **Pricing Engine** — not because the math is wrong, but because two things now need it that didn't before: T-22's buy-side (carrier) negotiation needs the mirror-image calculation, and a multi-tenant platform needs margin policy to come from T-19's `tenant_policies`, not a hardcoded constant. One engine, parameterized by direction and tenant, instead of the same math duplicated and drifting in two places.

---

## 2. Scope

**In scope:**

- `POST /pricing/quote` — a standalone service wrapping T-06's Steps 1–5 (distance, rate cascade, cost model, margin envelope, negotiation parameters), unchanged in logic, relocated behind an interface
- **Direction parameter**: `sell` (current behavior — initial offer high, concede down to floor) or `buy` (mirror — initial offer low, concede up to ceiling), matching the BUY ENVELOPE shape already hardcoded in `dispatch_one_v1.json`
- **Tenant-aware margin**: pulls `margin_floor_pct` from T-19's `tenant_policies` when present; falls back to Myra's existing hardcoded constants when a tenant has no override, so Myra's own pricing behavior is provably unchanged
- `pricing_engine_requests` — an audit/comparison log, separate from the existing customer-facing `quotes` table
- A shadow-parity harness: run the new service against real qualified loads in parallel with T-06's live inline computation, diff every output field
- Read API

**Out of scope (explicitly deferred to T-21b):**

- Cutting `researcher-worker.ts` over to call the service instead of computing inline
- Step 6 (shipper/counterparty profiling) and Step 7 (Claude-based strategy narrative) — these stay with the negotiation layer (T-22), not pricing. T-21 is deliberately just the deterministic math: what should this cost, what's the rate ladder — not who we're talking to or how we frame it.
- Buy-side rate learning (correction factors from real carrier acceptance data) — needs T-20's `carrier_outcome_events` at real volume first

---

## 3. Design decision: extraction, not rewrite — validated by exact match, not approximation

Unlike T-20 (a genuinely new capability layered alongside an untouched existing system), T-21 is relocating logic that already exists and works. That makes the validation bar different and stricter: this isn't "does the new model roughly agree with the old one" (T-18's disagreement report, T-20's shadow ranking report) — it's "does the relocated code produce byte-identical output to the code it replaced." If it doesn't, that's a bug in the extraction, full stop. Acceptance criterion §7.1 sets a 100% exact-match bar, not a directional one.

---

## 4. Data model

### 4.1 `pricing_engine_requests`

```sql
CREATE TABLE IF NOT EXISTS pricing_engine_requests (
    id                    BIGSERIAL PRIMARY KEY,
    tenant_id             INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id       INTEGER REFERENCES pipeline_loads(id),

    direction               VARCHAR(10) NOT NULL,   -- 'sell' | 'buy'
    request_source            VARCHAR(30) NOT NULL,   -- 'engine2_researcher_shadow' | 'engine2_researcher_live' |
                                                       -- 'dispatch_one' | 'shadow_comparison'

    input_params               JSONB NOT NULL,
    output_envelope              JSONB NOT NULL,
    margin_source_used             VARCHAR(20) NOT NULL,  -- 'tenant_override' | 'myra_default'

    computed_at                       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pricing_requests_load ON pricing_engine_requests(pipeline_load_id);
CREATE INDEX idx_pricing_requests_direction ON pricing_engine_requests(direction, tenant_id);
```

This is deliberately a separate table from the existing `quotes` table. `quotes` serves the TMS's own customer-facing quoting flow — a different product surface with its own feedback loop already described in T-06. Conflating the two would mix an external-facing quote history with an internal negotiation-envelope audit log; keeping them apart avoids that.

### 4.2 Margin resolution

```typescript
async function resolveMargin(tenantId: number, currency: 'CAD' | 'USD'): Promise<MarginConfig> {
  const policy = await getActiveTenantPolicy(tenantId);  // from T-19
  if (policy?.margin_floor_pct != null) {
    return computeMarginFromPct(policy.margin_floor_pct, currency);
  }
  // Fall back to Myra's existing hardcoded constants — unchanged from T-06
  return currency === 'CAD'
    ? { minMargin: 270, targetMargin: 470, stretchMargin: 675 }
    : { minMargin: 200, targetMargin: 350, stretchMargin: 500 };
}
```

For Myra (tenant 1), `tenant_policies.margin_floor_pct` is left `NULL` at seeding, so this resolves to the exact same constants T-06 uses today. That's not a coincidence — it's the mechanism that makes the shadow-parity test in §7.1 possible.

---

## 5. The service

```typescript
interface PricingQuoteRequest {
  tenantId: number;
  direction: 'sell' | 'buy';
  load: {
    originCity: string; originState: string; originCountry: string;
    destinationCity: string; destinationState: string; destinationCountry: string;
    equipmentType: string;
    distanceMiles?: number;  // computed if absent
  };
}

interface NegotiationEnvelope {
  direction: 'sell' | 'buy';
  openingOffer: number;      // sell: highest ask. buy: lowest offer.
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;        // sell: floor (never go below). buy: ceiling (never go above).
  walkAwayRate: number;      // same as finalOffer
  marginEnvelope: { floor: number; target: number; stretch: number };
  currency: 'CAD' | 'USD';
}

interface PricingQuoteResult {
  rates: RateCascadeResult;      // unchanged shape from T-06
  cost: CostBreakdown;           // unchanged shape from T-06
  negotiation: NegotiationEnvelope;
  marginSourceUsed: 'tenant_override' | 'myra_default';
}

async function quotePricing(req: PricingQuoteRequest): Promise<PricingQuoteResult> {
  const distance = req.load.distanceMiles ?? await getDistance(req.load);
  const rates = await runRateCascade(req.load);              // T-06's cascade, untouched
  const cost = calculateTotalCost(distance, req.load.originCountry, isCrossBorder(req.load));
  const margin = await resolveMargin(req.tenantId, rates.currency);

  const negotiation = req.direction === 'sell'
    ? computeSellEnvelope(cost.total, rates, margin)   // T-06's existing logic, relocated verbatim
    : computeBuyEnvelope(cost.total, rates, margin);   // mirror-image: low → high

  await logPricingRequest(req, { rates, cost, negotiation });
  return { rates, cost, negotiation, marginSourceUsed: /* from resolveMargin */ };
}
```

`computeSellEnvelope()` is T-06's `computeNegotiationParams()` moved here with zero logic changes — same variable names preserved in the diff for auditability. `computeBuyEnvelope()` is new: same shape, opposite direction, calibrated against `dispatch_one_v1.json`'s existing hardcoded BUY ENVELOPE fields (`opening_offer`, `target_buy_rate`, `max_buy_rate`, upward concession steps) as the acceptance fixture (§7.2).

---

## 6. Interfaces

```
POST /api/pricing/quote          { tenantId, direction, load } → PricingQuoteResult
GET  /api/pricing/requests?tenant_id=&direction=&since=
GET  /api/pricing/shadow-parity-report?since=
```

---

## 7. Acceptance criteria

1. **Shadow parity, sell direction:** run against ≥50 real loads that pass through T-06 live. For every field in `rates`, `cost`, and `negotiation`, the Pricing Engine's output matches T-06's actual inline-computed output within $0.01 rounding tolerance. 100% match required — any divergence is investigated and fixed before this criterion passes, not averaged away.
2. **Buy direction, fixture match:** given `dispatch_one_v1.json`'s example load parameters, `computeBuyEnvelope()` produces an opening offer, target, and max-buy rate consistent with that file's documented BUY ENVELOPE structure and concession direction (upward).
3. **Tenant margin override:** a test tenant with `margin_floor_pct` set produces a visibly different envelope than Myra's default; Myra's own tenant (no override) reproduces the exact existing constants.
4. Zero changes to `researcher-worker.ts` or any file in T-06's live path. T-16 suite green.
5. All three API endpoints functional.

---

## 8. Gate

**T-21 exit gate (unblocks T-22's buy-side envelope needs, and T-23):**

- All 5 acceptance criteria pass, including the 100% shadow-parity bar on criterion 1.
- Patrice reviews the parity report.

**T-21b (deferred):** cutting `researcher-worker.ts` over to call `POST /pricing/quote` instead of computing inline. Gated on: (a) the 100% shadow parity holding over a larger sample once more Phase 2 volume exists, and (b) a production canary — run both paths live for a set number of loads, alert on any divergence, before removing the inline computation.

---

## 9. Portability notes

- The service has no dependency on BullMQ or any queue — it's a pure request/response function, callable synchronously from any worker or, later, any tenant's integration.
- Rate cascade sources (DAT, Truckstop, Claude estimate, benchmark) stay behind their existing adapter functions — T-21 doesn't touch those integrations, only the orchestration around them.

---

## 10. Claude Code build plan

1. Migration: `pricing_engine_requests` (§4.1).
2. Relocate T-06's Steps 1–5 into the new service, preserving variable names and logic exactly — this should look like a `git mv` + wrapper, not a rewrite.
3. Build `computeBuyEnvelope()` as the mirror of the existing sell logic, calibrated against `dispatch_one_v1.json`'s fixture values.
4. Build `resolveMargin()` reading from T-19's `tenant_policies` with the documented fallback.
5. Shadow-parity harness: run against ≥50 real loads, produce the diff report.
6. API endpoints (§6).
7. Run T-16 suite — confirm zero regressions in `researcher-worker.ts`, which should be completely untouched.

Do not let Claude Code touch `researcher-worker.ts` in this session, and do not accept "close enough" on the shadow-parity numbers — this extraction is supposed to be invisible to Engine 2 until T-21b, and invisible means exact.

---

*End of T-21.*
