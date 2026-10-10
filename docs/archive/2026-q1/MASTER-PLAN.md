# MYRA M1 — MASTER IMPLEMENTATION PLAN

> Multi-Agent Parallel Build — 5 Teams × 20+ Sub-Agents Each
> Created: 2026-02-27
> Owner: Pat (Patrice)
> Companion files: memory.md (decisions), progress.md (tracking)

---

## TABLE OF CONTENTS
1. [Execution Strategy](#1-execution-strategy)
2. [Phase 0: Foundation](#2-phase-0-foundation--team-a)
3. [Phase 1: Core Features (Parallel)](#3-phase-1-core-features-parallel)
4. [Phase 2: Integration & Testing](#4-phase-2-integration--testing)
5. [Team Rosters](#5-team-rosters)
6. [Dependency Graph](#6-dependency-graph)
7. [File Ownership Matrix](#7-file-ownership-matrix)
8. [Agent Execution Protocol](#8-agent-execution-protocol)

---

## 1. EXECUTION STRATEGY

### Phased Parallel Execution

```
PHASE 0 (Sequential)     PHASE 1 (Parallel)              PHASE 2 (Sequential)
┌──────────────┐     ┌─────────────────────────────┐    ┌──────────────────┐
│  TEAM A       │     │ TEAM B: Real-Time/Tracking  │    │ Integration Test │
│  Foundation   │────►│ TEAM C: Integrations        │───►│ Security Audit   │
│  Auth+Schema  │     │ TEAM D: Driver PWA          │    │ Deploy           │
│  Settings     │     │ TEAM E: TMS Completion      │    └──────────────────┘
└──────────────┘     └─────────────────────────────┘
```

**Why this order:**
- Phase 0 delivers auth middleware + schema migration. Every other team depends on these.
- Phase 1 runs 4 teams in parallel. Each team owns distinct files — no merge conflicts.
- Phase 2 wires everything together and validates end-to-end.

### Conflict Prevention Rules
1. **File ownership is exclusive.** Only one team writes to a given file. See File Ownership Matrix.
2. **Shared files** (lib/db.ts, lib/api.ts, lib/mock-data.ts) have a designated owner. Other teams request changes via progress.md.
3. **Schema changes** are Team A only. Other teams define what they need in their spec; Team A implements.
4. **API routes** are owned by the team that creates them. Existing routes belong to Team E unless another team's spec overrides.

---

## 2. PHASE 0: FOUNDATION — TEAM A

**Goal:** Auth system working, schema migrated, API infrastructure solid. Every other team unblocks after this.

**Duration target:** Must complete before Phase 1 teams start.

### A1. Database Schema Migration

**Agent: A-Schema-Architect + A-Migration-Engineer**

Create `scripts/010-m1-migration.sql` with ALL schema changes in one atomic migration:

```sql
-- NEW TABLES
CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id VARCHAR(50) REFERENCES carriers(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(200),
  app_pin VARCHAR(6),
  status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','on_load','offline')),
  last_known_lat DECIMAL(10,7),
  last_known_lng DECIMAL(10,7),
  last_ping_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE location_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id VARCHAR(50) REFERENCES loads(id),
  driver_id UUID REFERENCES drivers(id),
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  speed_mph DECIMAL(5,1),
  heading DECIMAL(5,1),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_location_pings_load_time ON location_pings(load_id, recorded_at DESC);

CREATE TABLE load_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id VARCHAR(50) REFERENCES loads(id) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  status VARCHAR(50),
  location VARCHAR(200),
  note TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_load_events_load ON load_events(load_id, created_at);

CREATE TABLE check_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id VARCHAR(50) REFERENCES loads(id) NOT NULL,
  driver_id UUID REFERENCES drivers(id),
  location VARCHAR(200),
  status VARCHAR(50),
  notes TEXT,
  next_check_call TIMESTAMPTZ,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tracking_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id VARCHAR(50) REFERENCES loads(id) NOT NULL UNIQUE,
  token VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_tracking_tokens_token ON tracking_tokens(token);

CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  settings_key VARCHAR(100) NOT NULL,
  settings_value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, settings_key)
);

CREATE TABLE workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(50),
  trigger_config JSONB,
  conditions JSONB,
  actions JSONB,
  active BOOLEAN DEFAULT true,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- COLUMNS ADDED TO loads
ALTER TABLE loads ADD COLUMN IF NOT EXISTS driver_id UUID REFERENCES drivers(id);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(64) UNIQUE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS current_eta TIMESTAMPTZ;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dest_lat DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dest_lng DECIMAL(10,7);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pod_url TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS commodity VARCHAR(200);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS po_number VARCHAR(100);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS reference_number VARCHAR(50) UNIQUE;
```

**Acceptance criteria:**
- All tables created without errors
- Existing data unaffected
- Foreign keys validated
- Indexes in place for query performance

### A2. Authentication System

**Agents: A-Auth-Designer, A-Auth-Backend, A-Auth-Frontend, A-Auth-Middleware**

**Files to create/modify:**
- `app/api/auth/login/route.ts` — POST: validate email+password via bcryptjs, return JWT in httpOnly cookie
- `app/api/auth/logout/route.ts` — POST: clear auth cookie
- `app/api/auth/me/route.ts` — GET: decode JWT, return user profile
- `app/login/page.tsx` — Login form (email + password)
- `middleware.ts` — Check JWT cookie on protected routes, redirect to /login if missing
- `lib/auth.ts` — Helper functions: createToken, verifyToken, getCurrentUser, hashPassword

**JWT Token structure:**
```json
{
  "userId": "uuid",
  "email": "admin@myra.com",
  "role": "admin",
  "firstName": "Sarah",
  "lastName": "Chen",
  "iat": 1234567890,
  "exp": 1234654290
}
```

**Login flow:**
1. User enters email + password on /login
2. POST /api/auth/login validates against users table
3. On success: set httpOnly cookie with JWT, return user data
4. middleware.ts checks cookie on all routes except /login, /api/auth/login, /api/tracking/*
5. Protected API routes: extract user from JWT, use for assigned_rep and created_by

**Route protection matrix:**
| Route Pattern | Auth Required | Notes |
|---|---|---|
| /login | No | Public |
| /api/auth/login | No | Public |
| /api/tracking/[token]* | No | Token-based public |
| /api/drivers/me/* | Driver auth | Different JWT scope |
| /api/* | Yes | All other API routes |
| /* | Yes | All pages |

### A3. Settings & Profile Persistence

**Agents: A-Settings-Backend, A-Settings-Frontend, A-Profile-Backend, A-Profile-Frontend**

**Files to create/modify:**
- `app/api/settings/route.ts` — GET/PATCH settings from settings table
- `app/settings/page.tsx` — Wire all inputs to real API calls (currently buttons do nothing)
- `app/profile/page.tsx` — Wire to PATCH /api/auth/me (update users table)
- `app/api/auth/me/route.ts` — Add PATCH method for profile updates

**Settings to persist:** notification preferences, theme preference, default views, workspace mode.

### A4. Infrastructure Fixes

**Agents: A-Security, A-Infra**

- Fix `sql.unsafe()` in carriers/[id]/route.ts and loads/[id]/route.ts → use parameterized column mapping
- Add CORS middleware for Driver_App and One_pager origins
- Create `M1/MyraTMS/.env.example` with all env vars documented
- Delete `M1/MyraTMS/styles/globals.css` (stale duplicate)
- Standardize API error format: `{ error: string, details?: any }`

---

## 3. PHASE 1: CORE FEATURES (PARALLEL)

### TEAM B: Real-Time & Tracking System

**Goal:** Tracking tokens work, SSE streams live data, ETA calculates, exceptions alert, One_pager shows real data, check-calls persist.

#### B1. Tracking Token System
**Files to create:**
- `app/api/loads/[id]/tracking-token/route.ts` — POST: generate token, store in tracking_tokens + loads.tracking_token
- `app/api/tracking/[token]/route.ts` — GET: lookup token → load → join carrier/shipper → return PUBLIC data shape
- `app/api/tracking/[token]/events/route.ts` — GET: load_events for this load
- `app/api/tracking/[token]/sse/route.ts` — GET: SSE stream (sends event on location update, status change)

**Token generation:**
```typescript
import crypto from 'crypto'
const token = crypto.randomBytes(32).toString('hex') // 64-char hex
```

**Public tracking response shape (NO financials):**
```typescript
{
  loadNumber: string,       // loads.id
  referenceNumber: string,  // loads.reference_number
  poNumber: string,         // loads.po_number
  status: string,           // loads.status
  carrier: string,          // carriers.company
  shipper: string,          // shippers.company
  origin: { city, state, address, lat, lng, date, time },
  destination: { city, state, address, lat, lng, date, time },
  currentLat: number,
  currentLng: number,
  currentEta: string,       // ISO timestamp
  commodity: string,
  weight: string,
  equipment: string,
  events: LoadEvent[],
  isDelivered: boolean,
  podUrl: string | null,
  driver: { firstName: string, phone: string } | null,
  lastUpdated: string       // ISO timestamp
}
```

#### B2. Real-Time Engine
**Files to create:**
- `lib/sse.ts` — SSE utility (encoder, connection manager)
- `lib/eta.ts` — ETA calculation engine

**ETA calculation (per GPS ping):**
```
remaining_distance = haversine(current_lat, current_lng, dest_lat, dest_lng)
avg_speed = average of last 10 pings (or 55 mph default)
estimated_time = remaining_distance / avg_speed
predicted_arrival = now() + estimated_time + buffer(15 min)
IF predicted_arrival > delivery_date:
  → INSERT notification (type: 'warning', title: 'Delay Alert')
  → INSERT compliance_alert (severity: 'warning')
```

**Exception triggers:**
- ETA exceeds delivery by 30+ min → delay alert
- No GPS ping for 15+ min → communication alert
- Driver stationary at pickup for 2+ hrs → detention alert
- Route deviation > 50 miles from expected → deviation alert

#### B3. GPS Ingestion
**Files to create:**
- `app/api/loads/[id]/location/route.ts` — POST: store in location_pings, update loads.current_lat/lng/eta

**Request body:**
```json
{ "lat": 41.8781, "lng": -87.6298, "speed": 62.5, "heading": 180.0 }
```

**On each ping:**
1. INSERT into location_pings
2. UPDATE loads SET current_lat, current_lng, updated_at
3. Recalculate ETA → UPDATE loads SET current_eta
4. Check exception triggers
5. Update driver.last_known_lat/lng, last_ping_at

#### B4. Wire One_pager Tracking to Real Data

**Files to create/modify in `One_pager tracking/`:**
- `app/track/[token]/page.tsx` — NEW: Server component, fetch from MyraTMS API
- `app/track/[token]/tracking-client.tsx` — NEW: Client component with all the UI
- `app/page.tsx` — KEEP as demo/fallback with mock data

**Data mapping (API response → MOCK_SHIPMENT shape):**
```typescript
function mapApiToShipment(api: TrackingResponse): ShipmentData {
  return {
    loadNumber: api.referenceNumber || api.loadNumber,
    poNumber: api.poNumber || '',
    shipper: api.shipper,
    carrier: api.carrier,
    lastUpdated: formatRelativeTime(api.lastUpdated),
    status: mapStatus(api.status),  // map DB status to 6-value enum
    progress: calculateProgress(api.status, api.events),
    eta: formatEta(api.currentEta),
    currentCity: extractCity(api.currentLat, api.currentLng), // reverse geocode or last event location
    miles: calculateRemainingMiles(api),
    origin: { ...api.origin },
    destination: { ...api.destination },
    commodity: api.commodity,
    weight: api.weight,
    pieces: 0, // TODO: add pieces column
    events: api.events.map(mapEvent),
    isDelivered: api.isDelivered,
    podUrl: api.podUrl
  }
}
```

#### B5. Check-Calls & Send Tracking Link
**Files to create:**
- `app/api/check-calls/route.ts` — GET (filter by load_id) + POST (create)
- `app/api/loads/[id]/send-tracking/route.ts` — POST: generate token if needed, send email with tracking URL
- `lib/email.ts` — Email sending utility (nodemailer)

---

### TEAM C: External Integrations & Compliance

**Goal:** FMCSA verification is real, loadboard pulls real data, ELD GPS works, compliance alerts come from DB.

#### C1. FMCSA Integration
**Files to modify:**
- `app/api/compliance/verify/route.ts` — Replace empty stub with real FMCSA API call
- `app/api/compliance/alerts/route.ts` — Query compliance_alerts TABLE (not mock array)
- `app/api/compliance/batch/route.ts` — Real batch verification against DB carriers
- `app/compliance/page.tsx` — Remove mock imports, use SWR hooks hitting real API

**FMCSA API call:**
```
GET https://mobile.fmcsa.dot.gov/qc/services/carriers/{DOT_NUMBER}?webKey={FMCSA_API_KEY}
```

**Response mapping → carriers table update:**
- authority_status ← FMCSA allowedToOperate
- safety_rating ← FMCSA safetyRating
- insurance fields ← FMCSA insurance data
- vehicle_oos_percent, driver_oos_percent ← FMCSA OOS rates
- last_fmcsa_sync ← NOW()

**Auto-alert generation:** When FMCSA data shows issues (insurance expired, authority revoked, high OOS%), auto-INSERT into compliance_alerts.

#### C2. Loadboard Integration
**Files to modify:**
- `app/api/loadboard/search/route.ts` — Replace mock with real DAT + Truckstop API calls
- `app/api/loadboard/import/route.ts` — Actually INSERT into loads table
- `app/loadboard/page.tsx` — Remove mock imports, use SWR hooks

**DAT API:** `POST https://api.dat.com/search/loads` (requires DAT_API_KEY)
**Truckstop API:** `GET https://api.truckstop.com/search/v2/loads` (requires TRUCKSTOP_API_KEY)

**Redis caching:** Cache loadboard search results in Upstash Redis with 4-8hr TTL to minimize API calls.

**Graceful fallback:** If API keys not set, return mock data with `apiConnected: false` flag (existing pattern).

#### C3. ELD/GPS Provider Integration
**Files to modify:**
- `app/api/tracking/positions/route.ts` — Replace mock with real Samsara/Motive calls

**Samsara:** `GET https://api.samsara.com/v1/fleet/locations`
**Motive:** `GET https://api.gomotive.com/v1/vehicle_locations`

**Fallback chain:** Driver_App GPS pings (primary) → Samsara → Motive → mock data

---

### TEAM D: Driver PWA

**Goal:** Fully functional PWA that drivers install on their phones. Accept loads, navigate, update status, capture POD, stream GPS.

#### D1. Project Setup

**Create `M1/Driver_App/` with:**
```
Driver_App/
├── app/
│   ├── layout.tsx
│   ├── page.tsx              ← redirect to /login or /loads
│   ├── globals.css
│   ├── login/page.tsx
│   ├── loads/
│   │   ├── page.tsx          ← assigned load list
│   │   └── [id]/
│   │       └── page.tsx      ← load detail + status + nav
│   ├── manifest.json         ← PWA manifest (via route handler)
│   └── api/                  ← proxy routes to MyraTMS (optional)
├── components/
│   ├── ui/                   ← Shadcn components
│   ├── load-card.tsx
│   ├── status-flow.tsx
│   ├── gps-tracker.tsx
│   ├── pod-capture.tsx
│   ├── navigation-choice.tsx
│   └── map-view.tsx
├── lib/
│   ├── api.ts               ← fetch helpers pointing to MyraTMS
│   ├── gps.ts               ← Geolocation API wrapper
│   └── utils.ts             ← cn() helper
├── hooks/
│   ├── use-gps.ts
│   └── use-load-status.ts
├── public/
│   ├── sw.js                ← Service worker
│   ├── manifest.json
│   └── icons/               ← PWA icons (192, 512)
├── package.json
├── tsconfig.json
├── next.config.mjs
├── postcss.config.mjs
└── components.json
```

**package.json scripts:**
```json
{
  "dev": "next dev -p 3001",
  "build": "next build",
  "start": "next start -p 3001"
}
```

**PWA manifest:**
```json
{
  "name": "Myra Driver",
  "short_name": "Driver",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0f1e",
  "theme_color": "#f97316",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

#### D2. Driver Auth
- PIN-based: carrier selects from dropdown (or enters carrier code), driver enters 6-digit PIN
- POST to MyraTMS `/api/auth/driver-login` → validates against drivers table → returns JWT
- JWT stored in cookie, includes driver_id and carrier_id
- Auto-redirect to /loads on successful auth

#### D3. Load Screens
- `/loads` — GET /api/drivers/me/loads → list of assigned loads
- `/loads/[id]` — Full detail: origin/dest addresses, contact info, special instructions, map showing route
- Load accept: PATCH /api/loads/[id] with status 'accepted'

#### D4. Status Flow
**Sequential state machine:**
```
assigned → accepted → at_pickup → loaded/in_transit → at_delivery → delivered
```

Each button:
1. Shows only when status matches (e.g., "Arrived at Pickup" only when status === 'accepted')
2. On tap: PATCH /api/loads/[id] → status change
3. Create load_event for each transition
4. GPS tracking starts automatically when status = 'accepted'
5. POD capture triggers when status = 'at_delivery'

#### D5. GPS Background Tracking
```typescript
// hooks/use-gps.ts
navigator.geolocation.watchPosition(
  (position) => {
    fetch(`${API_URL}/api/loads/${loadId}/location`, {
      method: 'POST',
      body: JSON.stringify({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speed: position.coords.speed ? position.coords.speed * 2.237 : null, // m/s → mph
        heading: position.coords.heading
      })
    })
  },
  null,
  { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 }
)
```
Interval: POST every 30-60 seconds (configurable). Battery optimization: reduce accuracy when speed is consistent.

#### D6. POD Capture
- Camera API via `<input type="file" accept="image/*" capture="environment">`
- Photo preview with retake option
- Upload as FormData to POST /api/loads/[id]/pod (proxied to MyraTMS)
- On success: load status → 'delivered', pod_url set

#### D7. Navigation
- **In-app Mapbox:** Render route from origin → current → destination using Mapbox GL JS Directions API
- **Native maps:** Build deep link URLs:
  - Google Maps: `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}`
  - Apple Maps: `maps://maps.apple.com/?daddr={lat},{lng}`
- **Choice UI:** Toggle button, preference saved to localStorage

---

### TEAM E: TMS Completion & Polish

**Goal:** Every mock dependency replaced with real data. All pages fully functional. No more hardcoded "Sarah Chen."

#### E1. Workflows Persistence
**Files to create/modify:**
- `app/api/workflows/route.ts` — GET list + POST create (against workflows table)
- `app/api/workflows/[id]/route.ts` — PATCH update + DELETE
- `app/workflows/page.tsx` — Replace useState initializer with SWR hook, wire all CRUD to API

#### E2. Reports from Real Data
**Files to modify:**
- `app/reports/page.tsx` — Replace `import { loads, invoices } from '@/lib/mock-data'` with SWR hooks
- Create report query API routes as needed (or reuse existing list endpoints with filters)

#### E3. Intelligence Page
**Files to modify:**
- `app/intelligence/page.tsx` — Wire to existing POST /api/ai/analyze-risk + real DB data
- Replace all hardcoded risk data with AI-generated analysis

#### E4. Mock Data Cleanup (SYSTEMATIC)
Go through EVERY page file. For each one:
1. Check for `import ... from '@/lib/mock-data'`
2. Replace with appropriate SWR hook from lib/api.ts
3. If no SWR hook exists, create one in lib/api.ts

**Files known to import from mock-data.ts:**
- `app/compliance/page.tsx` — carriers, complianceAlerts
- `app/tracking/page.tsx` — trackingPositions
- `app/reports/page.tsx` — loads, invoices, shippers, carriers
- `app/finance/page.tsx` — agingReceivables (partial)
- `app/loadboard/page.tsx` — possibly
- `components/load-quick-view.tsx` — trackingPositions

#### E5. Notification Unification
- Remove in-memory mock notifications from workspace-context.tsx
- Wire useWorkspace().notifications to the useNotifications() SWR hook
- Single source: database only

#### E6. TMS Polish
- Replace every `"Sarah Chen"` hardcode with `getCurrentUser()` from auth
- Add "Send Tracking Link" button to load detail page
- Add "Assign Driver" dropdown to load detail (select from drivers table)
- Standardize on sonner toast everywhere (remove useToast references)

---

## 4. PHASE 2: INTEGRATION & TESTING

After all Phase 1 teams complete:

### End-to-End Smoke Test
1. Login to TMS as admin@myra.com
2. Create a load (origin: Chicago, dest: Atlanta)
3. Create a carrier + driver
4. Assign carrier + driver to load → tracking token auto-generates
5. Open Driver_App, login as driver
6. Driver accepts load
7. Driver taps "Navigate" → see both in-app and native map options
8. Driver arrives at pickup → status update flows to TMS
9. Driver loads → in_transit, GPS starts streaming
10. Open One_pager tracking at /track/[token] → see real load data, map, timeline
11. GPS pings update position in real-time on tracking page
12. ETA calculates correctly, exception triggers if delayed
13. Driver arrives at delivery → captures POD photo
14. POD appears on tracking page
15. Load marked delivered → invoice can be generated in TMS
16. Compliance: verify a carrier via FMCSA → real data returns
17. Loadboard: search → real DAT/Truckstop results (if keys configured)

### Security Checklist
- [ ] JWT tokens expire appropriately (24hr for TMS, 72hr for driver)
- [ ] Tracking tokens can't access financial data
- [ ] SQL injection via sql.unsafe() eliminated
- [ ] CORS only allows known origins
- [ ] File upload validates type and size
- [ ] Password hashing uses bcrypt with appropriate salt rounds
- [ ] Auth cookies are httpOnly + secure + sameSite

---

## 5. TEAM ROSTERS

### Team A: Foundation & Infrastructure (21 agents)
| ID | Role | Responsibility |
|---|---|---|
| A1 | Schema Architect | Design migration SQL, validate schema completeness |
| A2 | Migration Engineer | Write + execute migration scripts, verify data integrity |
| A3 | Auth Architect | Design auth flow, JWT structure, session management |
| A4 | Auth Backend Engineer | POST /api/auth/login, logout, me routes |
| A5 | Auth Frontend Engineer | Login page, protected route redirects |
| A6 | Auth Middleware Engineer | Next.js middleware.ts, route protection |
| A7 | Session Engineer | JWT cookie management, token refresh |
| A8 | Settings Backend | GET/PATCH /api/settings routes |
| A9 | Settings Frontend | Wire settings page inputs to API |
| A10 | Profile Backend | PATCH /api/auth/me for profile updates |
| A11 | Profile Frontend | Wire profile page to API, password change |
| A12 | CORS Engineer | Cross-origin config for Driver_App + One_pager |
| A13 | Error Standardizer | Consistent API error format across all routes |
| A14 | SQL Security | Fix sql.unsafe() injection, parameterize all queries |
| A15 | DB Indexer | Create indexes for new tables, optimize queries |
| A16 | Seed Engineer | Update seed scripts for new schema + test drivers |
| A17 | Env Config | Create .env.example, document all variables |
| A18 | Test Engineer 1 | Auth integration tests |
| A19 | Test Engineer 2 | Schema + migration validation tests |
| A20 | Security Analyst | Auth flow review, token security |
| A21 | Tech Writer | Document auth system, update CLAUDE.md |

### Team B: Real-Time & Tracking (22 agents)
| ID | Role | Responsibility |
|---|---|---|
| B1 | Token Architect | Design token generation, validation, expiry |
| B2 | Token API Engineer | POST /api/loads/[id]/tracking-token |
| B3 | Public Tracking API | GET /api/tracking/[token] — public data endpoint |
| B4 | Events API Engineer | GET /api/tracking/[token]/events |
| B5 | SSE Engineer | GET /api/tracking/[token]/sse — live stream |
| B6 | ETA Engine | lib/eta.ts — haversine, speed calc, prediction |
| B7 | Exception Engine | Delay/detention/deviation detection + alerts |
| B8 | GPS API Engineer | POST /api/loads/[id]/location |
| B9 | Location Storage | Efficient location_pings INSERT + loads UPDATE |
| B10 | Load Events System | Insert events on status changes, check-calls |
| B11 | Check-Call Backend | POST/GET /api/check-calls |
| B12 | Check-Call Frontend | Wire TMS tracking page form to API |
| B13 | One_pager Token Route | app/track/[token]/page.tsx in One_pager |
| B14 | One_pager Data Fetch | Server-side fetch + error/404 states |
| B15 | One_pager Mapping | Map API response → MOCK_SHIPMENT shape |
| B16 | One_pager Polish | Loading skeletons, carrier card extraction |
| B17 | TMS Tracking Wire | Replace mock tracking data in TMS with real API |
| B18 | Send Tracking Link | Email integration + TMS button |
| B19 | TMS Real-Time | SSE/polling for dashboard load status updates |
| B20 | Test Engineer 1 | Tracking API + token tests |
| B21 | Test Engineer 2 | ETA, exception, SSE tests |
| B22 | Security Analyst | Token security, public endpoint data exposure |

### Team C: External Integrations (20 agents)
| ID | Role | Responsibility |
|---|---|---|
| C1 | FMCSA Architect | Design integration pattern, error handling |
| C2 | FMCSA API Engineer | Real FMCSA API calls in compliance/verify |
| C3 | FMCSA Data Mapper | Map FMCSA response → carrier fields + alerts |
| C4 | Compliance Alert Engine | Auto-generate alerts from FMCSA data |
| C5 | Compliance Frontend | Wire page to real API, remove mock imports |
| C6 | DAT API Engineer | Real DAT load/rate search |
| C7 | Truckstop API Engineer | Real Truckstop load search |
| C8 | Loadboard Aggregator | Combine + deduplicate multi-source results |
| C9 | Loadboard Import Engine | Persist imported loads to DB |
| C10 | Loadboard Frontend | Wire page to real API, remove mock imports |
| C11 | Samsara Engineer | Real GPS from Samsara ELD API |
| C12 | Motive Engineer | Real GPS from Motive ELD API |
| C13 | ELD Normalizer | Normalize GPS from different providers |
| C14 | Redis Cache Engineer | Cache API responses in Upstash Redis |
| C15 | API Key Manager | Secure env handling, graceful fallback pattern |
| C16 | Webhook Handler | Incoming webhooks from external services |
| C17 | Integration Test 1 | FMCSA + compliance tests |
| C18 | Integration Test 2 | Loadboard + ELD tests |
| C19 | Security Analyst | API key security, external data sanitization |
| C20 | Tech Writer | Integration documentation |

### Team D: Driver PWA (24 agents)
| ID | Role | Responsibility |
|---|---|---|
| D1 | Project Architect | Next.js setup, folder structure, config |
| D2 | PWA Engineer | manifest.json, service worker, install flow |
| D3 | Auth Architect | PIN-based auth design |
| D4 | Auth Engineer | Login screen + driver auth API |
| D5 | Load List Engineer | /loads page — assigned loads screen |
| D6 | Load Detail Engineer | /loads/[id] — full detail screen |
| D7 | Status Flow Architect | State machine design |
| D8 | Status UI Engineer | Sequential status buttons + visual flow |
| D9 | Status API Engineer | PATCH calls + load_event creation |
| D10 | GPS Core Engineer | Geolocation API wrapper, watchPosition |
| D11 | GPS Background | Service worker GPS, battery optimization |
| D12 | GPS API Engineer | POST /api/loads/[id]/location interval |
| D13 | POD Camera | Camera API, photo capture |
| D14 | POD Upload | Upload flow + Vercel Blob |
| D15 | POD Review UI | Preview, retake, confirm screens |
| D16 | Mapbox Engineer | In-app map rendering + route display |
| D17 | Native Nav Engineer | Google Maps + Apple Maps deep links |
| D18 | Nav Choice UI | Toggle between in-app and native, save preference |
| D19 | UI/UX Lead | Mobile-first design system, theme |
| D20 | Offline Engineer | Service worker caching, offline fallback |
| D21 | Onboarding | First-time driver setup flow |
| D22 | Test Engineer 1 | PWA + GPS tests |
| D23 | Test Engineer 2 | Status flow + POD tests |
| D24 | Security Analyst | PIN security, GPS privacy, data handling |

### Team E: TMS Completion (20 agents)
| ID | Role | Responsibility |
|---|---|---|
| E1 | Workflows Backend | Workflows table + CRUD API routes |
| E2 | Workflows Engine | Trigger execution, condition evaluation logic |
| E3 | Workflows Frontend | Wire page to real API |
| E4 | Reports Backend | Real DB queries for reports |
| E5 | Reports Engine | Configurable report builder |
| E6 | Reports Frontend | Wire page to real API, real data |
| E7 | Intelligence Backend | Wire to AI analyze-risk |
| E8 | Intelligence Frontend | Replace hardcoded data |
| E9 | Aging Receivables | Compute from real invoice data, replace mock |
| E10 | Notification Sync | Unify DB + context to DB-only |
| E11 | Mock Cleanup Lead | Systematic removal of all mock imports |
| E12 | Dashboard Engineer | Real KPIs from DB aggregates |
| E13 | Load Detail Polish | Assign driver UI, send tracking link button |
| E14 | Auth Integration | Replace "Sarah Chen" with session user everywhere |
| E15 | Toast Standardizer | Migrate all useToast → sonner |
| E16 | Email Service | Nodemailer setup, tracking link email template |
| E17 | Stale File Cleanup | Delete unused files, unused mock-data exports |
| E18 | Test Engineer 1 | Workflows + reports tests |
| E19 | Test Engineer 2 | Mock cleanup validation tests |
| E20 | QA Lead | Cross-cutting integration verification |

---

## 6. DEPENDENCY GRAPH

```
Phase 0:
  A-SCHEMA ──────► ALL Phase 1 teams (schema must exist)
  A-AUTH ──────────► ALL Phase 1 teams (auth middleware must work)
  A-INFRA ─────────► ALL Phase 1 teams (CORS, error format)

Phase 1 (internal dependencies):
  B-TOKENS ──────► B-ONEPAGER (need token API before wiring tracking page)
  B-GPS ──────────► B-REALTIME (need GPS data before ETA calc works)
  B-REALTIME ────► B-SSE (ETA data feeds SSE stream)
  D-SETUP ───────► ALL D-* tasks (project must exist first)
  D-AUTH ─────────► D-LOADS, D-STATUS, D-GPS, D-POD (need auth first)
  D-STATUS ──────► D-POD (POD capture triggers on delivery status)
  C-FMCSA ───────► C-COMPLIANCE-FE (need real API before wiring frontend)
  E-AUTH-INTEGRATION ─► after A-AUTH completes
  E-MOCK-CLEANUP ────► after B, C complete (need real APIs before removing mocks)

Phase 2:
  ALL Phase 1 ──► Integration testing
```

---

## 7. FILE OWNERSHIP MATRIX

**Rule: Only the owning team modifies these files. Request changes via progress.md.**

| File/Directory | Owner | Notes |
|---|---|---|
| `scripts/010-m1-migration.sql` | Team A | Schema changes only through A |
| `middleware.ts` | Team A | Auth middleware |
| `lib/auth.ts` | Team A | Auth helpers |
| `app/api/auth/*` | Team A | Auth routes |
| `app/login/*` | Team A | Login page |
| `app/settings/page.tsx` | Team A | Settings UI |
| `app/profile/page.tsx` | Team A | Profile UI |
| `app/api/tracking/*` | Team B | Public tracking routes |
| `app/api/loads/[id]/tracking-token/*` | Team B | Token generation |
| `app/api/loads/[id]/location/*` | Team B | GPS ingestion |
| `app/api/check-calls/*` | Team B | Check-call routes |
| `app/api/loads/[id]/send-tracking/*` | Team B | Send tracking link |
| `lib/sse.ts` | Team B | SSE utilities |
| `lib/eta.ts` | Team B | ETA calculation |
| `lib/email.ts` | Team B | Email sending |
| `One_pager tracking/*` | Team B | All tracking page changes |
| `app/api/compliance/*` | Team C | Compliance routes |
| `app/api/loadboard/*` | Team C | Loadboard routes |
| `app/api/tracking/positions/*` | Team C | ELD GPS route |
| `app/compliance/page.tsx` | Team C | Compliance UI |
| `app/loadboard/page.tsx` | Team C | Loadboard UI |
| `lib/redis.ts` | Team C | Redis caching |
| `Driver_App/*` | Team D | Entire new app |
| `app/api/drivers/*` | Team D + A | Driver CRUD routes |
| `app/api/workflows/*` | Team E | Workflow routes |
| `app/workflows/page.tsx` | Team E | Workflows UI |
| `app/reports/page.tsx` | Team E | Reports UI |
| `app/intelligence/page.tsx` | Team E | Intelligence UI |
| `app/finance/page.tsx` | Team E | Finance fixes |
| `app/tracking/page.tsx` | Team E | TMS tracking page |
| `lib/api.ts` | Team E | SWR hooks (add new hooks here) |
| `lib/workspace-context.tsx` | Team E | Notification unification |
| `components/app-shell.tsx` | Team E | Shell updates |

---

## 8. AGENT EXECUTION PROTOCOL

### Before Writing Code
1. Read `memory.md` — understand all locked decisions
2. Read `progress.md` — check your task status, check for blockers
3. Read `CLAUDE.md` — understand existing codebase conventions
4. Read relevant existing files — understand patterns before modifying

### While Writing Code
1. Follow ALL conventions in memory.md Section 4
2. Use existing patterns (SWR hooks, API route structure, component patterns)
3. Do NOT modify files owned by other teams
4. Do NOT import from lib/mock-data.ts in new code (use real API/DB)
5. Use `"use client"` only when necessary (interactive components)
6. Use sonner toast (not useToast hook)
7. Use date-fns for date formatting
8. Handle errors gracefully — never silent failures

### After Writing Code
1. Update progress.md — mark your task complete
2. Log in the AGENT LOG section with timestamp
3. If you created a new API route, document it in memory.md Section 3
4. If you discovered a new issue, log it in memory.md Section 7
5. If blocked, mark task as [!] in progress.md with explanation

### Agent Communication
- **Need schema change?** → Log request in progress.md, tag Team A
- **Need new SWR hook?** → Log request in progress.md, tag Team E
- **Found a bug?** → Log in progress.md with details
- **Conflicting with another team?** → Stop, log in progress.md, wait for resolution
