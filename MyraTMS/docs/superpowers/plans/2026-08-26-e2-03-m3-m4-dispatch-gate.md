# E2-03 M3 + M4 — Rate-Con Gate + Carrier Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish PRD Session 3 (M4 verification) and Session 3/4's code portion of M3 (real rate-con send + dispatch-confirmation gate) — the two modules between M2 (cascade, done) and the still-blocked Session 4 operator work (shadow drain, founder sign-off, first live call, which stay out of scope here per the PRD's own gate).

**Architecture:** M2's cascade secures a carrier by writing `pipeline_loads.carrier_call_outcome='accept'` + `carrier_id_secured` + `carrier_agreed_rate` — but nothing downstream reads those columns yet. `dispatcher-worker.ts` still dispatches against the stale `top_carrier_id` (the Ranker's pre-cascade pick) and, being gated by `CARRIER_AUTO_ASSIGN_ENABLED=false`, always escalates for human phone confirmation regardless of what the cascade found. This plan (1) teaches the Dispatcher to consume the cascade's *secured* carrier when one exists — the exact connective tissue PRD §11's spec-reconciliation table calls for — and (2) adds the M3 gate + M4 precondition to `/api/loads/[id]/assign`, the shared route both the Dispatcher and human brokers call. The gate is scoped to AI-cascade loads only (`loads.pipeline_load_id IS NOT NULL`) — manual human assignments keep today's exact behavior, unchanged. This keeps blast radius on a shared, live production route to the minimum the PRD actually asks for.

**Tech Stack:** TypeScript, Neon (`withTenant`/`db-adapter`), `lib/verification/authority-lookup.ts` (E2-01, unmodified — reused, not rebuilt), `nodemailer` (`lib/email.ts`), `pdfkit` (`lib/rate-confirmation.ts`, unmodified — reused), Vercel Blob, Vitest.

**Spec:** `Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md` §7 (M3), §8 (M4), §11 (spec reconciliation — Dispatcher consumes a secured carrier), §13 Session 3 item 13 + Session 4 item 14.

## Global Constraints

- Do not touch `voice-worker.ts`, shipper-side webhook handlers, or anything in M2's cascade logic (`carrier-cascade.ts`, `carrier-voice-worker.ts`'s dial path) — this plan is downstream of M2, not a revision of it.
- The gate applies ONLY to loads with `loads.pipeline_load_id IS NOT NULL` (AI-cascade origin). Manual broker assignments through the same `/assign` route keep today's exact behavior — immediate dispatch flip, best-effort rate-con, no verification check. This is a deliberate scoping decision (documented here, not hidden) to avoid disrupting the live manual-assignment flow real brokers use today.
- `CARRIER_AUTO_ASSIGN_ENABLED` and `CARRIER_CALLS_ENABLED` both keep defaulting `false` in every env touched. This plan does not flip either.
- No re-verification expiry policy for M4 — `carriers.verified_at IS NOT NULL` is treated as verified indefinitely. Not asked for by the PRD; a future session can add a staleness window if the operator wants one.
- "Rate-con send attempted and logged" (PRD D6) is satisfied by any of: `rate_con_send_status IN ('sent', 'failed', 'skipped_no_email')` — a carrier with no `contact_email` on file is a logged, visible gap (mirrors M0's `carrier_cost_estimated` "honesty flag" pattern), not a silent block on every AI dispatch.

---

## Task 1: Migration 043 — schema additions

**Files:**
- Create: `scripts/043-m3-m4-dispatch-gate.sql`
- Create: `scripts/verify-043-m3-m4-dispatch-gate.ts` (mirrors `verify-042-carrier-call-columns.ts`'s shape)

**Columns:**
```sql
ALTER TABLE carriers
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
  -- carriers has contact_name/contact_phone but no email column at all —
  -- a real gap for "email first" (PRD D5) rate-con delivery.

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS rate_con_sent_at     TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rate_con_send_status VARCHAR(20),
      -- 'sent' | 'failed' | 'skipped_no_email'
  ADD COLUMN IF NOT EXISTS rate_con_send_error  TEXT;
```
`carriers.verified_at`/`verified_by`/`verification_snapshot` already exist (migration 041, M0/M4 foundation) — nothing to add there.

- [ ] Write the migration file (idempotent `ADD COLUMN IF NOT EXISTS`, `BEGIN`/`COMMIT`, header comment matching 041/042's style).
- [ ] Write the verify script: connects via `db-adapter`, asserts `information_schema.columns` has all 4 new columns with the right types, exits 0/1.
- [ ] Apply to live Neon via `pnpm tsx --env-file=.env.local scripts/043-m3-m4-dispatch-gate.sql`-equivalent runner (same ad-hoc tsx-executes-the-.sql-file approach prior sessions used — no dedicated generic applier exists in this repo, confirmed by grepping for one).
- [ ] Run the verify script — must pass.
- [ ] Commit migration + verify script.

---

## Task 2: `lib/verification/carrier-verification.ts` — M4

**Files:**
- Create: `lib/verification/carrier-verification.ts`
- Test: `__tests__/verification/carrier-verification.test.ts` (mock-HTTP-server pattern copied from `__tests__/verification/authority-lookup.test.ts`)

**Interface:**
```ts
export interface CarrierVerificationResult {
  verified: boolean;
  reason: string | null;      // set when verified=false; null when true
  entityClass: EntityClass;
  legalNameMatch: boolean | null; // null = couldn't evaluate (no legalName returned)
  snapshot: AuthorityLookupResult;
}

export async function verifyCarrierAuthority(
  carrierId: string,
  opts?: { verifiedBy?: string },
): Promise<CarrierVerificationResult>
```

**Logic:**
1. Fetch carrier row (`company`, `mc_number`, `dot_number`, `home_city`, `verified_at`).
2. If `verified_at` already set → short-circuit, return `{ verified: true, reason: null, ... }` reading the persisted `verification_snapshot` back out rather than re-querying FMCSA (no re-verification policy per Global Constraints).
3. Else, build `AuthorityLookupInput`: `mcNumber`/`dotNumber` from the carrier row (empty-string → `undefined`, matching `qualifier-worker.ts`'s existing convention), `companyName: company`, `country` inferred from a 2-letter code trailing `home_city` via a small local regex (`/,\s*([A-Z]{2})$/`) piped through `lib/loadboards/normalize-helpers.ts`'s exported `inferCountry()` — default `'US'` if no code found.
4. Call `lookupAuthority(input)`.
5. `legalNameMatch`: null if `result.legalName` is null; else a lenient normalized-token-overlap check against `carrier.company` (lowercase, strip `.,'"`, strip `inc|ltd|ltee|corp|co|llc|limited` tokens, split on whitespace, true if any non-trivial token (length ≥ 3) appears in both).
6. `verified = result.status === 'resolved' && result.entityClass === 'carrier_for_hire' && result.authority.commonOrContract === 'active' && legalNameMatch !== false` (i.e. an explicit mismatch fails verification; `null`/unknown does not).
7. `reason` when `verified=false`: one of `'lookup_unresolved'` | `'not_for_hire_authority'` | `'authority_inactive'` | `'legal_name_mismatch'` (first applicable, in that order).
8. If verified: `UPDATE carriers SET verified_at=NOW(), verified_by=$2, verification_snapshot=$3 WHERE id=$1` (`verified_by` defaults `'system:authority-lookup'` when `opts.verifiedBy` absent).
9. Return the result either way (callers decide what to do with `verified=false`).

- [ ] Implement `carrier-verification.ts`.
- [ ] Write tests: verified path (mock FMCSA returns `carrier_for_hire` + active + matching name → `carriers.verified_at` set); `not_for_hire_authority` (mock returns `carrier_private`); `authority_inactive` (mock returns `commonOrContract: 'inactive'`); `legal_name_mismatch` (mock legal name completely unrelated to carrier.company); already-verified short-circuit (pre-set `verified_at`, assert zero HTTP requests to the mock server).
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit.

---

## Task 3: `lib/email.ts` — rate-con send with PDF attachment

**Files:**
- Modify: `lib/email.ts`
- Test: covered by Task 5's integration test (no SMTP configured in test env → exercises the graceful `return false` path, same as existing `sendTrackingEmail` tests elsewhere in this codebase do — confirmed no dedicated `email.test.ts` exists today, matching convention of not unit-testing this file in isolation).

**Add:**
```ts
export async function sendRateConfirmationEmail(
  to: string,
  carrierName: string,
  loadReference: string,
  pdfBuffer: Buffer,
): Promise<boolean>
```
Mirrors `sendTrackingEmail`'s structure (branded HTML template, `getTransporter()` reuse, `return false` gracefully when SMTP unconfigured) but passes `attachments: [{ filename: 'RC-${loadReference}.pdf', content: pdfBuffer, contentType: 'application/pdf' }]` to `transporter.sendMail()` — nodemailer supports this natively, no new dependency.

- [ ] Implement, following `sendTrackingEmail`'s existing pattern exactly (branding, `getFromEmail` reuse, try/catch → `false`).
- [ ] `pnpm tsc --noEmit` clean.
- [ ] Commit.

---

## Task 4: `app/api/carriers/[id]/verify/route.ts` — M4 human-confirmation path

**Files:**
- Create: `app/api/carriers/[id]/verify/route.ts`
- Test: `__tests__/api/carriers-verify.test.ts`

Mirrors `app/api/carriers/[id]/promote/route.ts`'s shape exactly (role gate, `withTenant`, `compliance_audit` insert). `PATCH` body: `{ method: 'lookup' } | { method: 'manual', notes?: string }`.

- `method: 'lookup'` → calls `verifyCarrierAuthority(id, { verifiedBy: `user:${user.userId}` })`, returns its result (200 whether verified or not — the caller/UI decides what to show; this endpoint reports, doesn't gate anything itself).
- `method: 'manual'` → human override for carriers the automated lookup can't resolve (e.g. small CVOR-only Canadian carriers) — PRD §8 explicitly names "populated by the lookup or a human confirmation" as the two valid paths. Directly sets `verified_at=NOW()`, `verified_by=user:${userId}`, `verification_snapshot={"manual": true, "notes": notes ?? null, "confirmedBy": user.userId}`. Logged to `compliance_audit` with `check_type='carrier_manual_verify'` — a human bypassing the FMCSA check is exactly the kind of action that belongs in the audit trail.

- [ ] Implement the route.
- [ ] Tests: `lookup` method persists verification on a mocked-resolved carrier; `manual` method persists without ever calling `lookupAuthority`; both require admin/owner/service_admin role (403 otherwise, matching `promote`'s test coverage shape); 404 on unknown carrier.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit.

---

## Task 5: `/api/loads/[id]/assign` — the M3 + M4 gate

**Files:**
- Modify: `app/api/loads/[id]/assign/route.ts`
- Test: `__tests__/api/loads-assign-cascade-gate.test.ts`

**Changes:**
1. SELECT also fetches `pipeline_load_id` from `loads` alongside the existing columns.
2. If `pipeline_load_id` is `NULL` → **entire rest of the route is byte-for-byte unchanged** (manual-assignment path, untouched).
3. If `pipeline_load_id` is set (AI-cascade load):
   a. The carrier-assignment `UPDATE` still writes `carrier_id`/`carrier_name`/`carrier_cost`/`margin`/`margin_percent`/`driver_id`, but the `status = CASE WHEN status='Booked' THEN 'Dispatched' ...` clause is **dropped** for this branch — status stays whatever it was (still `'Booked'`) until the gate below clears.
   b. M4 precondition: `SELECT verified_at FROM carriers WHERE id=$1`. If null, call `verifyCarrierAuthority(carrier_id)`. If the result (fresh or persisted) is still not verified → write an `exceptions` row (`type='carrier_verification_failed'`, `severity='high'`, `carrier_id`, `pipeline_load_id`, `suggested_action` naming the `reason`) and return `{ status: 'escalated', escalation_reason: 'carrier_not_verified', verification_reason: <reason> }`, 200. **Rate-con is never generated or sent in this branch.**
   c. If verified: generate the PDF (`generateRateCon`, unchanged), upload to blob, `attachDocument` (unchanged) — same as today, just no longer wrapped in a "best-effort, doesn't matter if it fails" posture. If PDF generation itself throws (can't even attempt a send) → write an `exceptions` row (`type='rate_con_generation_failed'`) and return `{ status: 'escalated', escalation_reason: 'rate_con_generation_failed' }`, 200 — **no dispatch flip**.
   d. Fetch `carriers.contact_email`. If present → call `sendRateConfirmationEmail()`; log `rate_con_send_status = 'sent'` or `'failed'` (+ `rate_con_send_error` on failure) to `loads`, either way. If absent → log `rate_con_send_status = 'skipped_no_email'`, no send attempted.
   e. **Only now**, in all three logged outcomes from (d), run the deferred `UPDATE loads SET status='Dispatched' WHERE id=$1 AND status='Booked'`.
   f. Response shape unchanged (`{ load_id, carrier_id, carrier_name, assignment_method, status: "assigned", rateCon }`) for the success path — callers (including `dispatcher-worker.ts`'s `assignCarrier()`, which only checks `res.ok`) don't need a body-shape change.
4. The old `auto_send_rate_con` settings-flag console.log block is removed entirely for the AI-cascade branch (superseded by the real send in 3d) — left untouched for the manual-load branch (still gated behind `pipeline_load_id IS NULL`, so this doesn't reach it).

- [ ] Implement the route changes.
- [ ] Tests (new fixtures seed a `pipeline_loads` row + a `loads` row with `pipeline_load_id` set, matching the shape `dispatcher-worker.ts`'s own tests already use):
  - AI-cascade load, carrier pre-verified, has `contact_email` → dispatch flips to `'Dispatched'`, `rate_con_send_status='sent'` (SMTP unconfigured in test env, so actually asserts `'failed'` with a graceful error — OR mock `getTransporter`; decide based on how `dispatcher.test.ts` already handles email-adjacent assertions, reuse that convention) — **actually**: assert `rate_con_send_status` is one of `'sent'|'failed'` (both are valid "attempted" outcomes) and dispatch still flips either way, proving the gate is about *attempt*, not delivery success.
  - AI-cascade load, carrier pre-verified, no `contact_email` → `rate_con_send_status='skipped_no_email'`, dispatch still flips.
  - AI-cascade load, carrier NOT verified, lookup mock resolves `carrier_for_hire`+active → gets verified inline, dispatch proceeds.
  - AI-cascade load, carrier NOT verified, lookup mock resolves `broker` → stays unverified, `exceptions` row written (`type='carrier_verification_failed'`), status stays `'Booked'`, response `status:'escalated'`.
  - Manual load (`pipeline_load_id` NULL) → byte-identical behavior to pre-change: dispatch flips immediately regardless of carrier verification state (regression guard proving the scoping decision holds).
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit.

---

## Task 6: `dispatcher-worker.ts` — consume the cascade's secured carrier

**Files:**
- Modify: `lib/workers/dispatcher-worker.ts`
- Test: `__tests__/pipeline/dispatcher-cascade-secured.test.ts`

**Changes:**
1. `fetchPipelineLoad()`'s `SELECT` also pulls `carrier_call_outcome`, `carrier_id_secured`, `carrier_agreed_rate`, `carrier_agreed_currency`, `carrier_profit`.
2. In `process()`, right after fetching the load, branch:
   - `carrier_call_outcome === 'accept' && carrier_id_secured` set → this load has a **real, cascade-confirmed carrier**. Use `carrier_id_secured` (not `top_carrier_id`) for the prospect/active gate check, and use `carrier_agreed_rate`/`carrier_agreed_currency` (not the shipper-side `agreedRate` param, not `fetchCarrierRate()`'s match_results estimate) as the carrier rate passed into `assignCarrier()`. `carrier_profit` (already computed by M2's envelope check) replaces the locally-derived `profit` where it's logged.
   - Otherwise (no cascade-secured carrier — true for effectively every load today, since nothing yet triggers the cascade automatically and `CARRIER_CALLS_ENABLED` stays false) → **entirely unchanged**: same prospect-gate check on `top_carrier_id`, same `carrierAutoAssignEnabled` branch, same `escalateCarrierConfirmation()` fallback.
3. `createTMSLoad()`'s `revenue` field: still the shipper's `agreedRate` (that's genuinely the shipper-side revenue figure, unaffected by which carrier secured the load) — only the *carrier* rate passed to `assignCarrier()` changes between the two branches.
4. Log line at the end distinguishes the two paths (`carrier=${carrierId} (cascade-secured)` vs today's plain `carrier=${carrierId}`) for operator legibility once this ever fires for real.

- [ ] Implement.
- [ ] Tests: cascade-secured load (`carrier_call_outcome='accept'`, `carrier_id_secured` set to an `'active'` carrier) dispatches using the cascade's rate, not `top_carrier_id`'s match_results estimate; cascade-secured but `carrier_id_secured` carrier is `'prospect'` → still escalates via `escalateProspect()` (prospect gate applies regardless of source); no cascade outcome (existing fixture shape, `carrier_call_outcome` NULL) → byte-identical to current behavior (regression guard, reuses the existing `dispatcher-prospect-gate.test.ts`/`dispatcher-cost-estimated-flag.test.ts` fixtures' shape to confirm no drift).
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit.

---

## Task 7: Full regression + completion tracker

- [ ] `pnpm tsc --noEmit` clean across the whole repo.
- [ ] `pnpm vitest run __tests__/` (full suite, not just `pipeline/`+`loadboards/` — Task 4/5 touch `app/api/carriers` and `app/api/loads`, outside those two directories) — confirm no new failures beyond the pre-existing `ranker.test.ts`/`researcher.test.ts` environmental timeouts.
- [ ] Append a completion.md entry for this session (M3 + M4), following the established format: what shipped, real bugs/gaps found (the Dispatcher-reads-stale-carrier disconnect, the missing `carriers.contact_email` column), what's still open (Session 4 items 15/16 — shadow drain, founder sign-off, first real call — untouched, blocked on operator action same as before).
- [ ] Final commit.

---

## Self-Review Notes

- **Spec coverage:** §7 (M3: real send + gate) → Tasks 3, 5. §8 (M4: verification precondition before rate-con send) → Tasks 2, 4, 5b. §11 (Dispatcher consumes secured carrier) → Task 6, the load-bearing connective piece the PRD names but doesn't spell out as its own numbered item — without it, "gate on `carrier_call_outcome='accept'`" has nothing real to gate against yet.
- **Deliberately out of scope:** Session 4 items 15-16 (shadow drain against ≥20 real booked loads, founder sign-off, one real validated carrier call) — operator-driven, need real credentials/consent/a founder decision, not implementation work. M5/M6 remainder (lifecycle monitoring, `carrier_lanes` feedback wiring) — separate PRD sections (§9-§10), not part of "M2 to M4."
- **Placeholder scan:** no TBD/TODO; every task has literal logic, not a description of logic.
