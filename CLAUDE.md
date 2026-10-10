# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Docs ↔ code sync.** Last reconciled against `master` @ `41afeb6` on 2026-10-07. **Rule:** when a module, sprint, or migration lands, update the relevant tracker (`Engine 2/docs/superpowers/plans/completion.md` or `Engine 3/docs/superpowers/plans/completion.md`) **and** the status lines in this file and in `Engine 2/CLAUDE.md` / `Engine 3/CLAUDE.md` (there is no `MyraTMS/CLAUDE.md`) in the *same commit*. The trackers are the source of truth for progress; the implementation plans under `MyraTMS/docs/superpowers/plans/` are sequencing documents whose checkboxes are *not* maintained. Per-engine next steps live in `docs/next-steps/`.

## Repository Overview

MyraTMS is a freight brokerage Transportation Management System (TMS) built as a monorepo of five Next.js projects plus a standalone scraper, all sharing a single Neon PostgreSQL database and Upstash Redis instance. Only **MyraTMS** owns the API and the bulk of the schema; the other apps are pure clients (or static), and the scraper writes to a focused subset of tables.

- **MyraTMS/** — Main full-stack TMS application (admin/broker-facing). Hosts all backend API routes, DB migrations, the Engine 2 pipeline code (`lib/pipeline/`, `lib/workers/`, `lib/loadboards/`), every Engine 3 module (`lib/{governance,tenants,carriers,pricing,negotiation,dispatch,exceptions,risk,documents,finance,contract-intake}/`), and the Railway worker-host entry-point. Port 3000.
- **DApp/** — Driver progressive web app (mobile-first PWA). Communicates with MyraTMS API via Bearer token auth. `next.config.mjs` proxies `/api/*` to `NEXT_PUBLIC_API_URL` so the PWA can call the TMS without CORS. Port 3000.
- **One_pager tracking/** — Customer-facing shipment tracking page. Read-only, token-based access at `/track/[token]`. Since E2-04 M3 the same page also serves **confirm mode** (shipper rate-confirmation click-through) when the token is a confirmation token (live in production since the One_pager redeploy of 2026-10-09). Port 3002 (`next dev -p 3002`).
- **myra-landing/** — Marketing site. `next.config.ts` uses `output: 'export'` (static HTML), with content sourced from Sanity CMS (`@sanity/client`, `next-sanity`) plus JSON in `content/`. No DB or API.
- **Driver_App/** — Legacy driver app prototype (superseded by DApp). Port 3001. Not actively maintained.
- **scraper/** — Standalone TypeScript/Playwright headless scraper (DAT, Truckstop, 123LB, Loadlink). Not a Next.js app. Targets Railway, writes load-board rows into the shared Neon DB. See dedicated section below and `scraper/README.md`.
- **`Engine 2/`** — **Not a project.** Spec material (PRDs E2-01..E2-04, agent specs T02–T13, build plan, playbook) for the 7-agent acquisition pipeline **plus the sell-side loop** built on top of it. Status: deployed to production in shadow-drain mode; first live Retell call placed 2026-06-06; sell-side (E2-03 + E2-04) code-complete with every flag off. Has its own `CLAUDE.md`. Don't run anything from inside it.
- **`Engine 3/`** — **Not a project.** Master PRD + child specs T-17..T-30 for the "Autonomous Brokerage Operating System." Status: **T-17 through T-28 built and applied to production** (T-20 onward in shadow mode), **T-30 Tasks 1–11 merged to `master` 2026-10-09** (verified only on Neon `t30-verify`; migration 059 *not* applied to production; the `contract-intake-finalize` cron is held out of `vercel.json` until it is), **T-29 not started**. Code lives in `MyraTMS/`, not here. Has its own `CLAUDE.md`, `wave1.md` (T-18/T-19 outcomes), and the tracker at `docs/superpowers/plans/completion.md`.
- **`docs/`** — Repo-level architecture docs: `docs/architecture/` (multi-tenant ADRs, runbooks, `PRODUCTION_MIGRATION_LOG.md`), `docs/plans/` + `docs/superpowers/` (DApp, deployment, quoting, landing plans), `docs/next-steps/` (one brief per engine).
- **`_bmad/`** — BMAD agent framework tooling. Not a project; nothing here is deployed.

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **Package Manager:** pnpm
- **Styling:** TailwindCSS 4.x (`@import 'tailwindcss'` — no `tailwind.config.js`), CSS variables in `app/globals.css` using `oklch()` color space
- **Components:** Shadcn/UI (New York style, neutral base) + Radix UI primitives (MyraTMS, One_pager). DApp uses raw Tailwind + minimal Radix only.
- **Icons:** Lucide React
- **Data Fetching:** SWR (MyraTMS client-side), `driverFetch()` wrapper (DApp), fetch in API routes
- **Forms:** react-hook-form + Zod validation
- **Database:** Neon PostgreSQL (serverless) via `@neondatabase/serverless`
- **Auth:** JWT (`jsonwebtoken` + `bcryptjs`) with httpOnly cookies (MyraTMS) or localStorage Bearer tokens (DApp)
- **Cache:** Upstash Redis (`lib/redis.ts` — `getCached()`, `setCache()`, `invalidateCache()`)
- **Maps:** Mapbox GL (`mapbox-gl` + `react-map-gl`) in all 3 active apps
- **File Storage:** Vercel Blob
- **AI:** Two stacks. In-app assistant uses Vercel AI SDK v6 streaming with `xai/grok-3-mini-fast`. Engine 2/3 workers use the Anthropic SDK through `lib/pipeline/claude-service.ts` (default model `claude-sonnet-5`; do not call `@anthropic-ai/sdk` directly from workers).
- **Email:** nodemailer over IONOS SMTP (outbound); `imapflow` IMAP poller (inbound, E2-04 — never run against a real mailbox yet)
- **Voice:** Retell AI (shipper + carrier voice agents, webhook at `/api/webhooks/retell-callback`)
- **Testing:** Vitest (MyraTMS + scraper) — **see the production-DB warning under Build & Development Commands**
- **Queues:** BullMQ on ioredis (12 queues, 10 booted workers + scanner service)
- **Deployment:** Vercel for the four Next.js apps; Railway for the MyraTMS worker host (`scripts/run-workers.ts`) and the headless scraper. See Deployments.

## Build & Development Commands

All commands run from within each project directory:

```bash
pnpm install          # Install dependencies
pnpm run dev          # Start dev server
pnpm run build        # Production build (MyraTMS enforces TS; DApp does not)
pnpm run lint         # ESLint
pnpm run test         # Run tests (MyraTMS only, vitest)
pnpm run test:watch   # Watch mode tests (MyraTMS only)
```

**Running a single test (MyraTMS):**
```bash
cd MyraTMS
pnpm vitest run path/to/__tests__/foo.test.ts     # one file
pnpm vitest run -t "test name pattern"             # by name
pnpm vitest run --no-file-parallelism <file>       # when spawn/OOM errors appear (see Known Issues)
```

Test files live under `**/__tests__/**/*.test.ts` (configured in `vitest.config.ts`); 150 test files (1,390 tests: 1,367 pass, 20 skipped) as of 2026-10-09.

**Tests refuse the production Neon branch.** Since 2026-10-07, `vitest.setup.ts` + `lib/db/production-guard.ts` throw before any connection when `DATABASE_URL` contains the production branch/endpoint id (`br-rough-forest-aif4a3vf` / `ep-lively-shadow-aibzw8bp`); `ALLOW_PROD_TESTS=1` is the only escape hatch, for explicitly-confirmed post-apply verification runs. Most Engine 2/3 tests create and clean rows in real tables, so `.env.local` now points at the persistent **`dev-tests`** branch (`br-damp-river-ai21gg86`, cut from production 2026-10-07; migrations 059 + 060 applied there and not in production). Reset it from parent when it drifts. Quote the connection string when exporting it in a shell — it contains `&`. `tests/**/*.test.ts` is now included (the multi-tenant isolation suite had never run). Baseline 2026-10-07 on dev-tests: 849/864 → after fixes, only `ranker`/`researcher` remain environment-sensitive (N+1 scoring queries over HTTP; see their file headers); 5 `cost-calculator` assertions are quarantined with a reason (`test.skip`, spec-vs-code drift owned by the Engine 2 stream).

**Long-running processes (from `MyraTMS/`):**
```bash
pnpm tsx --env-file=.env.local scripts/run-workers.ts        # Engine 2 worker host (what Railway runs)
pnpm tsx --env-file=.env.local scripts/run-imap-poller.ts    # E2-04 inbound email poller (separate process; needs IMAP_* creds — never provisioned)
```

Database migrations are manual SQL scripts in `MyraTMS/scripts/` — run directly against Neon (`scripts/run-migration.ts` or `apply-0XX-*.ts` helpers; `verify-*.ts` scripts check them). No ORM. **Applying a migration to production is always a separate, explicitly-confirmed step** — never fold it into a build task.

## Environment Variables

**Required (MyraTMS app):**
- `DATABASE_URL` — Neon PostgreSQL connection string
- `JWT_SECRET` — For JWT signing/verification
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Upstash Redis (REST, app cache)
- `XAI_API_KEY` — For Grok/XAI model (in-app assistant)
- `BLOB_READ_WRITE_TOKEN` — For `@vercel/blob` document uploads
- `CRON_SECRET` — Bearer token every `/api/cron/*` route requires
- `PIPELINE_IMPORT_TOKEN` — Bearer token for `POST /api/pipeline/import`

**Required (Engine 2 workers / Railway):**
- `UPSTASH_REDIS_URL` (or `REDIS_URL`) — ioredis TCP URL for BullMQ (distinct from the REST pair above)
- `ANTHROPIC_API_KEY` — Researcher/Compiler/call parser via `claude-service.ts`
- `RETELL_API_KEY`, `RETELL_WEBHOOK_SECRET`, `RETELL_FROM_NUMBER`/`RETELL_FROM_NUMBERS`, `RETELL_WEBHOOK_URL`
- `TMS_API_URL` — base URL the Dispatcher uses to call existing TMS routes with a service token

**Kill switches (exact-match, `.trim().toLowerCase()`; a trailing newline in a Vercel/Railway value has silently defeated one before):**
- `PIPELINE_ENABLED` (master), `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS` (`0` = shadow mode), `CARRIER_CALLS_ENABLED`, `CARRIER_AUTO_ASSIGN_ENABLED`, `SHIPPER_CONFIRMATION_ENABLED`, `SHIPPER_DIRECT_GATE_ENABLED` (+ `SHIPPER_DIRECT_GATE_MODE` `shadow`|`enforce`, `SHIPPER_DIRECT_GATE_ENFORCED_AT` ISO timestamp — E2-01), `INBOUND_EMAIL_POLLING_ENABLED`, `SCRAPER_ENABLED` (scraper side). `AUTO_BOOK_PROFIT_THRESHOLD` is **retired** (T-19) — the margin floor lives in `lib/tenants/margin-floor.ts`.

**Required (DApp / One_pager):** `NEXT_PUBLIC_API_URL` — MyraTMS API base URL

**Optional:**
- `NEXT_PUBLIC_MAPBOX_TOKEN` — Enables real Mapbox maps (all 3 apps fall back gracefully without it)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` — Nodemailer (tracking emails, shipper rate confirmations)
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_POLL_INTERVAL_MS` — E2-04 inbound poller
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DRIVER_APP_URL`, `NEXT_PUBLIC_TRACKING_URL` — Production URLs for CORS + outbound links
- `DAT_API_KEY`, `TRUCKSTOP_API_KEY` — Load board integration (clients are still stubs)
- `FMCSA_API_KEY` — Carrier compliance verification
- `FMCSA_QC_WEBKEY` — E2-01 shipper-direct gate: FMCSA QCMobile lookups on poster-registry misses (missing key → miss goes to human review, fail closed)
- `DAT_SEL_CELL_MC`, `DAT_SEL_CELL_DOT` — scraper-side DAT selectors for the poster MC/DOT cells (E2-01)
- `SAMSARA_API_KEY`, `MOTIVE_API_KEY` — GPS tracking positions

## Architecture

### Database & Schema

Schema defined across migration scripts in `MyraTMS/scripts/`. Hyphenated names are feature migrations; underscored names (`027_…`) are the multi-tenant series and have paired `*_rollback.sql` files (058/059 also ship rollbacks).

| Script | Tables/Changes |
|--------|----------------|
| `001-create-tables.sql` | users, shippers, carriers, loads, invoices, documents, activity_notes, notifications, compliance_alerts |
| `002/003-seed-data.sql` | Sample data (003 is the corrected version) |
| `005-fix-auth.sql` | Auth schema fixes |
| `010-m1-migration.sql` | drivers, location_pings, load_events, check_calls, tracking_tokens, settings, workflows; adds lat/lng/tracking columns to loads |
| `011-seed-drivers.sql` | Seed driver accounts |
| `012-workflow-columns.sql` | Workflow column additions |
| `013-push-subscriptions.sql` | push_subscriptions |
| `014-carrier-matching-engine.sql` | carrier_equipment, carrier_lanes, match_results; adds home_lat/lng/city, communication_rating, overall_match_score to carriers |
| `020-quoting-engine.sql` | quotes, rate_cache, distance_cache, fuel_index, quote_corrections; integrations table |
| `021-check-call-reminder.sql` | Check-call reminder scheduling |
| `021-delivery-ratings-report-log.sql` | Delivery ratings + report execution log |
| `022-user-invites.sql` | User invitation tokens |
| `pipeline_migrations.sql` | Engine 2 baseline: `pipeline_loads`, `agent_calls`, `negotiation_briefs`, `consent_log`, `dnc_list`, `shipper_preferences`, `lane_stats`, `personas`, `agent_jobs` + columns on loads/carriers/shippers |
| `023-pipeline-schema-corrections.sql` | Engine 2: TEXT ids on `pipeline_loads`, drops a TMS FK that blocked match-before-book |
| `024-pipeline-brief-schema-corrections.sql` | Engine 2: `negotiation_briefs.top_carrier_id` → TEXT |
| `025-compliance-audit-table.sql` | Engine 2: `compliance_audit` — append-only consent + DNC audit |
| `026-loadboard-sources.sql` | Engine 2: `loadboard_sources` registry (shared by Vercel API path and the Railway scraper) |
| `027_multi_tenant_foundation.sql` | Multi-tenant M1: `tenants`, `tenant_users`, `is_super_admin` — **applied to production 2026-05-04** |
| `028_add_tenant_id.sql` | Multi-tenant: `tenant_id BIGINT` on 26 Category A tables — **applied 2026-05-04**. Engine 2 tables explicitly deferred to 030. |
| `029_create_rls_policies.sql` | Creates RLS policies but **does NOT enable them** — applied 2026-05-04; RLS still OFF (verified 2026-10-07) |
| `030_engine2_tenanting.sql.PENDING` | **Staged, not applied.** Adds `tenant_id` to all Engine 2 tables. Gated on Engine 2 stable in prod ≥24h. `pipeline_loads.tenant_id` confirmed absent 2026-10-07. |
| `031_tenant_usage.sql` | `tenant_usage` per-tenant metering — applied 2026-05-04 |
| `032-carrier-status-prospect.sql` | `carriers.carrier_status` (`prospect`/`active`) — FMCSA seed + Dispatcher prospect gate |
| `033-event-data-layer.sql` | Engine 3 T-17: `events` + 5 exception-safe triggers + 4 metric views |
| `034-agent-runtime-governance.sql` | Engine 3 T-18: `agents`, `authority_envelopes`, `authority_evaluations`, `escalations` |
| `035-t19-tenant-policy-model.sql` | Engine 3 T-19: `fn_myra_tenant_id()`, `tenants.freight_business_type`, `tenant_type_policy_templates`, `tenant_policies`, `co_broker_agreements` (see Known Issues: tenant-id mislabeling fix) |
| `040_shipper_direct_gate.sql` | Engine 2 E2-01 M1: shipper-direct hard gate — `poster_registry`, `authority_lookups`, load-source classification on `pipeline_loads` |
| `041-sellside-expansion-schema.sql` | Engine 2 E2-03 M0/M1/M4: `agent_calls.call_type` CHECK (`outbound_shipper`/`outbound_carrier`), carrier-outcome columns, `loads.carrier_cost_estimated` |
| `042-carrier-call-columns.sql` | Engine 2 E2-03 M2: `carrier_agreed_rate`/`carrier_outcome`/`carrier_profit` on `agent_calls` |
| `043-m3-m4-dispatch-gate.sql` | Engine 2 E2-03 M3/M4: rate-con dispatch gate + carrier verification columns |
| `044-t20-carrier-intelligence.sql` | Engine 3 T-20: `carrier_registry`, `carrier_outcome_events`, `carrier_risk_signals`, `myra_carrier_scores` |
| `045-t21-pricing-engine.sql` | Engine 3 T-21: `pricing_engine_requests` |
| `046-e2-04-sellside-loop-schema.sql` | Engine 2 E2-04: `inbound_emails`, confirmation token columns, `awaiting_shipper_confirmation`/`shipper_confirmed` stages, persona `call_type` split |
| `047-confirmation-token-expiry-tz-fix.sql` | Fix: `confirmation_token_expires_at` → TIMESTAMPTZ (real Neon driver tz bug) |
| `048-carrier-brief-column.sql` | E2-04 M5: `pipeline_loads.carrier_brief` |
| `049-e2-04-awaiting-signature-status.sql` | E2-04 M6: `loads.status` gains `'Awaiting Signature'` |
| `050-documents-type-check-shipper-ratecon.sql` | Fix: `documents_type_check` accepts shipper rate-con types |
| `051-carrier-signature-method.sql` | E2-04 review F1: carrier signature method/confirmer + manual override route |
| `052-t22-objection-playbook.sql` | Engine 3 T-22: `objection_playbook` |
| `053-t23-dispatch-lifecycle-monitor.sql` | Engine 3 T-23: `carrier_acceptance_state`, `dispatch_routing_rules`, `v_lifecycle_late_loads`, 2 lifecycle triggers |
| `054-t24-exception-classification-rules.sql` | Engine 3 T-24: `exception_classification_rules` (+ seed) |
| `055-t25-risk-fraud-scoring.sql` | Engine 3 T-25: `payer_registry`, `payer_credit_assessments`, `transaction_halts`, `carrier_banking_details`, `v_payer_concentration_exposure` |
| `056-t26-document-automation.sql` | Engine 3 T-26: `documents.parsed_terms`/`terms_match_status` + document/inbound-email lifecycle triggers |
| `057-t27-finance-orchestration.sql` | Engine 3 T-27: `financing_decisions`, `factoring_submissions`, `quick_pay_disbursements`, `kyc_verifications`, `v_float_exposure` |
| `058-t28-customer-os-onboarding.sql` (+rollback) | Engine 3 T-28: `tenant_onboarding_sessions` + go-live classification rule |
| `059-t30-contract-freight-intake.sql` (+rollback) | Engine 3 T-30: `contract_shipper_authorizations` + seeds the `contract_intake` classification rule — **NOT applied to production** (verified 2026-10-09). Apply only this post-merge version (the pre-merge master copy lacked the rule seed) |
| `060_harden_rls_policies.sql` | Multi-tenant M3 pre-req: rewrites all 30 policies with a `NULLIF(current_setting(...), '')` guard so a reused pooled connection returns zero rows instead of erroring — **applied to production 2026-10-08** |
| `061_app_role_grants.sql` | Multi-tenant M3 pre-req: grants for the non-BYPASSRLS app role `myra_app` — **applied to production 2026-10-08**. Migrations still run as `neondb_owner` |

Production state: everything through 058 is live, plus **060 + 061 applied 2026-10-08**; 059 is not; `pipeline_loads.tenant_id` does not exist; RLS is enabled on `tenant_audit_log` only (see PRODUCTION_MIGRATION_LOG.md Entry 2).

**Critical: snake_case vs camelCase mismatch.** DB columns are snake_case. API routes return raw Neon rows (snake_case). Frontend components must manually map fields. Canonical TypeScript interfaces are in `lib/types.ts` (camelCase) and `lib/mock-data.ts` (legacy camelCase).

**BIGINT columns come back as strings.** Neon returns `tenant_id`/`tenants.id` as strings; coerce before comparing (bit T-28 three times).

`lib/db.ts` exports `getDb()` (unauthenticated/global paths). Tenant-scoped reads/writes go through `withTenant()` / `asServiceAdmin()` in `lib/db/tenant-context.ts`. Two SQL patterns coexist — tagged template in API routes and `db.query(text, params)` via `lib/pipeline/db-adapter.ts` in workers/gate (Neon v1 quirk: `sql.query(text, params)` required); match the surrounding file.

### Auth System

Fully implemented JWT auth with RBAC:

- **`lib/auth.ts`** — `createToken()`, `verifyToken()`, `getCurrentUser(request)`, `requireRole()`, `requireSuperAdmin()`, `getTenantContext()`/`requireTenantContext()`, `hashPassword()`, `comparePassword()`
- **`middleware.ts`** — Route protection + CORS. Public paths: `/login`, `/api/auth/login`, `/api/auth/driver-login`. Tracking/confirmation paths bypass cookie auth (token-based). Driver JWTs restricted to `/api/drivers/me`, `/api/loads/`, `/api/auth/*`.
- **MyraTMS login** — JWT stored as `httpOnly` cookie `auth-token` (24h expiry)
- **DApp login** — Driver PIN auth via `/api/auth/driver-login`, JWT stored in `localStorage` as `driver-token`, sent as `Authorization: Bearer` header

### Multi-tenancy

Sessions 1–8 shipped the code; **migrations 027–031 were applied to production on 2026-05-04** (see `docs/architecture/PRODUCTION_MIGRATION_LOG.md` Entry 1, with LSN + Vercel deployment pins). Start at `docs/architecture/HANDOFF.md`; the index is `docs/architecture/INDEX.md`.

- **Phase status (ADR-004):** M1 foundation ✅ production · M2 app code ✅ production · **M3 RLS enable 🟡 Day 1 of 12 done** (`tenant_audit_log` enabled 2026-10-08; 060 + 061 applied; Vercel on `myra_app`, Railway not yet) · M4 drop-default/strict JWT ⬜ · **M5 Engine 2 tenanting (migration 030) ⬜ not started**.
- **JWT shape** — Tokens carry `tenant_id` (from `tenant_users`) and `is_super_admin` (from `users`). Super-admin bypasses tenant scoping for cross-tenant admin actions only.
- **Scoping mechanism** — Application-layer: every query touching a Category A table must go through `withTenant()` or carry `WHERE tenant_id = $1`. **RLS policies exist (029, hardened by 060) and are enabled on `tenant_audit_log` only.** For the other 29 tables, do not assume the DB will catch a missing tenant filter.
- **Engine 2 tables are still single-tenant** (no `tenant_id`). Don't convert pipeline paths pre-emptively; use the staged `030_….PENDING` file when the time comes.
- **Feature gating (`lib/features/`)** — plan limits → tenant overrides → user role. Server-side: `requireFeature()` in a few routes plus `lib/features/route-gate.ts`; page shells: `components/feature-gate.tsx` (both merged from `platform-ui-gaps` 2026-10-09).
- **Usage tracking (`lib/usage/`)** — writes to `tenant_usage`.
- **Admin surface** — `app/api/admin/**` and `app/admin/**` are super-admin-only. **Tenant provisioning is now shared code**: `lib/tenants/provision.ts` (T-28) backs both the admin routes and the `app/api/tenant-onboarding/*` flow.

### API Routes

REST conventions under `MyraTMS/app/api/`:
- Collection: `app/api/[resource]/route.ts` (GET list, POST create)
- Item: `app/api/[resource]/[id]/route.ts` (GET one, PATCH update)
- Parameters via `req.nextUrl.searchParams`; responses via `NextResponse.json()`
- Error helper: `apiError(message, status)` from `lib/api-error.ts`
- ID generation: `LD-${Date.now().toString(36).toUpperCase()}` for loads, `DOC-` for documents, `CAR-` for carriers, `SHP-` for shippers

Route groups (under `MyraTMS/app/api/`), by owner:
- **TMS core:** `admin`, `ai`, `auth`, `carriers`, `check-calls`, `compliance`, `cron`, `dispatch`, `documents`, `drivers`, `exceptions`, `finance`, `fuel-index`, `health`, `import`, `integrations`, `invoices`, `loadboard`, `loads`, `matching`, `me`, `notes`, `notifications`, `push`, `quotes`, `rate`, `rates`, `settings`, `shippers`, `tenants`, `tracking`, `workflows`
- **Engine 2:** `pipeline` (operator surface, import), `loadboard-sources` (ingest registry), `webhooks` (Retell), `confirmations/[token]` (E2-04 shipper confirm actions), `loads/[id]/confirm-carrier-signature` (E2-04 F1 manual override)
- **Engine 3:** `events`, `metrics/*` (T-17) · `agents`, `evaluations`, `escalations` (T-18) · `carriers/registry` (T-20) · `pricing` (T-21) · `negotiation` (T-22) · `lifecycle`, `dispatch/routing` (T-23) · `exceptions/classification-rules`, `exceptions/sla-breaches`, `cron/exception-bridge` (T-24) · `risk/*` (T-25) · `documents/{rate-con,terms-mismatches,intake-match-report}` (T-26) · `finance/*` (T-27) · `tenant-onboarding/*`, `tenants/[id]/onboarding-status` (T-28)

Notes:
- `rate/` (singular) and `rates/` (plural with `[token]` and `import` sub-routes) are intentionally separate.
- `loadboard/` is the broker-facing CRUD; `loadboard-sources/` is the Engine 2 ingest registry shared with the Railway scraper.
- `health/` is `/api/health` for uptime checks.
- Several Engine 3 routes had tenant-isolation IDORs caught in review (T-22, T-23, T-26, T-27). Every new route that takes an id must scope it by tenant.

### Cron Jobs

Configured in `MyraTMS/vercel.json`; all require `Authorization: Bearer $CRON_SECRET`, pipeline ones also require `PIPELINE_ENABLED=true`.

| Schedule | Route | Purpose |
|----------|-------|---------|
| `0 2 * * *` | `/api/cron/fmcsa-reverify` | Carrier compliance re-verification — **never executed (405), intentionally parked; see Known Issues** |
| `0 8 * * *` | `/api/cron/invoice-alerts` | Invoice payment reminders — **never executed (405), intentionally parked** |
| `0 12 * * *` | `/api/cron/exception-detect` | Proactive load exception detection (8 rules, `lib/exceptions/detector.ts`) |
| `0 6 1 * *` | `/api/cron/shipper-reports` | Monthly shipper performance reports — **never executed (405), intentionally parked** |
| `0 10 * * *` | `/api/cron/pipeline-scan` | Engine 2: per-source API poll (only sources with `ingest_method='api'`) |
| `0 11 * * *` | `/api/cron/pipeline-health` | Engine 2: stuck-job + dead-letter + E2-03 M5 sell-side health checks (`lib/pipeline/health-checks.ts`) |
| `0 7 * * *` | `/api/cron/feedback-aggregation` | Engine 2: lane_stats aggregation + persona α/β refresh |
| `0 13 * * *` | `/api/cron/exception-bridge` | Engine 3 T-24: bridges lifecycle-late / carrier-risk / stage-escalated / dead-letter signals into `exceptions` |
| *(held)* | `/api/cron/contract-intake-finalize` | Engine 3 T-30: books `matched` email-tender loads (`finalizeMatchedTenders()`). Route merged 2026-10-09 and listed in middleware `SELF_AUTHENTICATING_PATHS`; **schedule deliberately absent from `vercel.json`** until migration 059 is applied (no kill switch) |

**T-30 cron held (2026-10-09):** `contract-intake-finalize` was removed from `vercel.json` on purpose — `finalizeMatchedTenders()` has no kill switch and migration 059 is not applied to production. Re-add `{"path":"/api/cron/contract-intake-finalize","schedule":"0 14 * * *"}` only in the same change that records the 059 apply.

Crons run on Vercel. Engine 2 *workers* do not — they run on Railway. `lib/cron/cron-handlers.ts` is **dead code** (no cron route imports it).

**Three of these have never executed.** `fmcsa-reverify`, `invoice-alerts` and `shipper-reports` export `POST` only and read `x-cron-secret`, while Vercel sends `GET` + `Authorization: Bearer $CRON_SECRET` — Next answers 405 before the handler. See Known Issues; do not assume their effects have happened.

### Carrier Matching Engine

`lib/matching/` — AI-powered carrier scoring with 5 weighted criteria:

| Criterion | Weight | Source |
|-----------|--------|--------|
| Lane Familiarity | 30% | `scoring/lane-familiarity.ts` — historical loads on same lane |
| Proximity | 25% | `scoring/proximity.ts` — driver GPS distance to pickup (haversine) |
| Rate | 20% | `scoring/rate.ts` — carrier avg rate vs target |
| Reliability | 15% | `scoring/reliability.ts` — on-time % + communication rating |
| Relationship | 10% | `scoring/relationship.ts` — recency and frequency |

- `filters.ts` — Hard filter: equipment type match + active/insured status
- `grades.ts` — Letter grades: A (0.80-1.0), B (0.60-0.79), C (0.40-0.59), D (0.20-0.39), F (0.0-0.19)
- `index.ts` — `matchCarriers()` orchestrator, `storeMatchResults()` audit trail (note: `match_results.load_id` holds `pipeline_loads.load_id` for pipeline-sourced matches, and `was_selected` is never set true — found by T-20)
- API: `/api/loads/[id]/match` (POST), `/api/loads/[id]/assign` (POST), `/api/loads/bulk-match` (POST), `/api/carriers/[id]/rate` (POST), `/api/matching/refresh-lanes` (POST)
- T-20's `lib/carriers/shadow-ranking.ts` computes a parallel Myra Carrier Score ranking in shadow mode; the Ranker worker still uses this engine.

### Bulk Import System

`lib/import/` + `app/api/import/` + `app/settings/import/page.tsx` — CSV import of carriers, shippers, loads via `papaparse`; routes `/api/import/template/[type]`, `/api/import/validate`, `/api/import/execute`; 5-step UI wizard.

### Quoting Engine

`lib/quoting/` — Rate estimation: `geo/distance-service.ts`, `geo/region-mapper.ts`, `rates/benchmark.ts`, `rates/fuel-index.ts`, `lib/rates/ai-estimator.ts`. Tables from migration 020. API: `/api/quotes`, `/api/rates/*`. Engine 3's T-21 `lib/pricing/` wraps this cascade (`rate-cascade.ts`) rather than replacing it. `lib/geo/distance-service.ts` duplicates `lib/quoting/geo/distance-service.ts` (known drift, HANDOFF §4).

### Engine 2 AI Pipeline (acquisition + sell-side) — deployed, shadow-drain mode

BullMQ pipeline that scans load boards, qualifies/researches/ranks, compiles a negotiation brief, places Retell shipper calls, and — since E2-03/E2-04 — gets written shipper confirmation, calls carriers in a cascade, waits for a signed rate-con, then dispatches and feeds outcomes back into scoring.

**Status (2026-10-09):** Vercel is live. **Railway is not** — `myratms-workers` was deployed 2026-06-04 and 🔴 **has had no deployment since 2026-06-06** (verified 2026-10-09; see Known Issues), so there is currently no Engine 2 worker process in production at all; Phase 6A shadow drain proved the acquisition pipeline end-to-end; **first live Retell call 2026-06-06** (to the operator's own number). Phase 6B (10 consenting test shippers) has **not** run. Sell-side loop is code-complete and merged (E2-04 review PR #2), but **no carrier has ever been called in production** — `CARRIER_CALLS_ENABLED`, `CARRIER_AUTO_ASSIGN_ENABLED`, `SHIPPER_CONFIRMATION_ENABLED`, `INBOUND_EMAIL_POLLING_ENABLED` are all off and IMAP credentials were never provisioned. Full detail: `Engine 2/docs/superpowers/plans/completion.md` (Change Log + Production Ship Roadmap).

**Where the code lives (in `MyraTMS/`, not in `Engine 2/`):**
- `lib/pipeline/` — `stages.ts` (17 stages; `matched → booked` added by T-30 for email tenders), `queues.ts` (12 queues), `gate.ts`, `payloads.ts`, `claude-service.ts`, `compliance-service.ts`, `cost-calculator.ts`, `negotiation-brief.ts`, `retell-webhook.ts`, `redis-bullmq.ts`, `db-adapter.ts`, `service-token.ts`, `carrier-cascade.ts` (`decideCascadeAction()` state machine), `carrier-locks.ts`, `load-source-classifier.ts` (E2-01), `health-checks.ts` (M5), `time.ts` (calling-hours), `persona-selector.ts`, `objection-playbook.ts`, `benchmark-rates.ts`.
- `lib/workers/` — `base-worker.ts` + 11 workers: `scanner` (service, invoked by cron/import), `qualifier`, `researcher`, `ranker`, `compiler`, `voice`, `dispatcher`, `feedback`, plus sell-side `shipper-confirmation-worker`, `carrier-brief-compiler-worker`, `carrier-voice-worker`. `scripts/run-workers.ts` boots the 10 consumers on one ioredis connection.
- `lib/dispatch-gate.ts` (M3/M6: Dispatched only after signed rate-con; `completeDispatchOnSignedRateCon()`), `lib/confirmation-actions.ts` + `app/api/confirmations/[token]` (M3), `lib/shipper-rate-confirmation.ts` (shipper PDF) vs `lib/rate-confirmation.ts` (carrier PDF), `lib/email/{imap-poller,inbound-classifier}.ts` + `scripts/run-imap-poller.ts` (M4, separate process), `lib/verification/` (M4 carrier verification / authority lookup).
- `lib/loadboards/` — official-API clients (all stubs) + `loadboard_sources` registry. `lib/cron/` — dead code (see Cron Jobs).
- `scripts/sprint6-shadow/` — 7 operator scripts + runbook. `scripts/e2_backfill_load_source.ts`, `e2_seed_poster_registry.ts` (E2-01). `scripts/verify-04x-*.ts` migration verifiers.

**Stage machine:** `scanned → qualified → (researched ‖ matched) → matched → briefed → calling → booked → awaiting_shipper_confirmation → shipper_confirmed → dispatched → delivered → scored`; side stages `disqualified`, `declined`, `escalated`, `expired`, `callback`. `booked → dispatched` directly is still legal for the legacy path; `matched → booked` is T-30 only.

**Critical:**
- `Engine 2/` is **spec material only.** Do not re-copy its `.ts` files into `MyraTMS/`.
- `Engine 2/docs/superpowers/plans/completion.md` is the live tracker — keep it in sync as tasks finish; do not batch.
- Workers run on **Railway**, crons on **Vercel**; they share the same Upstash Redis and Neon DB.
- `lib/pipeline/redis-bullmq.ts` (ioredis TCP) and `lib/redis.ts` (Upstash REST) must coexist — BullMQ needs a real socket.
- The Dispatcher refuses to dispatch to `carrier_status='prospect'` carriers and escalates instead. Preserve this gate.
- Any change to `voice-worker`, `carrier-voice-worker`, `retell-webhook`, `compiler-worker`, `dispatcher-worker`, or `dispatch-gate` is a live-call-path change and needs human review (risk E3-R1).

### Engine 3 Autonomous Ops Layer — T-17..T-28 in production (shadow), T-30 merged (cron held, 059 unapplied), T-29 not started

Engine 3 wraps Engine 2 as a service: event layer, agent governance, tenant policy, carrier intelligence, pricing, negotiation, lifecycle monitoring, exception engine, risk/fraud, document automation, finance orchestration, customer onboarding. Phase 1 (T-17–T-19) shipped 2026-08-25. Phase 2 (T-20–T-26), Phase 3 (T-27) and Phase 4's T-28 were built and applied to production between 2026-08-26 and 2026-08-31, **all in shadow mode and all ahead of the master PRD §9 handoff gate at Patrice's explicit direction.** The gate itself (Pilot 1 green, real call volume) is still unmet, and so is Phase 2's own exit gate (100 consecutive zero-touch loads). Every "held open" acceptance criterion across these modules is waiting on real dispatch/call volume, not on code.

**Where the code lives (in `MyraTMS/`):**
- T-17 `app/api/events`, `app/api/metrics/*`, `scripts/t17_backfill_events.ts`; triggers in migration 033.
- T-18 `lib/governance/` (`applyEnvelope()`/`evaluateAuthority()`), `app/api/{agents,evaluations,escalations}/`, `scripts/t18_*.ts`.
- T-19 `lib/governance/evaluate-policy*.ts` (`evaluatePolicy()` — built, tested, **still not wired into Qualifier/Compiler/Dispatcher**), `lib/tenants/margin-floor.ts`, `lib/tenants/get-myra-tenant-id.ts`.
- T-20 `lib/carriers/` (`carrier-score.ts`, `shadow-ranking.ts`), `app/api/carriers/registry/`, `scripts/t20_*.ts`.
- T-21 `lib/pricing/` (`quotePricing()`), `app/api/pricing/`, `scripts/t21_shadow_parity_harness.ts`.
- T-22 `lib/negotiation/` (`compileEnvelope()`, both directions), `app/api/negotiation/`, `scripts/t22_shadow_parity_{sell,buy}.ts`.
- T-23 `lib/dispatch/routing.ts`, `app/api/lifecycle/`, `app/api/dispatch/routing/`, `scripts/t23_*.ts`.
- T-24 `lib/exceptions/bridge.ts` (`bridgeToExceptions()` + 4 pollers), `lib/exceptions/classification-rules.ts`, `app/api/exceptions/{classification-rules,sla-breaches}`, `app/api/cron/exception-bridge`. No new UI — the existing Alert Center is the console.
- T-25 `lib/risk/` (`payer-credit`, `carrier-risk-scoring`, `banking-change-detection`, `double-broker-crosscheck`), `app/api/risk/*`, `scripts/t25_reconcile_payer_registry.ts`.
- T-26 `lib/documents/rate-con-terms.ts` (Claude PDF term extraction + comparison, wired into the IMAP poller's `shipper_reply` branch), `app/api/documents/{rate-con,terms-mismatches,intake-match-report}`.
- T-27 `lib/finance/` (`routing.ts` `decideRoute()`, `credit-lookup`, `float-governor`, `capital-days`, `factoring-sync`, `treasury-report`, `adapters/{ecapital,stripe,persona}.ts` — **sandbox-only**), `app/api/finance/*`.
- T-28 `lib/tenants/provision.ts`, `lib/tenants/onboarding-session.ts`, `app/api/tenant-onboarding/*`, go-live approval via `PATCH /api/exceptions/[id]`.
- T-30 (Tasks 1–11 merged to `master` 2026-10-09; **059 not applied, finalize cron held**) `lib/contract-intake/{authorization,validate-rate,finalize-booking}.ts`, `lib/documents/tender-terms.ts`, IMAP-poller tender branch, `bridge.ts` `contract_intake` source, approve/reject branch on `PATCH /api/exceptions/[id]` (the only `pipeline_loads` insertion point), `app/api/contract-intake/pending`, `app/api/tenants/[id]/contract-shippers`, `app/api/cron/contract-intake-finalize`, `stages.ts` `matched → booked`, migration 059 (**unapplied to production**). Verified only on `t30-verify`; needs the E2-04 IMAP poller, which has never run against a real mailbox. Remaining (Task 12): the separately-confirmed production apply of 059, then re-adding the `contract-intake-finalize` schedule to `vercel.json`.

**Critical:** Read `Engine 3/wave1.md` before touching T-17/T-18/T-19 code, and the module's entry in `Engine 3/docs/superpowers/plans/completion.md` before touching any other Engine 3 module — each records real schema-reality corrections (tenant_id BIGINT vs INTEGER, TEXT vs INTEGER PKs, timestamptz casts) and real bugs (IDORs in T-22/T-23/T-26/T-27, test-row leaks) that a fresh session would otherwise re-hit. Engine 3 modules **do not edit Engine 2 live-path files**; T-30's one-line `stages.ts` change is the only exception to date. `completion.md` is the living tracker — update per module, don't batch.

### Headless Scraper (`scraper/`)

Standalone sibling project — not part of the MyraTMS workspace, not deployed on Vercel. Bridge layer until official load-board APIs land. Playwright + stealth, BullMQ, ioredis, raw `pg`. DAT adapter complete; Truckstop/123LB/Loadlink are stubs. Writes `pipeline_loads` with `created_by='scraper-v1'` and enqueues the exact `QualifyJobPayload`. Checks `loadboard_sources` before every poll and fails closed. **Railway deploy not recorded** (Engine 2 roadmap A.3.3 still open); the registry has `dat='scrape'`. Build/test: `pnpm build`, `pnpm dev`, `pnpm test`; `pnpm dat:manual-login`; `pnpm migrate`.

### AI Integration — Three Patterns

1. **Streaming chat** (`app/api/ai/chat/route.ts`): `streamText` + tools (`lookupLoad`, `searchLoads`, `getFinanceSummary`, `lookupCarrier`). Frontend: `components/ai-assistant.tsx` using `useChat`.
2. **Structured output** (`app/api/ai/analyze-risk/route.ts`): `generateText` + `Output.object()` for JSON risk analysis.
3. **Pipeline Claude service** (`lib/pipeline/claude-service.ts`): Anthropic SDK wrapper with retry, Zod structured parsing, token budgets; used by Researcher (rate Source 5), Compiler, call parser, T-26 term extraction.

### Data Fetching — SWR Hooks

`lib/api.ts` exports SWR hooks and mutation helpers for all resources. Cache invalidation: `mutate((key) => key.startsWith("/api/resource"), undefined, { revalidate: true })`.

### DApp (Driver PWA) Architecture

- **Single-page shell** (`app/page.tsx`) with tab navigation via `BottomNav`: map, active load, loads list, docs, profile
- **MapScreen** always mounted (hidden not unmounted); imperative `mapbox-gl` API
- **GPS tracking:** `useGPS` hook pings `POST /api/loads/[id]/location` while in-transit
- **Status flow:** internal statuses (`en_route_pickup`, `at_pickup`, `loaded`, `en_route_delivery`, `at_delivery`, `delivered`) mapped to TMS statuses on PATCH
- **POD capture** with Vercel Blob upload; **PWA** via `useServiceWorker` + `public/manifest.json`
- **No SWR, no Shadcn** — `driverFetch()` wrapper and raw Tailwind
- Components: `eta-pill`, `fab-menu`, `request-load`, `slide-to-confirm`, `status-stepper`; hooks `use-eta`; lib `haptics.ts`; join flow `app/join/[token]/page.tsx`

### Notable lib Modules

- `lib/email.ts` — `sendTrackingEmail()` via nodemailer (no-ops without SMTP); `lib/email-templates/` React Email templates
- `lib/email/` — E2-04 inbound: `imap-poller.ts` (injected-client design, testable without a mailbox), `inbound-classifier.ts`
- `lib/sse.ts`, `lib/eta.ts`, `lib/workflow-engine.ts`, `lib/push-notify.ts`, `lib/escape-like.ts`, `lib/sanitize-csv.ts`, `lib/logger.ts` (Pino, shared by API + workers)
- `lib/exceptions/` — `detector.ts` (8 live rules, the TMS Exception Detection Engine), `bridge.ts` + `classification-rules.ts` (T-24)
- `lib/documents.ts` + `lib/documents/rate-con-terms.ts` — document CRUD + T-26 term extraction
- `lib/dispatch-gate.ts`, `lib/confirmation-actions.ts`, `lib/shipper-rate-confirmation.ts`, `lib/rate-confirmation.ts`, `lib/rating-token.ts` — sell-side loop
- `lib/verification/` — carrier verification + FMCSA authority lookup (E2-03 M4)
- `lib/tenants/` — tenant lookup, margin floor, Myra tenant-id resolver, config schema/defaults/validators, **provision.ts + onboarding-session.ts** (T-28)
- `lib/features/`, `lib/usage/`, `lib/blob/`, `lib/crypto/`, `lib/geo/`, `lib/db/tenant-context.ts` (`withTenant`, `asServiceAdmin`, `forEachActiveTenant`)
- `lib/governance/`, `lib/carriers/`, `lib/pricing/`, `lib/negotiation/`, `lib/dispatch/`, `lib/risk/`, `lib/finance/`, `lib/contract-intake/` — Engine 3 (see above)
- `lib/test-utils/` — `cross-tenant-leak.ts` audit helper

## Key Conventions

**Path alias:** `@/*` maps to project root.

**Component patterns:** `"use client"` for interactive components; Shadcn/UI in `components/ui/` (`npx shadcn@latest add <component>` from `MyraTMS/`); business components in `components/` root; carrier matching UI in `components/carrier-matching/`.

**Naming:** Files kebab-case. Components PascalCase. Hooks `use*` in `hooks/`.

**Two toast systems (MyraTMS):** `sonner` (imperative) in business components; `useToast` (Shadcn/Radix) is older. Don't mix in one component.

**Theming:** Dark/light via `next-themes` + CSS variables. Fonts: Inter (sans), JetBrains Mono (mono). DApp uses Inter + Geist Mono.

**Maps:** Mapbox GL with `next/dynamic` SSR-disabled wrappers; graceful fallback without `NEXT_PUBLIC_MAPBOX_TOKEN`.

**Engine 2/3 build discipline (every module since T-17 followed this):** design doc with schema-reality corrections → implementation plan → build on a disposable Neon branch (`tXX-verify`) → tracker entry with acceptance-criteria status (PASS / OPEN with reason) → production apply as a separate explicitly-confirmed step → push as a separate explicitly-confirmed step. Never hardcode a tenant id (`fn_myra_tenant_id()` / `getMyraTenantId()`). Workers extend `BaseWorker`. Kill switches use exact-match `.trim().toLowerCase()`.

**Session hygiene:** open Claude Code sessions from the `M1/` root — sessions launched from a subdirectory (e.g. `Engine 3/`) cannot Read/Edit files in sibling directories and must fall back to shell commands.

## Build Strictness by Project

| Project | `ignoreBuildErrors` | `images.unoptimized` |
|---------|--------------------|--------------------|
| MyraTMS | `false` (strict) | `false` (optimized) |
| DApp | `true` (relaxed) | `true` (unoptimized) |
| One_pager tracking | `false` (strict) | `false` (optimized) |

## Deployments

### Vercel (Next.js apps + crons)

| Project | Vercel Project Name | Notes |
|---------|--------------------|-------|
| MyraTMS | `myratms` (`prj_gb8g00RfVeJeoujrLVPhchm8maN4`) | Production. API routes, 8 scheduled crons (T-30's 9th held), admin/broker UI. Node 24.x. |
| DApp | `myra-driver-app` | https://myra-driver-app.vercel.app |
| One_pager tracking | `v0-enterprise-logistic-one-pager` | https://v0-enterprise-logistic-one-pager.vercel.app |
| myra-landing | `myra-landing` | https://myra-landing.vercel.app — static export |

Neon project `lingering-bar-21372774` (MyraM1); production branch `br-rough-forest-aif4a3vf`; staging branch `br-twilight-wildflower-aidj2s93`.

### Railway (long-running processes)

| Service | Start command | Status |
|---------|---------------|--------|
| `myratms-workers` (project `149aa93e-…`) | `pnpm tsx scripts/run-workers.ts` via `railway.json` (NIXPACKS, ON_FAILURE ×5) | 🔴 **NOT RUNNING since 2026-06-06** — service instance has `latestDeployment = None` and no `source.repo`/`source.image`; all 10 deployments are `REMOVED`. Verified 2026-10-09 with an authenticated Railway CLI. See Known Issues. |
| Headless scraper | Dockerfile in `scraper/` | Deploy not recorded (roadmap A.3.3 open) |
| IMAP poller | `pnpm tsx scripts/run-imap-poller.ts` | **Not deployed; no IMAP credentials** — required before E2-04 M4/M6 or T-30's email-intake path can run for real |

Cross-app linking: `NEXT_PUBLIC_API_URL` (DApp, One_pager → MyraTMS API) and `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_DRIVER_APP_URL` / `NEXT_PUBLIC_TRACKING_URL` (MyraTMS → other apps for outbound links and CORS allowlist).

## Known Issues

- **`middleware.ts` had never run in production, and that made tenant context forgeable** (found 2026-10-08; **both layers deployed and verified live 2026-10-09** — see `docs/architecture/PRODUCTION_MIGRATION_LOG.md` Entry 3. The forged-header request was confirmed still returning HTTP 200 with real rows minutes before the deploy, and 401 after). The `config.matcher` had two independent bugs — an unbalanced trailing paren that became a *literal* `)` in the compiled regex, and `"\."` in a double-quoted TS string, which is not an escape and collapses to `.`, so `.*..*` made the negative lookahead reject every path. Compiling the exported matcher with Next's own `getMiddlewareMatchers` matches **no path at all**; fixing only the paren still matches nothing (both re-verified 2026-10-09). Consequences, both verified: (1) `getTenantContext()` read `x-myra-tenant-id` off the request, trusting middleware to overwrite it, so `curl -H "x-myra-tenant-id: 2" /api/loads` returned another tenant's rows **with no credentials** — confirmed live, HTTP 200; (2) the driver-JWT path restriction exists *only* in middleware, and `/api/shippers`, `/api/carriers`, `/api/invoices` have no role check of their own, so a driver token reaches all of them. **The fix is two layers on two branches — do not conflate them:**
  - **Layer 1, `fix-tenant-header-bypass` (GATE 0, merged to `master` and pushed 2026-10-09):** `getTenantContext()` derives tenant context from the signed JWT and never from headers. This closes consequence (1) on its own, whether or not middleware ever runs. **No behavioural change for any real caller** — re-grepped 2026-10-09: nothing in `app/`, `lib/`, `components/`, `scripts/`, `DApp/` or `One_pager tracking/` reads an `x-myra-*` header.
  - **Layer 2, `middleware-enable-gate4` (merged to `master` 2026-10-09 at the operator's explicit direction, ahead of the Gate 4 schedule GATE-0 assigned it to — middleware is now LIVE):** the matcher fix plus the bypass lists that make turning middleware on survivable. Only this layer closes consequence (2). Turning middleware on is a one-way door: every path it sees is now subject to `verifyJwtEdge()`. It adds `SELF_AUTHENTICATING_PATHS` (8 `/api/cron/*` on `CRON_SECRET`, `/api/pipeline/import` on `PIPELINE_IMPORT_TOKEN`, `/api/webhooks/retell-callback` on HMAC, `/api/health` as a deliberate anonymous liveness probe), narrows the bare `/api/tracking/` bypass (which also bypassed `positions` and `checkcall`, neither token-in-path), allowlists the three public `/api/confirmations/[token]` shapes without bypassing the authenticated `/verbal` override, narrows the driver allowlist from `startsWith("/api/loads/")` (whose blast radius included `/api/loads/<id>/{assign,match}`, neither role-checked), moves JWT signature verification out of the `/api/` branch (page routes passed on the mere *presence* of an `auth-token` cookie), and **strips** the four `x-myra-*` headers instead of injecting them. Four test files back it (175 tests), including one that compiles the real exported matcher and one that re-derives the cron and `app/api/loads/*` route lists from disk so a new route fails the test until it is classified. The compiled matcher was also read back out of `.next/server/middleware-manifest.json` to confirm it matches `/api/*` and page routes and skips `_next/static`. **If a bypass-list entry turns out to be wrong, the symptom is a 401 on a cron, the Retell webhook or a shipper confirmation link** — check those first after any middleware change. All of those were verified against production after the deploy (Entry 3 has the table). The discriminator to reuse: middleware's own rejection body is capitalised `{"error":"Unauthorized"}`, so a 405 or a lowercase `unauthorized` proves the request reached the route instead of being intercepted.
- **🔴 Three crons have never executed** (found 2026-10-08, deliberately still unfixed). `/api/cron/fmcsa-reverify`, `/api/cron/invoice-alerts` and `/api/cron/shipper-reports` are registered in `vercel.json` but export **`POST` only** and read **`x-cron-secret`**, while a Vercel cron invocation is `GET` + `Authorization: Bearer $CRON_SECRET`. Next answers 405 from the router before any handler code, so neither mismatch is reachable to fix the other. Treat their effects as never having happened — no FMCSA re-verification, no invoice reminders, no monthly shipper reports have ever been sent. **Deliberately not fixed:** switching them on starts live FMCSA API traffic and real outbound email to external shippers, retroactive over everything that has aged since. Operator decision. The five crons that *do* work (`exception-bridge`, `exception-detect`, `feedback-aggregation`, `pipeline-health`, `pipeline-scan`) export `GET` and read `authorization`; match that shape. Documented in-file on `middleware-enable-gate4`, which also hardens all three credential checks to fail closed (an unset `CRON_SECRET` used to skip the check entirely).
- **`/api/documents` had no role scoping** (found 2026-10-08; fixed 2026-10-09 in the same commit that enabled middleware). Its filter requires *both* `relatedTo` and `relatedType`, but `DApp/components/docs-screen.tsx` sends `relatedType=Load` alone, so the handler falls through to an unscoped `SELECT * FROM documents` for the whole tenant — carrier rate cons, invoices and signed shipper rate cons included. It was never live, only because middleware — which is what grants a driver token this path — did not run; enabling middleware and scoping the handler had to be the same commit. The fix belongs in the handler, not the allowlist: an allowlist decides *reachability*, never *rows*.
- **🔴 The Railway worker host has not existed since 2026-06-06, because THE RAILWAY TRIAL EXPIRED** (found 2026-10-09, the first session with an authenticated Railway CLI). `railway up` fails with **"Your trial has expired. Please select a plan to continue using Railway."** before any build starts. **The fix is billing, not engineering** — select a plan for workspace `e58a63c4-4da2-4e65-8cfa-b6402883ec8a`; until then nothing can deploy, not the CLI, not the UI, not a GitHub push. The API still authenticates and all 27 environment variables are readable and intact. The symptoms below are what Railway does to a lapsed trial — it removes running deployments and detaches the build source while preserving the project, service and variables — not evidence of a deliberate teardown. `railway status --json` reports `latestDeployment = None`, `source.repo = None` and `source.image = None` on the `myratms-workers` service instance; `railway deployment list` returns 10 deployments, **all status `REMOVED`**, newest `2026-06-07T01:04:14Z`; `railway logs` returns nothing. Setting an environment variable does not trigger a redeploy, because there is no source to build. **Treat every Engine 2 worker as never having run since 2026-06-06** — no Qualifier, Researcher, Ranker, Compiler, Voice, Dispatcher or Feedback worker, and none of the three sell-side workers. The date matches the one and only live Retell call (2026-06-06), and it explains why `agent_calls` is empty on production. Anything described in these docs as happening "on Railway in shadow mode" has not been happening. **Why it went unnoticed for four months:** the 2026-06-04 deploy was recorded as a fact and never re-asserted, the worker host's liveness was never observable from inside the repo, and the synthetic-monitoring cron that would have caught it is roadmap item D.1.3, still unbuilt. A redeploy, once billing is active, is one `railway up` from a **clean checkout** — `railway up` ships the local directory, not `origin/master`, and `railway.json` lives in `MyraTMS/`. It will boot idle on the current flags. Settle the M3 RLS rotation (`DATABASE_URL` is still `neondb_owner`) and the missing `FMCSA_QC_WEBKEY`/`TMS_API_URL` in the same sitting. Note there are **two** Railway projects named `myratms-workers`; `149aa93e-…` is the real one, `01bbf6ef-…` is an abandoned duplicate with zero services.
- **`MAX_CONCURRENT_CALLS` — RESOLVED 2026-10-09.** It was found live at `25` on 2026-08-26 while every doc described shadow-drain as `0`, and was unverifiable for six weeks for want of Railway access. Re-verified still `25` on 2026-10-09 and **set to `0`** the same day with the operator's authorisation; read back as `'0'`, length 1. Current Railway kill-switch state: `PIPELINE_ENABLED=true`, `SCANNER_ENABLED=false`, `MAX_CONCURRENT_CALLS=0`, `SHIPPER_DIRECT_GATE_ENABLED=true`, `SHIPPER_DIRECT_GATE_MODE=shadow`, all others unset.
- **What IS live in production, verified three ways on 2026-10-09** (worth knowing because the worker-host finding above invites the wrong conclusion that nothing shipped). **Schema: applied** — all 17 expected T-17→T-28 and E2-01/E2-04 tables confirmed present by `to_regclass` against production; only T-30's `contract_shipper_authorizations` (migration 059) is absent, as documented. **Vercel code: live** — the Vercel API reports the production deployment's `githubCommitSha` equal to `origin/master` (re-verified 2026-10-09 during the cleanup). *(The earlier evidence here — `/api/metrics/summary` + `/api/pricing` returning 401 — proved nothing: neither route exists, and middleware 401s every unauthenticated path before routing.)* **Railway workers: down** since 2026-06-06. The three layers failed independently; only the third failed. Blast radius of the worker outage is narrow by design: T-17's `events` table is fed by 5 **PostgreSQL triggers** (migration 033) that fire on any write regardless of workers — the "derive, don't instrument" decision paying off — the five working Vercel crons kept running, and only **7 import lines** in `lib/workers/` reach Engine 3 code at all. What genuinely did not happen: no load scanned, qualified, researched, ranked, briefed, called, dispatched or scored since 2026-06-06.
- **Railway env gaps found 2026-10-09, none changed.** `DATABASE_URL` is still `neondb_owner` (confirms the open M3 RLS blocker — RLS is a no-op for worker paths); `FMCSA_QC_WEBKEY` is unset, so the 2026-10-09 QCMobile fix would be inert there and registry misses fail closed to human review; `TMS_API_URL` is unset though it is listed as required for the Dispatcher; `AUTO_BOOK_PROFIT_THRESHOLD` is still present despite being retired by T-19. `SHIPPER_DIRECT_GATE_ENABLED=true` / `SHIPPER_DIRECT_GATE_MODE=shadow` were set on Railway 2026-10-09 (GATE 1 step 5) and read back byte-exact, but nothing consumes them while the service is down. They were **deliberately not set on Vercel**: there the flag only makes `shipper_direct_attestation` mandatory on `POST /api/pipeline/import`, which would 400 the existing shadow-drain import scripts.
- **Tests used to write to production** (and did). Guarded since 2026-10-07 (see Build & Development Commands). The leftovers were **cleaned 2026-10-08** with explicit approval: 6 `TEST-*` `pipeline_loads` (+16 `exceptions`, 18 cascaded `events`) and `payer_registry` id 33 `ACME CO`, audited as `tenant_audit_log` id 345. See PRODUCTION_MIGRATION_LOG.md Entry 2 Step 5.
- **RLS M3 is under way as of 2026-10-08.** Both 2026-10-07 blockers are cleared on production (`docs/architecture/RLS_ROLLOUT.md` §0a, PRODUCTION_MIGRATION_LOG.md Entry 2): migrations 060 + 061 applied, role `myra_app` (NOBYPASSRLS) created, Vercel `DATABASE_URL` rotated to it, and **Day 1 `tenant_audit_log` RLS is ENABLED** and verified fail-closed. **Railway (`myratms-workers`) is still on `neondb_owner`**, so RLS remains a no-op for every worker path until that env var is rotated — that rotation is staged in `RAILWAY_REDEPLOY_TODO.md` and blocked on Railway billing. Days 2–12 of the schedule are still pending.
- **Intentionally parked (decision D3, Phase 2 cleanup 2026-10-09):** (1) no scraper Railway service; (2) the three never-executed crons (`fmcsa-reverify`, `invoice-alerts`, `shipper-reports`) stay POST-only/405; (3) no `SMTP_*`/`FROM_EMAIL` on Vercel, so tracking and rate-con emails silently no-op. Each needs an explicit operator decision to turn on.
- **Notifications dual source:** `useNotifications()` polls DB every 30s; topbar bell reads `useWorkspace()` mock context. Not synchronized.
- **PATCH atomicity:** `loads/[id]/route.ts` runs separate `UPDATE` per field using `sql.unsafe()`.
- **Edge-runtime JWT verification:** `middleware.ts` re-implements HMAC-SHA256 via Web Crypto. Keep in sync with `lib/auth.ts` and the JWT shape (`tenant_id`, `is_super_admin`).
- **Two Redis clients on purpose:** `lib/redis.ts` (Upstash REST) and `lib/pipeline/redis-bullmq.ts` (ioredis TCP). Cannot be merged.
- **RLS is on for exactly one table** (`tenant_audit_log`, since 2026-10-08) and off for the other 29 policied tables. Application code is still the live tenant boundary for everything else — do not assume the DB will catch a missing tenant filter.
- **Engine 2 placement is one-way.** Files in `Engine 2/` are spec material; live copies are under `MyraTMS/lib/`.
- **Never hardcode a tenant id.** `id=1` is `_system`, `id=2` is `myra`; migrations 033/034 originally hardcoded `1` and mislabeled every T-17/T-18 row until T-19 fixed it. Use `fn_myra_tenant_id()` / `getMyraTenantId()`. Full story in `Engine 3/wave1.md`.
- **"Applied to production" has two halves — the database and the deployed code.** Check `git log --oneline origin/master..master` before assuming code parity with a live migration (as of 2026-10-07 the two match).
- **Dead code:** `lib/cron/cron-handlers.ts` (no cron route imports it); `compliance-service.ts`'s `runFullComplianceCheck()` has no caller — `voice-worker.ts` runs its own inline compliance checks.
- **`scripts/sprint6-shadow/06-cleanup.ts` FK-violates against `exceptions`** when deleting old `TEST_` rows (found 2026-08-26). **Root cause identified 2026-10-08:** `exceptions.pipeline_load_id` is `integer` and references `pipeline_loads(id)` — the integer surrogate PK — not `pipeline_loads.load_id`, which is the TEXT business key. Any dependency census keyed on the `TEST-…` load_id strings returns 0 for every FK table and the delete then fails. Census and delete must key on the PK. The script itself is still unfixed.
- **`evaluatePolicy()` (T-19) is called by the Qualifier only, in shadow mode** (`qualifier-worker.ts`, since `5e80213`), and the Qualifier is not running while Railway is down. Compiler and Dispatcher are unwired — the three-point enforcement the master PRD requires (risk E3-R2) is still pending.
- **Duplicate distance services:** `lib/geo/distance-service.ts` vs `lib/quoting/geo/distance-service.ts`.
- **Spec copies:** canonical Engine 3 specs live only in `Engine 3/`. Byte-identical strays were removed 2026-10-07; don't let new copies appear in `MyraTMS/` or `Engine 2/`.
- **vitest + MCP plugin reconnect storms** have caused `spawn UNKNOWN` / V8 OOM when many test files run in parallel; use `--no-file-parallelism`.
