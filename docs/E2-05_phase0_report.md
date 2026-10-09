# E2-05 Engine Room — Phase 0 read-only inventory

**Date:** 2026-10-08 · **Code:** `master` @ `dd9b662` (MyraTMS) · **DB:** Neon production branch `br-rough-forest-aif4a3vf`, read-only queries only · **Shipped UI inspected:** `engine-room-tsx.zip` (`types.ts`, `api.ts`, `page.tsx`, README)

Nothing was modified. Every claim below carries a `file:line`, a column listing, or **NOT FOUND**. Paths are relative to `MyraTMS/` unless prefixed.

---

## 1. Framework and conventions

| Item | Finding | Evidence |
|---|---|---|
| Framework | **Next.js 16.0.10, React 19.2.0, TypeScript, App Router.** Not SvelteKit. The shipped components drop in without a port. | `package.json` deps (`next 16.0.10`, `react 19.2.0`) |
| Build strictness | `ignoreBuildErrors: false` — TS errors fail the build | root `CLAUDE.md` "Build Strictness" |
| Routing | `app/<segment>/page.tsx`; API under `app/api/**/route.ts`; **no `app/**/layout.tsx` besides root** (`git ls-files 'app/**/layout.tsx'` → root only). Pages are `"use client"` SWR consumers. | `git ls-files 'app/**/page.tsx'` (34 pages) |
| Import alias | `@/*` → project root (same as the shipped bundle) | `tsconfig.json` |
| Auth/session | JWT in httpOnly cookie `auth-token`; payload `{userId, email, role, tenantId, tenantIds, isSuperAdmin}` | `lib/auth.ts:32-48` |
| Server-side read | `getCurrentUser(request: NextRequest)` — **takes a request**; there is no `cookies()`-based helper for server components. `page.tsx`'s `resolveRole()` will need one (read `auth-token` via `next/headers` → `verifyToken`). | `lib/auth.ts` (`getCurrentUser`), `grep cookies\(\) app/**/page.tsx` → none |
| Client-side role | `useTenant()` from `components/tenant-context.tsx:34-35` (`user.role`, `user.isSuperAdmin`) fed by `GET /api/me/tenant` (`app/api/me/tenant/route.ts:92-93`) | |
| Role model | **Two role axes.** JWT `role` comes from `users.role` ∈ `admin \| ops \| sales` (`scripts/001-create-tables.sql:12`). `tenant_users.role` ∈ `owner \| admin \| operator \| driver \| viewer \| service_admin` (`scripts/027_multi_tenant_foundation.sql:88-89`). `requireRole(user, ...roles)` checks the **JWT** role (`lib/auth.ts:183-191`). Production: all 7 `tenant_users` rows are `admin`; no `viewer` exists yet. | Neon query |
| Tenant context | `getTenantContext()` on `master` **reads `x-myra-tenant-*` headers** (`lib/auth.ts:146-157`) that middleware was supposed to set — and middleware never ran (matcher at `middleware.ts:266` is malformed). Fix commit `dd649f1` is on branch `fix-tenant-header-bypass`, **not merged**. Engine Room routes must derive identity from the JWT (`getCurrentUser`) and never from headers. | `git branch --contains dd649f1` → only the fix branch |
| Existing route-auth pattern to copy | `authorizeGovernanceRequest()` = JWT + `requireRole('admin','ops')` (`lib/governance/api-helpers.ts:5-8`); `authorizeEventsRequest()` same shape (`lib/pipeline/events-api-helpers.ts:10`) | |
| Component library | Shadcn/UI (New York) + Radix in `components/ui/`; Tailwind 4 with oklch CSS variables in `app/globals.css`; `sonner` toasts | root `CLAUDE.md` |
| Chart library | `recharts 2.15.4` via `components/ui/chart.tsx`; used by `app/intelligence/page.tsx`, `app/finance/page.tsx`, `app/page.tsx`, `app/reports/page.tsx`, `app/quotes/analytics/page.tsx` | `git grep recharts` |
| Data fetching | SWR hooks in `lib/api.ts`; mutation via `mutate(key => key.startsWith(...))`. The shipped `usePoll()` is self-contained and does not conflict. | |
| Main admin nav | `components/app-sidebar.tsx:64-81` (`adminNavigation`) and `:85-95` (`opsNavigation`), filtered by `requiredFeature` / `superAdminOnly` at `:112-118`. One entry added here satisfies "one nav entry". | |
| Dispatch Briefing page | `app/dispatch/briefing/page.tsx` (client, fetches `app/api/dispatch/briefing/route.ts`) | |
| `/intelligence` page | `app/intelligence/page.tsx` — TMS shipper-risk analytics over loads/carriers/invoices; **does not read any Engine 2/3 table** | |
| Alert Center | `components/alert-center.tsx`, mounted in `components/topbar.tsx:154`; reads `GET /api/exceptions?status=active&limit≤200` (`app/api/exceptions/route.ts:11-13`), `POST /api/exceptions/detect`, `PATCH /api/exceptions/[id]` | |

---

## 2. Kill switches — every read site and its parsing

Legend: **V** = runs on Vercel, **R** = runs on Railway (`scripts/run-workers.ts`), **P** = separate poller process (never deployed).

| Flag | Read site | Parsing | Where |
|---|---|---|---|
| `PIPELINE_ENABLED` | `lib/workers/voice-worker.ts:96` | `!== 'true'` **strict, no trim** | R |
| | `lib/workers/carrier-voice-worker.ts:109` | `!== 'true'` strict | R |
| | `lib/workers/shipper-confirmation-worker.ts:163` | `!== 'true'` strict | R |
| | `app/api/cron/pipeline-scan/route.ts:86` | `=== 'true'` strict | V |
| | `app/api/cron/pipeline-health/route.ts:46` | `!== 'true'` strict | V |
| | `app/api/cron/feedback-aggregation/route.ts:38` | `!== 'true'` strict | V |
| | `app/api/pipeline/import/route.ts:51` | `!== 'true'` strict → 503 | V |
| | `scripts/run-workers.ts:120` | logged only; `:83` comment: gating lives in `process()`, workers are never paused | R |
| | `lib/cron/cron-handlers.ts:997` | dead code | — |
| | **Not read by** qualifier, researcher, ranker, compiler, dispatcher, feedback, carrier-brief-compiler workers | they keep draining when `false` | R |
| `SCANNER_ENABLED` | `app/api/cron/pipeline-scan/route.ts:87` | `=== 'true'` strict | V |
| | `scripts/run-workers.ts:121` | logged only | R |
| `MAX_CONCURRENT_CALLS` | `lib/workers/voice-worker.ts:101` | **`Number(process.env.MAX_CONCURRENT_CALLS ?? '1')`** → `<= 0` = shadow. **Unset ⇒ 1 ⇒ LIVE.** `""` ⇒ `Number("")=0` ⇒ shadow by coincidence. `"0\n"` ⇒ 0 (Number trims whitespace). `"abc"` ⇒ NaN ⇒ `NaN <= 0` is false ⇒ **dials with cap NaN** (Lua `tonumber("NaN")`→nil → `count < nil` errors; effectively every dial throws). | R |
| | `lib/workers/compiler-worker.ts:143` | `=== '0'` strict (shadow-mode brief validation) — **disagrees with voice-worker's `<=0`** (`"00"`, `"-1"`, `""` are shadow for Voice but not for Compiler) | R |
| | `scripts/run-workers.ts:122` | logged, default `'1'` | R |
| `AUTO_BOOK_PROFIT_THRESHOLD` | **Retired.** Only `scripts/run-workers.ts:128` logs it as inert. Margin floor = `lib/tenants/margin-floor.ts` (`getMarginFloor()`, called at `lib/workers/compiler-worker.ts:228`) | — | R |
| `INBOUND_EMAIL_POLLING_ENABLED` | `scripts/run-imap-poller.ts:32` | `?.trim().toLowerCase() === 'true'` | P |
| `SHIPPER_CONFIRMATION_ENABLED` | `lib/workers/shipper-confirmation-worker.ts:139` | `?.trim().toLowerCase() === 'true'`; when off, booked loads are **escalated** (`:398-424`) | R |
| `CARRIER_CALLS_ENABLED` | `lib/workers/carrier-voice-worker.ts:102` (constructor — read **once at boot**, not per job) | `?.trim().toLowerCase() === 'true'` | R |
| `CARRIER_AUTO_ASSIGN_ENABLED` | `lib/workers/dispatcher-worker.ts:144` (constructor, once) | trim/lower | R |
| `SHIPPER_DIRECT_GATE_ENABLED` / `_MODE` | `lib/pipeline/gate-mode.ts:13-14`; `app/api/pipeline/import/route.ts:91` | trim/lower; mode `enforce` else `shadow` | V+R |
| `ENGINE_FORCE_STOP`, `ENGINE_CONFIG_SOURCE`, `ENGINE_ROOM_UI_ENABLED` | **NOT FOUND** (new in E2-05) | | |

**Current values.**

| Environment | Source | Values |
|---|---|---|
| Vercel production | `.vercel/.env.production.local` (pulled **2026-05-27**; live `vercel env ls` fails with `UNKNOWN: unknown error, read`) | `PIPELINE_ENABLED="false\n"`, `SCANNER_ENABLED="false\n"`, `MAX_CONCURRENT_CALLS="0\n"`, `AUTO_BOOK_PROFIT_THRESHOLD="999999\n"` — **every value carries a literal trailing `\n`**. With strict `=== 'true'` compares, `"true\n"` would read as *false*; `"false\n"` happens to read as false either way. |
| Railway `myratms-workers` | `railway variables` → `Unauthorized` (CLI not logged in) | **NOT VISIBLE.** Last recorded observation 2026-08-26: `MAX_CONCURRENT_CALLS=25`, `SCANNER_ENABLED=false` (root `CLAUDE.md` Known Issues). Must be re-read before seeding `engine_config`. |
| Local `.env.local` | file | `PIPELINE_ENABLED=true`, `SCANNER_ENABLED=false`, `MAX_CONCURRENT_CALLS=25`; carrier/shipper flags unset |

---

## 3. Concurrency and dial gate (`lib/workers/voice-worker.ts`)

| Question | Answer | Evidence |
|---|---|---|
| In-flight count | Redis sorted set `shipper-call-slots`; Lua script evicts members older than TTL (30 min) then `ZCARD < max` → `ZADD`, atomically. `activeCallSlotCount()` exists for a read. Slots release on dial failure only; successful calls expire by TTL, **not** on `call_ended` (webhook runs in another process). | `lib/pipeline/carrier-locks.ts:77-127`; `voice-worker.ts:121-138` |
| Order of gates at dial time | 1 `PIPELINE_ENABLED` (`:96`) → 2 `MAX_CONCURRENT_CALLS<=0` shadow (`:101`) → 3 `recheckCompliance`: DNC `SELECT FROM dnc_list` (`:166-170`) + calling hours **hardcoded 8–20** in `metadata.timezone ?? 'America/Toronto'` (`:173-178`, via `hourInZone`, `lib/pipeline/time.ts:17`) → 4 `acquireCallSlot(max)` (`:125`) → 5 `POST https://api.retellai.com/v2/create-phone-call` (`:207-226`) | |
| Calling **days** | **NOT FOUND** — no weekday check anywhere (`isWithinCallingHours` is hour-only) | `lib/pipeline/time.ts:37` |
| Per-phone Redis lock (E2-01 M4) | **Shipper side: NOT FOUND.** Carrier side only: `carrier-lock:phone:<E164>` 5-min NX lock (`carrier-locks.ts:19-20,44-52`), taken at `carrier-voice-worker.ts:200`, plus a per-load lock (`:114`). No `max_calls_per_phone_per_day` logic exists. | |
| Carrier-side concurrency | No global slot cap; `carrier-call-queue` BullMQ concurrency 5 (`queues.ts:240`) + per-load lock; `CARRIER_CALLS_ENABLED` read once at boot (`:102`) so a flip needs a Railway restart today. | |
| Brief-time gates (Compiler) | DNC (`compiler-worker.ts:524-530`), consent type `implied_load_post` (`:538`), calling hours (`:533`, `:808`), margin floor (`:228`) | |
| Error-rate brake | **NOT FOUND** | |
| Daily spend / per-day call caps / area-code pacing | **NOT FOUND** | |

---

## 4. Queues

**12 queues** defined in `lib/pipeline/queues.ts:436-449` (the file header at `:4` still says "9"). There is **no `scan-queue`**: the scanner is a service invoked by the cron (`app/api/cron/pipeline-scan`) and the import route, inserting into `pipeline_loads` and enqueueing `qualify-queue` directly (`lib/workers/scanner-worker.ts:255`).

| Queue | Concurrency | Attempts | Consumer booted by `run-workers.ts`? |
|---|---|---|---|
| `qualify-queue` | 50 (`:99`) | 3 | yes (`:88`) |
| `research-queue` | 20 (`:127`) | 5 | yes (`:91`) |
| `match-queue` | 20 (`:155`) | 3 | yes (`:94` Ranker) |
| `brief-queue` | 20 (`:184`) | 2 | yes (`:97`) |
| `call-queue` | 100 (`:213`) | 1 | yes (`:100`) |
| `carrier-call-queue` | 5 (`:240`) | 1 | yes (`:115`) |
| `shipper-confirmation-queue` | 10 (`:271`) | 3 | yes (`:109`) |
| `carrier-brief-queue` | 20 (`:304`) | 2 | yes (`:112`) |
| `dispatch-queue` | 10 (`:332`) | 3 | yes (`:103`) |
| `feedback-queue` | 5 (`:360`) | 3 | yes (`:106`) |
| `callback-queue` | 20 (`:389`) | 1 | **NO** — producer only (`lib/pipeline/retell-webhook.ts:46,1340`) |
| `escalation-queue` | 5 (`:413`) | 3 | **NO** — producer only (`retell-webhook.ts:47,1341`) |

`grep -c "callback-queue\|escalation-queue" scripts/run-workers.ts` → 0. Jobs enqueued to those two queues sit in Redis until `removeOnFail/Complete` ages expire. The only "consumer" code is `lib/cron/cron-handlers.ts:163,394,685`, which is dead.

| Question | Answer | Evidence |
|---|---|---|
| Can Vercel reach BullMQ? | **Yes, already does, over TCP.** `lib/pipeline/redis-bullmq.ts:3-18` builds an `IORedis` client from `UPSTASH_REDIS_URL \|\| REDIS_URL` (TLS when `rediss://`, `maxRetriesPerRequest: null`). Imported by Vercel routes `app/api/cron/pipeline-scan`, `app/api/pipeline/import`, `app/api/pipeline/loads/[id]/resolve-source`, `app/api/webhooks/retell-callback` (via `retell-webhook.ts`). So Vercel can read `Queue.getJobCounts()` / `isPaused()` and enqueue; it must not *consume*. The REST client (`lib/redis.ts`) is separate and is what `/api/health` pings (`app/api/health/route.ts:60`). | |
| Redis pub/sub for commands | Technically available (ioredis on Upstash TCP) but a Vercel function cannot hold a subscription, only Railway can; and nothing in the codebase uses pub/sub today. 2-second polling of `engine_commands` is the only pattern with precedent (workers already poll Postgres). | |
| Failed jobs persisted? | **Yes.** `BaseWorker.logJob()` inserts into `agent_jobs` with `status='completed' \| 'failed'`, `error_message`, `result` (`lib/workers/base-worker.ts:200-215`). BullMQ keeps failed jobs 24 h, completed 1 h (`queues.ts:109-114`, repeated per queue). Production: 232 `agent_jobs`, 23 failed (`research-queue` 17, `brief-queue` 6). `agent_jobs` has `attempts`, `max_attempts` but **no `batch_id`**. | Neon |
| Worker pause | `BaseWorker.pause()` exists (`base-worker.ts:309`) but nothing calls it; `PIPELINE_ENABLED=false` does **not** pause workers (`run-workers.ts:83`). | |

---

## 5. Data available per screen (production columns, verified by `information_schema`)

All Engine 2 tables are **single-tenant** (no `tenant_id`; migration `030_engine2_tenanting.sql.PENDING` not applied).

**`pipeline_loads`** (250 rows; stages seen: `briefed, disqualified, matched, qualified`)
`id, load_id, load_board_source, external_load_id, origin_*/destination_* (city,state,country), pickup_date, delivery_date, equipment_type, commodity, weight_lbs, distance_miles/km, shipper_company/contact_name/phone/email, posted_rate(+currency, rate_type), stage, stage_updated_at, has_carrier_match, estimated_margin_low/high, priority_score, qualification_reason, qualification_detail, research_completed_at, market_rate_floor/mid/best, recommended_strategy, carrier_match_count, top_carrier_id(text), call_attempts, last_call_at, call_outcome, agreed_rate(+currency), profit, profit_margin_pct, auto_booked, booked_at, tms_load_id(text), dispatched_at, delivered_at, created_at, updated_at, created_by, notes, poster_* (E2-01), load_source_class/method/confidence/evaluated_at/evidence, shipper_direct_attestation, attested_by/at, carrier_agreed_rate/currency, carrier_call_outcome, carrier_id_secured, carrier_cascade_position, carrier_profit, confirmation_token(+expires_at tz), confirmation_sent_at/nudged_at, confirmed_at, confirmed_rate(+currency), confirmation_snapshot, confirmation_outcome, decline_reason, shipper_ratecon_returned_at, carrier_ratecon_signed_at, carrier_brief(jsonb), payer_registry_id`.
Stage names (`lib/pipeline/stages.ts`): `scanned, qualified, researched, matched, briefed, calling, booked, awaiting_shipper_confirmation, shipper_confirmed, dispatched, delivered, scored` + `disqualified, declined, escalated, expired, callback`. **`Awaiting Signature` is not a pipeline stage** — it is `loads.status` on the TMS table (`loads_status_check`: `Booked, Awaiting Signature, Dispatched, In Transit, Delivered, Invoiced, Closed`). The UI's `carrier_cascade` and `awaiting_signature` columns must be *derived*: `shipper_confirmed` + `carrier_cascade_position > 0` + `carrier_id_secured IS NULL` → cascade; `carrier_id_secured IS NOT NULL` + `carrier_ratecon_signed_at IS NULL` (or `loads.status='Awaiting Signature'` via `tms_load_id`) → awaiting signature.

**`agent_calls`** (**0 rows in production**, see §11)
`id, pipeline_load_id, call_id, call_type ∈ {outbound_shipper, outbound_carrier} (CHECK), persona, language, currency, retell_call_id, retell_agent_id, phone_number_called, call_initiated_at, call_connected_at, call_ended_at, duration_seconds, negotiation_brief_id, initial_offer, min_acceptable_rate, target_rate, outcome, agreed_rate, profit, profit_tier, auto_book_eligible, sentiment, objections(jsonb), concessions_made, next_action, callback_scheduled_at, decision_maker_name/phone/email, transcript(text), recording_url, call_analysis(jsonb), call_quality_score, created_at, retell_cost_cents, claude_cost_cents, carrier_agreed_rate, carrier_outcome, carrier_profit`.
Outcome vocab written by the webhook: shipper `booked \| callback \| declined \| no_answer \| voicemail \| escalated` (`retell-webhook.ts:1092,1244`); carrier `accept \| decline \| voicemail \| no_answer \| disconnected \| escalated` (`:505`). Costs are **cents**, not CAD. No `batch_id`. No "email read-back" flag (`decision_maker_email` only; look in `call_analysis` jsonb). UI `callType` `shipper_confirmation` has no call — confirmation is email (E2-04).

**`agent_jobs`** — `id, job_id, queue_name, pipeline_load_id, status, priority, attempts, max_attempts, queued_at, started_at, completed_at, failed_at, result(jsonb), error_message, created_at`.

**`negotiation_briefs`** — `id, pipeline_load_id, brief(jsonb), brief_version, persona_selected, strategy, initial_offer, target_rate, min_acceptable_rate, concession_step_1/2, final_offer, carrier_count, top_carrier_id(text), top_carrier_rate, created_at, used_at, call_id`.

**`personas`** (6 rows) — `id, persona_name, retell_agent_id_en, retell_agent_id_fr, description, tone, prompt_template(+_fr), voice_id, voice_settings, is_active, total_calls, total_bookings, total_revenue, avg_profit, booking_rate, avg_call_duration_sec, alpha, beta, created_at, updated_at, call_type`. Rows: shipper `analytical/assertive/friendly` active (friendly α=2, β=1, calls=1 — the one live call), carrier `carrier_data_driven/direct/relationship` inactive. UI `Persona.retellAgentId` (single) must pick `_en`.

**`consent_log`** — `id, phone, consent_type, consent_source, consent_date, consent_proof, expires_at, revoked_at, revoked_reason, created_at, updated_at`. **`dnc_list`** — `id, phone, added_at, source, reason, added_by, notes` (what `mark_dnc` writes). **`compliance_audit`** — append-only `phone, check_type, result, details, pipeline_load_id, call_id, checked_at`.

**`call_budget`** — **NOT FOUND** (table, code, migration). E2-01 M4 was never built. **`v_pipeline_funnel_daily`** — **NOT FOUND** (E2-01 M5 never built).

**`events`** (1,321 rows) — `id, tenant_id, event_type, entity_type, entity_id, pipeline_load_id, source, actor_type, payload, stage_from, stage_to, occurred_at, recorded_at, derived_from_table, derived_from_id, correlation_id`. Types present: `load.scanned 250, load.stage_changed 318, job.completed 306, job.failed 49, load.disqualified 193, load.researched 56, load.matched 51, load.qualified 45, ranking.shadow_compared 44, document.rate_con_received 5, exception.resolved 3, consent.logged 1`. **Zero `call.*` events.** Views **exist**: `v_stage_conversion`, `v_call_funnel`, `v_time_in_stage`, `v_cost_per_call` (`scripts/033-event-data-layer.sql:367-392`, tenant fix in `035:244`); also `v_lifecycle_late_loads`, `v_float_exposure`, `v_payer_concentration_exposure`.

**`agents`** (11, all `status='shadow'`: scanner, qualifier, researcher, ranker, compiler, voice, dispatcher, feedback, negotiation, dispatch_one, policy_engine) — `id, agent_key, display_name, agent_type, status, description, created_at` (**no tenant_id**). **`authority_envelopes`** (9 × v1, tenant 2, `autonomy_default='L2'`, all active; none for negotiation/dispatch_one) — `id, agent_id, tenant_id(integer), version, envelope_name, permissions, tools, budget, policies, confidence_threshold, autonomy_default, escalation_rules, is_active, effective_from, created_by, created_at`. **`authority_evaluations`** (**0 rows**) — `id, envelope_id, agent_id, tenant_id, pipeline_load_id, action, context, autonomy_level_applied, decision, reason, shadow_mode, source_event_id, evaluated_at, correlation_id`. **`escalations`** (**0 rows**) — `id, evaluation_id, tenant_id, pipeline_load_id, severity, status, assigned_to, resolution_note, created_at, resolved_at`. The UI's `Disagreement {e2Did, e3Would, rule}` has **no backing table**; it would have to be derived from `authority_evaluations.decision ≠ observed outcome`, and today there are none to derive from.

**`exceptions`** — `id(uuid), load_id(text), carrier_id, type, severity, title, detail, status, acknowledged_at, resolved_at, created_at, tenant_id(bigint), pipeline_load_id(integer → pipeline_loads.id), source_module, suggested_action, sla_due_at`. Production: **114 active from `pipeline_health_cron`**, 13 active TMS, 2 resolved. A "Needs you" list over `/api/exceptions` will be dominated by stuck-load noise unless filtered by `source_module`/`type`.

**`scraper_runs`** — exists, **0 rows**: `id, source, tenant_id, started_at, completed_at, status, loads_found/inserted/duplicates/skipped, error_message, error_stack, duration_ms, user_agent, proxy_used, session_reused, created_at`.

**`tenants`** — `id(bigint), slug, name, type, status, parent_tenant_id, billing_email, primary_admin_user_id, created_at, updated_at, deleted_at, freight_business_type`. Two rows: `1 _system`, `2 myra (broker)`. `loadboard_sources`: `dat=scrape`, others `disabled`.

**`engine_config`, `engine_commands`, `worker_heartbeats`, `call_batches`** — **NOT FOUND** (all new).

---

## 6. Batches

**No batch/run entity exists** for calls. Candidates:

- `scraper_runs` (0 rows) groups a scrape sweep but is never written (scraper not deployed).
- `POST /api/pipeline/import` ingests N loads in one request (`app/api/pipeline/import/route.ts:110-119`) with `source` defaulting to `'manual'`; the only marker is `pipeline_loads.created_by` (`scanner-worker.ts:331-335`) — no request id is stored.
- The cron scan runs `pollSourceViaAPI(source)` per registry source (`scanner-worker.ts:325-337`); no run row.
- Carrier cascade is implicit in `pipeline_loads.carrier_cascade_position` per load.
- Callback sweeps do not exist (no `callback-queue` consumer).

A derived batch id (`import:<ISO>`, `scan:<source>:<date>`, `cascade:<pipeline_load_id>`) is possible for new work only; Phase 1.5's `call_batches` + nullable `batch_id` on `agent_calls`/`agent_jobs` is justified.

---

## 7. Existing routes

| Asked | Finding |
|---|---|
| `/api/pipeline/calls` | **NOT FOUND** |
| `/api/pipeline/escalations` | **NOT FOUND** |
| `/api/pipeline/*` that exist | `import` (POST ingest, GET status; bearer `PIPELINE_IMPORT_TOKEN`), `loads/[id]/resolve-source` (POST) |
| T-17 metrics | `GET /api/metrics/{funnel, stage-conversion, time-in-stage, cost-per-call}` — tenant-scoped, JWT + role via `authorizeEventsRequest`; `GET /api/events/[id]` |
| T-18 | `GET /api/agents` · `GET+POST /api/agents/[agentKey]/envelope` (POST inserts a **new version** and flips `is_active`, `route.ts:66-97` — this is the E3 "save envelope" write already built) · `GET /api/evaluations` · `GET /api/escalations`, `PATCH /api/escalations/[id]`. All use `authorizeGovernanceRequest` = JWT + `requireRole('admin','ops')`. |
| T-18 replay | `scripts/t18_replay_shadow_evaluation.ts` exports `runReplay()`; maps only `call.initiated → voice/place_call` (`:21-23`). With 0 call events it is a no-op today; it is a script, not an API. |
| E2-04 F1 manual sign-off | **Already built:** `POST /api/loads/[id]/confirm-carrier-signature` (records `manual_ops`, migration 051). Phase 2's `rate-con-signed` should wrap it, not rebuild it. |
| Alert Center API | `GET /api/exceptions`, `PATCH /api/exceptions/[id]`, `GET /api/exceptions/sla-breaches`, `classification-rules` |
| Health | `GET /api/health` checks Neon + Upstash REST only (`app/api/health/route.ts:60-74`); says nothing about workers or queues |

---

## 8. Retell capabilities (checked against docs.retellai.com on 2026-10-08)

| Capability | Finding | Source |
|---|---|---|
| End an in-progress call by API | **Yes.** `POST https://api.retellai.com/v2/stop-call/{call_id}`, Bearer API key, no body, `204` on success, `422` if the call is not ongoing/not ours. → `capabilities.endCall = true` is wireable from Railway. | https://docs.retellai.com/api-references/stop-call |
| Live listen (audio) | Dashboard **Live Listen** (Admin/Developer roles) or the **Retell Web SDK** `listen()` in a browser over WebRTC using a *public* key from an allowed domain. **Not** available server-side. Take-over is irreversible. | https://docs.retellai.com/features/live-monitoring |
| Live monitor (text) | `wss://api.retellai.com/v2/monitor-call/{call_id}` streams transcript/tool/node events only, no audio; server auth needs an API key with *Call → Edit*; browser auth via public key; call must be `ongoing`; max 5 watchers per call (close `4008`). This is where `LiveCall.node` would come from. | https://docs.retellai.com/api-references/monitor-call-websocket |
| Recordings / transcripts | Stored **by us from the webhook payload**: `agent_calls.transcript` (text) and `agent_calls.recording_url` (Retell-hosted URL as delivered) — `retell-webhook.ts:582-601, 1013, 1126-1142`. No `get-call` fetch exists (`grep get-call` → none). `call_analysis` jsonb also stored. Retell's `GET /v2/get-call` additionally offers `transcript_object` (speaker turns with timestamps), `call_cost.combined_cost` (cents), `public_log_url`. | https://docs.retellai.com/api-references/get-call |

Recommendation for v1: `endCall=true` (Railway executes `stop-call`), `listen=false` with a "Open in Retell dashboard" link; text monitoring can be a later Railway→DB relay.

---

## 9. Worker liveness

**No heartbeat is persisted anywhere.** `scripts/run-workers.ts:167-170` runs a `setInterval` that only emits `logger.debug('[worker-host] heartbeat')` every `WORKER_HEARTBEAT_MS` (default 60 s). `BaseWorker` has a `healthCheck()` log (`base-worker.ts:280`) but no writer. "Worker is up" is known today only from Railway's own dashboard/logs and, indirectly, from `pipeline-health`'s stuck-load exceptions (`lib/pipeline/health-checks.ts:79`). `worker_heartbeats` — **NOT FOUND**.

---

## 10. Engine 3 isolation and protected files (baseline)

- `git grep evaluateAuthority|applyEnvelope -- lib/workers scripts/run-workers.ts` → **no hits**. Isolation holds today.
- Protected files to diff against in Phase 4: `lib/pipeline/retell-webhook.ts`, `lib/pipeline/negotiation-brief.ts` (brief schema), `lib/exceptions/detector.ts` (8 rules), Retell agent configs (dashboard only; `Engine 2/retell_config_*.jsx` are spec copies).

---

## 11. Observations that affect the build (not asked, but material)

1. **`agent_calls` is empty in production** while `personas.friendly.total_calls=1` and docs record a live call on 2026-06-06. Either the row never persisted or it was removed in the 2026-10-08 test-row cleanup. Every Calls-tab query will return nothing until Pilot 1 produces data; the UI's empty states will be exercised immediately.
2. **`CARRIER_CALLS_ENABLED` and `CARRIER_AUTO_ASSIGN_ENABLED` are read once in worker constructors.** Moving them to `getEngineConfig()` changes semantics from boot-time to per-job — desired, but it is a live-call-path edit to `carrier-voice-worker.ts` and `dispatcher-worker.ts` (E3-R1 review gate).
3. **`PIPELINE_ENABLED` is not read by 7 of the 10 workers.** "Pipeline off" today still drains qualify/research/match/brief/dispatch/feedback/carrier-brief. The Phase 1.2 "every worker's should-I-take-a-job check" is net-new behaviour for them, not a refactor.
4. `pipeline_loads` rows are in the mid-funnel (`briefed/matched/qualified/disqualified`) — a shadow drain never completed to `calling`; the funnel view will show zero past `briefed`.
5. `authority_envelopes.tenant_id` is `integer`, `tenants.id` is `bigint`; Neon returns bigint as string. Coerce (bit T-28 three times).
6. `exceptions.pipeline_load_id` references `pipeline_loads.id` (integer PK), not the `load_id` text key (root `CLAUDE.md` Known Issues). "Needs you" joins must use the PK.

---

## Conflicts with this prompt

1. **"Vercel copies of the kill switches are decorative" is wrong.** Vercel reads `PIPELINE_ENABLED`/`SCANNER_ENABLED` in the scan cron, health cron, feedback cron and the import route (§2). Ingestion is gated on Vercel; processing on Railway. Phase 1's "Railway is the authority" must still give those four Vercel sites a config read (or accept that ingestion stays env-gated), otherwise the UI's *scanner* toggle changes nothing.
2. **`MAX_CONCURRENT_CALLS` default is `'1'`, not `0`.** Unset ⇒ live dialing, not shadow (`voice-worker.ts:101`). The prompt's premise (safety "relies on `Number("") === 0`") understates it: the safe behaviour depends on the operator setting the variable at all. Fail-closed parsing is mandatory, not a cleanup.
3. **Compiler and Voice disagree on what "shadow" means** (`=== '0'` vs `<= 0`). The new reader must give both the same boolean.
4. **Queue list differs.** No `scan` queue; three extra queues (`carrier-call`, `shipper-confirmation`, `carrier-brief`); `callback-queue` and `escalation-queue` have **no consumer**. Consequence: the `schedule_callback` command and any "callback sweep" batch cannot be wired truthfully until a consumer exists → **hide `schedule_callback` in v1 or scope a consumer into Phase 1**. `retry_call` is wireable (re-add to `call-queue`).
5. **Roles.** There is no `viewer` JWT role; TMS roles are `admin|ops|sales`. Mapping proposal for sign-off: Engine Room `admin` ⇐ JWT `role='admin'`; Engine Room `viewer` ⇐ JWT `role in ('ops','sales')` **or** `tenant_users.role='viewer'`. Kevin currently has no account (all 7 tenant users are `admin`), so a viewer account must be created for Phase 4 test 5.
6. **Tenant context must come from the JWT**, not `getTenantContext()` headers, until `fix-tenant-header-bypass` merges (§1). Engine Room routes should call `getCurrentUser()` directly.
7. **`AUTO_BOOK_PROFIT_THRESHOLD` is already retired**; there is no `auto_book_enabled` flag to seed from. Auto-book today = webhook sets `auto_book_eligible` when the agreed rate clears `getMarginFloor()`; the Dispatcher acts on it. `auto_book_enabled`/`auto_book_min_margin_cad` would be a *new* gate inserted in the Dispatcher (live path), and `auto_book_min_margin_cad` duplicates `lib/tenants/margin-floor.ts` unless that becomes the reader.
8. **`calling_enabled` and `carrier_cascade_enabled` have no single env ancestor.** `calling_enabled` ⇐ `MAX_CONCURRENT_CALLS > 0`; `carrier_cascade_enabled` ⇐ `CARRIER_CALLS_ENABLED`. Seed must say so explicitly.
9. **No per-phone lock, per-day caps, spend cap, pacing, brake or calling-days logic exists on the shipper path.** Phase 1's config keys for those are new enforcement in `voice-worker.ts` (live path), not a relocation.
10. **`call_budget` and `v_pipeline_funnel_daily` do not exist** — nothing to migrate or fold in. T-17's views do exist and should be used.
11. **`LoadStage` in `types.ts` mixes a TMS status (`awaiting_signature`) with derived states** (`carrier_cascade`); neither is a `pipeline_loads.stage` value. Derive in the API layer (§5), keep the UI type.
12. **`CallDetail.emailReadBack` and `LiveCall.node` have no stored source.** `node` requires the monitor websocket (Railway relay); `emailReadBack` is **NOT FOUND** — show as unknown or drop.
13. **`Disagreement` has no table and `authority_evaluations` has 0 rows.** The E3 tab's disagreements/verdicts need a definition (and the verdict needs a column or table) before Phase 2 can return anything but `[]`.
14. **`end_call` is supported** (Retell `stop-call`), so the "only if Phase 0 proved it" condition is met. **Audio `listen` is not** wireable server-side; text monitoring is.
15. **Railway's current `MAX_CONCURRENT_CALLS` could not be read** (CLI unauthenticated). The seed step requires an operator read of Railway variables first.
16. **Prompt says E2-04 F1 "if not already built"** — it is built (`/api/loads/[id]/confirm-carrier-signature`); wrap it.
17. **Phase 1.2's "raise an Alert Center exception on config read failure"** is fine, but the current Alert Center query already returns 114 active cron exceptions; the Engine Room's "Needs you" must filter by `source_module`/`type` or it will bury the new ones.

**Stopped here, per the prompt. Awaiting approval before Phase 1.**
