import { describe, it, expect } from "vitest"
import { resolveAlertTarget, alertKey, getActionNotice, containsToken } from "@/lib/intelligence/alert-target"

const carriers = [
  { id: "CAR-1", company: "Swift Haulers" },
  { id: "CAR-2", company: "Swift" },
  { id: "CAR-3", company: "Blue Ridge Freight LLC" },
]
const shippers = [
  { id: "SHP-1", company: "Acme Foods" },
  { id: "SHP-2", company: "Blue Ridge" },
]
const data = { carriers, shippers }
const alert = (affectedEntity: string | null, title = "Some risk") => ({ severity: "high", title, affectedEntity })

describe("resolveAlertTarget", () => {
  it("routes a load id to /loads/<ID>, normalizing case", () => {
    const t = resolveAlertTarget(alert("ld-4821"), data)
    expect(t).toMatchObject({ kind: "load", href: "/loads/LD-4821" })
  })

  it("finds a load id embedded in a sentence", () => {
    const t = resolveAlertTarget(alert("Load LD-MK3Z9 (Chicago to Dallas) has negative margin"), data)
    expect(t.href).toBe("/loads/LD-MK3Z9")
  })

  it("load id beats a carrier name in the same text", () => {
    expect(resolveAlertTarget(alert("Swift Haulers on LD-77"), data).href).toBe("/loads/LD-77")
  })

  it("falls back to the title when affectedEntity is null", () => {
    expect(resolveAlertTarget(alert(null, "Negative margin on LD-9001"), data).href).toBe("/loads/LD-9001")
  })

  it("matches a carrier by exact name, case-insensitively", () => {
    const t = resolveAlertTarget(alert("swift haulers"), data)
    expect(t).toMatchObject({ kind: "carrier", href: "/carriers/CAR-1" })
  })

  it("picks the longest carrier name match", () => {
    expect(resolveAlertTarget(alert("Swift Haulers insurance lapsed"), data).href).toBe("/carriers/CAR-1")
    expect(resolveAlertTarget(alert("Swift insurance lapsed"), data).href).toBe("/carriers/CAR-2")
  })

  it("finds a later valid occurrence when the first is inside a longer word", () => {
    // 'Swift' first appears inside 'Swiftly' (boundary fails) but is named verbatim later.
    const t = resolveAlertTarget(alert("Swiftly, Swift lapsed on insurance"), data)
    expect(t).toMatchObject({ kind: "carrier", href: "/carriers/CAR-2" })
  })

  it("does not match a name inside a longer word", () => {
    expect(resolveAlertTarget(alert("Swiftly moving freight"), data).kind).toBe("list")
  })

  it("matches a shipper by name", () => {
    expect(resolveAlertTarget(alert("Acme Foods"), data)).toMatchObject({ kind: "shipper", href: "/shippers/SHP-1" })
  })

  it("prefers the longer match across carriers and shippers", () => {
    // 'Blue Ridge Freight LLC' (carrier) is longer than 'Blue Ridge' (shipper)
    expect(resolveAlertTarget(alert("Blue Ridge Freight LLC authority revoked"), data).href).toBe("/carriers/CAR-3")
    // only the shipper name present
    expect(resolveAlertTarget(alert("Blue Ridge volume dropping"), data).href).toBe("/shippers/SHP-2")
  })

  it("matches an explicit entity id", () => {
    expect(resolveAlertTarget(alert("CAR-3"), data).href).toBe("/carriers/CAR-3")
  })

  it("encodes ids in the path", () => {
    const odd = { carriers: [{ id: "CAR 1/2", company: "Odd Co" }], shippers: [] }
    expect(resolveAlertTarget(alert("Odd Co"), odd).href).toBe("/carriers/CAR%201%2F2")
  })

  describe("list fallbacks", () => {
    it("carrier-ish text goes to /carriers and carries the search text", () => {
      const t = resolveAlertTarget(alert("Unknown carrier insurance expiring"), data)
      expect(t).toMatchObject({ kind: "list", href: "/carriers", search: "Unknown carrier insurance expiring" })
    })
    it("shipper-ish text goes to /shippers", () => {
      expect(resolveAlertTarget(alert("Several customers at risk"), data).href).toBe("/shippers")
    })
    it("invoice-ish text goes to /finance", () => {
      expect(resolveAlertTarget(alert("Overdue invoices piling up"), data).href).toBe("/finance")
    })
    it("anything else goes to /loads; null entity has no search", () => {
      const t = resolveAlertTarget(alert(null, "Too many loads in Booked"), data)
      expect(t).toMatchObject({ kind: "list", href: "/loads" })
      expect(t.search).toBeUndefined()
    })
    it("only ever returns known route prefixes", () => {
      const samples = ["x", "", "LD-1", "Acme Foods", "Swift", "invoice", "carrier", "<script>", "../../etc"]
      for (const s of samples) {
        const { href } = resolveAlertTarget(alert(s || null), data)
        expect(href).toMatch(/^\/(loads|carriers|shippers|finance)(\/[^/]+)?$/)
      }
    })
  })
})

describe("alertKey", () => {
  it("is stable across reordering (does not depend on position)", () => {
    const a = { severity: "high", title: "Insurance lapse", affectedEntity: "Swift" }
    const b = { severity: "low", title: "Margin", affectedEntity: null }
    const first = [a, b].map(alertKey)
    const second = [b, a].map(alertKey)
    expect(second).toEqual([first[1], first[0]])
  })

  it("ignores case and whitespace differences", () => {
    expect(alertKey({ severity: "High", title: "Insurance  Lapse", affectedEntity: " Swift " })).toBe(
      alertKey({ severity: "high", title: "insurance lapse", affectedEntity: "swift" }),
    )
  })

  it("distinguishes different alerts", () => {
    expect(alertKey({ severity: "high", title: "A", affectedEntity: "x" })).not.toBe(
      alertKey({ severity: "high", title: "A", affectedEntity: "y" }),
    )
    expect(alertKey({ severity: "high", title: "A", affectedEntity: null })).not.toBe(
      alertKey({ severity: "low", title: "A", affectedEntity: null }),
    )
  })
})

describe("alertKey description", () => {
  it("distinguishes alerts that differ only in description", () => {
    const base = { severity: "high", title: "Low margin", affectedEntity: null }
    expect(alertKey({ ...base, description: "LD-1 at 2%" })).not.toBe(alertKey({ ...base, description: "LD-2 at 1%" }))
  })
  it("still ignores case/whitespace in description", () => {
    const base = { severity: "high", title: "Low margin", affectedEntity: null }
    expect(alertKey({ ...base, description: "LD-1  at 2%" })).toBe(alertKey({ ...base, description: "ld-1 at 2%" }))
  })
  it("treats a missing description like an empty one", () => {
    const base = { severity: "high", title: "T", affectedEntity: "x" }
    expect(alertKey(base)).toBe(alertKey({ ...base, description: "" }))
  })
})

describe("getActionNotice", () => {
  const loadIds = ["LD-1", "LD-2"]
  it("warns on a list fallback with null affectedEntity (nothing actioned)", () => {
    const target = resolveAlertTarget(alert(null, "Too many loads in Booked"), data)
    const n = getActionNotice(target, loadIds)
    expect(n).not.toBeNull()
    expect(n!.level).toBe("info")
    expect(n!.message).toMatch(/nothing has been actioned/i)
    expect(n!.message).toContain("Loads")
  })
  it("asks the operator to search when a list fallback has search text", () => {
    const target = resolveAlertTarget(alert("Unknown carrier insurance expiring"), data)
    const n = getActionNotice(target, loadIds)
    expect(n!.message).toContain('search for "Unknown carrier insurance expiring"')
  })
  it("warns when a load id is not in the recent loads", () => {
    const target = resolveAlertTarget(alert("LD-999"), data)
    const n = getActionNotice(target, loadIds)
    expect(n).toEqual({ level: "warning", message: "LD-999 isn't in your recent loads — it may not exist." })
  })
  it("is silent for a load that is in the recent loads", () => {
    const target = resolveAlertTarget(alert("LD-1"), data)
    expect(getActionNotice(target, loadIds)).toBeNull()
  })
  it("is silent for a resolved carrier/shipper", () => {
    expect(getActionNotice(resolveAlertTarget(alert("Acme Foods"), data), loadIds)).toBeNull()
    expect(getActionNotice(resolveAlertTarget(alert("Swift Haulers"), data), loadIds)).toBeNull()
  })
})

describe("containsToken", () => {
  it("returns false (and terminates) for an empty needle", () => {
    expect(containsToken("abc", "")).toBe(false)
    expect(containsToken("", "")).toBe(false)
  })
  it("still matches standalone tokens and rejects embedded ones", () => {
    expect(containsToken("swift inc", "swift")).toBe(true)
    expect(containsToken("swiftly then swift inc", "swift")).toBe(true)
    expect(containsToken("swiftly", "swift")).toBe(false)
  })
})

describe("containsToken word boundaries", () => {
  it("rejects a match whose LEFT neighbour is a word character", () => {
    // Guards the `before` half of the boundary check. Without it "ACME" would
    // match inside "MACMEN" and every other test here would still pass.
    expect(containsToken("macmen", "acme")).toBe(false)
    expect(containsToken("xacme", "acme")).toBe(false)
  })

  it("accepts a match whose left neighbour is punctuation or whitespace", () => {
    expect(containsToken("(acme)", "acme")).toBe(true)
    expect(containsToken("re: acme", "acme")).toBe(true)
  })

  it("rejects when embedded on both sides but accepts a later standalone run", () => {
    expect(containsToken("macmen", "acme")).toBe(false)
    expect(containsToken("macmen and acme co", "acme")).toBe(true)
  })
})

describe("resolveAlertTarget entity fallback chain", () => {
  it("matches a carrier named only in the title when affectedEntity matches nothing", () => {
    // Guards `sources` including alert.title for *entity* matching, not just
    // for load-id extraction (which the LD-9001 test already covers).
    const t = resolveAlertTarget(alert("nothing recognisable here", "Insurance lapse at Swift Haulers"), data)
    expect(t).toMatchObject({ kind: "carrier", href: "/carriers/CAR-1" })
  })

  it("matches a shipper named only in the title", () => {
    const t = resolveAlertTarget(alert("nothing recognisable here", "Payment risk at Acme Foods"), data)
    expect(t).toMatchObject({ kind: "shipper", href: "/shippers/SHP-1" })
  })

  it("prefers affectedEntity over the title when both resolve", () => {
    const t = resolveAlertTarget(alert("Acme Foods", "Insurance lapse at Swift Haulers"), data)
    expect(t).toMatchObject({ kind: "shipper", href: "/shippers/SHP-1" })
  })
})

describe("resolveAlertTarget carrier/shipper scoring", () => {
  const tied = {
    carriers: [{ id: "CAR-9", company: "Northwind" }],
    shippers: [{ id: "SHP-9", company: "Northwind" }],
  }

  it("gives the tie to the carrier when both names score identically", () => {
    const t = resolveAlertTarget(alert("Northwind"), tied)
    expect(t).toMatchObject({ kind: "carrier", href: "/carriers/CAR-9" })
  })

  it("lets an explicit id beat a longer name match on the other side", () => {
    // Carrier "Swift" matches by name (score 5); shipper SHP-1 matches by id
    // (score 1000+5), so the id must win.
    const t = resolveAlertTarget(alert("SHP-1 is late paying, moved by Swift"), data)
    expect(t).toMatchObject({ kind: "shipper", href: "/shippers/SHP-1" })
  })
})

describe("alertKey collisions", () => {
  const key = (severity: string, title: string, affectedEntity: string | null, description: string) =>
    alertKey({ severity, title, affectedEntity, description })

  it("does not collide when LLM text contains a literal pipe", () => {
    const a = key("high", "A|B", "C", "")
    const b = key("high", "A", "B", "C|")
    expect(a).not.toBe(b)
  })

  it("still collapses genuinely identical alerts", () => {
    expect(key("high", "A|B", "C", "")).toBe(key("high", "A|B", "C", ""))
  })

  it("distinguishes alerts differing only in description", () => {
    expect(key("high", "Low margin", null, "LD-1")).not.toBe(key("high", "Low margin", null, "LD-2"))
  })
})
