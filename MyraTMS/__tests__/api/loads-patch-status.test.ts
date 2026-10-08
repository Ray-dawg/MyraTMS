import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const query = vi.fn()
vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(async (_tid: unknown, fn: (c: { query: typeof query }) => unknown) => fn({ query })),
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(() => ({ id: "u1", role: "admin" })),
  requireTenantContext: vi.fn(() => ({ tenantId: 42, role: "admin", userId: "u1", isSuperAdmin: false })),
}))
vi.mock("@/lib/workflow-engine", () => ({ executeWorkflows: vi.fn(async () => undefined) }))
vi.mock("@/lib/quoting/feedback", () => ({ processQuoteFeedback: vi.fn(async () => undefined) }))

import { PATCH } from "@/app/api/loads/[id]/route"
import { executeWorkflows } from "@/lib/workflow-engine"
import { processQuoteFeedback } from "@/lib/quoting/feedback"
import { getCurrentUser } from "@/lib/auth"

function asRole(role: string) {
  vi.mocked(getCurrentUser).mockReturnValue({ id: "u1", role } as unknown as ReturnType<typeof getCurrentUser>)
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/loads/LD-1", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "LD-1" }) },
  )
}

function mockCurrent(status: string, after: Record<string, unknown> = {}) {
  query.mockImplementation(async (sql: string) => {
    if (/SELECT shipper_id, carrier_id, status/.test(sql)) {
      return { rows: [{ shipper_id: "S1", carrier_id: "C1", status }] }
    }
    if (/^UPDATE loads/.test(sql)) return { rows: [] }
    return { rows: [{ id: "LD-1", status, ...after }] }
  })
}

const updateCalls = () => query.mock.calls.filter(([sql]) => /^UPDATE loads/.test(sql))

describe("PATCH /api/loads/[id] status transitions", () => {
  beforeEach(() => {
    query.mockReset()
    asRole("admin")
    vi.mocked(executeWorkflows).mockClear()
    vi.mocked(processQuoteFeedback).mockClear()
  })

  it("rejects an illegal transition with 409 and runs no UPDATE", async () => {
    mockCurrent("Booked")
    const res = await patch({ status: "Closed", revenue: 100 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: expect.any(String),
      from: "Booked",
      to: "Closed",
      allowed: ["Awaiting Signature", "Dispatched"],
    })
    expect(updateCalls()).toHaveLength(0)
    expect(executeWorkflows).not.toHaveBeenCalled()
  })

  it("rejects an unknown status with 400 and runs no UPDATE", async () => {
    mockCurrent("Booked")
    const res = await patch({ status: "Lost" })
    expect(res.status).toBe(400)
    expect(updateCalls()).toHaveLength(0)
  })

  it("applies a valid DApp transition and fires the workflow engine", async () => {
    mockCurrent("Dispatched", { status: "In Transit" })
    const res = await patch({ status: "In Transit" })
    expect(res.status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
    expect(executeWorkflows).toHaveBeenCalledWith(42, "status_change", {
      loadId: "LD-1",
      oldStatus: "Dispatched",
      newStatus: "In Transit",
    })
  })

  it("fires quote feedback on In Transit->Delivered but not on a same-status re-send", async () => {
    mockCurrent("In Transit", { quote_id: "Q1", carrier_cost: "900" })
    await patch({ status: "Delivered" })
    expect(processQuoteFeedback).toHaveBeenCalledWith(42, "Q1", 900, "LD-1")

    vi.mocked(processQuoteFeedback).mockClear()
    vi.mocked(executeWorkflows).mockClear()
    mockCurrent("Delivered", { quote_id: "Q1", carrier_cost: "900" })
    const res = await patch({ status: "Delivered" })
    expect(res.status).toBe(200)
    expect(processQuoteFeedback).not.toHaveBeenCalled()
    expect(executeWorkflows).not.toHaveBeenCalled()
  })

  it("does not validate status when status is absent from the body", async () => {
    mockCurrent("Closed")
    const res = await patch({ revenue: 100 })
    expect(res.status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
  })

  it("rejects a driver PATCHing Delivered on an Invoiced load (POD-flow regression) with 409", async () => {
    asRole("driver")
    mockCurrent("Invoiced", { quote_id: "Q1", carrier_cost: "900" })
    const res = await patch({ status: "Delivered" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: expect.any(String),
      from: "Invoiced",
      to: "Delivered",
      allowed: ["Closed"],
    })
    expect(updateCalls()).toHaveLength(0)
    expect(executeWorkflows).not.toHaveBeenCalled()
    expect(processQuoteFeedback).not.toHaveBeenCalled()
  })

  it("lets an admin apply the Invoiced -> Delivered correction", async () => {
    asRole("admin")
    mockCurrent("Invoiced", { status: "Delivered" })
    const res = await patch({ status: "Delivered" })
    expect(res.status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
  })

  it("lets a dispatcher apply the Dispatched -> Booked correction", async () => {
    asRole("dispatcher")
    mockCurrent("Dispatched", { status: "Booked" })
    expect((await patch({ status: "Booked" })).status).toBe(200)
  })

  it("rejects Awaiting Signature -> Dispatched for any role with the confirm-carrier-signature hint", async () => {
    for (const role of ["admin", "dispatcher", "driver"]) {
      query.mockReset()
      asRole(role)
      mockCurrent("Awaiting Signature")
      const res = await patch({ status: "Dispatched" })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body).toEqual({
        error: expect.any(String),
        from: "Awaiting Signature",
        to: "Dispatched",
        allowed: role === "driver" ? [] : ["Booked"],
      })
      expect(body.error).toContain("POST /api/loads/[id]/confirm-carrier-signature")
      expect(updateCalls()).toHaveLength(0)
    }
  })

  it("still lets a driver move Booked -> Dispatched (DApp en_route_pickup / accept)", async () => {
    asRole("driver")
    mockCurrent("Booked", { status: "Dispatched" })
    expect((await patch({ status: "Dispatched" })).status).toBe(200)
  })
})
