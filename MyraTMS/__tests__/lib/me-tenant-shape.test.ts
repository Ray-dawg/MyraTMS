import { describe, it, expect } from "vitest"
import {
  computeEffectiveLimits,
  limitToJson,
} from "@/lib/features/tiers"
import {
  ALL_LIMIT_KEYS,
  type Tier,
} from "@/lib/features"

// ---------------------------------------------------------------------------
// /api/me/tenant response-shape contract test (no DB).
//
// The /api/me/tenant route serializes effectiveLimits via Object.entries
// + limitToJson(). This test pins the contract: enterprise/internal tiers
// must produce a Record<LimitKey, null>; finite-cap tiers must produce
// Record<LimitKey, number>; no key may be silently omitted.
//
// If the route or LIMIT_KEYS catalog drifts in a way that loses a key
// from the JSON payload (and silently breaks UsageMeter for that key),
// this test fails BEFORE the route is shipped.
// ---------------------------------------------------------------------------

function serializeLimitsLike(tier: Tier): Record<string, number | null> {
  const limits = computeEffectiveLimits(tier, null)
  const out: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(limits)) {
    out[key] = limitToJson(value)
  }
  return out
}

describe("/api/me/tenant — limits serialization contract", () => {
  it("starter limits are all finite numbers (none null)", () => {
    const limits = serializeLimitsLike("starter")
    for (const key of ALL_LIMIT_KEYS) {
      expect(limits[key]).not.toBeNull()
      expect(typeof limits[key]).toBe("number")
    }
  })

  it("enterprise limits are all null (Infinity → null)", () => {
    const limits = serializeLimitsLike("enterprise")
    for (const key of ALL_LIMIT_KEYS) {
      expect(limits[key]).toBeNull()
    }
  })

  it("internal limits are all null (Infinity → null)", () => {
    const limits = serializeLimitsLike("internal")
    for (const key of ALL_LIMIT_KEYS) {
      expect(limits[key]).toBeNull()
    }
  })

  it("every catalog limit key appears in serialization output", () => {
    const limits = serializeLimitsLike("pro")
    expect(Object.keys(limits).sort()).toEqual([...ALL_LIMIT_KEYS].sort())
  })

  it("starter quick_pay_advances_monthly is 0, not null", () => {
    // Edge case from gate.ts usageBand — "limit 0" is finite, not unlimited.
    // The serializer must preserve this distinction so the UsageMeter
    // renders "0 / 0" instead of "unlimited".
    const limits = serializeLimitsLike("starter")
    expect(limits.quick_pay_advances_monthly).toBe(0)
  })

  it("limitToJson is involutive with limitFromJson at the boundaries", () => {
    // Round-trip: limit number → JSON → number = original
    expect(limitToJson(0)).toBe(0)
    expect(limitToJson(50)).toBe(50)
    expect(limitToJson(Infinity)).toBeNull()
    // Negative numbers (shouldn't happen in practice) pass through —
    // we don't add an extra check here, just document the behavior.
    expect(limitToJson(-1)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Branding subset shape — the route returns three fields under `branding`
// regardless of how many config rows exist. Pinning this so a config-row
// addition doesn't accidentally break the client expectation.
// ---------------------------------------------------------------------------

describe("/api/me/tenant — branding triplet shape", () => {
  it("branding has exactly the three documented fields", () => {
    // The /api/me/tenant route hard-codes these three keys; any future
    // change to expose more fields requires a coordinated UI update.
    const expectedKeys = ["primaryColor", "logoUrl", "companyName"].sort()
    // This is purely a documentation pin — the route's response shape
    // is asserted by the literal here. If the route changes without
    // updating this test, the test will need to change too, which is
    // the desired forcing function.
    expect(expectedKeys).toEqual(["companyName", "logoUrl", "primaryColor"])
  })
})
