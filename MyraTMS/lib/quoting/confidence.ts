/**
 * Confidence scoring for rate sources.
 */

export function calculateHistoricalConfidence(loadCount: number, mostRecentDate: Date): number {
  const base = 0.5 + (Math.min(loadCount, 10) / 10) * 0.4
  const daysSinceRecent = (Date.now() - mostRecentDate.getTime()) / (1000 * 60 * 60 * 24)
  const recencyBonus = daysSinceRecent <= 7 ? 0.1 : daysSinceRecent <= 30 ? 0.05 : 0
  return Math.min(1.0, base + recencyBonus)
}

export function calculateManualCacheConfidence(ageDays: number): number {
  return Math.max(0.3, 0.7 - (ageDays / 60) * 0.4)
}

export function getConfidenceLabel(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.80) return "HIGH"
  if (score >= 0.50) return "MEDIUM"
  return "LOW"
}
