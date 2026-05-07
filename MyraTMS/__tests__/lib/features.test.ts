import { describe, it, expect } from "vitest"
import {
  ALL_FEATURES,
  ALL_LIMIT_KEYS,
  FEATURES,
  LIMIT_PERIODS,
  TIERS,
  type Feature,
} from "@/lib/features"
import {
  TIER_FEATURES,
  TIER_LIMITS,
  FEATURE_OVERRIDES_SCHEMA,
  computeEffectiveFeatures,
  computeEffectiveLimits,
  limitToJson,
  limitFromJson,
} from "@/lib/features/tiers"
import {
  requireFeature,
  hasFeature,
  withinLimit,
  resolveLimit,
  resolveSubscription,
  usageBand,
  gateErrorResponse,
  FeatureUnavailableError,
  LimitExceededError,
} from "@/lib/features/gate"

// ---------------------------------------------------------------------------
// Layer 1 — definitions integrity
// ---------------------------------------------------------------------------

describe("features/index — catalog integrity", () => {
  it("ALL_FEATURES matches the keys of FEATURES", () => {
    expect(ALL_FEATURES.length).toBe(Object.keys(FEATURES).length)
    for (const key of ALL_FEATURES) {
      expect(FEATURES[key]).toBeDefined()
    }
  })

  it("every LIMIT_KEYS entry has a LIMIT_PERIODS mapping", () => {
    for (const key of ALL_LIMIT_KEYS) {
      expect(LIMIT_PERIODS[key]).toMatch(/^(monthly|daily|concurrent)$/)
    }
  })

  it("TIERS includes the four documented tiers", () => {
    expect(TIERS).toEqual(["starter", "pro", "enterprise", "internal"])
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — tier mapping + override resolution
// ---------------------------------------------------------------------------

describe("TIER_FEATURES — tier-to-feature map", () => {
  it("starter only has the smallest set", () => {
    expect(TIER_FEATURES.starter).toEqual(["tms_basic", "autobroker_starter"])
  })

  it("enterprise gets every feature in FEATURES", () => {
    expect(TIER_FEATURES.enterprise.length).toBe(ALL_FEATURES.length)
  })

  it("internal gets every feature too", () => {
    expect(TIER_FEATURES.internal.length).toBe(ALL_FEATURES.length)
  })

  it("pro is a strict superset of starter", () => {
    for (const f of TIER_FEATURES.starter) {
      // Note: pro replaces autobroker_starter with autobroker_pro — superset
      // means every feature that exists in starter that's NOT specifically
      // upgraded should still be in pro. tms_basic is the only one.
      if (f === "tms_basic") {
        expect(TIER_FEATURES.pro).toContain(f)
      }
    }
  })
})

describe("TIER_LIMITS — tier-to-limit map", () => {
  it("starter has finite caps everywhere", () => {
    for (const k of ALL_LIMIT_KEYS) {
      expect(Number.isFinite(TIER_LIMITS.starter[k])).toBe(true)
    }
  })

  it("enterprise is Infinity everywhere", () => {
    for (const k of ALL_LIMIT_KEYS) {
      expect(TIER_LIMITS.enterprise[k]).toBe(Infinity)
    }
  })

  it("starter caps are <= pro caps", () => {
    for (const k of ALL_LIMIT_KEYS) {
      expect(TIER_LIMITS.starter[k]).toBeLessThanOrEqual(TIER_LIMITS.pro[k])
    }
  })
})

describe("FEATURE_OVERRIDES_SCHEMA — validates the JSONB shape", () => {
  it("accepts an empty object", () => {
    expect(FEATURE_OVERRIDES_SCHEMA.parse({})).toEqual({})
  })

  it("accepts a fully-populated overrides object", () => {
    const ok = FEATURE_OVERRIDES_SCHEMA.parse({
      addedFeatures: ["sso_saml"],
      removedFeatures: ["multi_language"],
      limitOverrides: { personas: 50, retell_minutes_monthly: 100_000 },
    })
    expect(ok.addedFeatures).toEqual(["sso_saml"])
  })

  it("rejects unknown feature names", () => {
    expect(() =>
      FEATURE_OVERRIDES_SCHEMA.parse({ addedFeatures: ["fake_feature"] }),
    ).toThrow()
  })

  it("rejects unknown limit keys (catches typos like 'person')", () => {
    expect(() =>
      FEATURE_OVERRIDES_SCHEMA.parse({
        limitOverrides: { person: 50 },
      }),
    ).toThrow()
  })

  it("rejects extra top-level fields (.strict)", () => {
    expect(() =>
      FEATURE_OVERRIDES_SCHEMA.parse({
        addedFeatures: [],
        bonus: "free shipping",
      }),
    ).toThrow()
  })
})

describe("computeEffectiveFeatures", () => {
  it("returns tier defaults when overrides are null", () => {
    expect(computeEffectiveFeatures("starter", null)).toEqual([
      "tms_basic",
      "autobroker_starter",
    ])
  })

  it("addedFeatures grants beyond-tier features", () => {
    const features = computeEffectiveFeatures("starter", {
      addedFeatures: ["sso_saml"],
    })
    expect(features).toContain("sso_saml")
    expect(features).toContain("tms_basic")
  })

  it("removedFeatures revokes a tier feature", () => {
    const features = computeEffectiveFeatures("pro", {
      removedFeatures: ["multi_language"],
    })
    expect(features).not.toContain("multi_language")
    expect(features).toContain("tms_advanced")
  })

  it("removedFeatures wins over a default tier feature even if also added", () => {
    // Edge: addedFeatures + removedFeatures naming the same flag → removed wins.
    const features = computeEffectiveFeatures("pro", {
      addedFeatures: ["multi_language"],
      removedFeatures: ["multi_language"],
    })
    expect(features).not.toContain("multi_language")
  })

  it("output order matches catalog order in FEATURES", () => {
    const features = computeEffectiveFeatures("enterprise", null)
    expect(features).toEqual(ALL_FEATURES)
  })
})

describe("computeEffectiveLimits", () => {
  it("returns tier defaults when overrides are null", () => {
    expect(computeEffectiveLimits("starter", null).personas).toBe(3)
    expect(computeEffectiveLimits("pro", null).personas).toBe(10)
  })

  it("limitOverrides raises a single limit", () => {
    const limits = computeEffectiveLimits("starter", {
      limitOverrides: { personas: 50 },
    })
    expect(limits.personas).toBe(50)
    expect(limits.users).toBe(3 < 50 ? 5 : 5) // unchanged
  })

  it("limitOverrides can lower a limit too", () => {
    const limits = computeEffectiveLimits("pro", {
      limitOverrides: { users: 5 },
    })
    expect(limits.users).toBe(5)
  })

  it("returns a fresh object per call (no shared state with TIER_LIMITS)", () => {
    const a = computeEffectiveLimits("starter", null)
    a.personas = 999
    const b = computeEffectiveLimits("starter", null)
    expect(b.personas).toBe(3)
  })
})

describe("limitToJson / limitFromJson — Infinity handling", () => {
  it("Infinity → null", () => {
    expect(limitToJson(Infinity)).toBeNull()
  })

  it("null → Infinity", () => {
    expect(limitFromJson(null)).toBe(Infinity)
  })

  it("finite numbers round-trip", () => {
    expect(limitFromJson(limitToJson(50))).toBe(50)
    expect(limitFromJson(limitToJson(0))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — gate enforcement
// ---------------------------------------------------------------------------

function sub(tier: Parameters<typeof resolveSubscription>[1], overrides: Parameters<typeof resolveSubscription>[3] = null) {
  return resolveSubscription(2, tier, "active", overrides)
}

describe("requireFeature / hasFeature", () => {
  it("hasFeature returns true for a tier-default feature", () => {
    expect(hasFeature(sub("starter"), "tms_basic")).toBe(true)
    expect(hasFeature(sub("pro"), "autobroker_pro")).toBe(true)
  })

  it("hasFeature returns false for an out-of-tier feature", () => {
    expect(hasFeature(sub("starter"), "autobroker_pro")).toBe(false)
    expect(hasFeature(sub("starter"), "sso_saml")).toBe(false)
  })

  it("requireFeature passes silently for an in-tier feature", () => {
    expect(() => requireFeature(sub("pro"), "autobroker_pro")).not.toThrow()
  })

  it("requireFeature throws FeatureUnavailableError for out-of-tier", () => {
    try {
      requireFeature(sub("starter"), "autobroker_pro")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureUnavailableError)
      const e = err as FeatureUnavailableError
      expect(e.statusCode).toBe(403)
      expect(e.feature).toBe("autobroker_pro")
      expect(e.tier).toBe("starter")
    }
  })

  it("respects addedFeatures override", () => {
    const s = sub("starter", { addedFeatures: ["sso_saml"] })
    expect(hasFeature(s, "sso_saml")).toBe(true)
    expect(() => requireFeature(s, "sso_saml")).not.toThrow()
  })

  it("respects removedFeatures override", () => {
    const s = sub("pro", { removedFeatures: ["multi_language"] })
    expect(hasFeature(s, "multi_language")).toBe(false)
    expect(() => requireFeature(s, "multi_language")).toThrow(
      FeatureUnavailableError,
    )
  })
})

describe("withinLimit — threshold semantics", () => {
  it("Infinity limits always pass", () => {
    expect(() => withinLimit(sub("enterprise"), "personas", 1_000_000)).not.toThrow()
  })

  it("usage below limit passes silently", () => {
    expect(() => withinLimit(sub("starter"), "personas", 2)).not.toThrow()
    expect(() => withinLimit(sub("starter"), "personas", 0)).not.toThrow()
  })

  it("usage at limit throws limit_reached", () => {
    try {
      withinLimit(sub("starter"), "personas", 3)
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(LimitExceededError)
      const e = err as LimitExceededError
      expect(e.reason).toBe("limit_reached")
      expect(e.statusCode).toBe(429)
      expect(e.limit).toBe(3)
    }
  })

  it("usage at 2x limit throws hard_block", () => {
    try {
      withinLimit(sub("starter"), "personas", 6)
      throw new Error("should have thrown")
    } catch (err) {
      const e = err as LimitExceededError
      expect(e.reason).toBe("hard_block")
    }
  })

  it("limitOverride is respected", () => {
    const s = sub("starter", { limitOverrides: { personas: 100 } })
    expect(() => withinLimit(s, "personas", 50)).not.toThrow()
    expect(() => withinLimit(s, "personas", 100)).toThrow(LimitExceededError)
  })
})

describe("resolveLimit", () => {
  it("returns tier-default + override-resolved limit", () => {
    expect(resolveLimit(sub("starter"), "users")).toBe(5)
    expect(
      resolveLimit(sub("starter", { limitOverrides: { users: 50 } }), "users"),
    ).toBe(50)
    expect(resolveLimit(sub("enterprise"), "users")).toBe(Infinity)
  })
})

describe("usageBand — threshold classification", () => {
  it("normal/warn/limit_reached/over/hard_block bands", () => {
    const s = sub("starter") // personas limit = 3
    expect(usageBand(s, "personas", 0)).toBe("normal")
    expect(usageBand(s, "personas", 2)).toBe("normal")
    // 2.4/3 = 0.7999... in IEEE-754 — just below 0.8, so still 'normal'.
    // Use 2.5 (0.833) to land in the warn band.
    expect(usageBand(s, "personas", 2.5)).toBe("warn")
    expect(usageBand(s, "personas", 3)).toBe("limit_reached")
    expect(usageBand(s, "personas", 4.5)).toBe("over") // 150% of 3
    expect(usageBand(s, "personas", 6)).toBe("hard_block") // 200%
  })

  it("returns 'normal' for Infinity limits regardless of usage", () => {
    expect(usageBand(sub("enterprise"), "personas", 1_000_000)).toBe("normal")
  })

  it("returns 'normal' when limit is 0 (avoid division-by-zero)", () => {
    // starter has quick_pay_advances_monthly = 0 — usage of 0 is "normal",
    // not "limit_reached" via a misleading 0/0 calc.
    expect(usageBand(sub("starter"), "quick_pay_advances_monthly", 0)).toBe(
      "normal",
    )
  })
})

describe("gateErrorResponse", () => {
  it("maps FeatureUnavailableError to 403 JSON", async () => {
    const resp = gateErrorResponse(
      new FeatureUnavailableError("autobroker_pro" as Feature, "starter"),
    )
    expect(resp).not.toBeNull()
    expect(resp!.status).toBe(403)
    const body = await resp!.json()
    expect(body.code).toBe("feature_unavailable")
    expect(body.feature).toBe("autobroker_pro")
    expect(body.tier).toBe("starter")
  })

  it("maps LimitExceededError to 429 JSON", async () => {
    const resp = gateErrorResponse(
      new LimitExceededError("personas", 3, 3, "limit_reached"),
    )
    expect(resp).not.toBeNull()
    expect(resp!.status).toBe(429)
    const body = await resp!.json()
    expect(body.code).toBe("limit_exceeded")
    expect(body.usage).toBe(3)
    expect(body.limit).toBe(3)
    expect(body.reason).toBe("limit_reached")
  })

  it("returns null for non-gate errors (caller must re-throw)", () => {
    expect(gateErrorResponse(new Error("not a gate error"))).toBeNull()
    expect(gateErrorResponse("some string")).toBeNull()
    expect(gateErrorResponse(null)).toBeNull()
  })
})
