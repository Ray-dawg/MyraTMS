# Myra M1 — Shared Agent Memory

> This file is the single source of truth for all architectural decisions, conventions, and context.
> Every sub-agent MUST read this file before writing any code.
> Updated: 2026-02-27

---

## 1. LOCKED ARCHITECTURAL DECISIONS

### Monorepo Layout
```
M1/
├── MyraTMS/              ← TMS + CRM (Next.js 16, App Router) — EXISTS, ~40% built
├── One_pager tracking/   ← Shipper tracking page (Next.js 16) — EXISTS, mock data
├── Driver_App/           ← Driver PWA (Next.js 16 + PWA) — NEW, to be created
├── CLAUDE.md             ← Project-level instructions
├── MASTER-PLAN.md        ← Implementation plan
├── memory.md             ← THIS FILE
└── progress.md           ← Agent progress tracker
```

### Technology Stack (ALL APPS)
| Decision | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | Already 40% built, keep it |
| Language | TypeScript | Already in use |
| Database | Neon PostgreSQL (serverless) | Already connected, working |
| Cache | Upstash Redis | Already configured in lib/redis.ts |
| File Storage | Vercel Blob | Already working for documents |
| AI | Vercel AI SDK v6 + xai/grok-3-mini-fast | Already working |
| Styling | TailwindCSS 4.x + Shadcn/UI (New York) | Already in use |
| Package Manager | pnpm | Already in use |
| Deployment | Vercel | Already configured |
| Maps (Driver) | Mapbox (in-app) + Native maps option | User choice: dual nav |
| Maps (Tracking) | Keep decorative canvas Bezier | Already built, visually polished |

### Authentication
- **Type:** Simple email + password against `users` table
- **Session:** Cookie-based JWT (httpOnly, secure)
- **No SSO**, no OAuth, no NextAuth — keep it minimal for internal app
- **Users table already exists** with bcrypt passwords (via bcryptjs)
- **Middleware:** Next.js middleware.ts for route protection
- **Test credentials:** admin@myra.com / ops@myra.com / sales@myra.com (password: password123)

### ID Format
- **Existing tables** (loads, carriers, shippers, invoices, documents): Keep VARCHAR IDs (LD-xxxx, CR-xxxx, etc.)
- **New tables** (drivers, location_pings, tracking_tokens, load_events, check_calls): Use UUID v4
- **Tracking tokens:** Random 64-char hex string (crypto.randomBytes(32).toString('hex'))

### Feature Priority
**DAY ZERO (build now):**
- Auth system (email + password)
- Database schema migration (add missing tables/columns)
- Real-time updates (SSE for tracking, SSE/polling for TMS)
- ETA calculation + proactive exception management
- Tracking token generation + public tracking endpoint
- Wire One_pager tracking to real MyraTMS API
- GPS tracking (real positions from Driver_App)
- Driver PWA (entire new app)
- Compliance/FMCSA verification (make real)
- Loadboard/DAT integration (make real)
- Check-calls (persist to DB)
- Settings + Profile persistence
- Workflows persistence
- Reports from real DB data
- Notifications sync (DB ↔ context)

**FUTURE (NOT in this build):**
- Quoting engine (rate_cache, fuel surcharge, margin calc)
- Carrier matching/scoring algorithm
- ML pricing model
- Shipper self-service portal
- Automated dispatch

---

## 2. DATABASE SCHEMA DECISIONS

### Current Tables (keep, may need column additions)
- `users` — email, password_hash, role (admin/ops/sales)
- `shippers` — company CRM data
- `carriers` — company + FMCSA compliance fields
- `loads` — central object, needs new columns (see below)
- `invoices` — linked to loads
- `documents` — linked to entities + Vercel Blob URLs
- `activity_notes` — polymorphic notes
- `notifications` — user notifications
- `compliance_alerts` — carrier compliance

### New Tables to Create
- `drivers` — carrier_id FK, name, phone, app_pin, status, last_known_lat/lng
- `location_pings` — load_id, driver_id, lat, lng, speed, heading, recorded_at
- `load_events` — load_id, event_type, status, location, note, timestamp (for tracking timeline)
- `check_calls` — load_id, driver_id, location, status, notes, next_check_call, created_by
- `tracking_tokens` — load_id, token (64-char hex), created_at, expires_at
- `settings` — user_id, key, value (or JSON column)
- `workflows` — id, name, trigger, conditions, actions, active, created_at

### Columns to Add to `loads`
- `driver_id` UUID FK → drivers
- `tracking_token` VARCHAR(64) UNIQUE (denormalized for fast lookup)
- `current_lat` DECIMAL(10,7)
- `current_lng` DECIMAL(10,7)
- `current_eta` TIMESTAMP
- `origin_lat` DECIMAL(10,7)
- `origin_lng` DECIMAL(10,7)
- `dest_lat` DECIMAL(10,7)
- `dest_lng` DECIMAL(10,7)
- `pod_url` TEXT
- `commodity` VARCHAR(200)
- `po_number` VARCHAR(100)
- `reference_number` VARCHAR(50) UNIQUE (MYR-2026-XXXX format)

### Status Enum Expansion for `loads`
Current: `Booked, Dispatched, In Transit, Delivered, Invoiced, Closed`
New: `created, quoted, booked, assigned, accepted, at_pickup, in_transit, at_delivery, delivered, invoiced, paid, cancelled`

---

## 3. API CONVENTIONS

### Existing Pattern (FOLLOW THIS)
- Collection: `app/api/[resource]/route.ts` → GET list, POST create
- Item: `app/api/[resource]/[id]/route.ts` → GET one, PATCH update, DELETE
- Params: `req.nextUrl.searchParams` for query filters
- Response: `NextResponse.json({ ...data })` or `NextResponse.json({ error }, { status: 4xx })`
- DB access: `const sql = getDb()` then tagged template queries

### New Endpoints to Create
| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | /api/auth/login | Email + password login | Public |
| POST | /api/auth/logout | Clear session | Auth |
| GET | /api/auth/me | Get current user | Auth |
| POST | /api/loads/[id]/tracking-token | Generate tracking token | Auth |
| GET | /api/tracking/[token] | Public tracking data | Token |
| GET | /api/tracking/[token]/events | Load event timeline | Token |
| GET | /api/tracking/[token]/sse | SSE real-time stream | Token |
| POST | /api/loads/[id]/location | GPS ping from driver | Driver auth |
| POST | /api/loads/[id]/pod | Upload POD photo | Driver auth |
| POST | /api/loads/[id]/assign | Assign carrier + driver | Auth |
| GET | /api/drivers | List drivers | Auth |
| POST | /api/drivers | Create driver | Auth |
| GET | /api/drivers/[id] | Get driver | Auth |
| PATCH | /api/drivers/[id] | Update driver | Auth |
| GET | /api/drivers/me/loads | Driver's assigned loads | Driver auth |
| POST | /api/check-calls | Create check-call | Auth |
| GET | /api/check-calls | List check-calls | Auth |
| GET | /api/workflows | List workflows | Auth |
| POST | /api/workflows | Create workflow | Auth |
| PATCH | /api/workflows/[id] | Update workflow | Auth |
| DELETE | /api/workflows/[id] | Delete workflow | Auth |
| PATCH | /api/settings | Update settings | Auth |
| GET | /api/settings | Get settings | Auth |
| POST | /api/loads/[id]/send-tracking | Send tracking link email | Auth |

### Critical Pattern: snake_case vs camelCase
- DB columns: snake_case (carrier_cost, risk_flag)
- TypeScript interfaces: camelCase (carrierCost, riskFlag)
- API returns raw DB rows → snake_case
- Frontend must map manually (see components/load-quick-view.tsx for pattern)
- NEW CODE should follow this same pattern for consistency

---

## 4. CODING CONVENTIONS

### File Naming
- Files: kebab-case (load-quick-view.tsx, app-sidebar.tsx)
- Components: PascalCase exports
- Hooks: use* prefix, in hooks/ directory
- API routes: route.ts inside directory structure

### Path Alias
- `@/*` maps to project root in ALL three apps
- Example: `@/components/ui/button`, `@/lib/db`

### Component Patterns
- Interactive → `"use client"` directive
- Shadcn/UI in `components/ui/` — add via `npx shadcn@latest add <component>`
- Business components in `components/` root
- Use `sonner` toast (not useToast hook) for imperative notifications

### Dependencies to Use
- Forms: react-hook-form + zod
- Data fetching: SWR hooks (client), fetch (server/API)
- Date: date-fns
- Icons: lucide-react
- Charts: recharts
- Crypto: Node.js crypto module (for tokens)
- Auth: bcryptjs (already installed), jsonwebtoken (add)

---

## 5. CROSS-APP COMMUNICATION

### Driver_App → MyraTMS API
- Driver_App calls MyraTMS API routes
- In development: direct HTTP calls to localhost:3000 (MyraTMS) from localhost:3001 (Driver_App)
- In production: CORS headers on MyraTMS API, or API proxy in Driver_App
- GPS pings: POST /api/loads/[id]/location every 30-60 seconds
- Status updates: PATCH /api/loads/[id] with new status

### One_pager tracking → MyraTMS API
- Tracking page calls MyraTMS API using tracking token
- GET /api/tracking/[token] for initial data
- GET /api/tracking/[token]/sse for real-time updates
- No auth required — token IS the auth
- Must NOT expose financial data (revenue, carrier_cost, margin)

### MyraTMS → One_pager tracking
- TMS generates tracking token and builds URL
- URL format: https://track.myralogistics.com/track/[token]
- "Send Tracking Link" button emails/texts this URL to shipper

---

## 6. ENVIRONMENT VARIABLES

### MyraTMS (.env.local)
```
DATABASE_URL=             # Neon PostgreSQL connection string
KV_REST_API_URL=          # Upstash Redis URL
KV_REST_API_TOKEN=        # Upstash Redis token
XAI_API_KEY=              # For Grok AI model
BLOB_READ_WRITE_TOKEN=    # Vercel Blob
JWT_SECRET=               # For auth tokens (generate: openssl rand -hex 32)
FMCSA_API_KEY=            # Real FMCSA verification
DAT_API_KEY=              # Real DAT loadboard
TRUCKSTOP_API_KEY=        # Real Truckstop loadboard
SAMSARA_API_KEY=          # Samsara ELD GPS
MOTIVE_API_KEY=           # Motive ELD GPS
SMTP_HOST=                # Email sending
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=               # noreply@myralogistics.com
NEXT_PUBLIC_APP_URL=      # https://app.myralogistics.com
NEXT_PUBLIC_TRACKING_URL= # https://track.myralogistics.com
```

### Driver_App (.env.local)
```
NEXT_PUBLIC_API_URL=      # MyraTMS API base URL
MAPBOX_ACCESS_TOKEN=      # For in-app maps
```

### One_pager tracking (.env.local)
```
NEXT_PUBLIC_API_URL=      # MyraTMS API base URL (for tracking token fetch)
```

---

## 7. KNOWN ISSUES & TECH DEBT

- `loads/[id]/route.ts` PATCH uses `sql.unsafe()` per field — SQL injection risk. Fix: use parameterized updates.
- `assigned_rep` hardcoded to "Sarah Chen" — replace with auth session user
- Two toast systems (sonner + useToast) — standardize on sonner
- `styles/globals.css` is stale duplicate of `app/globals.css` — delete it
- Notifications dual source (DB vs context) — unify to DB-only
- `next.config.mjs` has ignoreBuildErrors: true — turn off after fixing TS errors
- No test runner configured — add vitest or jest
