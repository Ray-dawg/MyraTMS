import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("swr", () => ({ default: vi.fn(), mutate: vi.fn() }))

import { mutate } from "swr"
import { updateLoad, ApiError } from "@/lib/api"

function mockFetch(status: number, body: unknown, jsonThrows = false) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: jsonThrows ? vi.fn().mockRejectedValue(new SyntaxError("bad json")) : vi.fn().mockResolvedValue(body),
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res))
}

describe("updateLoad error surfacing", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it("returns the parsed row on success", async () => {
    mockFetch(200, { id: "LD-1", status: "Dispatched" })
    await expect(updateLoad("LD-1", { status: "Dispatched" })).resolves.toEqual({ id: "LD-1", status: "Dispatched" })
  })

  it("throws ApiError carrying the server message, status and body on a 409", async () => {
    const body = {
      // Mirrors the real 409 body from checkLoadTransition() for this edge.
      error: "Invalid load status transition: Booked -> Closed. Allowed from Booked: Dispatched",
      from: "Booked",
      to: "Closed",
      allowed: ["Dispatched"],
    }
    mockFetch(409, body)
    const err = await updateLoad("LD-1", { status: "Closed" }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.message).toBe(body.error)
    expect(err.body).toEqual(body)
    // The SWR cache must NOT be revalidated on a rejected write: nothing
    // changed server-side, and moving the mutate() above the !res.ok check
    // would otherwise still satisfy every other assertion here.
    expect(mutate).not.toHaveBeenCalled()
  })

  it("revalidates the /api/loads cache only on success", async () => {
    mockFetch(200, { id: "LD-1", status: "Dispatched" })
    await updateLoad("LD-1", { status: "Dispatched" })
    expect(mutate).toHaveBeenCalledTimes(1)
    const [keyPredicate, data, opts] = vi.mocked(mutate).mock.calls[0] as unknown as [
      (k: string) => boolean,
      undefined,
      { revalidate: boolean },
    ]
    expect(data).toBeUndefined()
    expect(opts).toEqual({ revalidate: true })
    // Prefix match covers useLoad's own key, so the detail page refreshes too.
    expect(keyPredicate("/api/loads")).toBe(true)
    expect(keyPredicate("/api/loads/LD-1")).toBe(true)
    expect(keyPredicate("/api/carriers")).toBe(false)
  })

  it("falls back to the generic message when the error body is not JSON", async () => {
    mockFetch(500, null, true)
    const err = await updateLoad("LD-1", { status: "Closed" }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(err.message).toBe("Failed to update load")
    expect(err.body).toBeNull()
  })

  it("falls back to the generic message when the body has no error string", async () => {
    mockFetch(400, { detail: "x" })
    const err = await updateLoad("LD-1", {}).catch((e) => e)
    expect(err.message).toBe("Failed to update load")
    expect(err.body).toEqual({ detail: "x" })
  })
})
