"use client"

import { useState, useEffect } from "react"
import { UserCheck, Loader2, Phone } from "lucide-react"
import { toast } from "sonner"
import { mutate } from "swr"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface Driver {
  id: string
  first_name: string
  last_name: string
  phone: string | null
  status: string
  carrier_id: string | null
  carrier_name: string | null
}

export interface AssignDriverDialogProps {
  loadId: string
  carrierId?: string | null
  currentDriverId?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (driverName: string) => void
}

function driverFullName(driver: Driver): string {
  return [driver.first_name, driver.last_name].filter(Boolean).join(" ")
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default"
  if (status === "on_load") return "secondary"
  return "outline"
}

function statusLabel(status: string): string {
  if (status === "on_load") return "On Load"
  if (status === "active") return "Available"
  return status
}

export default function AssignDriverDialog({
  loadId, carrierId, currentDriverId, open, onOpenChange, onSuccess,
}: AssignDriverDialogProps) {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(currentDriverId ?? null)

  // Sync selection when dialog opens or currentDriverId changes
  useEffect(() => {
    if (open) setSelectedDriverId(currentDriverId ?? null)
  }, [open, currentDriverId])

  // Fetch drivers when dialog opens
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()

    async function fetchDrivers() {
      setLoading(true)
      try {
        // GET /api/drivers reads carrier_id (snake_case) as the query param
        const qs = carrierId ? "?carrier_id=" + encodeURIComponent(carrierId) : ""
        const res = await fetch("/api/drivers" + qs, { signal: controller.signal })
        if (!res.ok) throw new Error("Failed to load drivers (" + String(res.status) + ")")
        const data: Driver[] = await res.json()
        setDrivers(data)
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        toast.error("Could not load drivers. Please try again.")
        setDrivers([])
      } finally { setLoading(false) }
    }

    fetchDrivers()
    return () => controller.abort()
  }, [open, carrierId])

  async function handleSave() {
    if (selectedDriverId === currentDriverId) { onOpenChange(false); return }

    setSaving(true)
    try {
      const res = await fetch("/api/loads/" + loadId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // PATCH whitelist maps camelCase driverId -> snake_case driver_id
        body: JSON.stringify({ driverId: selectedDriverId ?? null }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? "Request failed (" + String(res.status) + ")")
      }

      // Invalidate all loads SWR cache keys
      mutate(
        (key: unknown) => typeof key === "string" && key.startsWith("/api/loads"),
        undefined,
        { revalidate: true }
      )

      const assignedDriver = drivers.find((d) => d.id === selectedDriverId)
      const driverName =
        selectedDriverId === null
          ? "Unassigned"
          : assignedDriver ? driverFullName(assignedDriver) : "Driver"

      toast.success(
        selectedDriverId === null ? "Driver unassigned" : "Driver assigned: " + driverName
      )
      onSuccess?.(driverName)
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message || "Failed to assign driver")
    } finally { setSaving(false) }
  }

  const hasChanged = selectedDriverId !== currentDriverId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-primary" />
            Assign Driver
          </DialogTitle>
        </DialogHeader>

        <div className="py-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading drivers...
            </div>
          ) : drivers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">
              {carrierId
                ? "No drivers found for this carrier. Add drivers first."
                : "No drivers found."}
            </p>
          ) : (
            <ScrollArea className="max-h-72 pr-1">
              <ul className="space-y-1">
                <li>
                  <button
                    type="button"
                    onClick={() => setSelectedDriverId(null)}
                    className={cn(
                      "w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                      "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selectedDriverId === null
                        ? "bg-muted ring-2 ring-primary/40"
                        : "bg-transparent"
                    )}
                  >
                    <span className="font-medium text-muted-foreground italic">
                      — Unassign Driver
                    </span>
                  </button>
                </li>

                {drivers.map((driver) => {
                  const isSelected = selectedDriverId === driver.id
                  const isCurrent = currentDriverId === driver.id
                  return (
                    <li key={driver.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedDriverId(driver.id)}
                        className={cn(
                          "w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                          "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isSelected
                            ? "bg-muted ring-2 ring-primary/40"
                            : "bg-transparent"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium truncate">
                                {driverFullName(driver)}
                              </span>
                              {isCurrent && (
                                <Badge variant="outline" className="text-xs shrink-0">
                                  Current
                                </Badge>
                              )}
                            </div>
                            {driver.phone && (
                              <div className="flex items-center gap-1 mt-0.5 text-muted-foreground">
                                <Phone className="h-3 w-3 shrink-0" />
                                <span className="text-xs truncate">{driver.phone}</span>
                              </div>
                            )}
                          </div>
                          <Badge
                            variant={statusVariant(driver.status)}
                            className="shrink-0 text-xs capitalize"
                          >
                            {statusLabel(driver.status)}
                          </Badge>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || loading || !hasChanged}
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving...
              </>
            ) : (
              <>
                <UserCheck className="h-4 w-4 mr-2" />
                Assign Driver
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
