/**
 * Extract a region identifier from a load origin/destination string.
 * Input formats: "Toronto, ON" or "123 Main St, Toronto, ON" or "Dallas, TX"
 * Output: normalized "city, state" like "toronto, on" or "dallas, tx"
 */
export function extractRegion(locationStr: string): string {
  if (!locationStr) return ""

  const parts = locationStr.split(",").map((p) => p.trim())

  if (parts.length >= 2) {
    // Take the last two meaningful parts as city, state
    const state = parts[parts.length - 1].trim().substring(0, 2)
    const city = parts[parts.length - 2].trim()
    return `${city}, ${state}`.toLowerCase()
  }

  return locationStr.trim().toLowerCase()
}

/**
 * Get adjacent/nearby regions for a given region.
 * This is a simplified heuristic — matches by same state/province.
 * In a later phase, this could use actual geographic adjacency data.
 */
export function getAdjacentRegions(region: string): string[] {
  const parts = region.split(",")
  if (parts.length < 2) return []

  const state = parts[parts.length - 1].trim().toLowerCase()
  // Return wildcard pattern for same-state matching
  // The caller will use SQL LIKE '%state' to match
  return [state]
}
