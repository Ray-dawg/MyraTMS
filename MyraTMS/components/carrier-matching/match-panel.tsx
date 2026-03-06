"use client"

import { useState, useCallback } from "react"
import { Search, RefreshCw, Loader2, Zap, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MatchCard } from "./match-card"
import { toast } from "sonner"
import type { CarrierMatch, MatchResponse } from "@/lib/matching"
import type { MatchGrade } from "@/lib/matching/grades"

interface MatchPanelProps {
  loadId: string
  onAssign: (carrierId: string, carrierName: string, driverId?: string | null, matchScore?: number) => void
}

export function MatchPanel({ loadId, onAssign }: MatchPanelProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MatchResponse | null>(null)
  const [minGrade, setMinGrade] = useState<MatchGrade>("C")
  const [maxResults, setMaxResults] = useState(5)
  const [assigningId, setAssigningId] = useState<string | null>(null)

  const runMatch = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/loads/${loadId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_results: maxResults,
          min_grade: minGrade,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Matching failed")
      }

      const data: MatchResponse = await res.json()
      setResult(data)

      if (data.matches.length === 0) {
        toast.info("No carriers matched the criteria")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Matching failed")
    } finally {
      setLoading(false)
    }
  }, [loadId, maxResults, minGrade])

  const handleAssign = async (match: CarrierMatch) => {
    setAssigningId(match.carrier_id)
    try {
      const res = await fetch(`/api/loads/${loadId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrier_id: match.carrier_id,
          driver_id: match.suggested_driver?.id || null,
          carrier_rate: match.breakdown.rate.carrier_avg_rate,
          match_score: match.match_score,
          assignment_method: "matched",
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Assignment failed")
      }

      toast.success(`Assigned to ${match.carrier_name}`)
      onAssign(
        match.carrier_id,
        match.carrier_name,
        match.suggested_driver?.id,
        match.match_score
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assignment failed")
    } finally {
      setAssigningId(null)
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">Carrier Matching Engine</CardTitle>
          </div>
          {result && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              <span>
                {result.total_eligible_carriers} eligible, {result.total_scored} scored
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Controls */}
        <div className="flex items-center gap-2">
          <Select
            value={minGrade}
            onValueChange={(v) => setMinGrade(v as MatchGrade)}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue placeholder="Min grade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="A">Grade A+</SelectItem>
              <SelectItem value="B">Grade B+</SelectItem>
              <SelectItem value="C">Grade C+</SelectItem>
              <SelectItem value="D">Grade D+</SelectItem>
              <SelectItem value="F">All</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={String(maxResults)}
            onValueChange={(v) => setMaxResults(Number(v))}
          >
            <SelectTrigger className="h-8 w-20 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3">Top 3</SelectItem>
              <SelectItem value="5">Top 5</SelectItem>
              <SelectItem value="10">Top 10</SelectItem>
            </SelectContent>
          </Select>

          <Button
            size="sm"
            className="text-xs h-8 flex-1"
            onClick={runMatch}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                Matching...
              </>
            ) : result ? (
              <>
                <RefreshCw className="h-3 w-3 mr-1.5" />
                Re-Match
              </>
            ) : (
              <>
                <Search className="h-3 w-3 mr-1.5" />
                Find Carriers
              </>
            )}
          </Button>
        </div>

        {/* Results */}
        {result && result.matches.length > 0 && (
          <div className="space-y-2">
            {result.matches.map((match) => (
              <MatchCard
                key={match.carrier_id}
                match={match}
                onAssign={handleAssign}
                assigning={assigningId === match.carrier_id}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {result && result.matches.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Search className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No Matches Found</p>
            <p className="text-xs text-muted-foreground mt-1">
              Try lowering the minimum grade or check carrier equipment types
            </p>
          </div>
        )}

        {/* Initial state */}
        {!result && !loading && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Zap className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              AI-Powered Carrier Matching
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Scores carriers on lane familiarity, proximity, rate, reliability,
              and relationship
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
