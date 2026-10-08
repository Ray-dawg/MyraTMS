---
title: Contract Freight Intake
id: T-30
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-19, T-20, T-21, T-24, T-26, E3-00]
referenced_by: []
---

# T-30 — CONTRACT FREIGHT INTAKE

**Engine 3 · Phase 4 (Commercialize)**
**Parent:** E3-00 §4.3 (Freight sources by phase), §7 (module table)
**Precondition:** Phase 3 exit gate passed. T-19, T-20, T-21, T-24, T-26 deployed.

---

## 1. Objective

E3-00 §4.3 scoped this precisely: load boards through Phase 3, then "Contract Freight Intake (T-30): an email-intake agent that receives a tenant's direct shipper tenders, parses them, and injects them into that tenant's pipeline at `scanned`." T-26 flagged, while building the narrower rate-confirmation parser, that this module should reuse and generalize that infrastructure rather than duplicate it. This spec does that.

**What's structurally different here, and why it changes the risk posture:** T-26's inbound parser validates a document *against an already-negotiated load* — the pipeline row exists, a human already talked to the shipper, the parser is a cross-check. T-30's parser *creates* a booked commitment from a parsed email, with no voice negotiation in between. That's a meaningfully higher-stakes action — a bad parse or a spoofed sender here doesn't just flag a mismatch, it could inject a fraudulent "booked" load that a real carrier gets dispatched against and real money moves on. Every design decision below follows from taking that difference seriously.

---

## 2. Scope

**In scope:**

- **Sender authorization** — `contract_shipper_authorizations`, a per-tenant whitelist. Freight tenders only come from senders a tenant has explicitly authorized; this is not a general-purpose inbox parser.
- **Tender parsing** — extends T-26's `inbound_document_intake` with a new `intake_type = 'freight_tender'`, reusing its Claude-based extraction rather than building a second extraction service
- **Margin validation** — T-21's Pricing Engine called in a *validate* mode (does the tendered rate clear the tenant's margin floor?), not its negotiate mode — there's nothing to negotiate, the rate is already fixed by the shipper's tender
- **Human approval before injection** — every parsed tender lands in T-24's existing console for confirmation before it becomes a real `pipeline_loads` row. This is the strictest gate in this spec's v1, and it stays in place until T-30b explicitly earns its removal.
- Pipeline injection: an approved tender creates a `pipeline_loads` row entering at `qualified`, flowing through research and carrier ranking normally, **skipping** `briefed`/`calling` (no sell-side voice negotiation needed — the terms are already tendered), landing at `booked` with `booked_via = 'email_tender'`

**Out of scope (explicitly deferred to T-30b):**

- Auto-injection without human approval — the strictest deferred cutover in this series, for the reason in §1
- Solving the open buy-side carrier-securing question T-22 and T-23 already flagged (whether/how Dispatch One is wired into the `matched → booked` transition). T-30's injected loads reach `booked` and enter the **existing** dispatch flow exactly like any other booked load — this spec does not attempt to resolve that separate open question, it inherits whatever the answer turns out to be.
- Any change to C-06's manual shipper-onboarding SOP. If anything, T-30 is what C-06 eventually feeds *into* — a shipper Patrice or a tenant onboards manually today becomes, once authorized in `contract_shipper_authorizations`, a source T-30 can ingest tenders from automatically. That connection is worth having in mind, but building it is not part of this spec.

---

## 3. Design decisions

### 3.1 Generalize T-26, don't duplicate it

T-30 adds an `intake_type` dimension to T-26's existing intake table and extraction service rather than building a parallel pipeline. The two intake types diverge only where they have to: a `rate_con_confirmation` matches against an existing load; a `freight_tender` has no existing load to match — it's the seed of a new one.

### 3.2 Authorization is not the same as matching, and both are required

T-26's parser matches a document to a load and reports confidence. That's an appropriate bar for a document that's already inside a known transaction. T-30 adds a check T-26 didn't need: is this sender even allowed to originate freight for this tenant at all? An email arriving from an address not on `contract_shipper_authorizations` isn't a low-confidence match to be flagged — it doesn't get parsed for injection purposes at all. It's routed to T-24's console as a security-relevant event, the same conservative posture T-25 uses for a banking-detail change: detect, don't act, put it in front of a human.

### 3.3 Human approval is the default, not the fallback

Every module in this series has had some form of "prove it before it acts automatically." T-30's version of that is the strictest, because unlike a halt (T-25) or a resolution action (T-24), approving a tender doesn't just permit something to continue — it originates a brand-new financial commitment from an unattended email parse. Acceptance criterion §7.5 requires human approval to be the only path to injection in this build; T-30b is what earns removing it, the same way T-27b earns real money movement and T-28b earns autonomous tenant go-live.

---

## 4. Data model

### 4.1 `contract_shipper_authorizations`

```sql
CREATE TABLE IF NOT EXISTS contract_shipper_authorizations (
    id                    SERIAL PRIMARY KEY,
    tenant_id             INTEGER NOT NULL REFERENCES tenants(id),

    shipper_email            VARCHAR(200) NOT NULL,   -- exact address or a verified domain pattern
    shipper_company_name        VARCHAR(200),
    margin_floor_override_pct      NUMERIC(5,2),          -- optional, else falls back to tenant default

    is_active                        BOOLEAN DEFAULT true,
    authorized_by                       VARCHAR(100) NOT NULL,
    authorized_at                          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id, shipper_email)
);
```

### 4.2 Extending T-26's `inbound_document_intake`

```sql
ALTER TABLE inbound_document_intake ADD COLUMN IF NOT EXISTS intake_type VARCHAR(30) DEFAULT 'rate_con_confirmation';
    -- 'rate_con_confirmation' (T-26) | 'freight_tender' (T-30)
ALTER TABLE inbound_document_intake ADD COLUMN IF NOT EXISTS sender_authorized BOOLEAN;
ALTER TABLE inbound_document_intake ADD COLUMN IF NOT EXISTS created_pipeline_load_id INTEGER REFERENCES pipeline_loads(id);
ALTER TABLE inbound_document_intake ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20) DEFAULT 'pending_review';
    -- 'pending_review' | 'approved' | 'rejected' | 'unauthorized_sender'
```

Additive to T-26's table, not a new one — a `freight_tender` row simply doesn't populate `matched_pipeline_load_id` (nothing to match yet) and instead populates `created_pipeline_load_id` once approved.

### 4.3 Margin validation (thin call into T-21, not new pricing logic)

```typescript
async function validateTenderedRate(tenant_id: number, tender: ExtractedTenderTerms): Promise<{
  acceptable: boolean; marginPct: number; reason: string;
}> {
  const cost = await getCostEstimate(tender);          // T-21's existing cost model
  const marginFloor = await getMarginFloor(tenant_id);  // T-19/T-21's existing resolution
  const impliedMargin = ((tender.rate - cost.total) / tender.rate) * 100;
  return {
    acceptable: impliedMargin >= marginFloor,
    marginPct: impliedMargin,
    reason: impliedMargin >= marginFloor ? 'Clears margin floor' : 'Below tenant margin floor — human decision required',
  };
}
```

---

## 5. The intake flow

```
Email arrives → sender checked against contract_shipper_authorizations
   │
   ├─ Unauthorized → intake_status = 'unauthorized_sender'
   │                  → routed to T-24 console as a security-relevant exception (existing bridge, new exception_type)
   │                  → NOT parsed further, NOT injected
   │
   └─ Authorized → Claude-based extraction (reusing T-26's service, intake_type = 'freight_tender')
                    → validateTenderedRate() (§4.3)
                    → intake_status = 'pending_review', routed to T-24 console either way:
                        "New tender ready — approve to inject" (margin clears)
                        "Tender below margin floor — accept anyway or decline" (margin doesn't clear)
                    → human resolves via the existing console
                        Approve → creates pipeline_loads row: source_type='email_tender',
                                  enters at 'qualified', flows through research + carrier ranking,
                                  skips briefed/calling, lands at 'booked', booked_via='email_tender'
                        Reject  → intake_status = 'rejected', no pipeline_loads row created
```

---

## 6. Interfaces

```
POST /api/contract-intake/webhook            (email/attachment receipt)
GET  /api/contract-intake/pending?tenant_id=
POST /api/contract-intake/:id/approve
POST /api/contract-intake/:id/reject
GET  /api/tenants/:id/contract-shippers       (manage the authorization whitelist)
POST /api/tenants/:id/contract-shippers
```

---

## 7. Acceptance criteria

1. Sender authorization correctly blocks injection for any email not on `contract_shipper_authorizations` — tested against both a valid and an invalid sender for the same tenant.
2. Unauthorized-sender attempts correctly route to T-24's existing console as a security-relevant exception, reusing the bridge built for T-24/T-28 rather than a new mechanism.
3. Tender extraction (intake_type = 'freight_tender') reuses T-26's extraction service; parser accuracy reported honestly (same standard as T-26 §6.2 — no historical baseline exists for this either).
4. `validateTenderedRate()` produces correct accept/flag decisions against seeded test cases at, above, and below a tenant's margin floor.
5. **No pipeline_loads row is ever created without a human approval action recorded** — verified by an explicit test that a pending tender, left unapproved, produces zero downstream effect.
6. An approved tender correctly creates a `pipeline_loads` row at `qualified`, and — traced through a fixture run — correctly reaches `booked` with `booked_via = 'email_tender'` and zero `agent_calls` rows, confirming downstream code that might assume every booked load has a call history handles this case without erroring.
7. T-16 suite green. Zero changes to `qualifier-worker.ts`, `researcher-worker.ts`, `ranker-worker.ts`, or C-06's SOP.

---

## 8. Gate

**T-30 exit gate:**

- All 7 acceptance criteria pass, with criterion 5 treated as non-negotiable.
- Patrice reviews at least one full fixture run end-to-end (authorized sender → parsed tender → console approval → real-shaped booked load) before this is used against a real tenant's real shipper relationship.

**T-30b (deferred):** removing the human approval requirement for injection, once a real tenant has run enough tenders through manual approval to justify it — same staged-trust arc as every `*b` in this series, applied here to its strictest case.

---

## 9. Portability notes

- Reuses T-26's extraction service and email-intake mechanism entirely — no new document-processing infrastructure introduced.
- The authorization whitelist is plain Postgres, portable to any host, and is the actual security boundary — not the email channel itself, which should never be trusted alone.

---

## 10. Claude Code build plan

1. Migration: `contract_shipper_authorizations` (§4.1), additive columns on `inbound_document_intake` (§4.2).
2. Sender authorization check, wired first, before any extraction logic runs — an unauthorized email should never reach the Claude extraction call at all, both for correctness and to avoid spending tokens on senders that were never going to be accepted.
3. Extend T-26's extraction service with `intake_type = 'freight_tender'` handling — reuse, don't reimplement.
4. `validateTenderedRate()` (§4.3), thin wrapper on T-21.
5. Console routing for both unauthorized-sender and pending-tender cases, via T-24's existing bridge.
6. Approval action that creates the `pipeline_loads` row per §5's flow — this is the one place in this module that writes a real row with real downstream consequence, and it should only be reachable from an explicit human approval action.
7. Fixture test tracing an approved tender all the way to `booked` (criterion 6), including confirming no downstream code path breaks on the absence of `agent_calls` rows.
8. Run T-16 suite — confirm zero regressions.

Do not let Claude Code build any code path that creates a `pipeline_loads` row from a parsed tender without a human approval action in between, in this session or any future one until T-30b is explicitly authorized. This is the one instruction in this entire document series worth repeating without hedging.

---

*End of T-30. Master child-spec set (T-17 through T-30) complete.*
