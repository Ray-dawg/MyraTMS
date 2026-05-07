import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  TENANT_CONFIG_VALIDATORS,
  validateConfigValue,
  isKnownConfigKey,
  isEncryptedConfigKey,
} from "@/lib/tenants/config-schema"
import {
  DEFAULT_TENANT_CONFIG,
  SENSITIVE_CONFIG_KEYS,
} from "@/lib/tenants/defaults"

// ---------------------------------------------------------------------------
// Coverage guard — every default key + every sensitive key must have a
// validator entry. The schema's setRequiredKeysCovered() throws at module
// load time, so importing the module in this test file is itself the check.
// ---------------------------------------------------------------------------

describe("tenant config schema — coverage guard", () => {
  it("loads without throwing (every default + sensitive key has a validator)", () => {
    expect(Object.keys(TENANT_CONFIG_VALIDATORS).length).toBeGreaterThan(
      DEFAULT_TENANT_CONFIG.length,
    )
  })

  it("every DEFAULT_TENANT_CONFIG key is recognized", () => {
    for (const def of DEFAULT_TENANT_CONFIG) {
      expect(isKnownConfigKey(def.key)).toBe(true)
    }
  })

  it("every SENSITIVE_CONFIG_KEYS entry is recognized and marked encrypted", () => {
    for (const key of SENSITIVE_CONFIG_KEYS) {
      expect(isKnownConfigKey(key)).toBe(true)
      expect(isEncryptedConfigKey(key)).toBe(true)
    }
  })

  it("non-sensitive default keys are NOT marked encrypted", () => {
    const sensitive = new Set(SENSITIVE_CONFIG_KEYS as ReadonlyArray<string>)
    for (const def of DEFAULT_TENANT_CONFIG) {
      if (!sensitive.has(def.key)) {
        expect(isEncryptedConfigKey(def.key)).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Per-key validation cases — exercise representative shapes
// ---------------------------------------------------------------------------

describe("validateConfigValue — accepts valid values", () => {
  it("currency_default accepts CAD/USD/EUR/GBP", () => {
    expect(validateConfigValue("currency_default", "CAD")).toBe("CAD")
    expect(validateConfigValue("currency_default", "USD")).toBe("USD")
  })

  it("locale_default accepts BCP 47 like en-CA, fr-CA", () => {
    expect(validateConfigValue("locale_default", "en-CA")).toBe("en-CA")
    expect(validateConfigValue("locale_default", "fr-CA")).toBe("fr-CA")
  })

  it("timezone_default accepts a real IANA tz", () => {
    expect(validateConfigValue("timezone_default", "America/Toronto")).toBe(
      "America/Toronto",
    )
    expect(validateConfigValue("timezone_default", "Europe/London")).toBe(
      "Europe/London",
    )
  })

  it("margin_floor_cad accepts numbers in 0-10000", () => {
    expect(validateConfigValue("margin_floor_cad", 0)).toBe(0)
    expect(validateConfigValue("margin_floor_cad", 150)).toBe(150)
    expect(validateConfigValue("margin_floor_cad", 10_000)).toBe(10_000)
  })

  it("walk_away_rate_factor accepts 0.5-1.0 range", () => {
    expect(validateConfigValue("walk_away_rate_factor", 0.5)).toBe(0.5)
    expect(validateConfigValue("walk_away_rate_factor", 0.92)).toBe(0.92)
    expect(validateConfigValue("walk_away_rate_factor", 1.0)).toBe(1.0)
  })

  it("branding_primary_color accepts #RRGGBB hex", () => {
    expect(validateConfigValue("branding_primary_color", "#FFFFFF")).toBe(
      "#FFFFFF",
    )
    expect(validateConfigValue("branding_primary_color", "#0066ff")).toBe(
      "#0066ff",
    )
  })

  it("branding_logo_url accepts URLs and null", () => {
    expect(
      validateConfigValue("branding_logo_url", "https://example.com/logo.png"),
    ).toBe("https://example.com/logo.png")
    expect(validateConfigValue("branding_logo_url", null)).toBeNull()
  })

  it("smtp_from_email accepts emails", () => {
    expect(
      validateConfigValue("smtp_from_email", "ops@myralogistics.com"),
    ).toBe("ops@myralogistics.com")
  })

  it("notif_checkcall_enabled accepts booleans", () => {
    expect(validateConfigValue("notif_checkcall_enabled", true)).toBe(true)
    expect(validateConfigValue("notif_checkcall_enabled", false)).toBe(false)
  })

  it("twilio_from_number accepts E.164 like +14165551212", () => {
    expect(validateConfigValue("twilio_from_number", "+14165551212")).toBe(
      "+14165551212",
    )
  })

  it("encrypted credential keys accept any non-empty string", () => {
    expect(validateConfigValue("dat_credentials", "abc123")).toBe("abc123")
    expect(validateConfigValue("retell_api_key", "rk_test_xyz")).toBe(
      "rk_test_xyz",
    )
  })
})

describe("validateConfigValue — rejects invalid values", () => {
  it("currency_default rejects unknown codes", () => {
    expect(() => validateConfigValue("currency_default", "JPY")).toThrow(z.ZodError)
    expect(() => validateConfigValue("currency_default", "")).toThrow()
  })

  it("locale_default rejects malformed BCP 47", () => {
    expect(() => validateConfigValue("locale_default", "en")).toThrow(z.ZodError)
    expect(() => validateConfigValue("locale_default", "EN-ca")).toThrow(
      z.ZodError,
    )
  })

  it("timezone_default rejects garbage strings", () => {
    expect(() => validateConfigValue("timezone_default", "Mars/Olympus")).toThrow(
      /Invalid IANA timezone/,
    )
  })

  it("margin_floor_cad rejects negatives and over-cap", () => {
    expect(() => validateConfigValue("margin_floor_cad", -1)).toThrow(z.ZodError)
    expect(() => validateConfigValue("margin_floor_cad", 10_001)).toThrow(
      z.ZodError,
    )
  })

  it("walk_away_rate_factor rejects out-of-range factors", () => {
    expect(() => validateConfigValue("walk_away_rate_factor", 0.4)).toThrow(
      z.ZodError,
    )
    expect(() => validateConfigValue("walk_away_rate_factor", 1.1)).toThrow(
      z.ZodError,
    )
  })

  it("branding_primary_color rejects non-hex", () => {
    expect(() =>
      validateConfigValue("branding_primary_color", "blue"),
    ).toThrow(/RRGGBB/)
    expect(() =>
      validateConfigValue("branding_primary_color", "#GGGGGG"),
    ).toThrow(/RRGGBB/)
  })

  it("smtp_from_email rejects malformed emails", () => {
    expect(() => validateConfigValue("smtp_from_email", "not-an-email")).toThrow(
      z.ZodError,
    )
  })

  it("twilio_from_number rejects non-E.164", () => {
    expect(() =>
      validateConfigValue("twilio_from_number", "555-1212"),
    ).toThrow(/E\.164/)
  })

  it("unknown key throws a non-Zod error", () => {
    expect(() => validateConfigValue("nonexistent_key", "anything")).toThrow(
      /Unknown config key/,
    )
  })
})

describe("isKnownConfigKey / isEncryptedConfigKey", () => {
  it("returns false for unknown keys", () => {
    expect(isKnownConfigKey("nonexistent_key")).toBe(false)
    expect(isEncryptedConfigKey("nonexistent_key")).toBe(false)
  })

  it("flags sensitive keys as encrypted", () => {
    expect(isEncryptedConfigKey("retell_api_key")).toBe(true)
    expect(isEncryptedConfigKey("dat_credentials")).toBe(true)
    expect(isEncryptedConfigKey("twilio_auth_token")).toBe(true)
  })

  it("does NOT flag plaintext keys as encrypted", () => {
    expect(isEncryptedConfigKey("currency_default")).toBe(false)
    expect(isEncryptedConfigKey("margin_floor_cad")).toBe(false)
    expect(isEncryptedConfigKey("notif_checkcall_enabled")).toBe(false)
  })
})
