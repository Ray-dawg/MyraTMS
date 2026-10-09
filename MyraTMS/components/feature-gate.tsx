"use client"

import { Loader2, Lock } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { useTenant, useTenantStatus } from "@/components/tenant-context"
import { FEATURES, type Feature } from "@/lib/features"

/**
 * Page-level counterpart to the sidebar's `requiredFeature` filter. Renders
 * a "not included in your plan" state instead of mounting a page whose
 * APIs would 403 (server gate: lib/features/route-gate.ts enforceFeature).
 *
 * Cosmetic only — the server is the source of truth. If /api/me/tenant
 * fails we render the page anyway and let the server decide, rather than
 * locking a paying tenant out on a transient error.
 */
export function FeatureGate({
  feature,
  title,
  children,
}: {
  feature: Feature
  title: string
  children: React.ReactNode
}) {
  const tenant = useTenant()
  const { isLoading } = useTenantStatus()

  if (isLoading && !tenant) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (tenant && !tenant.subscription.features.includes(feature)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Lock className="h-8 w-8 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{title} is not included in your plan</h2>
            <p className="text-sm text-muted-foreground">
              Your organization is on the <span className="font-medium capitalize">{tenant.subscription.tier}</span> plan.{" "}
              {title} requires: {FEATURES[feature]}.
            </p>
            <p className="text-sm text-muted-foreground">Contact your administrator to upgrade.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
