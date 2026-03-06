"use client"

import { useState } from "react"
import { Star } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

interface CarrierRatingProps {
  carrierId: string
  loadId?: string
  currentRating?: number
  onRated?: (rating: number) => void
}

export function CarrierRating({
  carrierId,
  loadId,
  currentRating,
  onRated,
}: CarrierRatingProps) {
  const [hoveredStar, setHoveredStar] = useState(0)
  const [submittedRating, setSubmittedRating] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleRate = async (rating: number) => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/carriers/${carrierId}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, load_id: loadId }),
      })

      if (!res.ok) throw new Error("Failed to submit rating")

      setSubmittedRating(rating)
      toast.success(`Rated ${rating}/5 stars`)
      onRated?.(rating)
    } catch {
      toast.error("Failed to submit rating")
    } finally {
      setSubmitting(false)
    }
  }

  if (submittedRating) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              className={cn(
                "h-4 w-4",
                star <= submittedRating
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground/30"
              )}
            />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">Rated</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Rate communication:</span>
      <div className="flex gap-0.5" onMouseLeave={() => setHoveredStar(0)}>
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            disabled={submitting}
            className="transition-transform hover:scale-110 disabled:opacity-50"
            onMouseEnter={() => setHoveredStar(star)}
            onClick={() => handleRate(star)}
          >
            <Star
              className={cn(
                "h-5 w-5 transition-colors",
                star <= (hoveredStar || currentRating || 0)
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground/30 hover:text-amber-400/50"
              )}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
