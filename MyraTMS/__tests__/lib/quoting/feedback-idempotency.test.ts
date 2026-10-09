import { describe, it, expect, vi, beforeEach } from "vitest"

const query = vi.fn()
vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(async (_tid: unknown, fn: (c: { query: typeof query }) => unknown) => fn({ query })),
}))

import { processQuoteFeedback } from "@/lib/quoting/feedback"

/**
 * quote_corrections does `sample_size = sample_size + 1` with a re-weighted
 * correction_factor, so a second run for the same load permanently
 * double-counts it. The load detail page's manual status control offers the
 * Invoiced -> Delivered ops correction, which makes
 * Invoiced -> Delivered -> Invoiced -> Delivered one click each way, so the
 * exactly-once guard has to live here (the sentinel is on `quotes`; `loads`
 * has no actual_carrier_cost column).
 */
const QUOTE = {
  id: "Q1",
  carrier_cost_estimate: "1000",
  rate_source: "benchmark",
  origin_region: "MW",
  dest_region: "SE",
  equipment_type: "Van",
}

function mockQuote(extra: Record<string, unknown> = {}) {
  query.mockImplementation(async (sql: string) => {
    if (/^SELECT \* FROM quotes/.test(sql)) return { rows: [{ ...QUOTE, ...extra }] }
    return { rows: [] }
  })
}

const quoteSelects = () => query.mock.calls.filter(([sql]) => /^SELECT \* FROM quotes/.test(sql))
const quoteUpdates = () => query.mock.calls.filter(([sql]) => /^UPDATE quotes/.test(sql))
const correctionWrites = () => query.mock.calls.filter(([sql]) => /INSERT INTO quote_corrections/.test(sql))

describe("processQuoteFeedback idempotency", () => {
  beforeEach(() => {
    query.mockReset()
    // mockClear as well as spyOn: vi.spyOn on an already-spied method returns
    // the SAME spy, so call counts would accumulate across tests.
    vi.spyOn(console, "warn").mockImplementation(() => {}).mockClear()
    vi.spyOn(console, "error").mockImplementation(() => {}).mockClear()
  })

  // The sentinel read MUST take a row lock. withTenant() opens a real READ
  // COMMITTED transaction, and processQuoteFeedback is fired UNAWAITED from
  // app/api/loads/[id]/route.ts after the `loads` transaction has already
  // committed and released its FOR UPDATE on the load row -- so nothing else
  // serializes two concurrent runs. Without FOR UPDATE both read NULL and both
  // sample, permanently double-weighting the lane.
  it("takes a row lock on the sentinel read (FOR UPDATE), not a bare SELECT", async () => {
    mockQuote({ actual_carrier_cost: null })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(quoteSelects()).toHaveLength(1)
    expect(quoteSelects()[0][0]).toMatch(/FOR UPDATE\s*$/)
  })

  it("locks the quote BEFORE writing it or the lane correction", async () => {
    mockQuote({ actual_carrier_cost: null })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    const sqls = query.mock.calls.map(([sql]) => String(sql))
    const lockAt = sqls.findIndex((q) => /^SELECT \* FROM quotes/.test(q) && /FOR UPDATE/.test(q))
    const updateAt = sqls.findIndex((q) => /^UPDATE quotes/.test(q))
    const correctionAt = sqls.findIndex((q) => /INSERT INTO quote_corrections/.test(q))
    expect(lockAt).toBe(0)
    expect(lockAt).toBeLessThan(updateAt)
    expect(updateAt).toBeLessThan(correctionAt)
  })

  it("samples quote_corrections on the first run", async () => {
    mockQuote({ actual_carrier_cost: null })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(quoteUpdates()).toHaveLength(1)
    expect(correctionWrites()).toHaveLength(1)
    // correction_factor = actual / estimated
    expect(correctionWrites()[0][1]).toEqual(["benchmark", "MW", "SE", "Van", 0.9])
  })

  it("skips the quote_corrections sample on a re-delivery (actual_carrier_cost already set)", async () => {
    mockQuote({ actual_carrier_cost: "900" })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(correctionWrites()).toHaveLength(0)
    // The quote row itself is still refreshed -- that UPDATE is a plain SET.
    expect(quoteUpdates()).toHaveLength(1)
  })

  it("treats a zero recorded cost as already sampled, not as missing", async () => {
    mockQuote({ actual_carrier_cost: 0 })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(correctionWrites()).toHaveLength(0)
  })

  it("an Invoiced -> Delivered -> Invoiced -> Delivered round-trip counts the load once", async () => {
    // First delivery: nothing recorded yet.
    mockQuote({ actual_carrier_cost: null })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    // Second delivery after the ops correction: the first run set the sentinel.
    query.mockReset()
    mockQuote({ actual_carrier_cost: "900" })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(correctionWrites()).toHaveLength(0)
  })

  it("does nothing when the quote is gone", async () => {
    query.mockImplementation(async () => ({ rows: [] }))
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(quoteUpdates()).toHaveLength(0)
    expect(correctionWrites()).toHaveLength(0)
  })
})

describe("processQuoteFeedback re-delivery reporting", () => {
  beforeEach(() => {
    query.mockReset()
    // mockClear as well as spyOn: vi.spyOn on an already-spied method returns
    // the SAME spy, so call counts would accumulate across tests.
    vi.spyOn(console, "warn").mockImplementation(() => {}).mockClear()
    vi.spyOn(console, "error").mockImplementation(() => {}).mockClear()
  })

  // On a re-delivery the quote row is refreshed with the new cost, but
  // quote_corrections keeps the sample taken from the first, now-repudiated
  // cost and cannot be re-weighted. That divergence is louder than a plain
  // re-delivery with the identical cost.
  it("logs the repudiated cost at error level, with both numbers", async () => {
    mockQuote({ actual_carrier_cost: "900" })
    await processQuoteFeedback(42, "Q1", 1100, "LD-1")
    expect(correctionWrites()).toHaveLength(0)
    expect(console.error).toHaveBeenCalledTimes(1)
    const msg = String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
    expect(msg).toContain("Q1")
    expect(msg).toContain("LD-1")
    expect(msg).toContain("900")
    expect(msg).toContain("1100")
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("stays a warning when the re-delivered cost is unchanged (nothing repudiated)", async () => {
    mockQuote({ actual_carrier_cost: "900" })
    await processQuoteFeedback(42, "Q1", 900, "LD-1")
    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
