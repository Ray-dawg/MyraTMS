# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Docs ↔ code sync:** reconciled against `master` @ `41afeb6` on 2026-10-07. When a sprint/milestone lands, update `docs/superpowers/plans/completion.md` **and** the status paragraph below in the same commit.

## What This Directory Is — IMPORTANT

**Engine 2 is the spec package for the AI freight pipeline. The integration is DONE; the live code is in the sibling `MyraTMS/` app.** The 7-agent acquisition pipeline was placed into `MyraTMS/` during Sprints 0–6.5 (April–May 2026). The **sell-side loop** (E2-02 investigation → E2-03 M0–M6 → E2-04 M0–M6 + review fixes) was built on top of it in August 2026, also in `MyraTMS/`.

**Status (2026-10-07):**
- **Deployed to production in shadow-drain mode.** Vercel (`myratms`) hosts the API + crons; Railway (`myratms-workers`) boots the 10 BullMQ workers (deployed 2026-06-04). Phase 6A shadow drain proved the acquisition pipeline end-to-end (75 synthetic loads, 5 reached `briefed`, 0 calls).
- **First live Retell call placed 2026-06-06** (to the operator's own number, persona `friendly`, 34.8s). Phase 6B — 10 consenting test shippers — has **not** run.
- **Sell-side loop code-complete, never exercised in production.** `CARRIER_CALLS_ENABLED`, `CARRIER_AUTO_ASSIGN_ENABLED`, `SHIPPER_CONFIRMATION_ENABLED`, `INBOUND_EMAIL_POLLING_ENABLED` are all off; no carrier has ever been called; IMAP credentials have never been provisioned; `scripts/run-imap-poller.ts` has never run against a real mailbox.
- **Open since 2026-08-26, not re-verified:** `MAX_CONCURRENT_CALLS=25` was found in production env while every doc says `0`. Re-check before any drain.
- Next step: `../docs/next-steps/ENGINE2.md`.

The files in this directory are **spec material** — the historical record of what was delivered and the design intent. The `.ts`/`.jsx`/`.json` copies here are the *original* delivery and have **not** been kept in sync with the debugged live copies.

| You want to… | Go here |
|---|---|
| Edit a worker, run it, or test it | `MyraTMS/lib/workers/` + `MyraTMS/__tests__/pipeline/` |
| Edit a pipeline service (Claude, compliance, cost-calculator, gate, brief schema, carrier cascade) | `MyraTMS/lib/pipeline/` |
| Edit the sell-side loop (dispatch gate, shipper confirmation, carrier brief, inbound email) | `MyraTMS/lib/dispatch-gate.ts`, `lib/confirmation-actions.ts`, `lib/shipper-rate-confirmation.ts`, `lib/email/`, `lib/workers/{shipper-confirmation,carrier-brief-compiler,carrier-voice}-worker.ts` |
| Apply or change a migration | `MyraTMS/scripts/*.sql` (023–026 integration fixes; 040–043, 046–051 sell-side; see Database) |
| Run the operator playbooks (shadow drain, live-call preflight, emergency stop) | `MyraTMS/scripts/sprint6-shadow/` |
| Boot the workers | `MyraTMS/scripts/run-workers.ts` (Railway, not Vercel) |
| Run the inbound email poller | `MyraTMS/scripts/run-imap-poller.ts` (separate process, not yet deployed anywhere) |
| Update CSV ingest, official-API ingest, or scraper cutover machinery | `MyraTMS/lib/loadboards/` + `MyraTMS/app/api/loadboard-sources/` |
| Edit the headless scraper (DAT, Truckstop, 123LB, Loadlink) | `M1/scraper/` (sibling, separate Railway deploy) |
| Read or update the completion tracker | `docs/superpowers/plans/completion.md` (in **this** directory) |

**Do NOT:**
- Re-copy files from this directory into MyraTMS. Sprint 0 already did this; running it again will overwrite live, debugged code.
- Run `pnpm install` / `pnpm build` / `pnpm test` from this directory. There's no `package.json` here. Tests run from `MyraTMS/` (`pnpm vitest run __tests__/pipeline/`) — **and they hit whatever `DATABASE_URL` is in `.env.local`, which has been production.** See the root `CLAUDE.md`.
- Edit imports in the files here to "make them resolve". They don't resolve here on purpose.
- Keep Engine 3 spec copies here. The canonical T-17..T-30 specs live in `../Engine 3/`; duplicates were removed 2026-10-07.

**Related, one directory up:** `../Engine 3/` wraps this pipeline as a service. T-17..T-28 are built and applied to production (shadow mode); T-30 is in progress. Engine 3 modules read Engine 2's tables via triggers and never edit live-path worker files — with one recorded exception: T-30 added a `matched → booked` transition to `lib/pipeline/stages.ts` (commit `642ec1d`, additive, email-tender loads only). T-24's `exception-bridge` cron and T-23's lifecycle triggers consume `pipeline_loads`, `agent_jobs`, and `carrier_risk_signals`.

## The Authoritative Documents (in order of how often you'll need them)

1. **`docs/superpowers/plans/completion.md`** — **The live source of truth.** Sprint-by-sprint progress, schema gaps discovered, the Production Ship Roadmap (Phase A–D) from "code complete" to "first real booking", and the Change Log (which also records E2-01, E2-03, E2-04 and the review session). Keep it in sync as tasks finish; do not batch.
2. **`docs/superpowers/plans/2026-04-30-engine2-end-to-end.md`** — The original execution plan completion.md tracks against ("Task 7", "Task 5.5-3", …).
3. **`docs/superpowers/plans/2026-06-04-engine2-full-deploy-and-test.md`** — The deploy plan (env audit → Railway → shadow drain → live-call readiness → first 10 calls). Phases 0–2 + the first call were executed per the Change Log; its checkboxes were never ticked.
4. **Sell-side PRDs:** `E2-02_SellSide_Investigation_Report.md` (the audit that found no carrier was ever called) → `E2-03_Engine2_SellSide_Expansion_PRD.md` (M0–M6: cascade, dispatch gate, carrier verification, health checks) → `E2-04_SellSide_Autonomous_Loop_PRD.md` (shipper written confirmation, carrier brief, inbound email, signed-rate-con gate). `E2-01_Engine2_Expansion_PRD.md` is the shipper-direct hard gate (M1 Session 1 shipped as a shadow backfill). Implementation plans + design docs for these live in `MyraTMS/docs/superpowers/{plans,specs}/2026-08-2*-e2-0*`.
5. **`CLAUDE_CODE_BUILD_PLAN.md`** (BUILD 11) — The original integration plan. Useful for design intent; placement has moved on.
6. **`C04_Voice_Agent_Conversation_Playbook.md`** — Script source for the Retell call flow. Material for Retell's dashboard; not loaded by code.
7. **`T02–T13` agent specs** — Per-agent contracts. Read only when resolving an ambiguity.

## File Inventory — Where Each File Was Placed

| Group | Files in this dir | Placed at |
|---|---|---|
| **Pipeline foundation** | `stages.ts`, `queues.ts`, `payloads.ts`, `gate.ts` | `MyraTMS/lib/pipeline/` |
| **Services** | `claude-service.ts` + `-types.ts`, `compliance-service.ts` + `-types.ts`, `cost-calculator.ts` (+ test), `types.ts`, `examples.ts`, `persona-selector.ts`, `objection-playbook.ts`, `benchmark-rates.ts`, `myra_negotiation_brief_schema.ts` → `negotiation-brief.ts` | `MyraTMS/lib/pipeline/` |
| **Workers (original 8 + base)** | `base-worker.ts`, `scanner-worker.ts`, `qualifier-worker.ts`, `researcher-worker.ts`, `ranker-worker.ts`, `compiler-worker.ts`, `voice-worker.ts`, `dispatcher-worker.ts`, `feedback-worker.ts`, `index.ts` | `MyraTMS/lib/workers/` |
| **Voice / Webhook** | `retell-webhook.ts`, `retell-types.ts`, `test-webhook.ts`, `example_retell_payload.json` | `MyraTMS/lib/pipeline/` (test → `MyraTMS/__tests__/pipeline/`) |
| **Cron handlers** | `cron-handlers.ts`, `cron-types.ts` | `MyraTMS/lib/cron/` — **dead code**; no `/api/cron/*` route imports it |
| **Database** | `pipeline_migrations.sql` | `MyraTMS/scripts/` (plus the correction migrations below) |
| **Retell dashboard configs (reference only)** | `retell_config_v2_gatekeeper.jsx`, `retell_config_carrier_onboarding.jsx` | Pasted into Retell dashboard, not Git |

**Files born in `MyraTMS/` after integration (no copy here):**
- `lib/pipeline/redis-bullmq.ts` (ioredis for BullMQ), `db-adapter.ts` (Neon v1 `sql.query(text, params)` quirk), `service-token.ts` (admin JWT for the Dispatcher), `time.ts` (single timezone-aware calling-hours helper), `health-checks.ts` (M5 sell-side checks for the `pipeline-health` cron), `carrier-cascade.ts` (`decideCascadeAction()` — the E2-03 M2 cascade state machine), `carrier-locks.ts` (per-carrier-phone lock), `load-source-classifier.ts` (E2-01), `events-api-helpers.ts`/`events-types.ts`.
- `lib/workers/shipper-confirmation-worker.ts` (E2-04 M2), `carrier-brief-compiler-worker.ts` (E2-04 M5), `carrier-voice-worker.ts` (E2-03 M2) — all extend `BaseWorker`.
- `lib/dispatch-gate.ts` (E2-03 M3 + E2-04 M6: a load is `Dispatched` only after a *signed* rate-con is back), `lib/confirmation-actions.ts` + `app/api/confirmations/[token]/` (E2-04 M3), `lib/shipper-rate-confirmation.ts` (shipper PDF; distinct from carrier `lib/rate-confirmation.ts`), `lib/email/imap-poller.ts` + `inbound-classifier.ts` + `scripts/run-imap-poller.ts` (E2-04 M4), `lib/verification/` (E2-03 M4 carrier verification + authority lookup), `app/api/loads/[id]/confirm-carrier-signature` (review F1 manual override).
- `lib/loadboards/*` (Sprint 6.5 API ingest path, all clients still stubs), `scripts/run-workers.ts`, `scripts/sprint6-shadow/`, `scripts/e2_backfill_load_source.ts`, `scripts/e2_seed_poster_registry.ts`, `scripts/verify-04x-*.ts`, `scripts/apply-04x-*.ts`.

Worker source files here contain numbered TODOs (`Q-1`, `R-2`, …). **These are resolved in the MyraTMS copies** — the MyraTMS copy is canonical.

## Pipeline Architecture

### Stage Machine (`stages.ts`, 17 stages)

```
scanned → qualified ┬─→ researched ─┐
                    │                ├→ matched → briefed → calling → booked → awaiting_shipper_confirmation → shipper_confirmed → dispatched → delivered → scored
                    └─→ matched ────┘      │                                         (legacy direct: booked → dispatched)
                ↓                          └─→ booked   (T-30 email-tender loads only)
   disqualified | declined | escalated | expired | callback
```

Transitions are validated by `VALID_TRANSITIONS`. Terminal: `disqualified`, `scored`, `expired`. `awaiting_shipper_confirmation`/`shipper_confirmed` were added by E2-04 (migration 046); `declined` by E2-03. Only the shipper's page click (or the verbal-escalation route) advances `awaiting_shipper_confirmation → shipper_confirmed`; only signed-rate-con detection advances to `dispatched`. Never advance a stage from an inbound email.

### The Parallel Gate (`gate.ts`)

After `qualified`, Researcher and Ranker run in parallel off `qualify-queue`. "Research complete" = `research_completed_at IS NOT NULL`; "Ranker complete" = `carrier_match_count > 0`. Whichever finishes second calls `checkAndAdvanceToMatched()`. DB-backed idempotency, not distributed locks.

### 12 BullMQ Queues (`queues.ts`)

| Queue | Concurrency | Retry | Notes |
|---|---|---|---|
| `qualify-queue` | 50 | 3× exp / 30s | Pure SQL |
| `research-queue` | 20 | 5× exp / 60s | Claude API, 429 backoff |
| `match-queue` | 20 | 3× exp / 30s | Parallel with research |
| `brief-queue` | 20 | 2× fixed / 30s | Merge point |
| `call-queue` | 100 | **none** | Shipper voice calls (not idempotent) |
| `carrier-call-queue` | 5 | **none**, delayable | E2-03 M2 carrier cascade; `{ delay }` for the +2h voicemail retry |
| `shipper-confirmation-queue` | 10 | 3× exp / 30s, delayable | E2-04 M2: `send` / `nudge` (+45m) / `escalate` (+2h) |
| `carrier-brief-queue` | 20 | 2× fixed / 30s | E2-04 M5: carrier-facing brief from `confirmed_rate` |
| `dispatch-queue` | 10 | 3× exp / 30s | TMS writes |
| `feedback-queue` | 5 | 3× exp / 5min | Post-delivery |
| `callback-queue` | 20 | **none**, delayable | Scheduled callbacks |
| `escalation-queue` | 5 | 3× exp / 30s | Notifications |

### Worker Lifecycle (`base-worker.ts`)

All workers extend `BaseWorker<T extends BaseJobPayload>` and override `process(job)`. Base handles stage validation, `agent_jobs` logging, stage advancement, graceful shutdown. **Gotcha found on the first live call:** the `updatePipelineLoad()` override only runs when `config.nextStage` is truthy — the Voice worker had to set `nextStage='calling'` or live calls left no DB trace. **Always extend `BaseWorker`.**

### The Sell-Side Loop (E2-03 + E2-04) — how a booked load becomes a dispatched one

1. `booked` → `ShipperConfirmationWorker` generates the shipper rate-con PDF, emails a confirm link (dedicated 72h single-use token, never the tracking token), nudges at +45m, escalates at +2h. Stage `awaiting_shipper_confirmation`.
2. Shipper clicks confirm on the One_pager (confirm mode) → `confirmation-actions.ts` snapshots `confirmed_rate` → stage `shipper_confirmed`. Envelope math from here on uses `confirmed_rate`, never the transcript-parsed `agreed_rate`.
3. `CarrierBriefCompilerWorker` reuses the ranked `match_results` stack, computes the carrier negotiation envelope, writes `pipeline_loads.carrier_brief`, enqueues `carrier-call-queue`.
4. `CarrierVoiceWorker` runs the cascade (`decideCascadeAction()`: accept ends it, decline advances to the next carrier, voicemail retries at +2h), gated by `CARRIER_CALLS_ENABLED` and the per-phone lock. Carrier calls write `carrier_agreed_rate`/`carrier_outcome`/`carrier_profit` (migration 042), never the shipper columns.
5. Accept → `dispatch-gate.ts` sends the carrier rate-con; `loads.status='Awaiting Signature'` (migration 049).
6. The IMAP poller (`inbound-classifier.ts` → `carrier_reply` with sender-domain verification) or the manual override `POST /api/loads/[id]/confirm-carrier-signature` records the signature → `completeDispatchOnSignedRateCon()` → `dispatched`. T-23's trigger turns this into lifecycle events; T-26 compares extracted terms on `shipper_reply`.
7. `CARRIER_AUTO_ASSIGN_ENABLED` (E2-03 M3) gates the final TMS assign.

Dispatcher still refuses `carrier_status='prospect'` carriers (escalates instead). Preserve this.

### Service Modules

- **`claude-service.ts`** — Anthropic SDK wrapper (default `claude-sonnet-5`), retry/backoff, Zod structured parsing, token budgets. Used by Researcher, Compiler, call parser, T-26. Do not call the SDK directly.
- **`compliance-service.ts`** — CASL/TCPA/DNC/calling-hours gate. **`runFullComplianceCheck()` has no caller**; `voice-worker.ts` runs its own inline checks. Known gap.
- **`cost-calculator.ts`** — pure-math cost + envelope. Its test is one of the known rotating failures.
- **`persona-selector.ts`** — Thompson Sampling over `personas`; since E2-04 M1 every read/write is `call_type`-scoped (`outbound_shipper` vs `outbound_carrier`).
- **`negotiation-brief.ts`** — the Compiler→Voice contract; 63 Retell dynamic variables, all strings. Changing a field means updating `validateBrief()`, the Retell agent config, and a new migration for `negotiation_briefs`.

## Database

`pipeline_migrations.sql` (idempotent) adds 9 tables: `pipeline_loads`, `agent_calls`, `negotiation_briefs`, `consent_log`, `dnc_list`, `shipper_preferences`, `lane_stats`, `personas`, `agent_jobs`, plus columns on `loads`/`carriers`/`shippers`. Correction and extension migrations (never edit `CREATE TABLE` in place — add a new migration):

| Migration | What it does |
|---|---|
| `023` / `024` / `025` / `026` | TEXT ids, dropped TMS FK, `compliance_audit`, `loadboard_sources` |
| `027`–`029`, `031` | Multi-tenant foundation (applied to production 2026-05-04). **028 defers all Engine 2 tables to 030.** |
| `030_engine2_tenanting.sql.PENDING` | ⚠️ **Staged, NOT applied.** Adds `tenant_id` to all Engine 2 tables. Gated on Engine 2 stable ≥24h in prod. `pipeline_loads.tenant_id` confirmed absent 2026-10-07. |
| `032` | `carriers.carrier_status` prospect/active — Dispatcher gate |
| `040_shipper_direct_gate.sql` | E2-01: `poster_registry`, `authority_lookups`, load-source classification |
| `041-sellside-expansion-schema.sql` | E2-03 M0/M1/M4: `agent_calls.call_type`, carrier-outcome columns, `loads.carrier_cost_estimated` |
| `042-carrier-call-columns.sql` | E2-03 M2: carrier-specific rate/outcome/profit columns |
| `043-m3-m4-dispatch-gate.sql` | E2-03 M3/M4: rate-con gate + carrier verification |
| `046-e2-04-sellside-loop-schema.sql` | E2-04: `inbound_emails`, confirmation tokens, 2 new stages, persona `call_type` |
| `047` | Fix: confirmation token expiry → TIMESTAMPTZ (real driver bug) |
| `048` / `049` / `050` / `051` | `carrier_brief` column; `'Awaiting Signature'` status; documents type check; carrier signature method (F1) |

Engine 3 migrations (033–035, 044–045, 052–058) add tables and triggers *beside* these; none alter Engine 2 tables except additive trigger attachment.

### Multi-Tenancy — current state

Engine 2 is still operationally single-tenant. Until 030 lands: do not add `tenant_id` to a new pipeline table ad-hoc (follow the 030 pattern), don't assume RLS protects pipeline queries (RLS is off everywhere anyway), and see ADR-004 §M5 + the 030 file header for the plan.

### DB Query Pattern Note

Pattern A (tagged template) in API routes; Pattern B (`db.query(text, params)` via `lib/pipeline/db-adapter.ts`) in gate/workers. Match the surrounding file.

## Three Ingest Pathways

| Pathway | `pipeline_loads.created_by` | Lives in | Trigger |
|---|---|---|---|
| **CSV import** | `scanner-csv-v1` | `POST /api/pipeline/import` (bearer `PIPELINE_IMPORT_TOKEN`, 500-row cap) | Operator |
| **Headless scraper (DAT)** | `scraper-v1` | `M1/scraper/` (Railway deploy not recorded) | Per-board polling |
| **Official API (stubs)** | `scanner-v1` | `pollSourceViaAPI()` in `scanner-worker.ts`, driven by `/api/cron/pipeline-scan` | When `ingest_method='api'` |

`loadboard_sources` mediates (api / scrape / disabled / cutover). Scraper fails closed on registry error; API path fails open on rate-limiter Redis errors.

## Cron Routes (wired in `MyraTMS/vercel.json`)

| Schedule | Route | Purpose |
|---|---|---|
| `0 10 * * *` | `/api/cron/pipeline-scan` | Per-source API poll dispatcher |
| `0 11 * * *` | `/api/cron/pipeline-health` | Stuck-load detector + delivered-load advancer + E2-03 M5 sell-side checks (`lib/pipeline/health-checks.ts`) |
| `0 7 * * *` | `/api/cron/feedback-aggregation` | `lane_stats` aggregation + persona α/β refresh |
| `0 13 * * *` | `/api/cron/exception-bridge` | Engine 3 T-24 — reads `pipeline_loads`/`agent_jobs`, writes `exceptions` |

All gated by `CRON_SECRET` and `PIPELINE_ENABLED=true`.

## Kill Switches (env vars in Vercel + Railway; exact-match `.trim().toLowerCase()`)

| Var | Default | Purpose |
|---|---|---|
| `PIPELINE_ENABLED` | `false` | Master — skips all queue processing AND blocks crons |
| `SCANNER_ENABLED` | `false` | CSV/API ingest |
| `MAX_CONCURRENT_CALLS` | `0` (shadow) | Shipper calls. **Found at `25` in production 2026-08-26 — unresolved** |
| `CARRIER_CALLS_ENABLED` | `false` | E2-03 M2 carrier cascade dials |
| `CARRIER_AUTO_ASSIGN_ENABLED` | `false` | E2-03 M3 final TMS assign |
| `SHIPPER_CONFIRMATION_ENABLED` | `false` | E2-04 M2 shipper confirmation emails |
| `SHIPPER_DIRECT_GATE_ENABLED` | `false` | E2-01 shipper-direct hard gate (classification runs when `true`) |
| `SHIPPER_DIRECT_GATE_MODE` | `shadow` | E2-01: `shadow` (classify + persist, never block) or `enforce` (Qualifier F1 rejects / routes to review; Compiler + Dispatcher assert `load_source_class`). Only read when `SHIPPER_DIRECT_GATE_ENABLED=true` |
| `SHIPPER_DIRECT_GATE_ENFORCED_AT` | — | E2-01: ISO timestamp the operator writes at the moment `MODE=enforce` goes live; M2 assertions tolerate `NULL` class on rows created before it |
| `FMCSA_QC_WEBKEY` | — | E2-01: FMCSA QCMobile key used on registry misses. Missing → every miss goes to review (fail closed) |
| `DAT_SEL_CELL_MC` / `DAT_SEL_CELL_DOT` (scraper side) | `[data-field="mcNumber"]` / `[data-field="dotNumber"]` | E2-01: DAT result-row selectors for the poster MC / DOT cells |
| `INBOUND_EMAIL_POLLING_ENABLED` | `false` | E2-04 M4 IMAP poller |
| `SCRAPER_ENABLED` (scraper side) | `false` | Railway scraper |
| `AUTO_BOOK_PROFIT_THRESHOLD` | — | **Retired by T-19**; margin floor is `lib/tenants/margin-floor.ts`. Preflight scripts only report it. |

A trailing `\n` on a Vercel value once silently defeated the exact-match logic (fixed 2026-06-04). `scripts/sprint6-shadow/01-preflight.ts` checks these; `07-emergency-stop.ts` pauses all 12 queues.

## Existing TMS Functions These Workers Call (do not rewrite)

| Function | Location | Caller |
|---|---|---|
| `matchCarriers(sql, request)` + `storeMatchResults()` | `MyraTMS/lib/matching/index.ts` | Ranker |
| `getDistance()` | `MyraTMS/lib/geo/distance-service.ts` (duplicate in `lib/quoting/geo/`) | Researcher |
| `generateQuote()` / `rateCascade()` / `extractRegion()` | `MyraTMS/lib/quoting/` | Qualifier, Researcher |
| `createToken()` | `MyraTMS/lib/auth.ts` | via `lib/pipeline/service-token.ts` for the Dispatcher |

The Dispatcher chains `POST /api/loads` → `/assign` → `/tracking-token` → `/send-tracking` with the service-token cookie and writes pipeline-linkage columns directly afterwards (`loads.source` CHECK excludes `'AI Agent'`; use `'Load Board'` + `booked_via='ai_auto'`). Known gap (E2-02): `createTMSLoad()` has no idempotency check, so a `dispatch-queue` retry after a downstream failure can create a duplicate `loads` row.

## Operator Quick-Reference

```bash
# All from MyraTMS/, not from this directory.
cd ../MyraTMS

pnpm tsx --env-file=.env.local scripts/run-workers.ts                 # worker host
pnpm tsx --env-file=.env.local scripts/run-imap-poller.ts             # inbound email (needs IMAP_*)
pnpm tsx --env-file=.env.local scripts/verify-pipeline-migration.ts   # migration check

# Phase 6A shadow drain
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/01-preflight.ts
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts   # ⚠️ FK-violates against `exceptions` (found 2026-08-26)
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=75
# … 03-watch-pipeline.sql, then 04-shadow-metrics.ts

# Phase 6B first live calls
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts

# Emergency stop
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts --reason="…"

# Tests (check DATABASE_URL first — see root CLAUDE.md)
pnpm vitest run __tests__/pipeline/ __tests__/loadboards/
```

## Conventions When Editing Files HERE

These files are not compiled. Default to editing the live copy under `MyraTMS/`. If you edit a `.ts` file here, propagate to `MyraTMS/lib/...` in the same commit. Preserve TODO tag numbering. `BaseJobPayload` (`pipelineLoadId`, `loadId`, `loadBoardSource`, `enqueuedAt`, `priority`) is contract across all 12 queues. Engine 2 multi-tenanting goes through `030_…PENDING`, not a fresh migration.

## Parent Repo

`../CLAUDE.md` covers the MyraTMS monorepo. Read it first if your task crosses the integration boundary.
