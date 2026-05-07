"use client"

import { useEffect } from "react"
import { useTenantBranding } from "@/components/tenant-context"

/**
 * Side-effect-only component that mirrors the tenant's branding_primary_color
 * onto a CSS variable (`--brand-primary`) on document.documentElement, so any
 * descendant style rule can pick it up (e.g., an accent button using
 * `style={{ backgroundColor: 'var(--brand-primary)' }}`).
 *
 * Renders nothing. Lives next to TenantProvider in the shell so it runs after
 * branding is loaded.
 *
 * Per react-best-practices `rerender-derived-state-no-effect`: we use an
 * effect here intentionally because we're imperatively touching the DOM
 * (setProperty), not deriving render state. Setting a CSS variable can't be
 * done via render-time JSX without dropping a <style> tag.
 */
export function TenantBrandingApplier() {
  const branding = useTenantBranding()
  const primary = branding?.primaryColor

  useEffect(() => {
    const root = document.documentElement
    if (primary && /^#[0-9A-Fa-f]{6}$/.test(primary)) {
      root.style.setProperty("--brand-primary", primary)
    } else {
      root.style.removeProperty("--brand-primary")
    }
    return () => {
      // No cleanup needed on unmount — the provider lives at the app root,
      // so unmount only happens at full navigation away.
    }
  }, [primary])

  return null
}
