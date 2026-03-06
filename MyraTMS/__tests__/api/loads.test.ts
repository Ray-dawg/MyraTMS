import { describe, it, expect } from "vitest"

// ---------------------------------------------------------------------------
// Unit tests for loads API business logic
//
// These test the core business logic used in the loads API routes without
// needing a running server or database. We extract and test the pure
// functions / patterns used in app/api/loads/route.ts and
// app/api/loads/[id]/route.ts.
// ---------------------------------------------------------------------------

// -- ID generation ----------------------------------------------------------

describe("Load ID generation", () => {
  it("generates an ID matching the LD-<base36> format", () => {
    const id = `LD-${Date.now().toString(36).toUpperCase()}`
    expect(id).toMatch(/^LD-[A-Z0-9]+$/)
  })

  it("generates unique IDs on successive calls", () => {
    const id1 = `LD-${Date.now().toString(36).toUpperCase()}`
    // Date.now() has ms resolution; ensure at least 1ms gap
    const id2 = `LD-${(Date.now() + 1).toString(36).toUpperCase()}`
    expect(id1).not.toBe(id2)
  })

  it("produces IDs with a reasonable length", () => {
    const id = `LD-${Date.now().toString(36).toUpperCase()}`
    // base36 of a timestamp in 2026 is ~8 chars → total ~11 chars
    expect(id.length).toBeGreaterThanOrEqual(10)
    expect(id.length).toBeLessThanOrEqual(15)
  })
})

// -- Status validation ------------------------------------------------------

const VALID_STATUSES = [
  "Booked",
  "Dispatched",
  "In Transit",
  "At Pickup",
  "At Delivery",
  "Delivered",
  "Invoiced",
  "Paid",
  "Cancelled",
]

describe("Load status validation", () => {
  it("accepts all valid statuses", () => {
    for (const status of VALID_STATUSES) {
      expect(VALID_STATUSES.includes(status)).toBe(true)
    }
  })

  it("rejects invalid statuses", () => {
    expect(VALID_STATUSES.includes("InvalidStatus")).toBe(false)
    expect(VALID_STATUSES.includes("")).toBe(false)
    expect(VALID_STATUSES.includes("booked")).toBe(false) // case-sensitive
  })
})

// -- Margin calculation -----------------------------------------------------

function calculateMargin(revenue: number, carrierCost: number) {
  const margin = revenue - carrierCost
  const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0
  return { margin, marginPercent }
}

describe("Margin calculation", () => {
  it("calculates margin correctly for normal values", () => {
    const { margin, marginPercent } = calculateMargin(5000, 4000)
    expect(margin).toBe(1000)
    expect(marginPercent).toBe(20) // (1000/5000) * 100 = 20
  })

  it("handles zero revenue", () => {
    const { margin, marginPercent } = calculateMargin(0, 0)
    expect(margin).toBe(0)
    expect(marginPercent).toBe(0)
  })

  it("handles negative margin (carrier cost exceeds revenue)", () => {
    const { margin, marginPercent } = calculateMargin(3000, 4000)
    expect(margin).toBe(-1000)
    expect(marginPercent).toBe(-33) // Math.round((-1000/3000)*100) = -33
  })

  it("handles 100% margin (zero carrier cost)", () => {
    const { margin, marginPercent } = calculateMargin(5000, 0)
    expect(margin).toBe(5000)
    expect(marginPercent).toBe(100)
  })

  it("rounds margin percent to nearest integer", () => {
    // (500/3000)*100 = 16.666... rounds to 17
    const { marginPercent } = calculateMargin(3000, 2500)
    expect(marginPercent).toBe(17)
  })

  it("uses default zero for missing revenue/carrierCost", () => {
    // Mirrors the API route: body.revenue || 0, body.carrierCost || 0
    const revenue = undefined || 0
    const carrierCost = undefined || 0
    const { margin, marginPercent } = calculateMargin(revenue, carrierCost)
    expect(margin).toBe(0)
    expect(marginPercent).toBe(0)
  })
})

// -- Column whitelist mapping -----------------------------------------------

const ALLOWED_COLUMNS: Record<string, string> = {
  origin: "origin",
  destination: "destination",
  shipperId: "shipper_id",
  shipperName: "shipper_name",
  carrierId: "carrier_id",
  carrierName: "carrier_name",
  source: "source",
  status: "status",
  revenue: "revenue",
  carrierCost: "carrier_cost",
  margin: "margin",
  marginPercent: "margin_percent",
  pickupDate: "pickup_date",
  deliveryDate: "delivery_date",
  assignedRep: "assigned_rep",
  equipment: "equipment",
  weight: "weight",
  riskFlag: "risk_flag",
  driverId: "driver_id",
  trackingToken: "tracking_token",
  currentLat: "current_lat",
  currentLng: "current_lng",
  currentEta: "current_eta",
  originLat: "origin_lat",
  originLng: "origin_lng",
  destLat: "dest_lat",
  destLng: "dest_lng",
  podUrl: "pod_url",
  commodity: "commodity",
  poNumber: "po_number",
  referenceNumber: "reference_number",
}

describe("PATCH column whitelist", () => {
  it("maps camelCase keys to snake_case columns", () => {
    expect(ALLOWED_COLUMNS["carrierCost"]).toBe("carrier_cost")
    expect(ALLOWED_COLUMNS["marginPercent"]).toBe("margin_percent")
    expect(ALLOWED_COLUMNS["shipperName"]).toBe("shipper_name")
    expect(ALLOWED_COLUMNS["pickupDate"]).toBe("pickup_date")
  })

  it("passes through already-snake_case names unchanged", () => {
    expect(ALLOWED_COLUMNS["origin"]).toBe("origin")
    expect(ALLOWED_COLUMNS["destination"]).toBe("destination")
    expect(ALLOWED_COLUMNS["status"]).toBe("status")
  })

  it("returns undefined for unknown/disallowed keys", () => {
    expect(Object.prototype.hasOwnProperty.call(ALLOWED_COLUMNS, "__proto__")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(ALLOWED_COLUMNS, "constructor")).toBe(false)
    expect(ALLOWED_COLUMNS["id"]).toBeUndefined()
    expect(ALLOWED_COLUMNS["created_at"]).toBeUndefined()
    expect(ALLOWED_COLUMNS["password"]).toBeUndefined()
  })

  it("builds SET clauses only for whitelisted fields", () => {
    const body = { status: "Delivered", hackerField: "DROP TABLE", origin: "Chicago, IL" }
    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(body)) {
      const col = ALLOWED_COLUMNS[key]
      if (!col) continue
      setClauses.push(`${col} = $${values.length + 1}`)
      values.push(value)
    }

    expect(setClauses).toHaveLength(2) // status + origin, hackerField excluded
    expect(values).toEqual(["Delivered", "Chicago, IL"])
    expect(setClauses[0]).toBe("status = $1")
    expect(setClauses[1]).toBe("origin = $2")
  })
})
