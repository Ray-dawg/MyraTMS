# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

MyraTMS is a freight brokerage Transportation Management System (TMS) built as a monorepo of five Next.js projects plus a standalone scraper, all sharing a single Neon PostgreSQL database and Upstash Redis instance. Only **MyraTMS** owns the API and the bulk of the schema; the other apps are pure clients (or static), and the scraper writes to a focused subset of tables.

- **MyraTMS/** — Main full-stack TMS application (admin/broker-facing). Hosts all backend API routes, DB migrations, Engine 2 pipeline code (`lib/pipeline/`, `lib/workers/`, `lib/loadboards/`), and the Railway worker host entry-point. Port 3000.
- **DApp/** — Driver progressive web app (mobile-first PWA). Communicates with MyraTMS API via Bearer token auth. `next.config.mjs` proxies `/api/*` to `NEXT_PUBLIC_API_URL` so the PWA can call the TMS without CORS. Port 3000.
- **One_pager tracking/** — Customer-facing shipment tracking page. Read-only, token-based access at `/track/[token]`. Port 3002 (`next dev -p 3002`).
- **myra-landing/** — Marketing site. `next.config.ts` uses `output: 'export'` (static HTML), with content sourced from Sanity CMS (`@sanity/client`, `next-sanity`) plus JSON in `content/`. No DB or API.
- **Driver_App/** — Legacy driver app prototype (superseded by DApp). Port 3001. Not actively maintained.
- **scraper/** — Standalone TypeScript/Playwright headless scraper (DAT, Truckstop, 123LB, Loadlink). Not a Next.js app. Deploys to Railway, writes load-board rows into the shared Neon DB. See dedicated section below and `scraper/README.md`.
- **`Engine 2/`** — **Not a project.** Spec material for the 7-agent AI pipeline whose source was copied into `MyraTMS/` during Sprint 0. Has its own `CLAUDE.md` explaining the layout. Don't run anything from inside it.

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
- **AI:** Vercel AI SDK v6 streaming with `xai/grok-3-mini-fast`
- **Testing:** Vitest (MyraTMS + scraper)
- **Queues:** BullMQ on ioredis (Engine 2 pipeline workers + scraper)
- **Deployment:** Vercel for the four Next.js apps (each deployed as a separate project); Railway for the MyraTMS worker host (`scripts/run-workers.ts`) and the headless scraper (two separate Railway services). See Deployments section.

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
```

Test files live under `**/__tests__/**/*.test.ts` (configured in `vitest.config.ts`).

Database migrations are manual SQL scripts in `MyraTMS/scripts/` — run directly against Neon. No ORM.

## Environment Variables

**Required (MyraTMS):**
- `DATABASE_URL` — Neon PostgreSQL connection string
- `JWT_SECRET` — For JWT signing/verification
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Upstash Redis
- `XAI_API_KEY` — For Grok/XAI model
- `BLOB_READ_WRITE_TOKEN` — For `@vercel/blob` document uploads

**Required (DApp):**
- `NEXT_PUBLIC_API_URL` — MyraTMS API base URL (defaults to `http://localhost:3000`)

**Required (One_pager tracking):**
- `NEXT_PUBLIC_API_URL` — MyraTMS API base URL

**Optional:**
- `NEXT_PUBLIC_MAPBOX_TOKEN` — Enables real Mapbox maps (all 3 apps fall back gracefully without it)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` — Nodemailer tracking emails
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DRIVER_APP_URL`, `NEXT_PUBLIC_TRACKING_URL` — Production URLs for CORS
- `DAT_API_KEY`, `TRUCKSTOP_API_KEY` — Load board integration
- `FMCSA_API_KEY` — Carrier compliance verification
- `SAMSARA_API_KEY`, `MOTIVE_API_KEY` — GPS tracking positions

## Architecture

### Database & Schema

Schema defined across migration scripts in `MyraTMS/scripts/`:

| Script | Tables/Changes |
|--------|----------------|
| `001-create-tables.sql` | users, shippers, carriers, loads, invoices, documents, activity_notes, notifications, compliance_alerts |
| `002/003-seed-data.sql` | Sample data (003 is the corrected version) |
| `005-fix-auth.sql` | Auth schema fixes |
| `010-m1-migration.sql` | drivers, location_pings, load_events, check_calls, tracking_tokens, settings, workflows; adds lat/lng/tracking columns to loads |
| `012-workflow-columns.sql` | Workflow column additions |
| `013-push-subscriptions.sql` | push_subscriptions |
| `011-seed-drivers.sql` | Seed driver accounts |
| `014-carrier-matching-engine.sql` | carrier_equipment, carrier_lanes, match_results; adds home_lat/lng/city, communication_rating, overall_match_score to carriers |
| `020-quoting-engine.sql` | quotes, rate_cache, distance_cache, fuel_index, quote_corrections; integrations table |
| `021-check-call-reminder.sql` | Check-call reminder scheduling |
| `021-delivery-ratings-report-log.sql` | Delivery ratings + report execution log |
| `022-user-invites.sql` | User invitation tokens |
| `023-pipeline-schema-corrections.sql` | Engine 2 integration: corrections to `pipeline_migrations.sql` after schema drift was found against the real DB |
| `024-pipeline-brief-schema-corrections.sql` | Engine 2: corrections to the negotiation-brief JSON shape persisted in `pipeline_loads` |
| `025-compliance-audit-table.sql` | Engine 2: `compliance_audit_log` — append-only audit of consent + DNC checks |
| `026-loadboard-sources.sql` | Engine 2: `loadboard_sources` registry (single source of truth shared by Vercel API path and the Railway scraper) |
| `027_multi_tenant_foundation.sql` | Multi-tenant Phase 1: `tenants`, `tenant_users`, `is_super_admin` flag on users |
| `028_add_tenant_id.sql` | Multi-tenant Phase 2: adds `tenant_id` to all TMS-core "Category A" tables. Every API query must filter by tenant. |
| `029_create_rls_policies.sql` | Multi-tenant Phase 3: creates RLS policies but **does NOT enable them**. App-layer scoping is the live mechanism; RLS is staged for later activation. |
| `031_tenant_usage.sql` | Multi-tenant Phase 4: `tenant_usage` table for per-tenant metering (loads/month, seats, etc.) |
| `032-carrier-status-prospect.sql` | Carrier `status` enum: `prospect` vs `active` — used by FMCSA seed + dispatcher prospect-gate |
| `pipeline_migrations.sql` | Engine 2 baseline: `pipeline_loads`, `pipeline_calls`, `pipeline_briefs`, `pipeline_research`, `pipeline_carrier_matches`, `pipeline_feedback`, `pipeline_personas` (superseded in places by 023–026 corrections) |

Each multi-tenant migration has a paired `*_rollback.sql`. Multi-tenant migrations are numbered with underscores (`027_...`), pre-multi-tenant ones with hyphens (`027-...` style).

**Critical: snake_case vs camelCase mismatch.** DB columns are snake_case. API routes return raw Neon rows (snake_case). Frontend components must manually map fields. Canonical TypeScript interfaces are in `lib/types.ts` (camelCase) and `lib/mock-data.ts` (legacy camelCase).

`lib/db.ts` exports `getDb()` which returns a Neon tagged-template SQL client, created fresh per request.

### Auth System

Fully implemented JWT auth with RBAC:

- **`lib/auth.ts`** — `createToken()`, `verifyToken()`, `getCurrentUser(request)`, `requireRole()`, `hashPassword()`, `comparePassword()`
- **`middleware.ts`** — Route protection + CORS. Public paths: `/login`, `/api/auth/login`, `/api/auth/driver-login`. Tracking paths bypass cookie auth (token-based). Driver JWTs restricted to `/api/drivers/me`, `/api/loads/`, `/api/auth/*`.
- **MyraTMS login** — JWT stored as `httpOnly` cookie `auth-token` (24h expiry)
- **DApp login** — Driver PIN auth via `/api/auth/driver-login`, JWT stored in `localStorage` as `driver-token`, sent as `Authorization: Bearer` header

### Multi-tenancy

Phases 1–9 shipped (sessions 1–8 FINAL). Every API route is now tenant-scoped. The runbook lives at `docs/architecture/PRODUCTION_MIGRATION_LOG.md`.

- **JWT shape** — Tokens now carry `tenant_id` (from `tenant_users`) and `is_super_admin` (from `users`). `lib/auth.ts > createToken()` reads both at login time. Super-admin bypasses tenant scoping for cross-tenant admin actions only.
- **Scoping mechanism** — Application-layer: every query in `app/api/**/route.ts` that touches a Category A table (loads, carriers, shippers, invoices, drivers, etc.) must include `WHERE tenant_id = $1`. **RLS policies exist in migration 029 but are NOT enabled** — they're staged for activation later. Do not assume the DB will catch a missing tenant filter.
- **Feature gating (`lib/features/`)** — Three-layer check: plan limits → tenant overrides → user role. Used by sidebar nav, dialogs, and API guards (`requireFeature('quoting')`).
- **Usage tracking (`lib/usage/`)** — Writes to `tenant_usage` on load creation, seat changes, etc. Read by billing and admin dashboards.
- **Admin surface** — `app/api/admin/**` and `app/admin/**` are super-admin-only; the middleware checks `is_super_admin` before allowing the request through.

### API Routes

REST conventions under `MyraTMS/app/api/`:
- Collection: `app/api/[resource]/route.ts` (GET list, POST create)
- Item: `app/api/[resource]/[id]/route.ts` (GET one, PATCH update)
- Parameters via `req.nextUrl.searchParams`; responses via `NextResponse.json()`
- Error helper: `apiError(message, status)` from `lib/api-error.ts`
- ID generation: `LD-${Date.now().toString(36).toUpperCase()}` for loads, `DOC-` for documents, `CAR-` for carriers, `SHP-` for shippers

Key route groups (under `MyraTMS/app/api/`): `admin`, `ai`, `auth`, `carriers`, `check-calls`, `compliance`, `cron`, `dispatch`, `documents`, `drivers`, `exceptions`, `finance`, `fuel-index`, `health`, `import`, `integrations`, `invoices`, `loadboard`, `loadboard-sources`, `loads`, `matching`, `me`, `notes`, `notifications`, `pipeline`, `push`, `quotes`, `rate`, `rates`, `settings`, `shippers`, `tracking`, `webhooks`, `workflows`. Notes:
- `rate/` (singular) and `rates/` (plural with `[token]` and `import` sub-routes) are intentionally separate — verify which one a new endpoint belongs in.
- `loadboard/` is the broker-facing CRUD; `loadboard-sources/` is the Engine 2 ingest registry shared with the Railway scraper.
- `webhooks/` hosts Retell call-event ingestion (Engine 2 voice agent).
- `pipeline/` is the Engine 2 operator surface (job queueing, stage transitions, brief preview).
- `health/` is `/api/health` for uptime checks (added for Railway worker host preflight).

Additional sub-routes added:
- `loads/[id]/invoice/route.ts` — Invoice generation for a specific load
- `loads/request/route.ts` — Driver load request endpoint (DApp → TMS)

### Cron Jobs

Configured in `MyraTMS/vercel.json`:

| Schedule | Route | Purpose |
|----------|-------|---------|
| `0 2 * * *` (2 AM daily) | `/api/cron/fmcsa-reverify` | Carrier compliance re-verification |
| `0 8 * * *` (8 AM daily) | `/api/cron/invoice-alerts` | Invoice payment reminders |
| `0 12 * * *` (noon daily) | `/api/cron/exception-detect` | Proactive load exception detection |
| `0 6 1 * *` (6 AM, 1st of month) | `/api/cron/shipper-reports` | Monthly shipper performance reports |
| `0 10 * * *` (10 AM daily) | `/api/cron/pipeline-scan` | Engine 2: kicks off Scanner agent to pull fresh load-board candidates |
| `0 11 * * *` (11 AM daily) | `/api/cron/pipeline-health` | Engine 2: stuck-job + dead-letter health check across all 7 BullMQ queues |
| `0 7 * * *` (7 AM daily) | `/api/cron/feedback-aggregation` | Engine 2: aggregates Feedback worker outputs into the carrier scoring tables |

Crons run on Vercel. Engine 2 *workers* do not — they run on a separate Railway host (see Engine 2 section below).

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
- `index.ts` — `matchCarriers()` orchestrator, `storeMatchResults()` audit trail
- API: `/api/loads/[id]/match` (POST), `/api/loads/[id]/assign` (POST), `/api/loads/bulk-match` (POST), `/api/carriers/[id]/rate` (POST), `/api/matching/refresh-lanes` (POST)

### Bulk Import System

`lib/import/` + `app/api/import/` + `app/settings/import/page.tsx`

- Supports CSV import of carriers, shippers, and loads
- `papaparse` for CSV parsing with BOM handling and auto-delimiter detection
- 3 API routes: `/api/import/template/[type]` (GET), `/api/import/validate` (POST), `/api/import/execute` (POST)
- 5-step UI wizard: select type, upload, review validation, confirm, results

### Quoting Engine

`lib/quoting/` — Rate estimation and quoting system:

- `geo/distance-service.ts` — Mileage calculation between origin/destination
- `geo/region-mapper.ts` — Maps locations to rate regions/zones
- `rates/benchmark.ts` — Market rate benchmarking (DAT/Truckstop integration)
- `rates/fuel-index.ts` — Fuel surcharge calculations based on DOE index
- `lib/rates/ai-estimator.ts` — AI-powered rate estimation
- DB tables: `quotes`, `rate_cache`, `distance_cache`, `fuel_index`, `quote_corrections` (migration `020`)
- API: `/api/quotes` (GET/POST), `/api/rates/*`

### Engine 2 AI Pipeline (7-agent autonomous booking)

7-agent BullMQ pipeline that auto-scans load boards, qualifies/researches/ranks carriers, compiles negotiation briefs, places Retell voice calls, dispatches, and feeds outcomes back into scoring. Sprints 0–6.5 + Sprint 6 shipped; **code complete, pre-production.** Migrations 023–026 + `pipeline_migrations.sql`.

**Where the code lives (in `MyraTMS/`, not in `Engine 2/`):**
- `lib/pipeline/` — Stages, queues, payloads, gate, Claude service, compliance service, cost calculator, brief schema, Retell webhook, redis-bullmq adapter, db-adapter (Neon v1 quirk: `sql.query(text, params)` required), service-token (mints admin JWTs so Dispatcher can call existing TMS routes).
- `lib/workers/` — 9 workers: `base-worker`, `scanner`, `qualifier`, `researcher`, `ranker`, `compiler`, `voice`, `dispatcher`, `feedback`, plus `index.ts`.
- `lib/loadboards/` — Third ingest pathway after CSV + scraper: official-API clients (DAT, Truckstop, etc., currently stubs) + the `loadboard_sources` registry.
- `lib/cron/` — Cron handlers wired to `/api/cron/pipeline-*`.
- `scripts/run-workers.ts` — Single-process Railway entry-point booting all workers on one ioredis connection.
- `scripts/sprint6-shadow/` — 7 operator scripts (preflight, synthetic load gen, observation SQL, metrics, live-call gate, cleanup, emergency stop) + runbook.

**Key kill switches** (env vars read by `run-workers.ts`):
- `PIPELINE_ENABLED=false` — all workers stay paused.
- `SCANNER_ENABLED=false` — scanner cron heartbeat is a noop.
- `MAX_CONCURRENT_CALLS=0` — Voice worker enters shadow mode (logs without calling).

**Critical:**
- The `Engine 2/` directory at the repo root is **spec material only.** Source files there are the original delivery package — they were placed into `MyraTMS/lib/` during Sprint 0 and have since been debugged. **Do not re-copy them.** Do not run `pnpm install` inside `Engine 2/` — no package.json. See `Engine 2/CLAUDE.md` for the full integration map.
- The completion tracker at `Engine 2/docs/superpowers/plans/completion.md` is the live source of truth for sprint progress — keep it in sync as Engine 2 plan tasks finish; do not batch.
- Workers run on **Railway**, not Vercel. Vercel hosts the Next.js app (API routes + cron triggers); Railway hosts the long-running BullMQ consumers. They share the same Upstash Redis and same Neon DB.
- `lib/pipeline/redis-bullmq.ts` (ioredis TCP connection) and `lib/redis.ts` (Upstash REST client) must coexist — BullMQ needs a real socket; the TMS app reads cached values over REST. See Known Issues.

### Headless Scraper (`scraper/`)

Standalone sibling project — not part of the MyraTMS workspace, not deployed on Vercel.

- **Purpose:** Bridge layer until DAT / Truckstop / 123LB / Loadlink official API access lands. Scrapes load boards via Playwright + stealth plugins, normalizes results, writes to the same Neon DB and Upstash Redis as MyraTMS.
- **Stack:** TypeScript, Playwright + `puppeteer-extra-plugin-stealth`, BullMQ, ioredis, raw `pg` (not Neon serverless).
- **Build/test:** `pnpm build`, `pnpm dev` (tsx watch), `pnpm test` (Vitest). Manual login helper: `pnpm dat:manual-login`. Migrations: `pnpm migrate` (uses `scraper/migrations/001_scraper_tables.sql`).
- **Deploy:** Railway (`Dockerfile` in the root of `scraper/`). Sibling deploy unit to the worker host — they're separate Railway services but share infra.
- **Integration point:** Writes into the same `loadboard_sources` registry used by Engine 2's `lib/loadboards/`, so the scraper, official APIs, and CSV import all flow into one unified source pool.

### AI Integration — Two Patterns

1. **Streaming chat** (`app/api/ai/chat/route.ts`): `streamText` + tools (`lookupLoad`, `searchLoads`, `getFinanceSummary`, `lookupCarrier`) that execute SQL. Frontend: `components/ai-assistant.tsx` using `useChat`.
2. **Structured output** (`app/api/ai/analyze-risk/route.ts`): `generateText` + `Output.object()` for JSON risk analysis.

### Data Fetching — SWR Hooks

`lib/api.ts` exports SWR hooks and mutation helpers for all resources: loads, carriers, shippers, invoices, documents, notifications, notes, workflows, check-calls, drivers, tracking positions, finance summary.

Cache invalidation: mutations call `mutate((key) => key.startsWith("/api/resource"), undefined, { revalidate: true })`.

### DApp (Driver PWA) Architecture

- **Single-page shell** (`app/page.tsx`) with tab navigation via `BottomNav`: map, active load, loads list, docs, profile
- **MapScreen** always mounted (hidden not unmounted) for performance; uses Mapbox GL with imperative `mapbox-gl` API
- **GPS tracking:** `useGPS` hook pings `POST /api/loads/[id]/location` at interval when load is in-transit
- **Status flow:** Internal statuses (`en_route_pickup`, `at_pickup`, `loaded`, `en_route_delivery`, `at_delivery`, `delivered`) mapped to TMS statuses on PATCH
- **POD capture:** Camera-based proof of delivery with Vercel Blob upload
- **PWA:** Service worker registration via `useServiceWorker` hook, manifest at `public/manifest.json`
- **No SWR, no Shadcn** — uses `driverFetch()` wrapper and raw Tailwind
- **New components (Wave 3):**
  - `eta-pill.tsx` — ETA countdown pill showing time/distance to next stop
  - `fab-menu.tsx` — Floating action button with quick actions (call, navigate, camera, report)
  - `request-load.tsx` — Load request/search screen for drivers to find and request available loads
  - `slide-to-confirm.tsx` — iOS-style slide gesture for confirming status changes (uses Vibration API)
  - `status-stepper.tsx` — Visual stepper for load status progression
- **New hooks:**
  - `use-eta.ts` — Real-time ETA calculation with geofence detection
- **New lib:**
  - `haptics.ts` — Vibration API wrapper (`hapticLight`, `hapticMedium`, `hapticHeavy`, `hapticSuccess`) for mobile PWA feedback
- **Join flow:** `app/join/[token]/page.tsx` — Driver invitation acceptance via token link

### Notable lib Modules

- `lib/email.ts` — `sendTrackingEmail()` via nodemailer (no-ops gracefully when SMTP not configured)
- `lib/sse.ts` — `createSSEStream()` for real-time GPS position streaming
- `lib/eta.ts` — ETA calculation with proactive exception detection (late delivery, missing GPS, detention risk)
- `lib/workflow-engine.ts` — `executeWorkflows(triggerType, context)` — evaluates active workflows, runs actions
- `lib/push-notify.ts` — `sendPushToDriver()` — inserts DB notification record
- `lib/escape-like.ts` — SQL LIKE pattern escaping utility
- `lib/sanitize-csv.ts` — CSV input sanitization for bulk imports
- `lib/quoting/geo/distance-service.ts` — Distance calculation service for quoting
- `lib/quoting/geo/region-mapper.ts` — Geographic region mapping for rate zones
- `lib/quoting/rates/benchmark.ts` — Rate benchmarking against market data
- `lib/quoting/rates/fuel-index.ts` — Fuel surcharge index calculations
- `lib/logger.ts` — Pino logger shared by API routes and workers (worker host expects this exact shape)
- `lib/tenants/` — Tenant lookup, `tenant_users` join, super-admin checks (consumed by `lib/auth.ts` at login time)
- `lib/features/` — Three-layer feature gate: plan → tenant override → user role
- `lib/usage/` — Per-tenant metering helpers (writes to `tenant_usage`)
- `lib/exceptions/` — Server-side error classes used by API guards
- `lib/blob/` — `@vercel/blob` upload helpers (POD, documents, brief artifacts)
- `lib/crypto/` — App-layer encryption helpers (compliance audit log, tracking tokens)
- `lib/geo/` — Shared distance/region utilities (extracted from `lib/quoting/geo/` for use by the matching engine and pipeline researcher)
- `lib/email-templates/` — React Email templates (rendered server-side, sent via nodemailer)

## Key Conventions

**Path alias:** `@/*` maps to project root (e.g., `@/components/ui/button`, `@/lib/db`)

**Component patterns:**
- Interactive components use `"use client"` directive
- Shadcn/UI components in `components/ui/` — add via `npx shadcn@latest add <component>` from `MyraTMS/`
- Business components in `components/` root
- Carrier matching UI in `components/carrier-matching/`
- `assign-driver-dialog.tsx` — Dialog for assigning a driver to a load (uses SWR mutate)
- `create-invoice-dialog.tsx` — Dialog for generating invoices from load data

**Naming:** Files: kebab-case. Components: PascalCase exports. Hooks: `use*` prefix in `hooks/`.

**Two toast systems (MyraTMS):** `sonner` is used imperatively in business components (`toast.success()`). The `useToast` hook in `hooks/use-toast.ts` is the older Shadcn/Radix pattern. Do not mix them in the same component.

**Theming:** Dark/light mode via `next-themes` + CSS variables. Fonts: Inter (sans), JetBrains Mono (mono). DApp uses Inter + Geist Mono.

**Maps:** All 3 active apps use Mapbox GL with `next/dynamic` SSR-disabled wrappers. Components gracefully return fallback UIs when `NEXT_PUBLIC_MAPBOX_TOKEN` is missing.

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
| MyraTMS | `myratms` | Production. Hosts API routes, the Vercel cron schedule (see Cron Jobs), and the admin/broker UI. Node 24.x runtime. |
| DApp | `myra-driver-app` | https://myra-driver-app.vercel.app |
| One_pager tracking | `v0-enterprise-logistic-one-pager` | https://v0-enterprise-logistic-one-pager.vercel.app |
| myra-landing | `myra-landing` | https://myra-landing.vercel.app — static export |

### Railway (long-running processes)

| Service | Start command | Purpose |
|---------|---------------|---------|
| MyraTMS worker host | `pnpm tsx scripts/run-workers.ts` (from `MyraTMS/`, via `railway.json`) | Boots all 7 Engine 2 BullMQ workers on a single ioredis connection. Honors `PIPELINE_ENABLED`, `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS` kill switches. Restart policy: ON_FAILURE, max 5 retries. |
| Headless scraper | (Dockerfile in `scraper/`) | Playwright-driven load board scraper. Separate Railway service from the worker host. Writes to same Neon DB + Upstash Redis. |

Cross-app linking: `NEXT_PUBLIC_API_URL` (DApp, One_pager → MyraTMS API) and `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_DRIVER_APP_URL` / `NEXT_PUBLIC_TRACKING_URL` (MyraTMS → other apps for outbound links and CORS allowlist).

## Known Issues

- **Notifications dual source:** `useNotifications()` SWR hook polls DB every 30s. Topbar bell reads from `useWorkspace()` context (in-memory mock data). These are not synchronized.
- **PATCH atomicity:** `loads/[id]/route.ts` runs separate `UPDATE` per field using `sql.unsafe()` (not atomic)
- **Edge-runtime JWT verification:** `MyraTMS/middleware.ts` re-implements HMAC-SHA256 verification via Web Crypto because `jsonwebtoken` cannot run in Edge runtime. Keep this in sync with `lib/auth.ts` if the signing scheme changes. Must also stay aligned with the multi-tenant JWT shape (`tenant_id`, `is_super_admin`) — middleware reads these for admin-route gating.
- **Two Redis clients on purpose:** `lib/redis.ts` is the Upstash REST client used by API routes for cache reads/writes; `lib/pipeline/redis-bullmq.ts` is an ioredis TCP client used by BullMQ workers and queues. They cannot be merged — BullMQ requires a real socket connection. When adding caching to a worker, prefer the BullMQ ioredis client to avoid two connections per process.
- **RLS exists but is off.** Migration 029 creates row-level security policies but does NOT enable them. Application code is the live tenant boundary. Forgetting `WHERE tenant_id = $1` in a query will leak data across tenants until RLS is turned on.
- **Engine 2 placement is one-way.** Files in `Engine 2/` look like working source but are spec material. Editing or re-copying them changes nothing the workers run; the live copies are under `MyraTMS/lib/pipeline/` and `MyraTMS/lib/workers/`.
