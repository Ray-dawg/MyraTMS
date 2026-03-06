/**
 * Margin calculation engine.
 * Determines markup percentage based on shipper history, confidence, and urgency.
 */

export interface MarginParams {
  shipperId: string | null
  shipperLoadCount: number
  confidenceScore: number
  isUrgent: boolean
  targetMargin: number | null
}

export function calculateMargin(params: MarginParams): number {
  // User override takes precedence
  if (params.targetMargin !== null) return params.targetMargin

  let margin = 0.15 // default 15%

  // Shipper relationship adjustments
  if (params.shipperId && params.shipperLoadCount === 0) {
    margin = 0.11 // new shipper — competitive pricing
  } else if (params.shipperLoadCount >= 10) {
    margin = 0.165 // loyal shipper — slightly higher
  }

  // Urgent / hot freight
  if (params.isUrgent) {
    margin = Math.max(margin, 0.20)
  }

  // Low confidence buffer
  if (params.confidenceScore < 0.50) {
    margin += 0.025
  }

  return Math.min(0.30, margin)
}
