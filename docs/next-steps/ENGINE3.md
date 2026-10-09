# Engine 3 — Next Step

> Written 2026-10-07 against `master` @ `41afeb6`. Paste this whole file as the opening message of a new conversation dedicated to Engine 3. Re-verify the "Where it stands" facts before acting on them; they decay.

## Where it stands

| Module | State | What is still open |
|---|---|---|
| T-17 Event layer · T-18 Governance · T-19 Tenant policy | In production since 2026-08-25 | T-19's `evaluatePolicy()` has **no caller** — tenant policy is not enforced at Qualifier/Compiler/Dispatcher |
| T-20 Carrier Intelligence · T-21 Pricing · T-22 Negotiation · T-23 Lifecycle Monitor | In production, shadow mode | T-20 criteria 4/5, T-22 criteria 1/7, T-23 criterion 4 held open pending real volume |
| T-24 Exception Engine · T-25 Risk & Fraud · T-26 Document Automation | In production, shadow mode | T-24 criteria 2/9 held open; **Phase 2 exit gate (100 consecutive ≥80% zero-touch loads) not met** |
| T-27 Finance Orchestration | In production, shadow mode | Adapters are sandbox-only; Pilot 1 Financial Architecture doc still not in repo |
| T-28 Customer OS & Onboarding | In production, pushed | — |
| **T-30 Contract Freight Intake** | **Code-complete on unmerged branch `t30-contract-freight-intake`; migration 059 NOT applied; not in production** | Whole-branch review, then the separately-confirmed 059 apply + merge/push; depends on the E2-04 IMAP poller which has never run for real |
| T-29 Control Plane & White-label | Not started | Gated on Phase 4 exit + counsel review |

Verified 2026-10-07 by direct query on production (`br-rough-forest-aif4a3vf`): every Engine 3 migration through 058 is live; `contract_shipper_authorizations` (059) is absent.

The master PRD §9 handoff gate (Pilot 1 green) is **unmet**. Everything from T-20 on was built ahead of it at Patrice's explicit direction. That authorization does not automatically extend to T-29.

## The next step: finish T-30, then stop building and measure

**Why T-30 first.** It is the only module left half-built. A committed-but-unapplied migration plus an orphan `matched → booked` stage transition is exactly the kind of state that gets misread six weeks later. Closing it costs roughly one focused session and leaves Engine 3 with a clean "every module either done or not started" ledger.

**Order of work** (plan: `MyraTMS/docs/superpowers/plans/2026-08-31-t30-contract-freight-intake.md`; design: `.../specs/2026-08-31-t30-contract-freight-intake-design.md`):

1. Read the T-30 tracker entry in `Engine 3/docs/superpowers/plans/completion.md` and the design doc §2/§2a (schema-reality corrections). Do not re-derive them.
2. Create a disposable Neon branch (`t30-verify`), apply 059 there, point `DATABASE_URL` at it (quote the string — it contains `&`).
3. Tasks 3–5: `lib/documents/tender-terms.ts` (mirror T-26's `rate-con-terms.ts`), `lib/contract-intake/validate-rate.ts` via T-21's `quotePricing()`, one-line `SourceSignal.sourceModule` widening in `lib/exceptions/bridge.ts`.
4. Tasks 6–8: wire into `lib/email/imap-poller.ts`, build `finalize-booking.ts`, add its cron to `vercel.json` (follow `exception-bridge` as the template).
5. Tasks 9–10: approve/reject branch in `PATCH /api/exceptions/[id]` (same additive-branch pattern T-28 used for go-live), pending list + authorization CRUD. Tenant-scope every id; four prior modules shipped IDORs.
6. Task 11: end-to-end fixture.
7. Task 12: full regression on `t30-verify`, then **stop and ask** before applying 059 to production, then **stop and ask** before pushing. Update the tracker entry and the status table in `Engine 3/CLAUDE.md` and root `CLAUDE.md` in the same commit.

**Then do not start T-29.** Instead run the Phase 2 exit measurement: how many loads have gone `booked → dispatched → delivered → scored`, what fraction were zero-touch. Today the honest answer is "none" — which is the Engine 2 stream's problem to fix (see `docs/next-steps/ENGINE2.md`), not something more Engine 3 code can change.

## If you would rather not finish T-30 now

Park it explicitly: either apply 059 (harmless, additive) or revert `01e79f4`…`87bc938` including the `stages.ts` line, and record the decision in the T-30 tracker entry. Do not leave it half-done silently.

## Risks to carry into the session

- **Tests write to production.** `MyraTMS/.env.local`'s `DATABASE_URL` has pointed at the production branch. Always run against a `tXX-verify` branch.
- **`MAX_CONCURRENT_CALLS=25`** was found in production env on 2026-08-26 and has not been re-verified. Not an Engine 3 problem, but check it before any shadow-drain-based measurement.
- **`evaluatePolicy()` unwired.** Risk E3-R2 (double-brokering via policy bypass) is unmitigated in code. Wiring it into Qualifier/Compiler/Dispatcher touches live-path files and needs the E3-R1 review gate.
- **Phase 2 "complete" ≠ Phase 2 "exited."** Don't let the module count be read as gate clearance.

## Working rules for this stream

Read the module's tracker entry before touching its code. Shadow mode only; zero edits to `voice-worker`, `carrier-voice-worker`, `retell-webhook`, `compiler-worker`, `dispatcher-worker`, `dispatch-gate` without human review. Never hardcode a tenant id. Tracker entry + `CLAUDE.md` status table in the same commit. Production apply and push are separate, explicitly-confirmed steps.

## Suggested opening prompt

```
Engine 3 session. Read Engine 3/CLAUDE.md, the T-30 entry in Engine 3/docs/superpowers/plans/completion.md,
and docs/next-steps/ENGINE3.md. Then finish T-30 Tasks 3–12 per the plan on a disposable Neon branch.
Stop before applying migration 059 to production and before pushing. Update the tracker and both
CLAUDE.md status tables in the same commit as the code.
```
