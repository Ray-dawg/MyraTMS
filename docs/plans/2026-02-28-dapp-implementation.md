# DApp Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the DApp shell (mock-data-only, 3-tab UI) into a fully functional driver app with authentication, real API data, GPS tracking, POD capture, documents, and profile management — replacing the old Driver_App entirely.

**Architecture:** Next.js 16 App Router, single `app/page.tsx` client shell with 5-tab navigation. All data flows through `driverFetch()` to MyraTMS API at `NEXT_PUBLIC_API_URL`. Auth via carrier code + PIN → JWT in localStorage. GPS via `watchPosition` + 30s interval POST. Always-dark amber/gold theme.

**Tech Stack:** Next.js 16, React 19, TypeScript, TailwindCSS 4.x (oklch), Shadcn/UI, Mapbox GL JS, Sonner toasts, Vercel Blob (POD uploads via TMS), PWA service worker.

**No test runner is configured.** Verification steps use `pnpm run build` and manual browser checks.

---

## Task 1: Environment & Dependencies

**Files:**
- Create: `DApp/.env.local`
- Modify: `DApp/package.json` (add `react-map-gl`)

**Step 1: Create `.env.local`**

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1IjoicmF5ODgxNiIsImEiOiJjbW03NGNhYWowb3U1MnBvbXRrbmRweHI5In0.zjje1mFqa7bSpeSsgjgzSw
```

**Step 2: Install react-map-gl**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm add react-map-gl`

**Step 3: Verify**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm run build`
Expected: Build succeeds.

---

## Task 2: Auth Library — `lib/driver-fetch.ts`

Port the authentication utilities from the old Driver_App (`Driver_App/lib/api.ts`).

**Files:**
- Create: `DApp/lib/driver-fetch.ts`

**Step 1: Create `DApp/lib/driver-fetch.ts`**

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('driver-token')
}

export function setStoredToken(token: string) {
  localStorage.setItem('driver-token', token)
}

export function clearStoredToken() {
  localStorage.removeItem('driver-token')
  localStorage.removeItem('driver-info')
}

export interface DriverInfo {
  id: string
  firstName: string
  lastName: string
  carrierId: string
  carrierName: string
}

export function getDriverInfo(): DriverInfo | null {
  if (typeof window === 'undefined') return null
  const info = localStorage.getItem('driver-info')
  if (!info) return null
  try { return JSON.parse(info) } catch { return null }
}

export function setDriverInfo(info: DriverInfo) {
  localStorage.setItem('driver-info', JSON.stringify(info))
}

function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch { return null }
}

export function isTokenExpired(): boolean {
  const token = getStoredToken()
  if (!token) return true
  const payload = decodeTokenPayload(token)
  if (!payload || typeof payload.exp !== 'number') return true
  return payload.exp - Math.floor(Date.now() / 1000) <= 60
}

export function isAuthenticated(): boolean {
  return !!getStoredToken() && !isTokenExpired()
}

export function checkTokenExpiry(): void {
  if (typeof window === 'undefined') return
  if (!getStoredToken()) return
  if (isTokenExpired()) {
    clearStoredToken()
    window.location.href = '/login'
  }
}

export function startTokenExpiryMonitor(): () => void {
  const id = setInterval(() => {
    if (!getStoredToken()) return
    if (isTokenExpired()) {
      clearStoredToken()
      if (typeof window !== 'undefined') window.location.href = '/login'
    }
  }, 30_000)
  return () => clearInterval(id)
}

export async function driverFetch(path: string, options?: RequestInit): Promise<Response> {
  checkTokenExpiry()
  const token = getStoredToken()
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (!(options?.body instanceof FormData)) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (response.status === 401) {
    clearStoredToken()
    if (typeof window !== 'undefined') window.location.href = '/login'
  }
  return response
}

export async function driverLogin(carrierCode: string, pin: string): Promise<{
  success: boolean
  error?: string
  driver?: DriverInfo
}> {
  try {
    const response = await fetch(`${API_URL}/api/auth/driver-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierCode, pin }),
    })
    const data = await response.json()
    if (!response.ok) return { success: false, error: data.error || 'Login failed' }
    if (data.token) setStoredToken(data.token)
    if (data.driver) setDriverInfo(data.driver)
    return { success: true, driver: data.driver }
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' }
  }
}
```

**Step 2: Verify**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm run build`

---

## Task 3: Auth Hook — `hooks/use-auth.ts`

**Files:**
- Modify: `DApp/hooks/use-auth.ts` (replace existing unused file OR create new)

**Step 1: Create `DApp/hooks/use-auth.ts`**

```typescript
'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { isAuthenticated, clearStoredToken, getDriverInfo, startTokenExpiryMonitor } from '@/lib/driver-fetch'
import type { DriverInfo } from '@/lib/driver-fetch'

export function useAuth() {
  const router = useRouter()
  const [authenticated, setAuthenticated] = useState(false)
  const [driver, setDriver] = useState<DriverInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const authed = isAuthenticated()
    setAuthenticated(authed)
    if (authed) setDriver(getDriverInfo())
    setLoading(false)
  }, [])

  // Monitor token expiry in background
  useEffect(() => {
    if (!authenticated) return
    return startTokenExpiryMonitor()
  }, [authenticated])

  const logout = useCallback(() => {
    clearStoredToken()
    setAuthenticated(false)
    setDriver(null)
    router.push('/login')
  }, [router])

  const requireAuth = useCallback(() => {
    if (!loading && !authenticated) router.push('/login')
  }, [loading, authenticated, router])

  return { authenticated, driver, loading, logout, requireAuth }
}
```

**Step 2: Verify**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm run build`

---

## Task 4: GPS Library — `lib/gps.ts`

Port from `Driver_App/lib/gps.ts`.

**Files:**
- Create: `DApp/lib/gps.ts`

**Step 1: Create `DApp/lib/gps.ts`**

```typescript
export interface GPSPosition {
  latitude: number
  longitude: number
  speed: number | null
  heading: number | null
  accuracy: number
  timestamp: number
}

export function startGPSTracking(
  _loadId: string,
  onPosition: (pos: GPSPosition) => void,
  onError?: (error: GeolocationPositionError) => void
): number {
  if (!navigator.geolocation) throw new Error('Geolocation not supported')

  return navigator.geolocation.watchPosition(
    (position) => {
      onPosition({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp,
      })
    },
    (error) => { if (onError) onError(error) },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
  )
}

export function stopGPSTracking(watchId: number): void {
  navigator.geolocation.clearWatch(watchId)
}

export function speedToMph(speedMs: number | null): number {
  if (speedMs === null || speedMs < 0) return 0
  return Math.round(speedMs * 2.237)
}
```

**Step 2: Verify build**

---

## Task 5: GPS Hook — `hooks/use-gps.ts`

Port from `Driver_App/hooks/use-gps.ts`.

**Files:**
- Create: `DApp/hooks/use-gps.ts`

**Step 1: Create `DApp/hooks/use-gps.ts`**

```typescript
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { startGPSTracking, stopGPSTracking, speedToMph, type GPSPosition } from '@/lib/gps'
import { driverFetch } from '@/lib/driver-fetch'

interface UseGPSOptions {
  loadId: string
  enabled?: boolean
  reportIntervalMs?: number
}

interface GPSState {
  status: 'inactive' | 'active' | 'error' | 'denied'
  position: GPSPosition | null
  speedMph: number
  lastReportedAt: Date | null
  error: string | null
}

export function useGPS({ loadId, enabled = false, reportIntervalMs = 30000 }: UseGPSOptions) {
  const [state, setState] = useState<GPSState>({
    status: 'inactive', position: null, speedMph: 0, lastReportedAt: null, error: null,
  })
  const watchIdRef = useRef<number | null>(null)
  const lastReportRef = useRef<number>(0)

  const reportPosition = useCallback(async (pos: GPSPosition) => {
    const now = Date.now()
    if (now - lastReportRef.current < reportIntervalMs) return
    lastReportRef.current = now
    try {
      await driverFetch(`/api/loads/${loadId}/location`, {
        method: 'POST',
        body: JSON.stringify({ lat: pos.latitude, lng: pos.longitude, speed: pos.speed, heading: pos.heading }),
      })
      setState((prev) => ({ ...prev, lastReportedAt: new Date() }))
    } catch { /* silent */ }
  }, [loadId, reportIntervalMs])

  const handlePosition = useCallback((pos: GPSPosition) => {
    setState((prev) => ({ ...prev, status: 'active', position: pos, speedMph: speedToMph(pos.speed), error: null }))
    reportPosition(pos)
  }, [reportPosition])

  const handleError = useCallback((error: GeolocationPositionError) => {
    setState((prev) => ({
      ...prev,
      status: error.code === error.PERMISSION_DENIED ? 'denied' : 'error',
      error: error.message,
    }))
  }, [])

  const start = useCallback(() => {
    if (watchIdRef.current !== null) return
    try {
      watchIdRef.current = startGPSTracking(loadId, handlePosition, handleError)
      setState((prev) => ({ ...prev, status: 'active', error: null }))
    } catch (error) {
      setState((prev) => ({ ...prev, status: 'error', error: error instanceof Error ? error.message : 'Failed' }))
    }
  }, [loadId, handlePosition, handleError])

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      stopGPSTracking(watchIdRef.current)
      watchIdRef.current = null
    }
    setState((prev) => ({ ...prev, status: 'inactive' }))
  }, [])

  useEffect(() => {
    if (enabled) start(); else stop()
    return () => { if (watchIdRef.current !== null) { stopGPSTracking(watchIdRef.current); watchIdRef.current = null } }
  }, [enabled, start, stop])

  return { ...state, start, stop }
}
```

**Step 2: Verify build**

---

## Task 6: Login Page

**Files:**
- Create: `DApp/app/login/page.tsx`

**Step 1: Create `DApp/app/login/page.tsx`**

Build a mobile-optimized login screen with:
- Myra logo + "Myra Driver" title
- Carrier Code input field (text, uppercased)
- 6-digit PIN input field (password type, maxLength 6)
- "Sign In" submit button with loading spinner
- Error message display (from API)
- On success: redirect to `/` (main app shell)
- Dark theme using existing CSS variables (amber primary)
- `driverLogin()` from `@/lib/driver-fetch`
- If already authenticated on mount, redirect to `/` immediately

Key details:
- Form state: `carrierCode`, `pin`, `loading`, `error`
- Submit handler: calls `driverLogin(carrierCode, pin)`, on success → `router.push('/')`
- Use `useAuth()` hook to check if already logged in on mount
- Layout: centered vertically, max-w-sm, safe-area padded

**Step 2: Verify**

Run: `pnpm run build`
Manual: Navigate to `localhost:3001/login` and confirm the login form renders.

---

## Task 7: Update `app/layout.tsx`

**Files:**
- Modify: `DApp/app/layout.tsx`

**Step 1: Update metadata and branding**

Changes:
- Change title from `"DriverPulse - Load Management"` to `"Myra Driver"`
- Remove `generator: 'v0.app'`
- Change `appleWebApp.title` to `"Myra Driver"`
- Keep viewport, fonts, and Analytics unchanged

**Step 2: Verify build**

---

## Task 8: Update Mock Data Types for API Compatibility

The existing `Load` interface in `lib/mock-data.ts` uses camelCase which matches TMS API response from `/api/drivers/me/loads` (which returns snake_case). We need a mapper and updated types.

**Files:**
- Modify: `DApp/lib/mock-data.ts`

**Step 1: Add `mapApiLoad()` function and keep types**

Keep the existing `Load`, `LoadStop`, `LoadStatus` interfaces and status labels/colors as-is. They're good and the mock data is useful for offline fallback.

Add a new exported function at the bottom of the file that maps TMS snake_case API rows to the DApp's camelCase `Load` interface:

```typescript
/** Map a TMS API load row (snake_case) to DApp Load interface */
export function mapApiLoad(row: Record<string, unknown>): Load {
  return {
    id: String(row.id || ''),
    referenceNumber: String(row.reference_number || row.referenceNumber || ''),
    status: mapApiStatus(String(row.status || 'assigned')),
    pickup: {
      type: 'pickup',
      name: String(row.shipper_name || row.origin || ''),
      address: String(row.origin || ''),
      city: extractCity(String(row.origin || '')),
      state: extractState(String(row.origin || '')),
      zip: '',
      lat: Number(row.origin_lat) || 0,
      lng: Number(row.origin_lng) || 0,
      scheduledTime: String(row.pickup_date || ''),
      contactName: '',
      contactPhone: '',
    },
    delivery: {
      type: 'delivery',
      name: String(row.destination || ''),
      address: String(row.destination || ''),
      city: extractCity(String(row.destination || '')),
      state: extractState(String(row.destination || '')),
      zip: '',
      lat: Number(row.dest_lat) || 0,
      lng: Number(row.dest_lng) || 0,
      scheduledTime: String(row.delivery_date || ''),
      contactName: '',
      contactPhone: '',
    },
    commodity: String(row.commodity || ''),
    weight: Number(row.weight) || 0,
    miles: 0,
    rate: Number(row.carrier_cost) || 0,
    broker: String(row.assigned_rep || 'Myra TMS'),
    brokerPhone: '',
    equipment: String(row.equipment || ''),
    specialInstructions: String(row.po_number ? `PO: ${row.po_number}` : ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function mapApiStatus(s: string): LoadStatus {
  const map: Record<string, LoadStatus> = {
    'Booked': 'assigned',
    'Dispatched': 'en_route_pickup',
    'In Transit': 'en_route_delivery',
    'Delivered': 'delivered',
    'Invoiced': 'completed',
    'Closed': 'completed',
  }
  return map[s] || (s as LoadStatus) || 'assigned'
}

function extractCity(location: string): string {
  const parts = location.split(',')
  return parts[0]?.trim() || location
}

function extractState(location: string): string {
  const parts = location.split(',')
  return parts[1]?.trim().substring(0, 2) || ''
}
```

**Step 2: Verify build**

---

## Task 9: 5-Tab Bottom Navigation

**Files:**
- Modify: `DApp/components/bottom-nav.tsx`

**Step 1: Expand from 3 tabs to 5 tabs**

Update the `Screen` type and `navItems` array:

```typescript
type Screen = 'map' | 'active' | 'loads' | 'docs' | 'profile'
```

Nav items:
1. `map` — MapPin icon, label "Map"
2. `active` — Truck icon, label "Active" (was `details`)
3. `loads` — Package icon, label "Loads" (was List)
4. `docs` — FileText icon, label "Docs"
5. `profile` — User icon, label "Profile"

Import `MapPin, Truck, Package, FileText, User` from lucide-react.

Keep the existing glassmorphic styling, active state dot on "Active" tab, safe-bottom padding.

**Step 2: Verify build**

---

## Task 10: POD Capture Component

Port from `Driver_App/components/pod-capture.tsx`.

**Files:**
- Create: `DApp/components/pod-capture.tsx`

**Step 1: Create `DApp/components/pod-capture.tsx`**

Copy the existing POD capture component from `Driver_App/components/pod-capture.tsx` but change the import path:
- Replace `import { driverFetch } from '@/lib/api'` with `import { driverFetch } from '@/lib/driver-fetch'`
- Keep everything else identical (Camera capture, preview, retake, upload via FormData to `/api/loads/${loadId}/pod`)

**Step 2: Verify build**

---

## Task 11: Documents Screen

**Files:**
- Create: `DApp/components/docs-screen.tsx`

**Step 1: Create `DApp/components/docs-screen.tsx`**

Build a documents management screen with:
- Header: "Documents" title
- Filter tabs: All, BOL, POD, Other
- Fetch from `/api/documents?relatedType=Load` via `driverFetch()`
- List items showing: document name, type badge, related load ID, date, file size
- Tap to open document URL (blob URL) in new tab
- Empty state when no documents
- Loading skeleton while fetching

Props: none (fetches its own data using driverFetch)

State:
- `docs: DocItem[]` (fetched from API)
- `filter: 'all' | 'BOL' | 'POD' | 'Other'`
- `loading: boolean`

`DocItem` interface (matches API response from `/api/documents`):
```typescript
interface DocItem {
  id: string
  name: string
  type: string // 'BOL' | 'POD' | 'Rate Confirmation' | etc.
  related_to: string
  related_type: string
  upload_date: string
  status: string
  blob_url: string
  file_size: number
}
```

Use Shadcn Badge for document type. Use FileText, Download icons from lucide-react.

**Step 2: Verify build**

---

## Task 12: Profile Screen

**Files:**
- Create: `DApp/components/profile-screen.tsx`

**Step 1: Create `DApp/components/profile-screen.tsx`**

Build a driver profile and settings screen with:
- Header: driver name (from `useAuth().driver`), carrier name subtitle
- Profile card: avatar placeholder (initials), name, carrier
- Info rows: Phone, Email, Carrier ID, Driver ID (read-only display from driver info)
- Settings section:
  - Push notifications toggle (visual only for now)
  - GPS tracking toggle (visual only)
- App info: "Myra Driver v1.0.0"
- Sign out button (calls `logout()` from `useAuth()`)
- Confirmation modal before sign out using Shadcn AlertDialog

Props: `onLogout: () => void`

**Step 2: Verify build**

---

## Task 13: Rewrite App Shell — `app/page.tsx`

This is the main orchestration task. Rewrite the app shell to:
- Check auth on mount (redirect to `/login` if not authenticated)
- Fetch loads from API (fall back to mock data)
- Route between 5 screens
- Integrate GPS tracking for active load

**Files:**
- Modify: `DApp/app/page.tsx`

**Step 1: Rewrite `DApp/app/page.tsx`**

```typescript
'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { BottomNav } from '@/components/bottom-nav'
import { MapScreen } from '@/components/map-screen'
import { LoadDetailsScreen } from '@/components/load-details-screen'
import { LoadsListScreen } from '@/components/loads-list-screen'
import { DocsScreen } from '@/components/docs-screen'
import { ProfileScreen } from '@/components/profile-screen'
import { useServiceWorker } from '@/hooks/use-service-worker'
import { useAuth } from '@/hooks/use-auth'
import { useGPS } from '@/hooks/use-gps'
import { driverFetch } from '@/lib/driver-fetch'
import { mockLoads, mapApiLoad } from '@/lib/mock-data'
import type { Load, LoadStatus } from '@/lib/mock-data'
import { Loader2 } from 'lucide-react'

type Screen = 'map' | 'active' | 'loads' | 'docs' | 'profile'

export default function DriverApp() {
  useServiceWorker()
  const router = useRouter()
  const { authenticated, driver, loading: authLoading, logout } = useAuth()

  const [screen, setScreen] = useState<Screen>('map')
  const [loads, setLoads] = useState<Load[]>([])
  const [selectedLoad, setSelectedLoad] = useState<Load | undefined>(undefined)
  const [dataLoading, setDataLoading] = useState(true)

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !authenticated) router.push('/login')
  }, [authLoading, authenticated, router])

  // Fetch loads from API
  const fetchLoads = useCallback(async () => {
    setDataLoading(true)
    try {
      const res = await driverFetch('/api/drivers/me/loads')
      if (res.ok) {
        const rows = await res.json()
        const mapped = (Array.isArray(rows) ? rows : rows.loads || []).map(mapApiLoad)
        setLoads(mapped.length > 0 ? mapped : mockLoads)
      } else {
        setLoads(mockLoads)
      }
    } catch {
      setLoads(mockLoads)
    } finally {
      setDataLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authenticated) fetchLoads()
  }, [authenticated, fetchLoads])

  const activeLoad = loads.find((l) => !['delivered', 'completed'].includes(l.status))

  // GPS tracking for active load
  const gpsEnabled = !!activeLoad && ['en_route_pickup', 'at_pickup', 'loaded', 'en_route_delivery', 'at_delivery'].includes(activeLoad.status)
  const gps = useGPS({ loadId: activeLoad?.id || '', enabled: gpsEnabled })

  const handleNavigate = useCallback((s: Screen) => { setScreen(s) }, [])

  const handleViewDetails = useCallback(() => {
    if (activeLoad) setSelectedLoad(activeLoad)
    setScreen('active')
  }, [activeLoad])

  const handleSelectLoad = useCallback((load: Load) => {
    setSelectedLoad(load)
    setScreen('active')
  }, [])

  const handleBackFromDetails = useCallback(() => { setScreen('map') }, [])

  const handleStatusUpdate = useCallback(async (loadId: string, newStatus: LoadStatus) => {
    // Optimistic update
    setLoads((prev) => prev.map((l) => l.id === loadId ? { ...l, status: newStatus, updatedAt: new Date().toISOString() } : l))
    setSelectedLoad((prev) => prev && prev.id === loadId ? { ...prev, status: newStatus } : prev)

    // API call to update status
    const apiStatus = { en_route_pickup: 'Dispatched', en_route_delivery: 'In Transit', delivered: 'Delivered' }[newStatus]
    if (apiStatus) {
      try {
        await driverFetch(`/api/loads/${loadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: apiStatus }),
        })
      } catch { /* optimistic update already applied */ }
    }
  }, [])

  // Show loading while checking auth
  if (authLoading) {
    return (
      <main className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" />
      </main>
    )
  }

  if (!authenticated) return null

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background">
      {/* Map screen - always mounted */}
      <div className={screen === 'map' ? 'h-full' : 'pointer-events-none fixed inset-0 opacity-0'} aria-hidden={screen !== 'map'}>
        <MapScreen activeLoad={activeLoad} onViewDetails={handleViewDetails} driverPosition={gps.position} />
      </div>

      {screen === 'active' && (
        <div className="h-full">
          <LoadDetailsScreen load={selectedLoad || activeLoad} onBack={handleBackFromDetails} onStatusUpdate={handleStatusUpdate} />
        </div>
      )}

      {screen === 'loads' && (
        <div className="h-full">
          <LoadsListScreen loads={loads} onSelectLoad={handleSelectLoad} />
        </div>
      )}

      {screen === 'docs' && (
        <div className="h-full">
          <DocsScreen />
        </div>
      )}

      {screen === 'profile' && (
        <div className="h-full">
          <ProfileScreen onLogout={logout} />
        </div>
      )}

      <BottomNav active={screen === 'active' ? 'active' : screen} onNavigate={handleNavigate} hasActiveLoad={!!activeLoad} />
    </main>
  )
}
```

**Step 2: Verify build**

---

## Task 14: Update MapScreen for Real GPS Data

**Files:**
- Modify: `DApp/components/map-screen.tsx`

**Step 1: Add `driverPosition` prop**

Add to `MapScreenProps`:
```typescript
interface MapScreenProps {
  activeLoad: Load | undefined
  onViewDetails: () => void
  driverPosition?: { latitude: number; longitude: number } | null
}
```

**Step 2: Replace simulated truck marker with real GPS position**

In the marker creation effect, instead of calculating a fake truck position between pickup/delivery:
- If `driverPosition` is available, use `driverPosition.latitude` / `driverPosition.longitude`
- If not, fall back to the midpoint calculation (for demo purposes)

Update the `useEffect` dependency array to include `driverPosition`.

**Step 3: Update route line to go through driver position**

When `driverPosition` exists:
```
routeCoords = [pickup, driverPosition, delivery]
```
When it doesn't, keep the existing behavior.

**Step 4: Update fitBounds to include driver position**

Add the driver position to the bounds calculation when it exists.

**Step 5: Verify build**

---

## Task 15: Update LoadDetailsScreen with POD Capture

**Files:**
- Modify: `DApp/components/load-details-screen.tsx`

**Step 1: Replace documents placeholder with POD capture**

In the existing Documents section (lines 326-336), replace the placeholder with:

```tsx
import { PODCapture } from '@/components/pod-capture'

{/* Documents & POD */}
<section className="px-4 py-4">
  <div className="flex items-center gap-2 mb-3">
    <FileText className="size-4 text-muted-foreground" />
    <h2 className="text-sm font-semibold text-foreground">Documents</h2>
  </div>
  {['at_delivery', 'delivered'].includes(load.status) ? (
    <PODCapture
      loadId={load.id}
      onCaptured={(url) => { /* refresh load data if needed */ }}
    />
  ) : (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="text-xs text-muted-foreground">
        POD capture available at delivery
      </p>
    </div>
  )}
</section>
```

**Step 2: Verify build**

---

## Task 16: Update `manifest.json` for Myra Branding

**Files:**
- Modify: `DApp/public/manifest.json`

**Step 1: Update manifest**

```json
{
  "name": "Myra Driver",
  "short_name": "Myra",
  "description": "Real-time load tracking and management for drivers",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1f35",
  "theme_color": "#1a1f35",
  "orientation": "portrait",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

**Step 2: Verify build**

---

## Task 17: Update Service Worker

**Files:**
- Modify: `DApp/public/sw.js`

**Step 1: Add GPS queue and background sync**

Add IndexedDB support for offline GPS queuing (from Driver_App pattern):
- On `sync` event with tag `sync-gps`: drain the IndexedDB queue by POSTing stored positions
- On `fetch` for `/api/loads/*/location`: if offline, store in IndexedDB instead of failing
- Add push notification handler

Keep existing cache-first/network-first strategies.

Update `CACHE_NAME` to `myra-driver-v2`.

**Step 2: Verify build**

---

## Task 18: Delete Stale Files

**Files:**
- Delete: `DApp/styles/globals.css` (stale duplicate, unused)

**Step 1: Delete stale file**

Run: `rm "C:/Users/patri/OneDrive/Desktop/M1/DApp/styles/globals.css"`

**Step 2: Verify build**

---

## Task 19: Full Build Verification

**Step 1: Build DApp**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm run build`
Expected: Build succeeds with zero errors.

**Step 2: Build MyraTMS (ensure no regressions)**

Run: `cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS" && pnpm run build`
Expected: Build succeeds.

**Step 3: Start dev servers and test**

Run:
```bash
cd "C:/Users/patri/OneDrive/Desktop/M1/MyraTMS" && pnpm run dev &
cd "C:/Users/patri/OneDrive/Desktop/M1/DApp" && pnpm run dev -- -p 3001 &
```

Manual verification checklist:
- [ ] Visit `localhost:3001` — should redirect to `/login` (not authenticated)
- [ ] Login page renders with Carrier Code + PIN fields, amber primary button
- [ ] After login (use test driver credentials), redirected to main app
- [ ] Map tab shows Mapbox dark map with markers for active load
- [ ] Active tab shows load details with status stepper and action buttons
- [ ] Loads tab shows list of driver's loads with filters
- [ ] Docs tab shows documents list (may be empty)
- [ ] Profile tab shows driver info and sign out button
- [ ] Sign out returns to login page
- [ ] Status update button on Active tab advances load status
- [ ] POD capture section appears when load is at delivery
- [ ] GPS indicator in map shows driver position (if permission granted)
- [ ] Bottom nav highlights correct tab, shows dot on Active when load exists
- [ ] PWA installable (manifest loads correctly)

---

## Execution Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Environment & deps | None |
| 2 | Auth library | Task 1 |
| 3 | Auth hook | Task 2 |
| 4 | GPS library | Task 1 |
| 5 | GPS hook | Tasks 2, 4 |
| 6 | Login page | Tasks 2, 3 |
| 7 | Update layout.tsx | None |
| 8 | Update mock-data types | None |
| 9 | 5-tab bottom nav | None |
| 10 | POD capture component | Task 2 |
| 11 | Documents screen | Task 2 |
| 12 | Profile screen | Task 3 |
| 13 | Rewrite app shell | Tasks 2-5, 8-12 |
| 14 | Update MapScreen | Task 5 |
| 15 | Update LoadDetailsScreen | Task 10 |
| 16 | Update manifest.json | None |
| 17 | Update service worker | None |
| 18 | Delete stale files | None |
| 19 | Full build verification | All above |

**Parallelizable batches:**
- Batch 1 (parallel): Tasks 1, 7, 8, 9, 16, 17, 18
- Batch 2 (parallel, after Task 1): Tasks 2, 4
- Batch 3 (parallel, after Tasks 2, 4): Tasks 3, 5, 6, 10, 11
- Batch 4 (after Task 3): Task 12
- Batch 5 (after all above): Tasks 13, 14, 15
- Batch 6: Task 19
