import { describe, it, expect } from "vitest"
import {
  resolveSubscription,
  requireFeature,
  hasFeature,
  withinLimit,
  resolveLimit,
  FeatureUnavailableError,
  LimitExceededError,
} from "@/lib/features/gate"
import type { Tier } from "@/lib/features"
import type { FeatureOverrides } from "@/lib/features/tiers"

// ---------------------------------------------------------------------------
// Subscription lifecycle integration tests — exercise the full chain:
//   tier change → resolveSubscription → requireFeature/withinLimit
// using fixtures (no DB).
//
// Per ADR-003 §Validation item 5 — "Phase 7.1 test suite scenario 3
// (tenant downgrade — features become unavailable) passes".
// ---------------------------------------------------------------------------

const TENANT = 2

function sub(tier: Tier, overrides: FeatureOverrides | null = null) {
  return resolveSubscription(TENANT, tier, "active", overrides)
}

// ---------------------------------------------------------------------------
// Scenario 1: Pro tenant downgrades to Starter
// ---------------------------------------------------------------------------

describe("Scenario: tenant downgrade Pro → Starter", () => {
  it("Pro tenant has tms_advanced before downgrade", () => {
    expect(hasFeature(sub("pro"), "tms_advanced")).toBe(true)
    expect(() => requireFeature(sub("pro"), "tms_advanced")).not.toThrow()
  })

  it("Starter tenant does NOT have tms_advanced after downgrade", () => {
    expect(hasFeature(sub("starter"), "tms_advanced")).toBe(false)
    expect(() => requireFeature(sub("starter"), "tms_advanced")).toThrow(
      FeatureUnavailableError,
    )
  })

  it("Pro had api_access; Starter does not", () => {
    expect(hasFeature(sub("pro"), "api_access")).toBe(true)
    expect(hasFeature(sub("starter"), "api_access")).toBe(false)
  })

  it("Pro had multi_language; Starter does not", () => {
    expect(hasFeature(sub("pro"), "multi_language")).toBe(true)
    expect(hasFeature(sub("starter"), "multi_language")).toBe(false)
  })

  it("downgrade also tightens limits — personas drops 10 → 3", () => {
    expect(resolveLimit(sub("pro"), "personas")).toBe(10)
    expect(resolveLimit(sub("starter"), "personas")).toBe(3)
  })

  it("downgrade strips quick_pay_advances entirely (limit becomes 0)", () => {
    expect(resolveLimit(sub("pro"), "quick_pay_advances_monthly")).toBe(50)
    expect(resolveLimit(sub("starter"), "quick_pay_advances_monthly")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: Tenant on Starter granted a single feature via override
// ---------------------------------------------------------------------------

describe("Scenario: per-tenant override grants a beyond-tier feature", () => {
  const proPatched: FeatureOverrides = { addedFeatures: ["sso_saml"] }

  it("starter+sso_saml grants sso_saml at requireFeature", () => {
    const s = sub("starter", proPatched)
    expect(hasFeature(s, "sso_saml")).toBe(true)
    expect(() => requireFeature(s, "sso_saml")).not.toThrow()
  })

  it("but does NOT grant other enterprise features", () => {
    const s = sub("starter", proPatched)
    expect(hasFeature(s, "data_lane_intelligence")).toBe(false)
    expect(() => requireFeature(s, "data_lane_intelligence")).toThrow(
      FeatureUnavailableError,
    )
  })

  it("removing the override revokes the grant immediately", () => {
    const s = sub("starter", null)
    expect(hasFeature(s, "sso_saml")).toBe(false)
    expect(() => requireFeature(s, "sso_saml")).toThrow(FeatureUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: Limit override raises a numeric cap
// ---------------------------------------------------------------------------

describe("Scenario: per-tenant limit override raises a Starter cap", () => {
  it("Starter default personas = 3; override raises to 50", () => {
    const before = sub("starter", null)
    const after = sub("starter", { limitOverrides: { personas: 50 } })
    expect(resolveLimit(before, "personas")).toBe(3)
    expect(resolveLimit(after, "personas")).toBe(50)
  })

  it("withinLimit pivots from blocking to passing at the override boundary", () => {
    const before = sub("starter", null)
    const after = sub("starter", { limitOverrides: { personas: 50 } })

    // 5 personas: blocked on plain Starter (limit 3, so 5 >= 3 → reached → 5 also >= 3*2=6? no, 5<6 → limit_reached, not hard_block)
    expect(() => withinLimit(before, "personas", 5)).toThrow(LimitExceededError)
    // Same usage under raised limit: passes silently.
    expect(() => withinLimit(after, "personas", 5)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: removedFeatures override revokes a tier-default capability
// ---------------------------------------------------------------------------

describe("Scenario: removedFeatures revokes a Pro-default capability", () => {
  it("Pro tenant minus multi_language can no longer use it", () => {
    const s = sub("pro", { removedFeatures: ["multi_language"] })
    expect(hasFeature(s, "multi_language")).toBe(false)
    expect(() => requireFeature(s, "multi_language")).toThrow(
      FeatureUnavailableError,
    )
  })

  it("but other Pro features are unaffected", () => {
    const s = sub("pro", { removedFeatures: ["multi_language"] })
    expect(hasFeature(s, "tms_advanced")).toBe(true)
    expect(hasFeature(s, "autobroker_pro")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Enterprise → no feature is ever blocked
// ---------------------------------------------------------------------------

describe("Scenario: Enterprise tier has no feature gate", () => {
  it("every catalog feature is available", () => {
    const s = sub("enterprise")
    for (const feat of [
      "sso_saml",
      "data_lane_intelligence",
      "whitelabel_branding",
      "autobroker_enterprise",
      "tms_advanced",
    ] as const) {
      expect(hasFeature(s, feat)).toBe(true)
    }
  })

  it("withinLimit always passes (Infinity caps)", () => {
    const s = sub("enterprise")
    expect(() => withinLimit(s, "personas", 1_000_000)).not.toThrow()
    expect(() =>
      withinLimit(s, "retell_minutes_monthly", 999_999_999),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: Internal tier behaves identically to enterprise
// ---------------------------------------------------------------------------

describe("Scenario: Internal tier (operating-company) ≡ enterprise capability set", () => {
  it("has every catalog feature", () => {
    const internal = sub("internal")
    const enterprise = sub("enterprise")
    expect(internal.effectiveFeatures.sort()).toEqual(
      enterprise.effectiveFeatures.sort(),
    )
  })

  it("has identical Infinity limits", () => {
    const internal = sub("internal")
    for (const limit of Object.values(internal.effectiveLimits)) {
      expect(limit).toBe(Infinity)
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: removedFeatures wins over addedFeatures naming the same key
// ---------------------------------------------------------------------------

describe("Scenario: removedFeatures wins when both lists name the same feature", () => {
  it("starter +sso_saml -sso_saml → no sso_saml", () => {
    const s = sub("starter", {
      addedFeatures: ["sso_saml"],
      removedFeatures: ["sso_saml"],
    })
    expect(hasFeature(s, "sso_saml")).toBe(false)
  })
})
