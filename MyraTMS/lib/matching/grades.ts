export type MatchGrade = "A" | "B" | "C" | "D" | "F"

/**
 * Convert a 0.0–1.0 match score to a letter grade.
 * A: 0.80–1.0  |  B: 0.60–0.79  |  C: 0.40–0.59  |  D: 0.20–0.39  |  F: 0.0–0.19
 */
export function scoreToGrade(score: number): MatchGrade {
  if (score >= 0.8) return "A"
  if (score >= 0.6) return "B"
  if (score >= 0.4) return "C"
  if (score >= 0.2) return "D"
  return "F"
}

/**
 * Convert a minimum grade filter to a minimum score threshold.
 */
export function gradeToMinScore(grade: MatchGrade): number {
  switch (grade) {
    case "A": return 0.8
    case "B": return 0.6
    case "C": return 0.4
    case "D": return 0.2
    case "F": return 0.0
  }
}

/**
 * Grade badge colors for the TMS UI.
 */
export const GRADE_COLORS: Record<MatchGrade, { bg: string; text: string; label: string }> = {
  A: { bg: "bg-emerald-500/15", text: "text-emerald-500", label: "Excellent" },
  B: { bg: "bg-blue-500/15", text: "text-blue-500", label: "Good" },
  C: { bg: "bg-amber-500/15", text: "text-amber-500", label: "Acceptable" },
  D: { bg: "bg-orange-500/15", text: "text-orange-500", label: "Weak" },
  F: { bg: "bg-red-500/15", text: "text-red-500", label: "Poor" },
}
