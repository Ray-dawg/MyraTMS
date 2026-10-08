---
title: Negotiation Service (Bidirectional)
id: T-22
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-08, T-09, T-17, T-19, T-20, T-21, E3-00]
referenced_by: [T-23, T-24, T-25]
---

# T-22 — NEGOTIATION SERVICE (BIDIRECTIONAL)

**Engine 3 · Phase 2 · Module 3 of 7**
**Parent:** E3-00 §7 (module table), Decision Log ("Sell-side and buy-side run on one Negotiation service with two directions")
**Precondition:** T-21 (Pricing Engine) deployed — this service consumes its envelopes. Phase 0 handoff gate passed for anything touching Engine 2's live path.
**Resolved by Patrice (2026-08-22):** Dispatch One is built as a Retell AI agent, shipped/published, and connected to the Engine 2 orchestrator. This spec's buy-side sections are written accordingly — see §3.1.

---

## Reconciliation note (E2-03, 2026-08-25)

- **§1, §3.1, acceptance criterion 6 ("Dispatch One connected to the orchestrator"):** Resolve per E2-03 §0 of this document first. If Dispatch One's config is recovered from Retell, T-22 should cite E2-03 M2 as the actual connection point; if authored fresh, T-22's acceptance criterion 6 is satisfied by M2 Session 1's audit, not by finding a pre-existing file.
- **§4.3 (`buy-negotiation-queue`):** Named `carrier-call-queue` (E2-03 §6.3) — same concept, actual name as built.

---

## 1. Objective

Today, sell-side negotiation (Engine 2: Compiler → Voice → Retell, calling shippers) and buy-side negotiation (Dispatch One: a standalone Retell config, calling carriers) are two separate, non-sharing systems. The sell side has real infrastructure behind it — a typed `NegotiationBrief` schema, a persona Thompson Sampling engine, a 9-entry objection playbook, a compiler that assembles all of it. The buy side, from what's in the corpus (`dispatch_one_v1.json`), is a single hardcoded Retell conversation flow with its own inline BUY ENVELOPE and no shared persona or objection infrastructure.

T-22 generalizes the sell-side infrastructure to serve both directions, rather than building a second, parallel, drifting copy for buy-side. One `NegotiationEnvelope` schema (built on T-21's direction-aware pricing output), one persona/objection-playbook system extended with a `counterpartyType` dimension, one service both paths call.

---

## 2. Scope

**In scope:**

- Generalized `NegotiationBrief` schema: the existing sell-side schema's `shipper` section abstracted to `counterparty` (works for shipper *or* carrier contact), with direction and counterparty-type fields added
- Objection playbook extended with `counterparty_type` tagging — the existing 9 shipper objections tagged `shipper`, plus a new set of carrier-facing objections (`already_committed`, `rate_too_low`, `equipment_unavailable`, `bad_lane_history`, `need_more_info`) tagged `carrier`, built from the negotiation patterns already present in `dispatch_one_v1.json`'s prompt text
- `NegotiationService.compileEnvelope()` — one function, both directions, calling T-21 for pricing and returning a complete brief
- **Integration discovery**: locate and document the actual code path connecting Dispatch One to the Engine 2 orchestrator (likely inside `dispatcher-worker.ts` or a webhook adjacent to it) — a precondition for everything else on the buy side
- New `buy-negotiation-queue` — BullMQ queue infrastructure formalizing the buy side within the standard pipeline pattern, once the current integration is understood (may replace or wrap whatever ad hoc trigger exists today)
- Shadow-parity validation for **both directions** — sell side against Compiler's live output (as before), buy side against Dispatch One's actual live call outcomes once the integration point is found (see §3.1)
- Read API

**Out of scope (explicitly deferred):**

- Cutting `compiler-worker.ts` over to call the shared service instead of its own assembly logic (T-22b, sell side)
- Modifying the live Dispatch One / orchestrator integration in any way, once located (T-22b — see §3.1 and §8)
- Persona Thompson Sampling extension to carrier-facing personas (needs real buy-side call outcome data first, same principle as T-00 R-2)
- Automated carrier selection logic for who gets called on the buy side — that's T-20/T-23 territory; T-22 only compiles what to say once a carrier is chosen

---

## 3. Design decisions

### 3.1 Dispatch One's actual status — resolved

Confirmed by Patrice: Dispatch One is built as a Retell AI agent, shipped/published, and **connected to the Engine 2 orchestrator.** No dedicated `buy-negotiation-queue` or worker is visible in `queues.ts` or T-00's system report, but that report is dated 2026-06-06 — over two months stale relative to this spec. The likeliest explanation is that the connection runs through the existing Dispatcher (T-10) step, or a direct orchestrator hook built after T-00 was last updated, neither of which is documented in the files available to this spec.

The Retell conversation flow itself confirms the workflow order: its global prompt states *"This load is ALREADY SOLD to the shipper — your job is to hand it off to a carrier at a rate that protects the margin you've been given."* Buy-side negotiation happens **after** sell-side booking, to secure execution capacity — not before. This means Dispatch One is most likely the mechanism, or a planned mechanism, behind T-10's "assigns carrier" step, actually negotiating rather than just picking the top of a pre-ranked stack.

**This changes the risk posture from the earlier draft of this spec.** Dispatch One is not a dormant config file with no live consequence — it is orchestrator-connected today. It gets **the same shadow-validate-before-cutover discipline as the sell side**, not the more permissive "new build, lower risk" treatment. The first buy-side task in this spec is not building new infrastructure — it's **finding and documenting the actual integration point** between Dispatch One and the orchestrator, so T-22b's later work is a known cutover, not a guess.

### 3.2 Generalizing, not duplicating

The alternative to this spec would be: leave the sell side alone, and build a second, independent brief-compiler-equivalent for buy side from scratch. That produces two systems that will drift — a persona tuned for shippers doesn't get shared learnings from carrier calls, an objection handled well on one side has to be manually ported to the other, and every future improvement has to be built twice. T-22 pays a one-time generalization cost to avoid that permanent duplication tax.

---

## 4. Data model

### 4.1 Generalized brief shape (TypeScript, not a new table — this is the in-memory/API contract)

```typescript
interface NegotiationBrief {
  meta: { briefId: number; direction: 'sell' | 'buy'; pipelineLoadId: number; tenantId: number; generatedAt: string };
  load: LoadDetails;                    // unchanged from existing schema

  counterparty: {                        // generalized from "shipper"
    counterpartyType: 'shipper' | 'carrier';
    companyName: string | null;
    contactName: string | null;
    phone: string;
    email: string | null;
    preferredLanguage: Language;
    previousCallCount: number;
    previousOutcomes: CallOutcome[];
    isRepeat: boolean;
    // Carrier-specific (null for shipper direction)
    mcNumber: string | null;
    myraCarrierScore: number | null;     // from T-20, when direction = 'buy'
  };

  pricing: NegotiationEnvelope;          // directly from T-21's PricingQuoteResult.negotiation

  strategy: { approach: string; reasoning: string; keyTalkingPoints: string[] };

  objectionPlaybook: ObjectionEntry[];    // filtered by counterpartyType
  persona: PersonaSelection;               // unchanged mechanism, direction-aware pool

  compliance: ComplianceBlock;              // unchanged from existing schema
  callConfig: CallConfigBlock;               // unchanged from existing schema
}
```

### 4.2 `objection_playbook` table (formalizing what's currently code/config)

```sql
CREATE TABLE IF NOT EXISTS objection_playbook (
    id                   SERIAL PRIMARY KEY,
    counterparty_type    VARCHAR(10) NOT NULL,   -- 'shipper' | 'carrier'
    objection_type        VARCHAR(40) NOT NULL,
    objection_label         VARCHAR(100) NOT NULL,
    response                  TEXT NOT NULL,
    alternate_response         TEXT,
    follow_up_question           TEXT,
    escalate_after                 INTEGER DEFAULT 0,
    priority                        INTEGER NOT NULL,
    is_active                        BOOLEAN DEFAULT true,

    UNIQUE (counterparty_type, objection_type)
);
```

Seeded with the existing 9 shipper objections verbatim (from `objection-playbook.ts`, `counterparty_type = 'shipper'`), plus new `counterparty_type = 'carrier'` entries derived from patterns already implicit in `dispatch_one_v1.json`'s prompts (gatekeeper handling, rate-too-low pushback, already-committed-elsewhere).

### 4.3 `buy-negotiation-queue`

New BullMQ queue, following the exact configuration pattern of the existing `call-queue` (T-03/`queues.ts`): concurrency sized for Retell's throughput, `RETRY_NO_RETRY` (buy-side calls are not idempotent, same reasoning as sell-side calls), priority by expected margin. Added to `ALL_QUEUE_CONFIGS` additively — existing 9 queues untouched.

---

## 5. The service

```typescript
async function compileEnvelope(input: {
  tenantId: number;
  direction: 'sell' | 'buy';
  pipelineLoadId: number;
  counterpartyId: number;      // shipper phone-keyed record, or carrier_registry_id from T-20
}): Promise<NegotiationBrief> {

  const pricing = await quotePricing({                     // T-21
    tenantId: input.tenantId,
    direction: input.direction,
    load: /* from pipeline_loads */,
  });

  const counterparty = input.direction === 'sell'
    ? await profileShipper(/* existing T-06 logic, unchanged */)
    : await profileCarrier(input.counterpartyId);            // new: pulls from T-20's carrier_registry + myra_carrier_scores

  const objections = await getObjectionPlaybook(
    input.direction === 'sell' ? 'shipper' : 'carrier'
  );

  const persona = await selectPersona(input.direction, /* existing Thompson Sampling, direction-scoped pool */);

  const strategy = input.direction === 'sell'
    ? await determineSellStrategy(pricing, counterparty)      // existing T-06 Step 7 logic, unchanged
    : await determineBuyStrategy(pricing, counterparty);       // new, mirrors sell logic

  return assembleBrief({ pricing, counterparty, objections, persona, strategy, /* ...meta, compliance, callConfig */ });
}
```

---

## 6. Interfaces

```
POST /api/negotiation/envelope     { tenantId, direction, pipelineLoadId, counterpartyId } → NegotiationBrief
GET  /api/negotiation/objection-playbook?counterparty_type=
GET  /api/negotiation/shadow-parity-report?since=      (sell side only)
```

---

## 7. Acceptance criteria

1. **Sell-side shadow parity:** `compileEnvelope({direction: 'sell', ...})`, run against ≥30 real briefs Compiler has actually produced, matches the live `NegotiationBrief` output field-for-field (same bar as T-21's criterion 1 — this is relocated logic, not new logic, on the sell side).
2. **Buy-side fixture match:** `compileEnvelope({direction: 'buy', ...})` against the load parameters implied by `dispatch_one_v1.json`'s example produces a consistent BUY ENVELOPE (opening/target/max, upward concessions) and correctly selects only `carrier`-tagged objections.
3. `objection_playbook` seeded with all 9 existing shipper entries verbatim (text diffed against `objection-playbook.ts`, zero drift) plus the new carrier entries.
4. `buy-negotiation-queue` added to `ALL_QUEUE_CONFIGS` without modifying any of the existing 9 queue configs.
5. Zero changes to `compiler-worker.ts`, `voice-worker.ts`, **or the discovered Dispatch One integration point**, once found. T-16 suite green.
6. The actual code path connecting Dispatch One to the Engine 2 orchestrator is located, documented, and confirmed against Patrice's description (Retell agent, shipped, orchestrator-connected) before any change is proposed to it.
7. If real Dispatch One call history exists (via `agent_calls` with `call_type` indicating buy-side, or an equivalent), the buy-side shadow-parity comparison in §7.2 is run against that real history rather than only the static fixture in `dispatch_one_v1.json`.

---

## 8. Gate

**T-22 exit gate (unblocks T-23, which needs to know whether a buy-side negotiation secured a carrier; and T-24/T-25, which consume negotiation outcomes):**

- All 7 acceptance criteria pass, including locating the real Dispatch One integration (criterion 6).
- Patrice reviews both shadow-parity reports (sell and, if real call history exists, buy).

**T-22b (deferred):**
- Sell side: cut `compiler-worker.ts` over to call the shared service. Gated on shadow parity holding at volume, plus a production canary.
- Buy side: cut the discovered Dispatch One integration point over to call `compileEnvelope()` instead of whatever assembles its variables today. Gated identically to the sell side — shadow parity against real call outcomes, plus a production canary — because this spec now treats Dispatch One as a live system, not a dormant one.

---

## 9. Portability notes

- `compileEnvelope()` has no queue dependency — callable directly for testing or by a future tenant-specific negotiation flow.
- The objection playbook moving from static TypeScript config to a database table makes it editable per the "policy without a deploy" principle already established in T-18/T-19 — a new carrier objection type can be added without a code change.

---

## 10. Claude Code build plan

1. **First task, before any new code:** search the codebase for the actual Dispatch One integration — likely inside `dispatcher-worker.ts`, a webhook handler, or a Retell agent-trigger call adjacent to the existing `retell-webhook.ts` pattern. Document what triggers it, what data it's given today, and where its call outcomes (if any) are logged. This is discovery, not build.
2. Migration: `objection_playbook` (§4.2), seeded from `objection-playbook.ts` with a diff check against the source file to confirm zero content drift.
3. `buy-negotiation-queue` config, added to `queues.ts`'s `ALL_QUEUE_CONFIGS` (§4.3) — as a parallel, additive structure alongside whatever integration step 1 found, not a replacement yet.
4. `compileEnvelope()` service (§5), calling T-21 for pricing.
5. `profileCarrier()` — new, built on T-20's `carrier_registry` and `myra_carrier_scores`.
6. Sell-side shadow-parity harness (§7.1).
7. Buy-side shadow-parity: against real Dispatch One call history if step 1 finds any logged outcomes; against the `dispatch_one_v1.json` fixture otherwise.
8. API endpoints (§6).
9. Run T-16 suite — confirm zero regressions.

Do not let Claude Code modify the Dispatch One integration point found in step 1, in this session, once found — that's T-22b, and it now carries the same live-system caution as the sell side.

---

*End of T-22.*
