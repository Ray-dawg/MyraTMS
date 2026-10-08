import { afterEach, describe, expect, it } from "vitest"
import {
  assertNotProductionUnderTest,
  isProductionDatabaseUrl,
  ProductionDatabaseGuardError,
} from "@/lib/db/production-guard"

const PROD_URL =
  "postgresql://u:p@ep-lively-shadow-aibzw8bp.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require"
const DEV_URL =
  "postgresql://u:p@ep-some-dev-branch-abc123.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require"

describe("production-guard", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("recognises the production endpoint and branch ids", () => {
    expect(isProductionDatabaseUrl(PROD_URL)).toBe(true)
    expect(isProductionDatabaseUrl("x br-rough-forest-aif4a3vf x")).toBe(true)
    expect(isProductionDatabaseUrl(DEV_URL)).toBe(false)
    expect(isProductionDatabaseUrl(undefined)).toBe(false)
  })

  it("throws under vitest when DATABASE_URL is production", () => {
    delete process.env.ALLOW_PROD_TESTS
    expect(() => assertNotProductionUnderTest(PROD_URL)).toThrow(ProductionDatabaseGuardError)
  })

  it("allows a dev branch under vitest", () => {
    expect(() => assertNotProductionUnderTest(DEV_URL)).not.toThrow()
  })

  it("honours the explicit ALLOW_PROD_TESTS=1 escape hatch", () => {
    process.env.ALLOW_PROD_TESTS = "1"
    expect(() => assertNotProductionUnderTest(PROD_URL)).not.toThrow()
  })

  it("is a no-op outside a test runtime", () => {
    delete process.env.VITEST
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    expect(() => assertNotProductionUnderTest(PROD_URL)).not.toThrow()
  })
})
