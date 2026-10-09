import { describe, it, expect } from "vitest"
import { isBareRoute } from "@/lib/bare-routes"

describe("isBareRoute", () => {
  it("treats login, invite and rate pages as chrome-free", () => {
    for (const p of ["/login", "/invite/abc", "/rate/tok.en", "/rate/tok?stars=5".split("?")[0]]) {
      expect(isBareRoute(p)).toBe(true)
    }
  })
  it("keeps chrome on app routes, including lookalikes", () => {
    for (const p of ["/", "/loads", "/rates", "/invitees", "/login-help", "/settings/import"]) {
      expect(isBareRoute(p)).toBe(false)
    }
  })
  it("handles null pathname", () => {
    expect(isBareRoute(null)).toBe(false)
  })
})
