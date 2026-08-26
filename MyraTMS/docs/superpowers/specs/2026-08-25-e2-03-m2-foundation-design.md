# E2-03 M2 Foundation — Webhook Branch + Cascade Worker (Shadow-Only): Design

**Date:** 2026-08-25
**Base spec:** `Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md` §6 (M2 design), §6.6 (schema), §6.7 (webhook branch), §6.8 (test plan), §13 Session 2 (build plan). This document does not restate that content — it records the leftover M1 item M0 didn't cover, two real gaps found auditing the PRD against the live codebase, and the exact scope of this session.

## Scope of this pass

Per the PRD's own build plan (§13), M2 spans multiple sessions: Session 2 builds the cascade worker infrastructure (flag off / shadow only — no real calls), Session 3 adds the negotiation envelope's live enforcement + M4 verification, Session 4 is real rate-con send + the shadow drain + the first live call. **This pass covers Session 2 plus the leftover Session-1 item M0 didn't build: the `retell-webhook.ts` `call_type` branch (§6.7).** That branch has to exist before Session 2's shadow drain can produce meaningful review data (an outcome has nowhere correct to land otherwise), and the PRD itself says it must be "built and tested before any real call" — so building it now, ahead of when it's strictly needed, is the PRD's own instruction, not scope creep.

**Explicitly not in this pass:** placing any real outbound call (`CARRIER_CALLS_ENABLED`/`MAX_CONCURRENT_CALLS` stay at their safe defaults throughout — this worker is shadow-only until a human decides otherwise, same discipline as the buy-side voice calling); M3 (real rate-con send, dispatch-confirmation gate); M4 (Gate 2 verification wiring); M5/M6.

## Two gaps found auditing the PRD against the live codebase

### 1. `agent_calls`'s shared-column risk — not yet fixed, and this session's own work would immediately exercise it

E2-03 M0 fixed `pipeline_loads`'s shared-column collision risk (E2-02 §4 item 8) by giving carrier outcomes their own columns (`carrier_call_outcome`, `carrier_agreed_rate`, etc.), separate from the shipper's `agreed_rate`/`profit`/`stage`. **`agent_calls` never got the same treatment.** Its `agreed_rate`, `profit`, and `outcome` columns are shared between both call types with nothing but `call_type` itself to disambiguate a read. This is the identical risk class, one table over, and it was never flagged by E2-02's own audit (which was scoped to `pipeline_loads`).

Building this session's webhook branch (`processCallCompleted()`'s new `outbound_carrier` path) means writing a carrier call's outcome into `agent_calls` for the first time — i.e., building the exact code path that would exercise this gap on day one, immediately after fixing the analogous gap on the neighboring table last session.

**Decision: fix it now, not defer it.** A migration `042` adds `agent_calls.carrier_agreed_rate DECIMAL(10,2)`, `carrier_outcome VARCHAR(30)`, `carrier_profit DECIMAL(10,2)` — mirroring `pipeline_loads`'s naming from M0. No separate `carrier_agreed_currency` needed: a single `agent_calls` row represents exactly one call (shipper or carrier, never both — `call_type` says which), so the row's existing single `currency` column already covers it. This is cheap, additive, and consistent with the standing principle this whole PRD arc has followed since E2-01: don't leave a known shared-column ambiguity sitting next to code that's about to depend on it being unambiguous.

### 2. PRD §6.5's own function signature contradicts its own formula

§6.5 reads: *"M2 adds `calculateCarrierNegotiationParams(agreedShipperRate, minMarginPct)` — ceiling = `agreedShipperRate - minMarginFloor`, target, opening offer."* The parameter is named `minMarginPct` (implying a percentage), but the formula subtracts `minMarginFloor` (implying a flat dollar amount) — these are two different things and the text never reconciles them.

Checked `lib/pipeline/cost-calculator.ts`'s existing shipper-side function (`calculateNegotiationParams`, the one §6.5 explicitly points at as "computes what Myra offers the shipper") for precedent: it uses `getMarginThresholds(currency)`, an internal (unexported) function returning flat-dollar `{floor, target, stretch}` from constants (`MIN_MARGIN_CAD=270`, `TARGET_MARGIN_CAD=470`, `STRETCH_MARGIN_CAD=675`, and USD equivalents `200/350/500`) — the same numbers `lib/tenants/margin-floor.ts`'s `getMarginFloor()` reads from `tenant_config` (T-19's now-corrected 270/200 floor).

**Decision: flat-dollar, matching the existing pattern — not a raw percentage parameter.** A percentage floor is the wrong shape for this business: 15% of a $500 load is a $75 floor, far under the $200-270 minimum this business actually needs to stay profitable regardless of load size, whereas the flat-dollar table is calibrated to real cost structure and is what every other margin calculation in this codebase already uses. `calculateCarrierNegotiationParams(agreedShipperRate: number, currency: 'CAD' | 'USD')` internally calls the same `getMarginThresholds(currency)` the shipper function uses — one shared source of margin truth, not two. Treating the PRD's `minMarginPct` naming as a drafting inconsistency, resolved in favor of consistency with the codebase's own established, already-calibrated pattern.

## What this session builds, precisely

1. **Migration `042-carrier-call-columns.sql`** — the three `agent_calls` columns above. Idempotent, additive, matches this repo's established migration conventions exactly.

2. **`calculateCarrierNegotiationParams()`** in `lib/pipeline/cost-calculator.ts` — per decision #2 above. Ceiling-down direction (opposite of the shipper function's floor-up): `ceiling = agreedShipperRate - floor`, `target = agreedShipperRate - target-margin`, `openingOffer` starts below target and concedes upward toward (but never above) the ceiling — mirroring the shipper function's 3-step concession-ladder shape, just inverted.

3. **`retell-webhook.ts`'s `call_type` branch** — `processCallCompleted()` reads `call_type` from the call's metadata (threaded through by the new carrier-voice-worker in item 5) and branches: the existing shipper path is untouched; a new carrier path writes `agent_calls`'s new carrier columns (never `agreed_rate`/`profit`) and `pipeline_loads`'s M0-era carrier columns (never `agreed_rate`/`profit`/`stage`), including the server-side envelope check from PRD §6.3/§6.5 — an accepted rate reported above the ceiling gets rewritten to `escalated`, never silently booked.

4. **`carrier-call-queue`** added to `lib/pipeline/queues.ts` — mirrors `call-queue`'s no-retry policy (a cascade step isn't safely re-playable any more than a shipper call is).

5. **`carrier-voice-worker.ts`** — new file, mirrors `voice-worker.ts`'s `BaseWorker` structure and kill-switch pattern exactly (same `PIPELINE_ENABLED`/concurrency-cap checks; a new `CARRIER_CALLS_ENABLED` flag per PRD §10/M6 gates this worker independently of the shipper side, default `false`). Reads `match_results`' top-N stack for the load (`ORDER BY match_score DESC LIMIT N`, default N=5 per PRD §12-D4), runs the cascade state machine (§6.3: accept/decline/voicemail-retry-once/no_answer/disconnected/exhausted), acquires `acquireLoadLock()` before starting a load's cascade and `acquireCarrierPhoneLock()` before each dial attempt (both already built, `lib/pipeline/carrier-locks.ts`, unchanged this session). Compliance recheck reuses the same direct `dnc_list` query + `hourInZone()` pattern `voice-worker.ts` already uses (confirmed: `voice-worker.ts` bypasses the `ComplianceService` class entirely for this, so a carrier path doing the same is consistent, not a deviation — `ComplianceService`'s other checks, consent/fatigue, are shipper-specific concepts with no carrier equivalent).

6. **12+ synthetic cascade fixtures** per PRD §6.8: accept on carrier 1; decline-then-accept on carrier 2; full exhaustion (all N decline); voicemail-then-retry-then-accept; envelope breach (server-side reject); concurrent-dial lock contention on the same carrier phone.

## Next step

Implementation plan via the writing-plans skill, scoped to the six items above.
