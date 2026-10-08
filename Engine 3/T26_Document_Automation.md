---
title: Document Automation
id: T-26
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-17, T-19, T-22, T-23, T-25, E3-00]
referenced_by: [T-27, T-30]
---

# T-26 — DOCUMENT AUTOMATION

**Engine 3 · Phase 2 · Module 7 of 7 (final Phase 2 module)**
**Parent:** E3-00 §7 (module table), original draft PRD Module 11 (Document Automation)
**Precondition:** Phase 0 handoff gate passed. T-17, T-19, T-22, T-23, T-25 deployed.

---

## 1. Objective — and an asymmetry the existing system already encodes correctly

More of this module already exists than the draft PRD's module list implies. The TMS has a working Document Vault (type-filtered upload to Vercel Blob — BOL, POD, Rate Con, Insurance, Contract, Invoice), PDFKit-based rate confirmation generation, and a public tracking page that self-serves BOL/POD/Invoice to shippers while correctly excluding Insurance/Contract/Rate Con. None of that needs rebuilding.

What's worth naming explicitly — because it's easy to miss and the two Retell conversation flows already get it right — is that **rate confirmation flows in opposite directions depending on which side of the transaction it's for:**

- **Sell-side (shipper):** the shipper issues the rate con, on their own letterhead. Myra's voice agent's job is to lock the rate verbally and capture where the shipper's document will come from. Myra *receives* this document; it does not generate it.
- **Buy-side (carrier):** Myra issues the rate con to the carrier. This is the flow `/api/loads/[id]/assign` already automates via PDFKit.

The existing system fully handles the second flow and has **no mechanism at all for the first** — nothing receives, parses, or validates an inbound shipper rate con today. That's the actual gap T-26 closes, alongside formalizing what already works.

---

## 2. Scope

**In scope:**

- **Inbound rate-con intake (sell-side) — genuinely new.** Receive the shipper's rate con (email attachment, sent to the `booking_email` the voice agent captures during the call), extract its terms (rate, lane, pickup date, equipment), match it to the correct `pipeline_load_id`, and compare its terms against what was verbally negotiated
- **Terms-mismatch detection** — a new control: if the shipper's actual issued rate con doesn't match the negotiated rate, that's a risk signal today's system has no way to catch, routed through T-25/T-24
- **Outbound rate-con formalization (buy-side)** — instrument the existing PDFKit generation/send flow with T-17 events, without touching the generation code itself
- Closing part of T-23's acceptance gap: a carrier's signed/returned rate con becomes a real `confirmation_method = 'rate_con_signed'` entry in `carrier_acceptance_state`
- Extending T-17's event taxonomy with document lifecycle events
- Additive tenant scoping on the existing `documents` table

**Out of scope (explicitly deferred to T-26b):**

- Automatically blocking booking or dispatch on a detected terms mismatch — flagged, not enforced, same reasoning as T-25's halt discipline
- Full generalization into T-30's broader email-tender intake (any tenant's direct shipper freight tenders, Phase 4). T-26 builds the narrower rate-con-specific parser now, scoped to Pilot-adjacent operation; T-30 should reuse and generalize this parser rather than duplicate it — noted explicitly so T-30's build doesn't start from zero
- OCR/extraction accuracy tuning beyond a first honest baseline (§6.2) — shippers issue on their own letterhead, so this is inherently more variable than any document Myra generates itself

---

## 3. Design decisions

### 3.1 Formalize the working half; build the missing half honestly

Same posture as T-25: the outbound (buy-side) rate-con flow is instrumented, not rebuilt — T-26 adds observability, not new generation logic, and the acceptance bar for that half is exact parity, same as every other extraction in this series. The inbound (sell-side) parser is new, and its acceptance bar is an honestly reported accuracy number, not a false 100% — extracting structured terms from documents on a shipper's own letterhead is a genuinely variable problem, closer to T-06's Claude-based rate estimation than to relocated deterministic logic.

### 3.2 Preserve the existing security boundary without exception

The public tracking page's exclusion of Insurance/Contract/Rate Con from self-service is a real security control, not an oversight to "fix" while extending the document system. T-26 must not weaken it — this is stated as a hard constraint in the acceptance criteria (§6.5), not left to be assumed.

---

## 4. Data model

### 4.1 `documents` table — additive extension

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parsed_terms JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS terms_match_status VARCHAR(20) DEFAULT 'not_checked';
    -- 'not_checked' | 'match' | 'mismatch' | 'unparseable'
```

(Exact existing column names for the `documents` table weren't available in the corpus consulted for this spec — Claude Code should confirm the live schema before writing this migration, rather than assume the table shape described here is complete.)

### 4.2 `inbound_document_intake`

```sql
CREATE TABLE IF NOT EXISTS inbound_document_intake (
    id                     SERIAL PRIMARY KEY,
    tenant_id              INTEGER NOT NULL DEFAULT 1,

    source_email             VARCHAR(200) NOT NULL,
    received_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attachment_blob_url           TEXT NOT NULL,

    matched_pipeline_load_id        INTEGER REFERENCES pipeline_loads(id),
    match_confidence                   NUMERIC(4,3),
    match_method                          VARCHAR(30),   -- 'load_id_reference' | 'lane_date_heuristic' | 'unmatched'

    extracted_terms                          JSONB,
    processing_status                           VARCHAR(20) DEFAULT 'pending'  -- 'pending' | 'matched' | 'unmatched' | 'parse_failed'
);

CREATE INDEX idx_inbound_intake_load ON inbound_document_intake(matched_pipeline_load_id);
CREATE INDEX idx_inbound_intake_unmatched ON inbound_document_intake(processing_status) WHERE processing_status != 'matched';
```

### 4.3 Extending T-17's event taxonomy

| event_type | derived_from_table | Fires on |
|---|---|---|
| `document.rate_con_sent` | documents / assign route | outbound rate con generated and sent |
| `document.rate_con_received` | inbound_document_intake | inbound email/attachment received |
| `document.rate_con_matched` | inbound_document_intake | `matched_pipeline_load_id` set |
| `document.terms_mismatch_detected` | documents | `terms_match_status = 'mismatch'` |
| `document.bol_uploaded` | documents | type = 'BOL' insert |
| `document.pod_uploaded` | documents | type = 'POD' insert |

Same exception-safe trigger pattern as T-17. No new parallel event log.

### 4.4 Terms comparison

```typescript
async function compareTerms(intake: InboundDocumentIntake): Promise<'match' | 'mismatch' | 'unparseable'> {
  if (!intake.extractedTerms) return 'unparseable';
  const negotiated = await getNegotiatedTerms(intake.matchedPipelineLoadId);  // from T-22's compiled envelope / agent_calls

  const rateMatches = Math.abs(intake.extractedTerms.rate - negotiated.agreedRate) < 1.00;
  const laneMatches = intake.extractedTerms.origin === negotiated.origin
                    && intake.extractedTerms.destination === negotiated.destination;
  const dateMatches = intake.extractedTerms.pickupDate === negotiated.pickupDate;

  return (rateMatches && laneMatches && dateMatches) ? 'match' : 'mismatch';
}
```

A `mismatch` result writes into T-25's risk-signal path (`transaction_risk_signals` or equivalent extension) and surfaces through T-24's console — this module detects, T-25/T-24 own what happens next, same separation of concerns as every prior module.

---

## 5. Interfaces

```
POST /api/documents/inbound-intake         (webhook/poll target for inbound rate-con emails)
GET  /api/documents/rate-con/:pipelineLoadId   (unified status: inbound for sell-side, outbound for buy-side)
GET  /api/documents/terms-mismatches?status=unresolved
GET  /api/documents/intake-match-report?since=   (parser accuracy, honestly reported)
```

---

## 6. Acceptance criteria

1. Outbound rate-con events (`document.rate_con_sent`) correctly populate T-17's `events` for every call to the existing `/api/loads/[id]/assign` flow, with zero changes to the PDFKit generation code itself.
2. Inbound parser tested against a sample set of real or representative shipper rate-con documents (varied formats, since shippers issue on their own letterhead). Match rate to the correct `pipeline_load_id` and term-extraction accuracy are both reported as real numbers in `intake-match-report` — not assumed, not rounded up.
3. Terms-mismatch detection correctly flags all deliberately seeded mismatch cases and produces zero false positives on matched-rate test cases.
4. `carrier_acceptance_state` gets populated with `confirmation_method = 'rate_con_signed'` when a carrier's returned rate con is detected, closing part of the gap T-23 quantified.
5. The public tracking page's document exclusion (Insurance/Contract/Rate Con never self-served) is verified unchanged by an explicit regression test, not just by inspection.
6. `documents` table tenant-scoped additively; zero behavior change for tenant 1's existing document flows.
7. T-16 suite green. Zero changes to `/api/loads/[id]/assign`'s rate-con generation logic.

---

## 7. Gate

**T-26 exit gate (completes the Phase 2 module set — T-20 through T-26 — feeding T-27's need for invoice/document state):**

Building all seven Phase 2 specs is not the same as passing Phase 2's own exit gate. E3-00 §8 sets that gate as 100 consecutive loads through `booked → dispatched → delivered → scored` with ≥80% zero-touch — that requires these modules built, integrated, and run against real volume, not just specified. T-26's own exit gate is narrower:

- All 7 acceptance criteria pass.
- Patrice reviews the inbound-parser accuracy report (§6.2) specifically, since — like T-25's payer credit logic — it's new functionality without a historical baseline to validate against.

**T-26b (deferred):** automatic blocking on terms mismatch; generalizing the inbound parser into T-30's broader email-tender intake.

---

## 8. Portability notes

- Document storage stays on Vercel Blob, unchanged — T-26 adds metadata and events around it, not a new storage layer.
- The terms-extraction function is isolated enough to be the literal reused component when T-30 generalizes it, rather than a pattern to be reimplemented.

---

## 9. Claude Code build plan

1. **First:** confirm the live `documents` table schema before writing the migration in §4.1 — don't assume the shape described here is complete.
2. Migration: `documents` additive columns, `inbound_document_intake` (§4.1–4.2).
3. Document-lifecycle trigger functions extending T-17 (§4.3).
4. Inbound intake handler — email/attachment receipt, Claude-based term extraction, load matching by `load_id_reference` first, `lane_date_heuristic` fallback.
5. `compareTerms()` (§4.4), tested against seeded mismatch and match cases.
6. Wire a `rate_con_signed` write path into T-23's `carrier_acceptance_state`.
7. Regression test confirming the public tracking page's document exclusion is unchanged (§6.5).
8. API endpoints (§5).
9. Run T-16 suite — confirm zero regressions.
10. Produce the intake-match-report with real numbers before declaring this module done.

---

*End of T-26. Phase 2 module set (T-20–T-26) complete — see note below on next steps before treating Phase 2 itself as finished.*
