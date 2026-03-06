# Myra M1 — Missing Features & Action Plan

> Comprehensive audit of all deferred, incomplete, and future features across all 3 apps.
> Generated: 2026-02-28
> Source: MASTER-PLAN.md, progress.md, memory.md, codebase TODOs, API route audit

---

## STATUS KEY
- `P0` — Critical: breaks core flow or security risk
- `P1` — High: needed for production launch
- `P2` — Medium: polish, optimization, or nice-to-have for MVP
- `P3` — Future: post-launch features

---

## 1. SECURITY & AUTH HARDCODES (P0)

### 1.1 "Sarah Chen" Hardcoded in API Routes
Several API routes hardcode "Sarah Chen" as the user instead of reading from the JWT session.

| File | Line | Fix |
|------|------|-----|
| `app/api/loads/route.ts` | 35 | Replace `${"Sarah Chen"}` with `${user.firstName} ${user.lastName}` |
| `app/api/shippers/route.ts` | 25 | Replace `${"Sarah Chen"}` with `${user.firstName} ${user.lastName}` |
| `app/api/notes/route.ts` | 23 | Replace `${"Sarah Chen"}` with `${user.firstName} ${user.lastName}` |
| `app/api/documents/upload/route.ts` | 33 | Replace `${"Sarah Chen"}` with `${user.firstName} ${user.lastName}` |
| `app/shippers/page.tsx` | 79, 110 | Use session user as default `assignedRep` |

**Effort:** Small (30 min). Each route already calls `getCurrentUser(req)`.

### 1.2 ignoreBuildErrors Still Enabled
All 3 apps have `ignoreBuildErrors: true` in next.config.mjs. This hides TypeScript errors.

| App | File |
|-----|------|
| MyraTMS | `next.config.mjs:4` |
| Driver_App | `next.config.mjs:4` |
| One_pager tracking | `next.config.mjs:4` |

**Fix:** Run `pnpm run build` with `ignoreBuildErrors: false`, fix any TS errors, then remove the flag.

---

## 2. MISSING TMS FEATURES (P1)

### 2.1 Assign Driver to Load
The load detail page has no UI to assign a driver/carrier to a load. The `useDrivers()` SWR hook exists in `lib/api.ts` but the dropdown is not wired into the load detail page.

**Files:** `app/loads/[id]/page.tsx`
**API:** `PATCH /api/loads/[id]` already supports `driver_id` and `carrier_id` updates
**Effort:** Medium (1-2 hrs)

### 2.2 Send Tracking Link Button (Email)
The "Send Tracking Link" API exists (`POST /api/loads/[id]/send-tracking`) but there's no button in the load detail UI. The Share Load button generates the link but doesn't email it.

**Files:** `app/loads/[id]/page.tsx` — add email input + send button to the Share Load popover
**API:** Already exists, sends HTML email via nodemailer
**Depends on:** SMTP env vars configured
**Effort:** Small (30 min)

### 2.3 Load Creation Form
The loads page has a "New Load" button but the create form needs validation and all fields wired.

**Files:** `app/loads/page.tsx`
**Needs:** Origin/destination autocomplete, shipper/carrier dropdowns, equipment selector, date pickers
**Effort:** Medium (2-3 hrs)

### 2.4 Invoice Generation from Load
The load detail has a "Create Invoice" button that currently does nothing.

**Files:** `app/loads/[id]/page.tsx`, `app/api/invoices/route.ts`
**Needs:** Auto-populate invoice from load data (revenue, shipper, dates), POST to invoices API
**Effort:** Medium (1-2 hrs)

### 2.5 Document Upload Flow
The "Upload Doc" button on load detail exists but the actual upload-to-Vercel-Blob flow needs testing and the `BLOB_READ_WRITE_TOKEN` env var.

**Files:** `app/api/documents/upload/route.ts`
**Depends on:** `BLOB_READ_WRITE_TOKEN` env var
**Effort:** Small (verify + test)

### 2.6 Carrier Create/Edit Form Improvements
The carrier creation form works but lacks FMCSA auto-verify on MC number entry and DOT number lookup.

**Files:** `app/carriers/page.tsx`
**Needs:** On MC/DOT entry, auto-call FMCSA verify endpoint and populate fields
**Effort:** Medium (1-2 hrs)

---

## 3. SCHEDULED & AUTOMATED TASKS (P1)

### 3.1 Periodic FMCSA Re-verification
Carriers need automatic re-verification every 30 days. Currently manual-only.

**Implementation:** Vercel Cron Job
**Files to create:** `app/api/cron/fmcsa-reverify/route.ts`
**Config:** Add to `vercel.json` cron schedule
**Effort:** Medium (1-2 hrs)

### 3.2 Workflow Engine Execution
Workflows can be created/edited/toggled but the trigger engine doesn't actually execute them. When a load status changes, matching workflows should fire their actions.

**Files to create:** `lib/workflow-engine.ts`
**Triggers:** `status_change`, `new_load`, `delivery_complete`, `invoice_overdue`
**Actions:** `send_email`, `create_notification`, `update_status`, `assign_carrier`
**Effort:** Large (4-6 hrs)

### 3.3 Overdue Invoice Alerts
No automated alerting when invoices pass their due date. Should auto-create notifications.

**Implementation:** Vercel Cron Job or workflow trigger
**Files to create:** `app/api/cron/invoice-alerts/route.ts`
**Effort:** Small (1 hr)

---

## 4. EXTERNAL INTEGRATIONS (P1-P2)

### 4.1 SMTP Email Configuration
Email sending is built (`lib/email.ts` via nodemailer) but gracefully skips when SMTP vars aren't set. Needs real SMTP credentials for production.

**Env vars needed:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`
**Effort:** Config only (15 min)

### 4.2 AI Assistant API Key
The AI chat assistant and risk analysis endpoints need the XAI API key.

**Env var needed:** `XAI_API_KEY`
**Files affected:** `app/api/ai/chat/route.ts`, `app/api/ai/analyze-risk/route.ts`
**Effort:** Config only (5 min)

### 4.3 Vercel Blob Storage
Document upload needs the Blob token for production file storage.

**Env var needed:** `BLOB_READ_WRITE_TOKEN`
**Effort:** Config only (5 min)

### 4.4 DAT / Truckstop Live Loadboard
Currently uses mock data fallback. Real integration requires API keys and account setup.

**Env vars needed:** `DAT_API_KEY`, `TRUCKSTOP_API_KEY`
**Status:** Code is built, API calls are real, fallback to mock is seamless
**Effort:** Config + account setup

### 4.5 Samsara / Motive ELD GPS
GPS currently relies on Driver App pings or mock fallback. Real ELD integration requires API keys.

**Env vars needed:** `SAMSARA_API_KEY`, `MOTIVE_API_KEY`
**Status:** Code is built with fallback chain
**Effort:** Config + account setup

### 4.6 FMCSA API Key
Compliance verification falls back to DB data without the FMCSA key.

**Env var needed:** `FMCSA_API_KEY`
**Status:** Code is built, mock fallback works
**Effort:** Config only (free API key from FMCSA)

---

## 5. DRIVER APP (P1)

### 5.1 UI Replacement
Pat will provide a custom frontend design. The current functional backend (API integration, auth, status flow, GPS, POD) stays — only the UI layer gets replaced.

**Status:** Waiting for Pat's frontend files
**Effort:** Medium-Large (depends on scope of new design)

### 5.2 POD Upload to Vercel Blob
Camera capture works but actual upload to Vercel Blob needs the `BLOB_READ_WRITE_TOKEN` and the MyraTMS `POST /api/loads/[id]/pod` endpoint to handle file storage.

**Files:** `Driver_App/app/loads/[id]/page.tsx`, `MyraTMS/app/api/loads/[id]/pod/route.ts`
**Depends on:** `BLOB_READ_WRITE_TOKEN`
**Effort:** Small-Medium (1-2 hrs)

### 5.3 Background GPS via Service Worker
GPS tracking currently uses foreground `watchPosition`. Background tracking via service worker would improve reliability when the app is minimized.

**Files:** `Driver_App/public/sw.js`
**Effort:** Medium (2-3 hrs) — browser support varies

### 5.4 Push Notifications
Driver notifications (new load assigned, status reminders) via Web Push API.

**Files to create:** Push subscription endpoint, notification service
**Effort:** Medium (2-3 hrs)

### 5.5 Offline Fallback Page
Service worker should cache the app shell and show a fallback page when offline.

**Files:** `Driver_App/public/sw.js`
**Effort:** Small (1 hr)

### 5.6 Auto-Logout on Token Expiry
Driver JWT expires after 72hrs but the app doesn't automatically detect expiry and redirect to login.

**Files:** `Driver_App/lib/api.ts`
**Fix:** Check 401 responses and redirect to /login
**Effort:** Small (30 min)

---

## 6. ONE_PAGER TRACKING (P2)

### 6.1 Synthetic Event Fallback
When the API returns no events, the tracking page generates synthetic events based on status. These should be replaced with real events once drivers actively use the status flow.

**Files:** `One_pager tracking/app/track/[token]/page.tsx:124-181`
**Status:** Self-resolving as real usage generates events
**Effort:** None — works correctly

### 6.2 Reverse Geocoding for Current City
The "current city" display uses the last event location. Could be improved with real reverse geocoding from lat/lng coordinates.

**Implementation:** Mapbox or OpenCage reverse geocoding API
**Effort:** Small (1 hr)

---

## 7. PERFORMANCE & POLISH (P2)

### 7.1 Loading Skeletons Across All Pages
Several TMS pages show "Loading..." text instead of proper skeleton UI. Affected pages:

| Page | Current | Needed |
|------|---------|--------|
| `loads/[id]` | "Loading load details..." text | Skeleton cards |
| `carriers/[id]` | Similar text loading | Skeleton cards |
| `shippers/[id]` | Similar text loading | Skeleton cards |
| Intelligence | Spinner icon | Skeleton dashboard |
| Reports | Spinner icon | Skeleton cards |

**Effort:** Medium (2-3 hrs for all pages)

### 7.2 SWR Cache Optimization
SWR hooks in `lib/api.ts` should use `dedupingInterval` and `revalidateOnFocus` settings to reduce unnecessary API calls during rapid navigation.

**Files:** `lib/api.ts`
**Effort:** Small (30 min)

### 7.3 Page Transition Speed
Consider prefetching data on link hover and using Next.js `<Link prefetch>` for critical navigation paths (Dashboard → Loads → Load Detail).

**Files:** Sidebar links in `components/app-sidebar.tsx`
**Effort:** Small (30 min)

### 7.4 Image Optimization
All 3 apps have `unoptimized: true` in next.config.mjs. Should enable Next.js Image optimization for production.

**Files:** All 3 `next.config.mjs` files
**Effort:** Small (15 min)

---

## 8. TECH DEBT (P2)

### 8.1 mock-data.ts Still Exists
`lib/mock-data.ts` is no longer imported by any page but still exists in the codebase. Contains TypeScript interfaces that some files reference indirectly.

**Fix:** Extract interfaces to `lib/types.ts`, then delete `mock-data.ts`
**Effort:** Medium (1-2 hrs)

### 8.2 No Test Runner
No vitest/jest configured. Zero automated tests.

**Fix:** Add vitest, write API route tests for critical paths (auth, tracking, loads CRUD)
**Effort:** Large (4-6 hrs for initial setup + key tests)

### 8.3 Dual Toast System Remnants
Some older components may still reference `useToast` instead of `sonner`.

**Fix:** Grep for `useToast` and replace with `toast` from sonner
**Effort:** Small (30 min)

---

## 9. FUTURE FEATURES (P3 — Post-Launch)

These were explicitly deferred in the MASTER-PLAN:

| Feature | Description |
|---------|-------------|
| Quoting Engine | Rate cache, fuel surcharge calc, margin targeting |
| Carrier Matching | Scoring algorithm based on performance, lane history, capacity |
| ML Pricing Model | Predictive rate suggestions based on historical data |
| Shipper Self-Service Portal | Customer portal for load booking and tracking |
| Automated Dispatch | AI-driven carrier selection and load assignment |
| Multi-tenant Support | Multiple brokerage companies on one instance |

---

## ACTION PLAN — Priority Order

### Sprint 1: Security & Critical Fixes (P0)
1. Fix all "Sarah Chen" hardcodes in API routes (30 min)
2. Disable `ignoreBuildErrors`, fix TS errors (1-2 hrs)

### Sprint 2: Missing TMS Features (P1)
3. Assign Driver dropdown on load detail page (1-2 hrs)
4. Send Tracking Link email button in Share Load popover (30 min)
5. Invoice creation from load detail (1-2 hrs)
6. Load creation form validation & dropdowns (2-3 hrs)
7. FMCSA auto-verify on carrier MC number entry (1-2 hrs)

### Sprint 3: Automation & Integrations (P1)
8. Workflow engine execution (4-6 hrs)
9. FMCSA cron re-verification (1-2 hrs)
10. Overdue invoice alert cron (1 hr)
11. Configure SMTP for email sending (15 min)
12. Configure XAI API key for AI assistant (5 min)

### Sprint 4: Driver App (P1)
13. Replace Driver App UI with Pat's custom frontend (TBD)
14. POD upload to Vercel Blob (1-2 hrs)
15. Auto-logout on token expiry (30 min)
16. Offline fallback page (1 hr)

### Sprint 5: Polish & Performance (P2)
17. Loading skeletons for all detail pages (2-3 hrs)
18. SWR cache optimization (30 min)
19. Page transition prefetching (30 min)
20. Enable image optimization (15 min)
21. Extract types from mock-data.ts, delete file (1-2 hrs)

### Sprint 6: Testing & Hardening (P2)
22. Set up vitest + write critical path tests (4-6 hrs)
23. Background GPS service worker (2-3 hrs)
24. Push notifications for drivers (2-3 hrs)
25. Reverse geocoding for tracking current city (1 hr)

### Future Sprints (P3)
26+ Quoting engine, carrier matching, ML pricing, shipper portal, automated dispatch
