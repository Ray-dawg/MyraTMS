"use client"

import { cn } from "@/lib/utils"
import { GRADE_COLORS, type MatchGrade } from "@/lib/matching/grades"

interface GradeBadgeProps {
  grade: MatchGrade
  score?: number
  size?: "sm" | "md" | "lg"
  showLabel?: boolean
}

export function GradeBadge({ grade, score, size = "md", showLabel = false }: GradeBadgeProps) {
  const colors = GRADE_COLORS[grade]

  const sizeClasses = {
    sm: "h-5 w-5 text-[10px]",
    md: "h-7 w-7 text-xs",
    lg: "h-9 w-9 text-sm",
  }

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          "flex items-center justify-center rounded-md font-bold",
          colors.bg,
          colors.text,
          sizeClasses[size]
        )}
      >
        {grade}
      </div>
      {(showLabel || score != null) && (
        <div className="flex flex-col">
          {score != null && (
            <span className={cn("text-xs font-semibold", colors.text)}>
              {(score * 100).toFixed(0)}%
            </span>
          )}
          {showLabel && (
            <span className="text-[10px] text-muted-foreground">{colors.label}</span>
          )}
        </div>
      )}
    </div>
  )
}
