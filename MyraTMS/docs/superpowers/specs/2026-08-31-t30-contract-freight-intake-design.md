# T-30 — Contract Freight Intake — Design

**Spec:** [T30_Contract_Freight_Intake.md](../../../../Engine%203/T30_Contract_Freight_Intake.md)
**Date:** 2026-08-31
**Status:** Approved for implementation planning

## 1. Objective (unchanged from spec)

An email-intake path that lets a tenant's authorized shippers tender freight directly, gets it Claude-parsed and margin-validated, and — after a mandatory human approval — injects it into that tenant's pipeline at `qualified`, flowing through the real Researcher/Ranker workers, landing at `booked` with zero sell-side voice negotiation. Human approval before injection is non-negotiable in this build (spec §3.3, acceptance criterion 5); nothing in this design creates a `pipeline_loads` row without it.

## 2. Schema-reality corrections (found during pre-build research, same discipline every T-2X module has required)

1. **No `inbound_document_intake` table exists.** T-26's own completion notes confirm it extended the real `inbound_emails` table instead of building the table its own spec proposed. T-30's additive columns land on `inbound_emails`, not a table that doesn't exist.
2. **`classifyInboundEmail()` (`lib/email/inbound-classifier.ts`) only recognizes replies to Myra's own outbound emails** — `shipper_reply`/`carrier_reply`, matched by subject-line regex against patterns Myra itself sends. An unsolicited freight-tender email can never match either pattern; today it always falls through to `unmatched`/quarantined. Sender authorization is therefore the actual entry point for this module: checked when classification is `unmatched`, before any extraction runs.
3. **`getMarginFloor(currency)` (`lib/tenants/margin-floor.ts`) is not what spec §4.3 assumes, and the fix is deeper than swapping in a different function.** `getMarginFloor()` is Myra-only (no `tenant_id` param) and returns a flat **dollar** floor ($270 CAD / $200 USD) — but §4.3 computes `impliedMargin` as a **percentage** and compares it directly. The per-tenant replacement, `resolveMargin(tenantId, currency)` (`lib/pricing/resolve-margin.ts`), is *also* dollar-based (`MarginConfig.minMargin`/`targetMargin`/`stretchMargin` are dollar amounts — confirmed via `lib/pricing/sell-envelope.ts`'s `computeSellEnvelope()`, which adds `margin.minMargin` directly onto `totalCost` with no division). **The entire margin system in this codebase — `getMarginThresholds`, `resolveMargin`, `computeSellEnvelope`, carrier-side negotiation params — is dollar-based, with no percentage-margin concept anywhere.** §4.3's percentage formula has no home here. `validateTenderedRate()` instead computes `dollarMargin = tender.rate - cost.total` and compares directly against `resolveMargin(tenantId, currency).margin.minMargin` (or the authorization row's override, see below) — the same shape as every other margin check in this repo, not a percentage. `contract_shipper_authorizations.margin_floor_override_pct` (spec §4.1) is renamed `margin_floor_override_amount` in §3 below for the same reason — a `_pct` column holding a dollar figure would be permanently misleading, and nothing else in this schema names a margin override as a percentage.
4. **No standalone "cost estimate only" function exists.** `validateTenderedRate()` calls `quotePricing()` (`lib/pricing/pricing-engine.ts`, direction `'sell'`) once instead of the spec's two separate calls — it already returns `cost.total` and a correctly-sourced margin envelope, and gets audit logging (`pricing_engine_requests`) for free. Requires one new `requestSource` literal, same pattern as T-22's `'negotiation_api_preview'`.
5. **`source_type`/`booked_via` don't exist on `pipeline_loads`.** They exist only on the TMS `loads` table with a different vocabulary (`manual|ai_agent|load_board_import` / `human|ai_auto|ai_escalated`). Genuinely new columns on `pipeline_loads`, confirmed not a naming collision.
6. **`pipeline_loads` has no `tenant_id`** (same reality T-25/T-26/T-27 already documented). `contract_shipper_authorizations` is tenant-scoped by design (the authorization boundary), but the `pipeline_loads` row it eventually creates inherits the same system-wide-today reality as every other T-2X module's writes into that table.
7. **The stage machine has no `MATCHED → BOOKED` edge**, and acceptance criterion 7 explicitly forbids changing `qualifier-worker.ts`/`researcher-worker.ts`/`ranker-worker.ts`. `VALID_TRANSITIONS`/`isValidTransition()` are declarative only — nothing in the codebase currently enforces them at write time — but the edge is added anyway to keep the stage machine an accurate model.
8. **The approve/reject action point.** Spec §5 says tenders "resolve via the existing console," and T-28 already established exactly this pattern: `PATCH /api/exceptions/[id]` with `action: "resolve"`, branching on `source_module`/`type`, privileged side effects via `asServiceAdmin`. This design follows that precedent rather than building the separate `/api/contract-intake/:id/approve`/`:id/reject` endpoints spec §6 lists — one fewer approval surface. §6's other endpoints (pending list, webhook, authorization CRUD) are still built as their own routes.

## 2a. One more correction found while writing the plan: linking an exception back to its `inbound_emails` row

`bridgeToExceptions()`'s `SourceSignal` links an exception to its source via exactly three nullable fields — `pipelineLoadId`, `loadId` (a `TEXT` FK'd to `loads.id`), `carrierId` (FK'd to `carriers.id`) — and none fits a freight-tender signal: there is no `pipeline_loads` row yet (that's the point — approval creates one), and there is no TMS `loads`/`carriers` row either. Repurposing `loadId` with a synthetic non-FK string would either violate the real FK constraint or (if unconstrained) silently collide with genuine load ids. Cleanest fix, same shape as every other module's targeted `exceptions`-table addition: `exceptions` gains one new nullable column, `inbound_email_id INTEGER REFERENCES inbound_emails(id)`, and `SourceSignal` gains a matching optional `inboundEmailId?: number | null`. `PATCH /api/exceptions/[id]`'s new `contract_intake` branch reads `exc.inbound_email_id` to find the row to act on. Dedup for this source module falls back to `bridgeToExceptions()`'s existing `title` fallback clause (none of `loadId`/`pipelineLoadId`/`carrierId` apply) — sufficient here since `imap-poller.ts` never reprocesses a `message_id` it's already inserted.

## 3. Data model (final)

```sql
-- New table, as spec'd (§4.1), unchanged
CREATE TABLE IF NOT EXISTS contract_shipper_authorizations (
    id                       SERIAL PRIMARY KEY,
    tenant_id                INTEGER NOT NULL REFERENCES tenants(id),
    shipper_email            VARCHAR(200) NOT NULL,
    shipper_company_name     VARCHAR(200),
    margin_floor_override_amount NUMERIC(10,2),  -- dollar amount, same unit as resolveMargin()'s minMargin; renamed from spec's _pct (see §2.3)
    is_active                BOOLEAN DEFAULT true,
    authorized_by            VARCHAR(100) NOT NULL,
    authorized_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, shipper_email)
);

-- Additive to the REAL inbound_emails table (not inbound_document_intake)
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_type VARCHAR(30);
    -- NULL for existing shipper_reply/carrier_reply rows; 'freight_tender' for T-30 rows
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS sender_authorized BOOLEAN;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS created_pipeline_load_id INTEGER REFERENCES pipeline_loads(id);
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS intake_status VARCHAR(20);
    -- 'pending_review' | 'approved' | 'rejected' | 'unauthorized_sender'

-- New columns on the real pipeline_loads table (neither exists there today)
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'load_board';
    -- 'load_board' (default, preserves existing rows' meaning) | 'email_tender'
ALTER TABLE pipeline_loads ADD COLUMN IF NOT EXISTS booked_via VARCHAR(20);
    -- 'ai_call' | 'email_tender' -- NULL for rows not yet booked, matching existing booked_at nullability
```

`VALID_TRANSITIONS[PipelineStage.MATCHED]` gains `PipelineStage.BOOKED`.

## 4. Components

- **`lib/contract-intake/authorization.ts`** — `checkSenderAuthorization(fromAddress)`: looks up `contract_shipper_authorizations` across active rows (single real mailbox today, same "effectively Myra-only, generically tenant-scoped" reality T-19/T-25/T-27 already documented), returns the matching row (with its `tenant_id` and any `margin_floor_override_pct`) or `null`.
- **`lib/documents/tender-terms.ts`** — `extractTenderTerms(pdfBuffer)`, a sibling to `rate-con-terms.ts`'s `extractRateConTerms()` (not a shared function — the extraction prompt and field set genuinely differ: a tender needs equipment type and commodity in addition to rate/origin/destination/pickup date, which `quotePricing()` requires as inputs). Same Claude PDF-input pattern, isolated client, exception-safe (null on any failure).
- **`lib/contract-intake/validate-rate.ts`** — `validateTenderedRate(tenantId, tender, currency, marginFloorOverrideAmount?)`: calls `quotePricing()` once (direction `'sell'`, new `requestSource: 'contract_intake_validation'`) to get `cost.total`, computes `dollarMargin = tender.rate - cost.total`, compares against `marginFloorOverrideAmount ?? (await resolveMargin(tenantId, currency)).margin.minMargin` — a direct dollar comparison, matching `computeSellEnvelope()`'s own pattern, not a percentage (see §2.3).
- **Wiring into `imap-poller.ts`**: when `classifyInboundEmail()` returns `unmatched`, check sender authorization before falling through to today's quarantine behavior.
  - Unauthorized → today's existing quarantine path is preserved as-is; additionally routed to `bridgeToExceptions()` synchronously (T-26's own pattern for calling the bridge inline, not via a poller) with a new `sourceModule: 'contract_intake'`, `exceptionType: 'unauthorized_tender_sender'`.
  - Authorized → extract via `extractTenderTerms()`, validate via `validateTenderedRate()`, write the `inbound_emails` row with `intake_type='freight_tender'`, `intake_status='pending_review'`, then `bridgeToExceptions()` with `exceptionType: 'tender_pending_approval'`, carrying the margin-clear/below-floor distinction in the exception's `description`/`context` so the console shows which case it is (spec §5's two message variants).
- **`lib/contract-intake/finalize-booking.ts`** — the new watcher, called from the same health-check/cron path T-24's `runExceptionBridge()` pollers already run from (not from any queue worker). Polls `pipeline_loads WHERE stage = 'matched' AND source_type = 'email_tender'`, and for each: sets `agreed_rate` from the originating tender, computes `profit`/`profit_margin_pct`, sets `stage='booked'`, `booked_at=NOW()`, `booked_via='email_tender'`, and back-fills `inbound_emails.created_pipeline_load_id`. Everything upstream of `matched` (qualified → researched → matched) is the real Researcher/Ranker workers running unmodified against the row this module inserted — satisfying "flows through research and carrier ranking normally" (spec §2) without touching either file, and satisfying acceptance criterion 7 by construction.
- **`PATCH /api/exceptions/[id]`** — extend the existing `resolve` branch: when `source_module === 'contract_intake'` and `type === 'tender_pending_approval'`, read a new `decision: 'approve' | 'reject'` field from the request body.
  - `reject` → `inbound_emails.intake_status = 'rejected'`, no `pipeline_loads` row, nothing else happens. This is the acceptance-criterion-5 case: verified by a test that a left-unapproved/rejected tender produces zero downstream effect.
  - `approve` → inserts the `pipeline_loads` row (`source_type='email_tender'`, `stage='qualified'`), sets `inbound_emails.intake_status='approved'`, runs via `asServiceAdmin` (same reasoning as T-28: this is a privileged action originating a financial commitment, not a same-tenant read).
  - When `type === 'unauthorized_tender_sender'`, `resolve` is just the existing generic exception resolution (acknowledging a human reviewed it) — no injection path exists for this type at all, by construction.

## 5. New API surface (spec §6, minus the approve/reject endpoints folded into `PATCH /api/exceptions/[id]`, and minus the webhook — see correction below)

**Correction found while gathering plan reference material:** spec §6's `POST /api/contract-intake/webhook` assumes a push-based email receipt mechanism. T-26's real inbound-email system has no such thing — `lib/email/imap-poller.ts`'s `pollInbox()` is a *pull*-based IMAP poller invoked by `scripts/run-imap-poller.ts` (a standalone long-running process, same category as the Railway worker host), not a Vercel route. There is nothing for a webhook to receive. Building one would be new infrastructure this module explicitly disclaims (§9: "no new document-processing infrastructure introduced"). Dropped from this design; T-30's email-side logic is entirely inside `processMessage()`'s existing unmatched branch (§4 above).

```
GET  /api/contract-intake/pending?tenant_id=    (list inbound_emails rows with intake_status='pending_review')
GET  /api/tenants/:id/contract-shippers         (manage contract_shipper_authorizations)
POST /api/tenants/:id/contract-shippers
```

## 6. Acceptance criteria mapping (spec §7)

| # | Criterion | Design coverage |
|---|---|---|
| 1 | Sender authorization blocks injection for unauthorized senders | `checkSenderAuthorization()`, tested with a valid and invalid sender for the same tenant |
| 2 | Unauthorized attempts route to T-24's console via the existing bridge | `bridgeToExceptions()` call, new `exceptionType`, no new mechanism |
| 3 | Extraction reuses T-26's approach, accuracy reported honestly | `extractTenderTerms()`, same Claude PDF pattern, no fabricated accuracy numbers (consistent with T-26 §6.2's own standard) |
| 4 | `validateTenderedRate()` correct at/above/below margin floor | Seeded test cases against `quotePricing()`'s real margin envelope |
| 5 | No `pipeline_loads` row without recorded human approval | `reject`/unapproved path produces zero rows; explicit test |
| 6 | Approved tender reaches `booked` with `booked_via='email_tender'`, zero `agent_calls` rows, no downstream error | Fixture test tracing qualified → researched → matched (real workers) → `finalize-booking.ts` → booked; confirms `agent_calls` subqueries in `qualifier-worker.ts`/`researcher-worker.ts`/`compiler-worker.ts` degrade to 0/null rather than erroring (they use `COUNT()`/scalar subqueries, not joins assumed non-empty — verified during research, but the fixture test is the actual proof this criterion requires) |
| 7 | T-16 suite green; zero changes to qualifier/researcher/ranker workers or C-06's SOP | By construction — those three files are never touched; `finalize-booking.ts` is the only new orchestration code, and it lives outside all three |

## 7. Deferred (spec §2, unchanged)

- T-30b: auto-injection without human approval.
- The buy-side carrier-securing question (T-22/T-23's open item) — inherited as-is, not addressed here.
- Any change to C-06's manual shipper-onboarding SOP.

## 8. Gate (spec §8, unchanged)

All 7 acceptance criteria pass, criterion 5 non-negotiable. Patrice reviews one full fixture run end-to-end before this touches a real tenant relationship.
