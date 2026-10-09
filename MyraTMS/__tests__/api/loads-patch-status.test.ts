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
import {
  AWAITING_SIGNATURE_ENTRY_HINT,
  CORRECTION_ROLES,
  OPERATOR_ROLES,
  RATE_CON_DISPATCH_GATE_HINT,
} from "@/lib/loads/status-transitions"

function asRole(role: string) {
  vi.mocked(getCurrentUser).mockReturnValue({ id: "u1", role } as unknown as ReturnType<typeof getCurrentUser>)
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/loads/LD-1", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "LD-1" }) },
  )
}

/**
 * `row` merges extra columns into the locked SELECT ... FOR UPDATE row -- that
 * is where the route reads pipeline_load_id / carrier_signature_received_at
 * for the E2-04 rate-con dispatch gate. `after` merges into the re-SELECTed
 * row returned to the client.
 */
function mockCurrent(
  status: string,
  after: Record<string, unknown> = {},
  row: Record<string, unknown> = {},
) {
  query.mockImplementation(async (sql: string) => {
    if (/SELECT shipper_id, carrier_id, status/.test(sql)) {
      return {
        rows: [
          {
            shipper_id: "S1",
            carrier_id: "C1",
            status,
            pipeline_load_id: null,
            carrier_signature_received_at: null,
            ...row,
          },
        ],
      }
    }
    if (/^UPDATE loads/.test(sql)) return { rows: [] }
    return { rows: [{ id: "LD-1", status, ...after }] }
  })
}

const lockSelect = () =>
  query.mock.calls.map(([sql]) => sql as string).find((sql) => /SELECT shipper_id, carrier_id, status/.test(sql))

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
      allowed: ["Dispatched"],
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
      // Invoiced -> Closed is operator-only now (finding 4), so a driver has
      // no legal edge at all out of Invoiced.
      allowed: [],
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
        // The "carrier withdrew" correction back to Booked is gone (finding 2),
        // so Awaiting Signature is a dead end for every PATCH caller.
        allowed: [],
      })
      expect(body.error).toContain("POST /api/loads/[id]/confirm-carrier-signature")
      expect(updateCalls()).toHaveLength(0)
    }
  })

  // Drift guard: the route no longer restates ["admin","dispatcher"] -- it
  // calls allowsCorrections(). These two tests are driven by CORRECTION_ROLES
  // itself, so adding or removing a role there without the route honouring it
  // (or the route diverging from the UI's option list, which imports the same
  // predicate) fails here.
  it.each(CORRECTION_ROLES)("grants the Invoiced -> Delivered correction to the %s role", async (role) => {
    asRole(role)
    mockCurrent("Invoiced", { status: "Delivered" })
    expect((await patch({ status: "Delivered" })).status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
  })

  // "shipper"/"carrier" are excluded only because the route's IDOR check
  // rejects them earlier (403) for a load they don't own -- not because they
  // would get the correction edge.
  it.each(["driver", "ops", "sales"])(
    "refuses the Invoiced -> Delivered correction for the non-correction role %s",
    async (role) => {
      expect(CORRECTION_ROLES as readonly string[]).not.toContain(role)
      asRole(role)
      mockCurrent("Invoiced", { status: "Delivered" })
      const res = await patch({ status: "Delivered" })
      expect(res.status).toBe(409)
      // `allowed` is what THIS caller may do: Invoiced -> Closed is an
      // operator-only forward edge now, so only `ops` is offered it.
      expect((await res.json()).allowed).toEqual(role === "ops" ? ["Closed"] : [])
      expect(updateCalls()).toHaveLength(0)
    },
  )

  it("still lets a driver move Booked -> Dispatched (DApp en_route_pickup / accept)", async () => {
    asRole("driver")
    mockCurrent("Booked", { status: "Dispatched" })
    expect((await patch({ status: "Dispatched" })).status).toBe(200)
  })

  // ---------------------------------------------------------------------
  // Round-6 finding 4: OPERATOR_ROLES on the finance-side forward edges.
  // Before this, every forward edge was open to any authenticated principal,
  // so a `sales` user or a DApp driver bearer token could PATCH
  // Delivered -> Invoiced -> Closed and get two 200s.
  // ---------------------------------------------------------------------
  // "shipper"/"carrier" are omitted: the route's IDOR branch 403s them first
  // for a load they don't own -- not because they'd get the edge.
  it.each(["driver", "sales", "viewer", "ops-typo"])(
    "refuses Delivered -> Invoiced for the non-operator role %s",
    async (role) => {
      expect(OPERATOR_ROLES as readonly string[]).not.toContain(role)
      asRole(role)
      mockCurrent("Delivered", { status: "Invoiced" })
      const res = await patch({ status: "Invoiced" })
      expect(res.status).toBe(409)
      expect((await res.json()).allowed).toEqual([])
      expect(updateCalls()).toHaveLength(0)
      expect(executeWorkflows).not.toHaveBeenCalled()
    },
  )

  it.each(["driver", "sales"])("refuses Invoiced -> Closed for the non-operator role %s", async (role) => {
    asRole(role)
    mockCurrent("Invoiced", { status: "Closed" })
    const res = await patch({ status: "Closed" })
    expect(res.status).toBe(409)
    expect(updateCalls()).toHaveLength(0)
  })

  // Drift guard: driven by OPERATOR_ROLES itself, so the route and the UI's
  // option list (which imports canChangeStatus from the same module) cannot
  // disagree about who gets the finance edges.
  it.each(OPERATOR_ROLES)("grants Delivered -> Invoiced -> Closed to the operator role %s", async (role) => {
    asRole(role)
    mockCurrent("Delivered", { status: "Invoiced" })
    expect((await patch({ status: "Invoiced" })).status).toBe(200)
    query.mockReset()
    mockCurrent("Invoiced", { status: "Closed" })
    expect((await patch({ status: "Closed" })).status).toBe(200)
  })

  it("still lets a driver reach Delivered (the last driver-reachable edge)", async () => {
    asRole("driver")
    mockCurrent("In Transit", { status: "Delivered" })
    expect((await patch({ status: "Delivered" })).status).toBe(200)
  })

  // ---------------------------------------------------------------------
  // Round-6 finding 5: entry into Awaiting Signature is owned by
  // lib/dispatch-gate.ts. Accepting it here stranded manually-assigned loads:
  // the only forward edge out is the rate-con gate, which never fires without
  // a pipeline_load_id, so every later driver PATCH 409s.
  // ---------------------------------------------------------------------
  it.each(["admin", "dispatcher", "ops", "sales", "driver"])(
    "refuses Booked -> Awaiting Signature for the %s role",
    async (role) => {
      asRole(role)
      mockCurrent("Booked", { status: "Awaiting Signature" })
      const res = await patch({ status: "Awaiting Signature" })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.from).toBe("Booked")
      expect(body.to).toBe("Awaiting Signature")
      expect(body.error).toContain(AWAITING_SIGNATURE_ENTRY_HINT)
      expect(body.allowed).not.toContain("Awaiting Signature")
      expect(updateCalls()).toHaveLength(0)
      expect(executeWorkflows).not.toHaveBeenCalled()
    },
  )

  // ---------------------------------------------------------------------
  // Round-6 finding 1 (the important one): the rate-con dispatch gate is
  // enforced HERE, on the server, not by hiding dropdown options. Scenario it
  // closes: a cascade load at Awaiting Signature with no signature, corrected
  // back to Booked and then pushed to Dispatched -- two ordinary clicks
  // reconstructing the one edge lib/dispatch-gate.ts exists to own, landing a
  // Dispatched load with carrier_signature_received_at NULL, no signed
  // rate-con document, no tracking_tokens row and no carrier_acceptance_state
  // / events row.
  // ---------------------------------------------------------------------
  it("reads pipeline_load_id and carrier_signature_received_at under the row lock", async () => {
    mockCurrent("Booked")
    await patch({ revenue: 1 })
    const sql = lockSelect()
    expect(sql).toBeDefined()
    expect(sql).toMatch(/pipeline_load_id/)
    expect(sql).toMatch(/carrier_signature_received_at/)
    expect(sql).toMatch(/FOR UPDATE/)
  })

  it.each(["admin", "dispatcher", "ops", "driver"])(
    "refuses Booked -> Dispatched on an unsigned cascade load for the %s role",
    async (role) => {
      asRole(role)
      mockCurrent("Booked", { status: "Dispatched" }, { pipeline_load_id: "9001", carrier_signature_received_at: null })
      const res = await patch({ status: "Dispatched" })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain(RATE_CON_DISPATCH_GATE_HINT)
      expect(body.error).toContain("POST /api/loads/[id]/confirm-carrier-signature")
      expect(body.allowed).not.toContain("Dispatched")
      expect(updateCalls()).toHaveLength(0)
      expect(executeWorkflows).not.toHaveBeenCalled()
    },
  )

  it("refuses the Awaiting Signature -> Booked -> Dispatched two-step at BOTH steps", async () => {
    asRole("admin")
    const cascade = { pipeline_load_id: "9001", carrier_signature_received_at: null }
    // Step 1: the ops-correction edge is gone (finding 2).
    mockCurrent("Awaiting Signature", { status: "Booked" }, cascade)
    expect((await patch({ status: "Booked" })).status).toBe(409)
    expect(updateCalls()).toHaveLength(0)
    // Step 2: even reaching Booked some other way, the gate refuses on the
    // row's own facts rather than on the previous status.
    query.mockReset()
    mockCurrent("Booked", { status: "Dispatched" }, cascade)
    expect((await patch({ status: "Dispatched" })).status).toBe(409)
    expect(updateCalls()).toHaveLength(0)
  })

  it("allows Booked -> Dispatched once the signature is on record", async () => {
    asRole("admin")
    mockCurrent(
      "Booked",
      { status: "Dispatched" },
      { pipeline_load_id: "9001", carrier_signature_received_at: "2026-10-08T00:00:00.000Z" },
    )
    expect((await patch({ status: "Dispatched" })).status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
  })

  it("allows Booked -> Dispatched for a manually-assigned (non-cascade) load", async () => {
    // Migration 049: only the AI-cascade path produces Awaiting Signature;
    // manual assignments flip straight to Dispatched, so the gate must not
    // break the DApp accept flow.
    asRole("driver")
    mockCurrent("Booked", { status: "Dispatched" }, { pipeline_load_id: null })
    expect((await patch({ status: "Dispatched" })).status).toBe(200)
    expect(updateCalls()).toHaveLength(1)
  })

  it("refuses the In Transit -> Dispatched correction on an unsigned cascade load", async () => {
    asRole("admin")
    mockCurrent("In Transit", { status: "Dispatched" }, { pipeline_load_id: "9001" })
    expect((await patch({ status: "Dispatched" })).status).toBe(409)
    expect(updateCalls()).toHaveLength(0)
  })
})
