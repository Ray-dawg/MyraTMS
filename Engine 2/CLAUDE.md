# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Directory Is — IMPORTANT

**Engine 2 is the original delivery package for the 7-agent AI pipeline. The integration is DONE.** All 32 source files were placed into the sibling `MyraTMS/` Next.js app during Sprints 0–6.5 (April–May 2026). The pipeline is **CODE COMPLETE, pre-production**.

The files in this directory are now **spec material** — the historical record of what was delivered and the design intent behind each agent. **The live code is in `MyraTMS/`, not here.**

| You want to… | Go here |
|---|---|
| Edit a worker, run it, or test it | `MyraTMS/lib/workers/` + `MyraTMS/__tests__/pipeline/` |
| Edit a pipeline service (Claude, compliance, cost-calculator, gate, brief schema) | `MyraTMS/lib/pipeline/` |
| Apply or change a migration | `MyraTMS/scripts/*.sql` (migrations 023–026 added at integration time fix drift discovered against the real DB) |
| Run the operator playbooks (shadow drain, live-call preflight, emergency stop) | `MyraTMS/scripts/sprint6-shadow/` |
| Boot all 7 workers | `MyraTMS/scripts/run-workers.ts` (deployed to Railway, not Vercel) |
| Update CSV ingest, official-API ingest, or scraper cutover machinery | `MyraTMS/lib/loadboards/` + `MyraTMS/app/api/loadboard-sources/` |
| Edit the headless scraper (DAT, Truckstop, 123LB, Loadlink) | `M1/scraper/` (sibling, separate Railway deploy) |
| Read or update the completion tracker | `docs/superpowers/plans/completion.md` (in **this** directory) |

**Do NOT:**
- Re-copy files from this directory into MyraTMS. Sprint 0 already did this; running it again will overwrite live, debugged code with the original delivery (which had multiple bugs caught and fixed during Sprints 0–5).
- Run `pnpm install` / `pnpm build` / `pnpm test` from this directory. There's no `package.json` here. The live tests run from `MyraTMS/` (`pnpm vitest run __tests__/pipeline/`).
- Edit imports in the files here to "make them resolve". They don't resolve here on purpose — the copies under `MyraTMS/lib/...` have the corrected paths.

**Related, one directory up:** `../Engine 3/` is the roadmap phase that wraps Engine 2 as a service rather than replacing it (T-17/T-18/T-19 shipped 2026-08-25 — event layer, agent governance, tenant policy). See `../Engine 3/wave1.md` if you need to understand what that layer now observes about this pipeline's tables, or `../Engine 3/CLAUDE.md` for the fuller picture. Nothing in Engine 3 Phase 1 writes to or gates any table/file in this pipeline.

## The Authoritative Documents (in order of how often you'll need them)

1. **`docs/superpowers/plans/completion.md`** — **The live source of truth.** Task-by-task progress through 6 sprints, schema gaps discovered, the Production Ship Roadmap from "code complete" to "first real booking", and a Change Log. Per saved user feedback: **keep this in sync as Engine 2 plan tasks finish; do not batch.**
2. **`docs/superpowers/plans/2026-04-30-engine2-end-to-end.md`** — The execution plan completion.md tracks against. Has the full task definitions referenced as "Task 7", "Task 5.5-3", etc.
3. **`CLAUDE_CODE_BUILD_PLAN.md`** (BUILD 11) — The *original* integration plan written before any code was placed. Still useful as a high-level map ("Agent 3 calls existing TMS `getDistance()`", "use existing `runMatchingEngine()` not a new one"), but the actual placement has moved on. Read this when you need the original design intent for an agent.
4. **`C04_Voice_Agent_Conversation_Playbook.md`** — Script source for the Retell call flow (persona prompts, objection responses). Material for the prompts inside Retell's dashboard; not loaded by code.
5. **`T02–T13` agent specs** — Deeper per-agent contracts. **Read only when resolving an ambiguity** — the live worker code + completion.md cover 95% of integration questions.

## File Inventory — Where Each File Was Placed

| Group | Files in this dir | Placed at |
|---|---|---|
| **Pipeline foundation** | `stages.ts`, `queues.ts`, `payloads.ts`, `gate.ts` | `MyraTMS/lib/pipeline/` |
| **Services** | `claude-service.ts` + `-types.ts`, `compliance-service.ts` + `-types.ts`, `cost-calculator.ts` (+ test), `types.ts`, `examples.ts`, `persona-selector.ts`, `objection-playbook.ts`, `benchmark-rates.ts`, `myra_negotiation_brief_schema.ts` → renamed `negotiation-brief.ts` | `MyraTMS/lib/pipeline/` |
| **Workers (9)** | `base-worker.ts`, `scanner-worker.ts`, `qualifier-worker.ts`, `researcher-worker.ts`, `ranker-worker.ts`, `compiler-worker.ts`, `voice-worker.ts`, `dispatcher-worker.ts`, `feedback-worker.ts`, `index.ts` | `MyraTMS/lib/workers/` |
| **Voice / Webhook** | `retell-webhook.ts`, `retell-types.ts`, `test-webhook.ts`, `example_retell_payload.json` | `MyraTMS/lib/pipeline/` (test → `MyraTMS/__tests__/pipeline/`) |
| **Cron handlers** | `cron-handlers.ts`, `cron-types.ts` | `MyraTMS/lib/cron/` |
| **Database** | `pipeline_migrations.sql` | `MyraTMS/scripts/` (plus 023, 024, 025, 026 correction migrations added at integration time) |
| **Retell dashboard configs (reference only — NOT copied)** | `retell_config_v2_gatekeeper.jsx`, `retell_config_carrier_onboarding.jsx` | Pasted into Retell dashboard, not Git |

**New files born at integration time** (don't exist in this dir; live only in `MyraTMS/`):
- `lib/pipeline/redis-bullmq.ts` — ioredis connection for BullMQ. Distinct from existing `lib/redis.ts` (Upstash REST client) because BullMQ needs raw TCP.
- `lib/pipeline/db-adapter.ts` — Pattern-A → Pattern-B query bridge with Neon serverless v1 quirk (`sql.query(text, params)` required, not `sql(text, params)`).
- `lib/pipeline/service-token.ts` — Mints short-lived `role='admin'` JWT cookies so the Dispatcher worker can call existing TMS routes (`/api/loads`, `/assign`, `/tracking-token`, `/send-tracking`) without modifying them.
- `lib/loadboards/*` — Third ingest pathway (after CSV import and headless scraper): official-API clients (currently all stubs that throw `not_implemented` cleanly) plus the `loadboard_sources` registry that's the single source of truth shared by Vercel API path AND the Railway scraper.
- `scripts/run-workers.ts` — Single-process Railway entry-point that boots all 7 workers sharing one ioredis connection.
- `scripts/sprint6-shadow/` — 7 operator scripts (preflight, synthetic-load generator, observation SQL, metrics evaluator, live-call gate, cleanup, emergency stop) + README runbook.

Worker source files in this directory contain numbered TODOs (`Q-1`, `R-2`, `RE-7`, `C-3`) referenced from the build plan. **These TODOs are mostly resolved in the copies under `MyraTMS/lib/workers/`** — when comparing the two, the MyraTMS copy is canonical.

## Pipeline Architecture (still accurate — this is the conceptual model)

### Stage Machine (`stages.ts`)

A load flows through `pipeline_loads.stage`:

```
scanned → qualified ┬─→ researched ─┐
                    │                ├→ matched → briefed → calling → booked → dispatched → delivered → scored
                    └─→ matched ────┘
                ↓
           disqualified | escalated | expired | callback
```

Stage transitions are validated by `VALID_TRANSITIONS` in `stages.ts`. Terminal stages (`disqualified`, `scored`, `expired`) are dead-ends.

### The Parallel Gate (`gate.ts`)

After `qualified`, **Agent 3 (Researcher) and Agent 4 (Ranker) run in parallel** off `qualify-queue`. The gate is the synchronization point:

- "Research complete" = `pipeline_loads.research_completed_at IS NOT NULL`
- "Ranker complete" = `pipeline_loads.carrier_match_count > 0`
- Each worker calls `onResearcherComplete()` / `onRankerComplete()` when done; whichever finishes second triggers `checkAndAdvanceToMatched()` which atomically advances stage and enqueues to `brief-queue`.

The gate uses **DB-backed idempotency, not distributed locks** — calling it multiple times is safe.

### 9 BullMQ Queues (`queues.ts`)

| Queue | Concurrency | Retry | Notes |
|---|---|---|---|
| `qualify-queue` | 50 | 3× exp / 30s | Pure SQL, fast |
| `research-queue` | 20 | 5× exp / 60s | Claude API, extended backoff for 429s |
| `match-queue` | 20 | 3× exp / 30s | Runs in parallel with research |
| `brief-queue` | 20 | 2× fixed / 30s | Merge point of parallel jobs |
| `call-queue` | 100 | **NO RETRIES** | Voice calls are not idempotent |
| `dispatch-queue` | 10 | 3× exp / 30s | TMS writes, low concurrency |
| `feedback-queue` | 5 | 3× exp / 5min | FIFO, post-delivery |
| `callback-queue` | 20 | NO RETRIES | **Delayable** — supports scheduled execution |
| `escalation-queue` | 5 | 3× exp / 30s | Notifications |

### Worker Lifecycle (`base-worker.ts`)

All workers extend `BaseWorker<T extends BaseJobPayload>`. Implementations override `process(job)`. The base class handles: stage validation on entry, success/failure logging into `agent_jobs`, automatic stage advancement, graceful shutdown. **Always extend `BaseWorker` — do not roll worker boilerplate by hand.**

### Service Modules

- **`claude-service.ts`** — Single Anthropic SDK wrapper used by Agents 3, 5, and the call parser. Retry with exponential backoff, Zod-based structured output parsing, per-job token budget tracking, `ClaudeServiceError` / `RateLimitError` / `ParseError` classes. Use this — do not call `@anthropic-ai/sdk` directly from workers.
- **`compliance-service.ts`** — Legal gate for outbound calls (CASL, TCPA, DNC, calling hours, shipper fatigue). `runFullComplianceCheck()` is the master function. **No call may be placed without passing this gate.** All decisions logged for regulatory defense.
- **`cost-calculator.ts`** — Pure-math, zero-dependency module for total cost (carrier rate + fuel + accessorials + factoring + admin) and negotiation envelope (initial/target/min). Unit tests in `cost-calculator_test.ts`. Used by Agents 2, 3, 5.
- **`persona-selector.ts`** — Thompson Sampling over Beta(α, β) per persona (Jöhnk rejection sampler, no external libs). Drives A/B selection of Retell agent IDs in Agent 5; α/β updated by Feedback agent.
- **`benchmark-rates.ts`** — Static Ontario CAD rate table (4 equipment types × 5 distance bands × 4 seasons). Source #6 in the 6-source rate cascade.

### The Negotiation Brief Contract

`myra_negotiation_brief_schema.ts` (here) → `lib/pipeline/negotiation-brief.ts` (live) defines **the data contract between Agent 5 (Compiler) and Agent 6 (Voice/Retell)**. Design principle: the voice agent is an **executor, not a thinker** — every number, threshold, script, and boundary is pre-computed in the brief. The brief is transformed into Retell `retell_llm_dynamic_variables` by `compileRetellPayload()`. **All 63 dynamic variables must be strings** (Retell contract).

If you change brief fields, you must also update:
1. `validateBrief()` in the same file
2. The Retell agent config in the Retell dashboard (reference `retell_config_v2_gatekeeper.jsx`)
3. The `negotiation_briefs` table column shape (a new migration in `MyraTMS/scripts/`, not an edit of an existing one)

## Database (`pipeline_migrations.sql` + 023–026, plus 027–032 multi-tenant/prospect)

`pipeline_migrations.sql` (idempotent, `IF NOT EXISTS` everywhere) was applied via `MyraTMS/scripts/apply-pipeline-migration.ts`. It adds 9 new tables: `pipeline_loads`, `agent_calls`, `negotiation_briefs`, `consent_log`, `dnc_list`, `shipper_preferences`, `lane_stats`, `personas`, `agent_jobs`. Plus `ALTER TABLE` additions to existing TMS tables (`loads.pipeline_load_id|source_type|booked_via`, `carriers.accepts_ai_dispatch|ai_call_count`, `shippers.consent_status|preferred_language|shipper_fatigue_score`) and seeds 3 default personas.

**Correction migrations added during integration** (these fix gaps between the build plan and the real schema — do not "undo" them):

| Migration | What it fixes |
|---|---|
| `023-pipeline-schema-corrections.sql` | `pipeline_loads.top_carrier_id`/`tms_load_id` → TEXT; drops `match_results_load_id_fkey` (existing TMS FK didn't anticipate pipeline-style match-before-book) |
| `024-pipeline-brief-schema-corrections.sql` | `negotiation_briefs.top_carrier_id` integer → TEXT (matches `carriers.id` reality) |
| `025-…compliance_audit` | Adds `compliance_audit` table the prebuilt audit logger writes to |
| `026-loadboard-sources.sql` | Adds `loadboard_sources` (4 rows: dat/truckstop/123lb/loadlink × ingest_method enum). Single source of truth for which ingest pathway each board uses |

**Migrations added *after* integration (027–032 — these post-date the original CLAUDE.md and change Engine 2's runtime assumptions):**

| Migration | What it does / why Engine 2 cares |
|---|---|
| `027_multi_tenant_foundation.sql` | Multi-tenant Phase M1: tenants + `tenant_users` + `is_super_admin`. Foundation only — no Engine 2 table touched yet. |
| `028_add_tenant_id.sql` | Adds `tenant_id BIGINT NOT NULL` to TMS-core tables **but explicitly DEFERS all Engine 2 tables to 030** (see its header comment). So right now the 10 pipeline tables are the *only* un-tenanted transactional tables. |
| `029_create_rls_policies.sql` | Row-Level Security policies for the 028 tables. Engine 2 tables are **not** under RLS yet. |
| `030_engine2_tenanting.sql.PENDING` | ⚠️ **Staged, NOT applied** (`.PENDING` suffix). When activated it adds `tenant_id` to all 10 Engine 2 tables and rewrites uniqueness (`pipeline_loads` → `(tenant_id, load_id, load_board_source)`; `dnc_list` → `(tenant_id, phone)` per-tenant legal DNC; `personas`/`lane_stats` likewise). Gated on: Engine 2 v1 in prod ≥24h with no critical incident AND completion.md fully checked. **Do not rename/apply it casually.** |
| `031_tenant_usage.sql` | Per-tenant usage metering. |
| `032-carrier-status-prospect.sql` | Adds `carriers.carrier_status` (`'prospect'` \| `'active'`). FMCSA-seeded carriers default `'prospect'`; existing carriers default `'active'`. **Changes Agent 4 + Agent 7 behavior — see Dispatcher note below.** |

### Multi-Tenancy — current state (read before adding any pipeline table or query)

Engine 2 was built **single-tenant** and is still operationally single-tenant: every pipeline table holds one implicit tenant (Myra). Migration 030 (PENDING) is the bridge to true multi-tenant. Until it lands:

- **Do NOT add `tenant_id` to a new pipeline table ad-hoc.** If you create a new Engine 2 table, it must follow the 030 pattern (`tenant_id BIGINT NOT NULL DEFAULT myra_tenant_id`, composite uniqueness) so 030 doesn't conflict — coordinate with `MyraTMS/scripts/030_engine2_tenanting.sql.PENDING` rather than inventing a parallel scheme.
- **Don't assume RLS protects pipeline queries.** It doesn't yet. Worker SQL is trusted-process SQL, not tenant-scoped.
- The trigger conditions and exact column/constraint plan live in the 030 file's header and `SESSION_2_NOTES.md §Open items #M5` / ADR-004 §M5.

### DB Query Pattern Note

Two patterns coexist in the codebase:

```ts
// Pattern A — used by most TMS API routes
const sql = neon(process.env.DATABASE_URL!);
const result = await sql`SELECT * FROM carriers WHERE id = ${id}`;

// Pattern B — used by gate.ts and some workers (via lib/pipeline/db-adapter.ts)
const result = await db.query('SELECT * FROM carriers WHERE id = $1', [id]);
```

When editing existing code, **match the surrounding pattern**. The `db-adapter.ts` shim handles the Neon serverless v1 quirk (must be `sql.query(text, params)` not `sql(text, params)`).

## Three Ingest Pathways (loads enter the pipeline via one of these)

| Pathway | Marker (`pipeline_loads.created_by`) | Lives in | Trigger |
|---|---|---|---|
| **CSV import** | `scanner-csv-v1` | `POST /api/pipeline/import` (bearer auth, 500-row cap) | Operator-driven |
| **Headless scraper (DAT)** | `scraper-v1` | `M1/scraper/` (Railway, sibling to MyraTMS) | Per-board polling intervals with jitter |
| **Official API (stubs)** | `scanner-v1` | `pollSourceViaAPI()` in `MyraTMS/lib/workers/scanner-worker.ts`, driven by `app/api/cron/pipeline-scan` | Every minute when source's `ingest_method='api'` |

The `loadboard_sources` table mediates between the scraper and the API path (mutually exclusive states: `api` / `scrape` / `disabled` / `cutover`). Per-board cutover is a 1-line SQL UPDATE — no deploys, no env coordination. Both services check the registry; the scraper fails *closed* on DB error (better to skip a poll than risk double-ingest), the API path fails *open* on rate-limiter Redis errors (the board's own 429 is a backstop).

## New Cron Routes (wired in `MyraTMS/vercel.json`)

| Schedule | Route | Purpose |
|---|---|---|
| `* * * * *` | `/api/cron/pipeline-scan` | Per-source API poll dispatcher; honors `loadboard_sources.ingest_method` |
| `*/5 * * * *` | `/api/cron/pipeline-health` | Stuck-load detector (60+ min in non-terminal) + delivered-load advancer |
| `0 7 * * *` | `/api/cron/feedback-aggregation` | Daily `lane_stats` aggregation + rate-target adjustment + persona summary refresh |

All gated by `CRON_SECRET` (Authorization: Bearer …) AND `PIPELINE_ENABLED=true`.

## Kill Switches (env vars set in Vercel + Railway)

| Var | Default in dev | Purpose |
|---|---|---|
| `PIPELINE_ENABLED` | `false` | Master kill switch — skips all queue processing AND blocks all crons |
| `SCANNER_ENABLED` | `false` | Disables CSV/API ingest specifically |
| `MAX_CONCURRENT_CALLS` | `0` (shadow mode) | Runs Agents 1–5 but never places a real call |
| `AUTO_BOOK_PROFIT_THRESHOLD` | `999999` | Effectively disables auto-booking |
| `SCRAPER_ENABLED` (scraper side) | `false` | Secondary kill switch for the Railway scraper |

Sprint 6's preflight and emergency-stop scripts (`MyraTMS/scripts/sprint6-shadow/01-preflight.ts`, `07-emergency-stop.ts`) operate against these.

## When You Must Read T-Series Specs

Most integration questions are answered by reading the live workers + `completion.md`. Reach for `T0X_*.md` only when:
- A worker's behavior is ambiguous AND `completion.md`'s Change Log doesn't cover the case
- Retell webhook event handling needs deeper context (T09, T12)
- Debugging compliance edge cases (T13)
- The Thompson Sampling math or feedback aggregation behavior is unclear (T11)

## Existing TMS Functions These Workers Call (do not rewrite)

Already exist in MyraTMS and called by the integrated workers:

| Function | Location | Caller |
|---|---|---|
| `matchCarriers(sql, request)` + `storeMatchResults()` | `MyraTMS/lib/matching/index.ts` | Agent 4 (Ranker) |
| `getDistance()` | `MyraTMS/lib/distance/index.ts` | Agent 3 (Researcher) |
| `generateQuote()` / `rateCascade()` / `extractRegion()` | `MyraTMS/lib/quoting/` | Agents 2, 3 |
| `createToken()` | `MyraTMS/lib/auth.ts` | Wrapped by `lib/pipeline/service-token.ts` for Dispatcher |

Agent 7 (Dispatcher) calls these existing TMS routes in order: `POST /api/loads` → `POST /api/loads/[id]/assign` → `POST /api/loads/[id]/tracking-token` → `POST /api/loads/[id]/send-tracking`, with the service-token JWT cookie. **Note:** the existing `/api/loads` POST doesn't accept the pipeline-linkage columns (`pipeline_load_id`, `source_type='ai_agent'`, `booked_via='ai_auto'`), so the Dispatcher writes those directly to the DB after the chain completes — preserves the "no modifying existing routes" rule. Also: `loads.source` has a CHECK constraint that excludes `'AI Agent'`; use `'Load Board'` and rely on `booked_via='ai_auto'` as the AI marker.

**Prospect/active carrier gate (migration 032).** The Ranker (Agent 4) matches **both** `'prospect'` and `'active'` carriers so shadow drains exercise the full pipeline against the FMCSA-seeded carrier pool. But the Dispatcher (Agent 7) **refuses to dispatch to a `'prospect'` carrier** — it reads `carriers.carrier_status` via `fetchCarrierStatus()` and **escalates** (not assigns) if the top carrier isn't `'active'`. Promotion `prospect → active` is a human step via `PATCH /api/carriers/[id]/promote`. If you touch the Dispatcher's assign path, preserve this gate — it's the safety boundary that prevents auto-dispatch to never-contacted carriers.

## Operator Quick-Reference

```bash
# All these run from MyraTMS/, not from this directory.
cd ../MyraTMS

# Worker host (Railway in prod, local for dev)
pnpm tsx --env-file=.env.local scripts/run-workers.ts

# Verify the pipeline migration is applied
pnpm tsx --env-file=.env.local scripts/verify-pipeline-migration.ts

# Phase 6A — shadow drain (no risk, ~30 min)
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/01-preflight.ts
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/06-cleanup.ts
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=75
# … then 03-watch-pipeline.sql in another terminal, then 04-shadow-metrics.ts

# Phase 6B — first 10 live calls (after 6A green AND Retell credentials in hand)
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/05-live-call-preflight.ts

# Emergency stop (pauses all 9 queues + disables all loadboard_sources + audit log)
pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts --reason="…"

# Pipeline test suite (lives at MyraTMS/__tests__/pipeline/ + __tests__/loadboards/)
pnpm vitest run __tests__/pipeline/ __tests__/loadboards/
```

## Conventions When Editing Files HERE (the spec material)

These files are kept around as spec/reference. They are NOT compiled — they have no `tsconfig.json` neighbor, and their imports (`'../lib/database'`, `'../lib/logger'`) intentionally don't resolve.

- **Default to editing the live copy under `MyraTMS/`, not here.** If you do edit a file in this directory, propagate the change to `MyraTMS/lib/pipeline/<same-file>` or `MyraTMS/lib/workers/<same-file>` in the same commit, or the live behavior drifts from the spec.
- Worker TODOs here use numbered tags (`Q-1`, `R-3`, `RE-7`); the corresponding sections in `MyraTMS/lib/workers/` usually have the resolution. Preserve the tag numbering for cross-referencing.
- The `BaseJobPayload` shape (`pipelineLoadId`, `loadId`, `loadBoardSource`, `enqueuedAt`, `priority`) is contract — every queue's payload extends it. Don't break it without bumping all 9 queues + all 7 workers + the gate.
- `pipeline_migrations.sql` here is the *original* migration. The live applied migration is the same file under `MyraTMS/scripts/` plus corrections 023–026 (and the later 027–032 multi-tenant/prospect work — see the Database section). Never edit `CREATE TABLE` blocks in-place — add a new `ALTER TABLE … IF NOT EXISTS` migration. **Engine 2 multi-tenanting must go through the staged `030_…PENDING` file, not a fresh ad-hoc migration.**

## Parent Repo

`../CLAUDE.md` covers the MyraTMS monorepo (Next.js app, DApp PWA, tracking page, marketing site, plus this Engine 2 spec + the sibling scraper). Read that first if your task crosses the integration boundary.
