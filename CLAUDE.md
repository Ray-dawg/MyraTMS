# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

MyraTMS is a freight brokerage Transportation Management System (TMS) built as a monorepo with four Next.js projects sharing a single Neon PostgreSQL database:

- **MyraTMS/** — Main full-stack TMS application (admin/broker-facing). Hosts all backend API routes. Port 3000.
- **DApp/** — Driver progressive web app (mobile-first PWA). Communicates with MyraTMS API via Bearer token auth. Port 3000 (default).
- **One_pager tracking/** — Customer-facing shipment tracking page. Read-only, token-based access. Port 3002.
- **Driver_App/** — Legacy driver app prototype (superseded by DApp). Port 3001. Not actively maintained.

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
- **Testing:** Vitest (MyraTMS only)
- **Deployment:** Vercel

## Build & Development Commands

All commands run from within each project directory:

```bash
pnpm install          # Install dependencies
pnpm run dev          # Start dev server
pnpm run build        # Production build (TS errors ignored via next.config.mjs)
pnpm run lint         # ESLint
pnpm run test         # Run tests (MyraTMS only, vitest)
pnpm run test:watch   # Watch mode tests (MyraTMS only)
```

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
| `010-m1-migration.sql` | drivers, location_pings, load_events, check_calls, tracking_tokens, settings, workflows; adds lat/lng/tracking columns to loads |
| `013-push-subscriptions.sql` | push_subscriptions |
| `014-carrier-matching-engine.sql` | carrier_equipment, carrier_lanes, match_results; adds home_lat/lng/city, communication_rating, overall_match_score to carriers |

**Critical: snake_case vs camelCase mismatch.** DB columns are snake_case. API routes return raw Neon rows (snake_case). Frontend components must manually map fields. Canonical TypeScript interfaces are in `lib/types.ts` (camelCase) and `lib/mock-data.ts` (legacy camelCase).

`lib/db.ts` exports `getDb()` which returns a Neon tagged-template SQL client, created fresh per request.

### Auth System

Fully implemented JWT auth with RBAC:

- **`lib/auth.ts`** — `createToken()`, `verifyToken()`, `getCurrentUser(request)`, `requireRole()`, `hashPassword()`, `comparePassword()`
- **`middleware.ts`** — Route protection + CORS. Public paths: `/login`, `/api/auth/login`, `/api/auth/driver-login`. Tracking paths bypass cookie auth (token-based). Driver JWTs restricted to `/api/drivers/me`, `/api/loads/`, `/api/auth/*`.
- **MyraTMS login** — JWT stored as `httpOnly` cookie `auth-token` (24h expiry)
- **DApp login** — Driver PIN auth via `/api/auth/driver-login`, JWT stored in `localStorage` as `driver-token`, sent as `Authorization: Bearer` header

### API Routes

REST conventions under `MyraTMS/app/api/`:
- Collection: `app/api/[resource]/route.ts` (GET list, POST create)
- Item: `app/api/[resource]/[id]/route.ts` (GET one, PATCH update)
- Parameters via `req.nextUrl.searchParams`; responses via `NextResponse.json()`
- Error helper: `apiError(message, status)` from `lib/api-error.ts`
- ID generation: `LD-${Date.now().toString(36).toUpperCase()}` for loads, `DOC-` for documents, `CAR-` for carriers, `SHP-` for shippers

Key route groups: `ai`, `auth`, `carriers`, `check-calls`, `compliance`, `cron`, `documents`, `drivers`, `finance`, `import`, `invoices`, `loadboard`, `loads`, `matching`, `notes`, `notifications`, `push`, `settings`, `shippers`, `tracking`, `workflows`

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

### Notable lib Modules

- `lib/email.ts` — `sendTrackingEmail()` via nodemailer (no-ops gracefully when SMTP not configured)
- `lib/sse.ts` — `createSSEStream()` for real-time GPS position streaming
- `lib/eta.ts` — ETA calculation with proactive exception detection (late delivery, missing GPS, detention risk)
- `lib/workflow-engine.ts` — `executeWorkflows(triggerType, context)` — evaluates active workflows, runs actions
- `lib/push-notify.ts` — `sendPushToDriver()` — inserts DB notification record

## Key Conventions

**Path alias:** `@/*` maps to project root (e.g., `@/components/ui/button`, `@/lib/db`)

**Component patterns:**
- Interactive components use `"use client"` directive
- Shadcn/UI components in `components/ui/` — add via `npx shadcn@latest add <component>` from `MyraTMS/`
- Business components in `components/` root
- Carrier matching UI in `components/carrier-matching/`

**Naming:** Files: kebab-case. Components: PascalCase exports. Hooks: `use*` prefix in `hooks/`.

**Two toast systems (MyraTMS):** `sonner` is used imperatively in business components (`toast.success()`). The `useToast` hook in `hooks/use-toast.ts` is the older Shadcn/Radix pattern. Do not mix them in the same component.

**Theming:** Dark/light mode via `next-themes` + CSS variables. Fonts: Inter (sans), JetBrains Mono (mono). DApp uses Inter + Geist Mono.

**Maps:** All 3 active apps use Mapbox GL with `next/dynamic` SSR-disabled wrappers. Components gracefully return fallback UIs when `NEXT_PUBLIC_MAPBOX_TOKEN` is missing.

## Known Issues

- **`next.config.mjs`** ignores TypeScript build errors (`ignoreBuildErrors: true`) and disables image optimization (`unoptimized: true`)
- **`styles/globals.css`** (MyraTMS) is a stale duplicate of `app/globals.css` — only `app/globals.css` is imported
- **Notifications dual source:** `useNotifications()` SWR hook polls DB every 30s. Topbar bell reads from `useWorkspace()` context (in-memory mock data). These are not synchronized.
- **PATCH atomicity:** `loads/[id]/route.ts` runs separate `UPDATE` per field using `sql.unsafe()` (not atomic)
