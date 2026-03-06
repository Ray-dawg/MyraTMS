"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Calculator,
  MapPin,
  Truck,
  DollarSign,
  Clock,
  BarChart3,
  Loader2,
  ArrowRight,
  History,
  TrendingUp,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useShippers, createQuote, bookQuote } from "@/lib/api"
import { toast } from "sonner"

interface QuoteResult {
  id: string
  reference: string
  shipperRate: number
  carrierCostEstimate: number
  fuelSurcharge: number
  marginPercent: number
  marginDollars: number
  ratePerMile: number
  rateSource: string
  rateSourceDetail: Record<string, unknown>
  confidence: number
  confidenceLabel: string
  distanceMiles: number
  distanceKm: number
  driveTimeHours: number
  rateRangeLow: number
  rateRangeHigh: number
  originRegion: string
  destRegion: string
  status: string
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2 }).format(value)
}

function ConfidenceBadge({ label }: { label: string }) {
  if (label === "HIGH") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">HIGH</Badge>
  if (label === "MEDIUM") return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">MEDIUM</Badge>
  return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">LOW</Badge>
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    historical: "Historical Loads",
    dat: "DAT RateView",
    truckstop: "Truckstop",
    "dat+historical": "DAT + Historical Blend",
    "truckstop+historical": "Truckstop + Historical Blend",
    manual_cache: "Manual Rate Cache",
    ai: "AI Estimation",
    benchmark: "Benchmark Formula",
  }
  return labels[source] || source
}

export default function QuotesPage() {
  const { data: shippers } = useShippers()
  const [loading, setLoading] = useState(false)
  const [booking, setBooking] = useState(false)
  const [result, setResult] = useState<QuoteResult | null>(null)

  // Form state
  const [origin, setOrigin] = useState("")
  const [destination, setDestination] = useState("")
  const [equipmentType, setEquipmentType] = useState("dry_van")
  const [weightLbs, setWeightLbs] = useState(42000)
  const [pickupDate, setPickupDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().split("T")[0]
  })
  const [commodity, setCommodity] = useState("")
  const [shipperId, setShipperId] = useState("")
  const [targetMargin, setTargetMargin] = useState([15])

  const handleGenerate = async () => {
    if (!origin.trim() || !destination.trim()) {
      toast.error("Origin and destination are required")
      return
    }
    setLoading(true)
    setResult(null)
    try {
      const shipperName = shippers?.find((s: { id: string; company: string }) => s.id === shipperId)?.company || ""
      const data = await createQuote({
        origin: origin.trim(),
        destination: destination.trim(),
        equipmentType,
        weightLbs,
        pickupDate,
        commodity: commodity.trim(),
        shipperId: shipperId || undefined,
        shipperName,
        targetMargin: targetMargin[0] / 100,
      })
      setResult({
        id: data.id,
        reference: data.reference,
        shipperRate: Number(data.shipper_rate ?? data.shipperRate),
        carrierCostEstimate: Number(data.carrier_cost_estimate ?? data.carrierCostEstimate),
        fuelSurcharge: Number(data.fuel_surcharge ?? data.fuelSurcharge),
        marginPercent: Number(data.margin_percent ?? data.marginPercent),
        marginDollars: Number(data.margin_dollars ?? data.marginDollars),
        ratePerMile: Number(data.rate_per_mile ?? data.ratePerMile),
        rateSource: data.rate_source ?? data.rateSource,
        rateSourceDetail: data.rate_source_detail ?? data.rateSourceDetail ?? {},
        confidence: Number(data.confidence),
        confidenceLabel: data.confidence_label ?? data.confidenceLabel,
        distanceMiles: Number(data.distance_miles ?? data.distanceMiles),
        distanceKm: Number(data.distance_km ?? data.distanceKm),
        driveTimeHours: Number(data.drive_time_hours ?? data.driveTimeHours),
        rateRangeLow: Number(data.rate_range_low ?? data.rateRangeLow),
        rateRangeHigh: Number(data.rate_range_high ?? data.rateRangeHigh),
        originRegion: data.origin_region ?? data.originRegion,
        destRegion: data.dest_region ?? data.destRegion,
        status: data.status,
      })
      toast.success("Quote generated")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate quote")
    } finally {
      setLoading(false)
    }
  }

  const handleBook = async () => {
    if (!result) return
    setBooking(true)
    try {
      const data = await bookQuote(result.id)
      toast.success(`Load ${data.loadId} created from quote`)
      setResult({ ...result, status: "accepted" })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to book load")
    } finally {
      setBooking(false)
    }
  }

  const rangeMin = result ? result.rateRangeLow : 0
  const rangeMax = result ? result.rateRangeHigh : 0
  const rangeTotal = rangeMax - rangeMin || 1
  const ratePosition = result ? Math.min(100, Math.max(0, ((result.carrierCostEstimate - rangeMin) / rangeTotal) * 100)) : 50

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Quotes</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Generate instant rate quotes with confidence scoring
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/quotes/analytics">
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Analytics
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/quotes/history">
              <History className="h-3.5 w-3.5 mr-1.5" />
              View History
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quote Form */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-sm text-card-foreground">New Quote</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Origin Address</Label>
              <div className="relative">
                <MapPin className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="e.g. Toronto, ON" className="h-9 text-sm pl-8" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Destination Address</Label>
              <div className="relative">
                <MapPin className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Sudbury, ON" className="h-9 text-sm pl-8" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Equipment Type</Label>
                <Select value={equipmentType} onValueChange={setEquipmentType}>
                  <SelectTrigger className="h-9 text-sm">
                    <Truck className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dry_van">Dry Van</SelectItem>
                    <SelectItem value="reefer">Reefer</SelectItem>
                    <SelectItem value="flatbed">Flatbed</SelectItem>
                    <SelectItem value="step_deck">Step Deck</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Weight (lbs)</Label>
                <Input type="number" value={weightLbs} onChange={(e) => setWeightLbs(Number(e.target.value))} className="h-9 text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Pickup Date</Label>
                <Input type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Commodity</Label>
                <Input value={commodity} onChange={(e) => setCommodity(e.target.value)} placeholder="Optional" className="h-9 text-sm" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Shipper</Label>
              <Select value={shipperId} onValueChange={setShipperId}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Optional — select shipper" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {(shippers || []).map((s: { id: string; company: string }) => (
                    <SelectItem key={s.id} value={s.id}>{s.company}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Target Margin</Label>
                <span className="text-xs font-medium text-foreground">{targetMargin[0]}%</span>
              </div>
              <Slider value={targetMargin} onValueChange={setTargetMargin} min={5} max={30} step={1} className="w-full" />
            </div>

            <Button onClick={handleGenerate} disabled={loading} className="w-full">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Calculator className="h-4 w-4 mr-2" />}
              Generate Quote
            </Button>
          </CardContent>
        </Card>

        {/* Result Panel */}
        {result && (
          <div className="space-y-4">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-card-foreground">{result.reference}</CardTitle>
                  <ConfidenceBadge label={result.confidenceLabel} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {sourceLabel(result.rateSource)}
                  {result.rateSourceDetail.loadCount ? ` — ${result.rateSourceDetail.loadCount} transactions` : ""}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Shipper rate (big number) */}
                <div className="text-center py-3">
                  <p className="text-3xl font-bold text-foreground">{formatCurrency(result.shipperRate)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Shipper Rate (all-in)</p>
                </div>

                <Separator />

                {/* Margin breakdown */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1 rounded-md bg-muted/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Carrier Cost</p>
                    <p className="text-sm font-semibold text-foreground">{formatCurrency(result.carrierCostEstimate)}</p>
                  </div>
                  <div className="space-y-1 rounded-md bg-muted/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Fuel Surcharge</p>
                    <p className="text-sm font-semibold text-foreground">{formatCurrency(result.fuelSurcharge)}</p>
                  </div>
                  <div className="space-y-1 rounded-md bg-muted/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Margin</p>
                    <p className="text-sm font-semibold text-green-600 dark:text-green-400">{formatCurrency(result.marginDollars)}</p>
                  </div>
                  <div className="space-y-1 rounded-md bg-muted/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Margin %</p>
                    <p className="text-sm font-semibold text-green-600 dark:text-green-400">{(result.marginPercent * 100).toFixed(1)}%</p>
                  </div>
                </div>

                {/* Distance + drive time */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {result.distanceMiles.toFixed(0)} mi / {result.distanceKm.toFixed(0)} km
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {result.driveTimeHours.toFixed(1)} hrs
                  </span>
                  <span className="flex items-center gap-1">
                    <DollarSign className="h-3 w-3" />
                    {formatCurrency(result.ratePerMile)}/mi
                  </span>
                </div>

                {/* Rate range bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{formatCurrency(rangeMin)}</span>
                    <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Rate Range</span>
                    <span>{formatCurrency(rangeMax)}</span>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted">
                    <div className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 opacity-30" style={{ width: "100%" }} />
                    <div
                      className="absolute top-[-2px] h-3 w-3 rounded-full bg-foreground border-2 border-background shadow-sm"
                      style={{ left: `calc(${ratePosition}% - 6px)` }}
                    />
                  </div>
                </div>

                <Separator />

                {/* Lane info */}
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <span>{result.originRegion}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span>{result.destRegion}</span>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <Button onClick={handleBook} disabled={booking || result.status === "accepted"} className="flex-1">
                    {booking ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Truck className="h-4 w-4 mr-2" />}
                    {result.status === "accepted" ? "Booked" : "Book Load"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => { setResult(null) }}
                    className="flex-1"
                  >
                    Adjust & Requote
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
