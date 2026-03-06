# DApp Design Document — Driver App Replacement

**Date:** 2026-02-28
**Status:** Approved
**Replaces:** `Driver_App/`

## 1. Architecture & Navigation

### Navigation: 5-Tab Bottom Bar
| Tab | Icon | Purpose |
|-----|------|---------|
| **Map** | MapPin | Full-screen Mapbox dark map, driver position, active route, floating glass status card |
| **Active** | Truck | Current load dashboard — status stepper, pickup/delivery details, action buttons |
| **Loads** | Package | Available & completed loads list with filters, accept/decline workflow |
| **Docs** | FileText | BOL viewer, POD camera capture, document upload gallery |
| **Profile** | User | Driver info, settings, hours, notification preferences |

### Auth Flow
- **PIN-based login**: Carrier Code + 6-digit PIN
- JWT stored in `localStorage` (72-hour expiry, auto-refresh)
- `driverFetch()` wrapper adds `Authorization: Bearer <token>` to all API calls
- Unauthenticated requests redirect to `/login`

### API Strategy
- Direct calls to MyraTMS API at `NEXT_PUBLIC_API_URL` (same pattern as One_pager tracking)
- `driverFetch()` utility in `lib/driver-fetch.ts`
- All endpoints under `/api/driver/*` on the TMS side

### Theme
- **Dark-first** design (always dark, no light mode toggle)
- **Amber/gold accent**: `oklch(0.80 0.16 75)` — distinct from TMS blue
- Glass panels: `backdrop-filter: blur(12px)` + semi-transparent surfaces
- Keep existing DApp shell's theme system and T constants

## 2. Feature Inventory

### Authentication
- Login screen with Carrier Code + PIN fields
- JWT persistence in localStorage
- Auto-logout on token expiry
- Protected route wrapper

### Map Tab
- Full-screen Mapbox GL (dark-v11 style)
- Driver GPS position (pulsing marker)
- Active load route line (origin → driver → destination)
- Origin/destination markers with gradient icons
- Floating glass card: load number, status, ETA, next action button
- Auto-center on driver position

### Active Tab
- Visual status stepper (Booked → Picked Up → In Transit → Delivered)
- Pickup/delivery detail cards with addresses, times, contacts
- One-tap status advancement buttons
- Check-call submission form
- Load details: commodity, weight, pieces, PO numbers
- Carrier/driver info display

### Loads Tab
- Available loads list (loads assigned to driver's carrier)
- Completed loads history
- Search & filter (date, status, origin/destination)
- Load detail bottom sheet on tap
- Accept/decline workflow for available loads

### Documents Tab
- BOL viewer (PDF/image display)
- POD camera capture with device camera
- Document upload to Vercel Blob via TMS API
- Document gallery with thumbnails
- Status indicators (pending, uploaded, verified)

### Profile Tab
- Driver name, carrier info, truck/trailer details
- Notification preferences
- Hours of service display
- App version, support link
- Logout button

### GPS Tracking
- `navigator.geolocation.watchPosition()` for real-time position
- POST to TMS every 30 seconds
- IndexedDB offline queue (drain when online)
- Background GPS via service worker

### PWA
- Service worker for offline caching
- App manifest (name: "Myra Driver", amber theme)
- Install prompt
- Push notification support
- Offline indicator banner

## 3. Implementation Phases

### Phase 0: Foundation (Parallel)
- Environment setup (.env.local, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_MAPBOX_TOKEN)
- Auth system (login page, JWT storage, driverFetch, protected routes)
- Theme finalization (T constants, glass panel component, amber accent tokens)
- Shared components (GlassPanel, StatusBadge, LoadCard, BottomSheet)
- 5-tab navigation shell

### Phase 1: Core Screens (Parallel after Phase 0)
- Login screen (Carrier Code + PIN, JWT flow)
- Map tab (Mapbox, driver marker, route, floating status card)
- Active tab (status stepper, details, action buttons)
- Loads tab (list, filters, load detail sheet)

### Phase 2: Load Lifecycle (Parallel after Phase 1)
- Status flow (one-tap advancement, check-calls)
- Load detail bottom sheet (full info, documents link)
- GPS tracking system (watchPosition, 30s POST, IndexedDB queue)
- Navigation panel (turn-by-turn link to Google/Apple Maps)

### Phase 3: Remaining Features (Parallel after Phase 2)
- POD capture (camera, upload, gallery)
- Documents tab (BOL viewer, upload, thumbnails)
- Profile tab (driver info, settings, logout)
- Push notifications (service worker registration, TMS webhook)

### Phase 4: Polish & PWA (Sequential)
- Service worker (offline caching, background sync)
- Loading skeletons for all screens
- Micro-animations (page transitions, status changes)
- Build verification across all apps
- PWA install prompt and offline banner

## 4. Technical Constraints

- DApp already has 42 Shadcn/UI components installed — reuse them
- Keep existing DApp shell structure (app/, components/, lib/, hooks/)
- TMS API endpoints under `/api/driver/*` need to be created in MyraTMS
- Mapbox token shared across all 3 apps via env var
- Must build clean (`pnpm run build`) with zero errors
