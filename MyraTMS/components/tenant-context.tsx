"use client"

import { createContext, useContext, useMemo } from "react"
import useSWR from "swr"
import type { Feature, LimitKey, Tier } from "@/lib/features"

// ---------------------------------------------------------------------------
// Tenant context — drives the entire UI's tenant-aware behavior.
//
// Reads /api/me/tenant via SWR (per react-best-practices client-swr-dedup —
// SWR de-dupes the same key across components, so 50 nav items calling
// useFeatures() trigger ONE network request).
//
// Hooks exposed here:
//   useTenant()        — full tenant + subscription + branding object
//   useFeatures()      — the resolved Feature[] for the caller's tier
//   useTenantConfig()  — branding values for app shell theming
//   hasFeature(name)   — non-throwing boolean check (cosmetic UI gating)
//
// Server enforcement is in lib/features/gate.ts — UI hiding is purely
// cosmetic per ADR-003 §Where enforcement runs.
// ---------------------------------------------------------------------------

export interface TenantContextValue {
  tenant: {
    id: number
    slug: string
    name: string
    type: string
    status: string
  }
  user: {
    id: string
    role: string
    isSuperAdmin: boolean
  }
  subscription: {
    tier: Tier
    status: string
    features: Feature[]
    /** Infinity limits arrive as null over JSON; consumers see them as null. */
    limits: Partial<Record<LimitKey, number | null>>
  }
  branding: {
    primaryColor: string | null
    logoUrl: string | null
    companyName: string | null
  }
}

const TenantContext = createContext<{
  data: TenantContextValue | null
  isLoading: boolean
  error: Error | null
}>({ data: null, isLoading: true, error: null })

async function fetchMeTenant(url: string): Promise<TenantContextValue> {
  const res = await fetch(url, { credentials: "include" })
  if (!res.ok) {
    throw new Error(
      `[/api/me/tenant] ${res.status} ${res.statusText}`,
    )
  }
  return (await res.json()) as TenantContextValue
}

export function TenantProvider({
  children,
}: {
  children: React.ReactNode
}) {
  // SWR de-dupes the same key across all consumers; one request per page load.
  // refreshInterval=0 — tenant subscription doesn't change between requests
  // for the same SWR cache lifetime; revalidateOnFocus picks up tier changes
  // when the user comes back to the tab.
  const { data, error, isLoading } = useSWR<TenantContextValue>(
    "/api/me/tenant",
    fetchMeTenant,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      dedupingInterval: 60_000,
    },
  )

  const value = useMemo(
    () => ({ data: data ?? null, isLoading, error: error ?? null }),
    [data, isLoading, error],
  )

  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  )
}

/**
 * Get the full tenant context. Returns `null` while loading or on error —
 * callers should branch on that and render a loading/error state.
 */
export function useTenant(): TenantContextValue | null {
  return useContext(TenantContext).data
}

/**
 * Loading + error state for callers that want to render a spinner / fallback
 * before the tenant data is ready (the app shell does this).
 */
export function useTenantStatus(): { isLoading: boolean; error: Error | null } {
  const ctx = useContext(TenantContext)
  return { isLoading: ctx.isLoading, error: ctx.error }
}

/**
 * The resolved Feature[] for the current tenant. Returns an empty array
 * while loading — combined with hasFeature() this gives "show nothing
 * until known", which is the right default for tier-gated UI (don't flash
 * features the tenant might not have).
 */
export function useFeatures(): Feature[] {
  const ctx = useContext(TenantContext).data
  return ctx?.subscription.features ?? []
}

/**
 * Non-throwing feature check. Cosmetic UI gating only — the server is the
 * source of truth (lib/features/gate.ts requireFeature).
 */
export function useHasFeature(feature: Feature): boolean {
  const features = useFeatures()
  return features.includes(feature)
}

/**
 * Branding subset — used by the app shell to theme accent colors and
 * header logo without re-pulling the full tenant payload.
 */
export function useTenantBranding(): TenantContextValue["branding"] | null {
  const ctx = useContext(TenantContext).data
  return ctx?.branding ?? null
}

/**
 * Convenience: returns a tenant config primitive (companyName fallback to
 * tenant.name). Used in topbar + emails so the user sees their org's name.
 */
export function useTenantDisplayName(): string {
  const ctx = useContext(TenantContext).data
  if (!ctx) return "Myra"
  return ctx.branding.companyName || ctx.tenant.name
}
