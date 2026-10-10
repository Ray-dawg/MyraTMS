# Engine 2 — Next Step

> Written 2026-10-07 against `master` @ `41afeb6`. Paste this whole file as the opening message of a new conversation dedicated to Engine 2. Re-verify the "Where it stands" facts before acting on them.

## Where it stands

- **Deployed, shadow-drain mode.** Vercel `myratms` (API + 8 crons) is live on `master`. Railway `myratms-workers` (10 BullMQ workers) ran 2026-06-04 → 2026-06-06 and **has had no deployment since** (trial expired — see `RAILWAY_REDEPLOY_TODO.md`).
- **Acquisition pipeline proven.** Phase 6A shadow drain (2026-06-04): 75 synthetic loads, 5 reached `briefed` with real negotiation briefs, two real bugs fixed mid-drain.
- **One live call, ever.** 2026-06-06, to the operator's own number, 34.8 seconds, full chain scanner → qualify → research → rank → compile → Retell dial. Post-call hardening fixed call recording and the webhook outcome flow.
- **Sell-side loop code-complete, never run.** E2-03 (carrier cascade, dispatch gate, carrier verification, health checks) and E2-04 (shipper written confirmation, carrier brief, inbound email, signed-rate-con gate) are merged. `CARRIER_CALLS_ENABLED`, `CARRIER_AUTO_ASSIGN_ENABLED`, `SHIPPER_CONFIRMATION_ENABLED`, `INBOUND_EMAIL_POLLING_ENABLED` are all off. No carrier has ever been called. IMAP credentials were never provisioned; `scripts/run-imap-poller.ts` has never run against a real mailbox and is not deployed anywhere.
- **Resolved safety finding.** `MAX_CONCURRENT_CALLS=25` was found in production env on 2026-08-26; set to `0` on Railway 2026-10-09.
- **Roadmap position** (`Engine 2/docs/superpowers/plans/completion.md` → Production Ship Roadmap): Phase A is done except A.3.3 (scraper deploy), A.3.4/A.3.6 (cron dashboard confirm, custom domain), **A.4.5 (first 10 live calls)**, and all of A.5 (compliance/legal review). Phases B–D untouched.

## The next step: run Pilot 1 for real — Phase 6B, first 10 live shipper calls

This is the single thing every other stream is waiting on. The Engine 3 handoff gate, migration 030 (Engine 2 tenanting), the Phase 2 exit measurement, and every "held open" acceptance criterion across T-20–T-28 all need real call volume that only this step produces.

**Pre-flight, in order:**

1. **Env audit.** Confirm in both Vercel and Railway: `PIPELINE_ENABLED=true`, `SCANNER_ENABLED` as intended, `MAX_CONCURRENT_CALLS=0` for now, no trailing newlines (the 2026-06-04 bug). Fix the `25`. Record what you found in the tracker Change Log.
2. **Compliance gate (A.5.2 first).** Seed `dnc_list` from the Canadian DNCL and US DNC. The live-call preflight refuses an empty DNC list for a reason. Decide how far to take A.5.1/A.5.3 (consent language, privacy policy) before real shippers hear an agent — this is Patrice's call, not a code task.
3. **Fix `scripts/sprint6-shadow/06-cleanup.ts`.** It FK-violates against `exceptions` when deleting `TEST_` rows (found 2026-08-26). You need it clean before and after the batch.
4. **Run the gates.** `01-preflight.ts` then `05-live-call-preflight.ts` against production env. Both must pass without `--force`. Check `personas` still has real Retell agent IDs and the webhook URL + signature verify.
5. **Prepare the 10 consenting test shippers** (deploy plan Task 3.4). Real people who agreed to be called, with the fictional/consented loads built as a CSV for `POST /api/pipeline/import`.
6. **Flip and listen.** `MAX_CONCURRENT_CALLS=1`, redeploy, restart the worker host, import the batch, listen live in the Retell dashboard, keep `07-emergency-stop.ts` ready in a second terminal. Verify one full booking chain lands a `loads` row with `booked_via='ai_auto'` and a tracking email.
7. **Record outcomes** per deploy plan Task 4.6: connect rate, book rate, cost per call, webhook ordering. These numbers are the Engine 3 handoff gate inputs.

**Then, second half of the session or next session:** shadow-drain the sell-side loop against the loads Pilot 1 booked — `SHIPPER_CONFIRMATION_ENABLED=true` with real shipper emails, `CARRIER_CALLS_ENABLED` still false — so the confirmation PDF, One_pager confirm mode, and nudge/escalate timers are exercised. This needs IMAP credentials provisioned and `run-imap-poller.ts` deployed as a third Railway service for the signed-rate-con return path.

> **Session mega-prompts:** each go-live gate has a paste-ready session prompt under `docs/next-steps/engine2-gate-prompts/` (GATE-0 security/env → GATE-1 registry calibration → GATE-2 enforce flip → GATE-3 Pilot 1 live calls → GATE-4 ramp/sell-side/middleware/tenanting). Run them in order; each checks its predecessor.

## Shipper-direct gate flip (E2-01 enforcement — built 2026-10-08, flag off)

The double-brokering gate is code-complete (see the tracker Change Log, 2026-10-08). It ships with `SHIPPER_DIRECT_GATE_ENABLED=false` and `SHIPPER_DIRECT_GATE_MODE=shadow`, so nothing blocks until this checklist is walked. It can run before or in parallel with Pilot 1; step 6 should land **before** Phase 6B so the ten consenting shippers' loads are classified.

1. ~~Register an FMCSA QCMobile webKey~~ — **done 2026-10-08**, key seeded in `MyraTMS/.env.local`. Still must be set on Railway **and** Vercel. Without it every registry miss goes to human review (fail closed) and the queue will be unworkable.
2. **Seed the registry — this is now the load-bearing step, not an optional calibration.** Live FMCSA runs on 2026-10-08 proved QCMobile *cannot* establish shipper-direct status (see the tracker entry for that date): every classic private fleet tested also holds "Authorized For Hire" operating authority, so the classifier's FMCSA `shipper_direct` accept path is unreachable for real shippers. FMCSA can only *reject* (active broker authority) or *escalate*. Every accept therefore comes from `poster_registry` or an import attestation. Budget real labelling time here.
   Seed it: `pnpm tsx --env-file=.env.local scripts/e2_seed_poster_registry.ts` (add `--dry-run` first). **The script takes no CSV argument** — it reads three fixed paths under `scripts/data/poster-registry-seed/` and skips any missing file with a warning: `pilot1-shippers.csv` (205 shipper-list rows → `shipper`/`seed_shipper_list`/0.9), `ontario-mines.csv` (~40 rows → `shipper`/`seed_mines_dossier`/0.95), `broker-list.csv` (~60 rows → `broker`/`seed_broker_list`/0.9). Header exactly `legal_name,mc_number,dot_number,country,province_state`; MC/DOT may be blank, `country` is `CA` or `US`. All three are currently absent (PRD §4.13 criterion 5 is blocked on them — see the tracker entry dated 2026-10-09).
3. Backfill history in shadow: `pnpm tsx --env-file=.env.local scripts/e2_backfill_load_source.ts`. **Blocked on real ingest, not on this script.** Surveyed 2026-10-09 on a clone of production: all 250 `pipeline_loads` rows are synthetic `TEST_*` drain fixtures (`load_board_source='manual'`), there is no real history to back-fill, and `loadboard_sources.dat.last_polled_at` is NULL — the scraper has never polled, so step 5's 24 h of real ingest has no source either. Deploying the DAT scraper (roadmap A.3.3) is an unlisted prerequisite for steps 3 and 5. See the tracker entry dated 2026-10-09.
4. Calibrate: `pnpm tsx --env-file=.env.local scripts/e2_source_calibration_report.ts` → **must exit 0 — and over a non-empty registry.** It exits 0 on an empty registry too (verified 2026-10-09), so an exit 0 only means something once step 2 has really seeded and step 3 has really backfilled; check `byClass` and `registryHitRate` in the JSON, not just the exit code. Label `unresolvedTopPosters`, re-seed, re-run until it does. Attach the final JSON to the PR (criterion 4).
5. Set `SHIPPER_DIRECT_GATE_ENABLED=true`, `SHIPPER_DIRECT_GATE_MODE=shadow` on Railway. Watch 24 h of real ingest: distribution of `load_source_class`, registry hit rate (re-run the report).
6. Flip: set `SHIPPER_DIRECT_GATE_ENFORCED_AT=<now ISO>`, then `SHIPPER_DIRECT_GATE_MODE=enforce` on Railway (Qualifier) first, then Vercel (import route). Restart the worker host. Before this, declare `load_source_class`, `poster_legal_name`, `co_broker_counterparty` on the Retell shipper agents (dynamic variables 63 → 66).
7. Watch the Alert Center for `load_source_review` rows; resolve each via `POST /api/pipeline/loads/:id/resolve-source` (`entity_class`, `applies_to_poster`, `note`). Unresolved reviews auto-expire inside the 4 h pickup window (daily `pipeline-health` cron). Count per day; if >20/day after day 3, tighten `STRONG_BROKER_TOKENS` in `lib/pipeline/load-source-classifier.ts`.

Any `load_source_assertion` exception (critical) means a load reached the Compiler or Dispatcher without a class after the enforce timestamp. Treat it as a pipeline bug, not an operator task.

## What this unlocks

- Engine 3 handoff gate (master PRD §9) and Phase 2 exit measurement.
- Migration 030 (Engine 2 tenanting) once Engine 2 has been stable in production for 24 hours.
- Retiring or deploying the headless scraper (A.3.3) — a decision that only matters once calls are real.

## Risks to carry

- **CASL/TCPA.** The compliance audit table is the legal defense; `runFullComplianceCheck()` is dead code and `voice-worker.ts` runs its own inline checks — confirm those cover calling hours and DNC before the batch.
- **Dispatcher idempotency.** `createTMSLoad()` has no idempotency check; a `dispatch-queue` retry after a downstream failure can duplicate a `loads` row (E2-02 finding, unfixed).
- **Tests write to production** when `.env.local` points there. Don't run the suite mid-drain.
- **Live-path files** (`voice-worker`, `carrier-voice-worker`, `retell-webhook`, `compiler-worker`, `dispatcher-worker`, `dispatch-gate`) need human review on every change.

## Suggested opening prompt

```
Engine 2 session — Pilot 1. Read Engine 2/CLAUDE.md, the Production Ship Roadmap and the last three
Change Log entries in Engine 2/docs/superpowers/plans/completion.md, and docs/next-steps/ENGINE2.md.
Start with the env audit (MAX_CONCURRENT_CALLS) and the DNC seed; report findings before flipping anything.
No live call fires without my explicit go.
```
