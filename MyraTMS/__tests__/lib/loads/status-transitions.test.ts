import { describe, it, expect } from "vitest"
import {
  AWAITING_SIGNATURE_ENTRY_HINT,
  LOAD_STATUSES,
  VALID_LOAD_TRANSITIONS,
  FORWARD_LOAD_TRANSITIONS,
  OPERATOR_FORWARD_LOAD_TRANSITIONS,
  CORRECTION_LOAD_TRANSITIONS,
  GATE_OWNED_STATUSES,
  RATE_CON_DISPATCH_GATE_HINT,
  isValidLoadTransition,
  nextLoadStatuses,
  checkLoadTransition,
  violatesRateConDispatchGate,
  CORRECTION_ROLES,
  OPERATOR_ROLES,
  allowsCorrections,
  canChangeStatus,
} from "@/lib/loads/status-transitions"

/**
 * The three caller classes the route now distinguishes. `ops` keeps its name
 * (it is used throughout this file) and means "the most privileged caller":
 * corrections + the finance-side forward edges, i.e. an admin/dispatcher.
 */
const ops = { allowCorrections: true, allowOperatorForward: true }
/** An OPERATOR_ROLE without corrections -- users.role 'ops', or 'operator'. */
const operator = { allowOperatorForward: true }
/** Any other authenticated caller: a DApp driver token, or users.role 'sales'. */
const plain = {}

describe("load status transitions", () => {
  it("has an entry for every status and only references known statuses", () => {
    expect([...LOAD_STATUSES]).toEqual([
      "Booked",
      "Awaiting Signature",
      "Dispatched",
      "In Transit",
      "Delivered",
      "Invoiced",
      "Closed",
    ])
    for (const table of [
      FORWARD_LOAD_TRANSITIONS,
      OPERATOR_FORWARD_LOAD_TRANSITIONS,
      CORRECTION_LOAD_TRANSITIONS,
      VALID_LOAD_TRANSITIONS,
    ]) {
      expect(Object.keys(table).sort()).toEqual([...LOAD_STATUSES].sort())
      for (const targets of Object.values(table)) {
        for (const t of targets) expect(LOAD_STATUSES).toContain(t)
      }
    }
  })

  it("treats Closed as terminal, even with corrections", () => {
    expect(nextLoadStatuses("Closed")).toEqual([])
    expect(nextLoadStatuses("Closed", ops)).toEqual([])
    for (const s of LOAD_STATUSES) {
      if (s !== "Closed") expect(isValidLoadTransition("Closed", s, ops)).toBe(false)
    }
  })

  it("same-status is a no-op", () => {
    for (const s of LOAD_STATUSES) expect(isValidLoadTransition(s, s)).toBe(true)
  })

  it("allows the DApp driver sequence Booked->Dispatched->In Transit->Delivered", () => {
    expect(isValidLoadTransition("Booked", "Dispatched")).toBe(true) // request-load accept / en_route_pickup
    expect(isValidLoadTransition("Dispatched", "In Transit")).toBe(true)
    expect(isValidLoadTransition("In Transit", "Delivered")).toBe(true)
  })

  // Round-6 finding 4: the finance-side forward edges are no longer open to
  // every authenticated caller. A DApp driver token / users.role 'sales' gets
  // Dispatched / In Transit / Delivered and nothing past it.
  it("keeps the finance-side forward edges out of reach of a non-operator", () => {
    expect(isValidLoadTransition("Delivered", "Invoiced", plain)).toBe(false)
    expect(isValidLoadTransition("Invoiced", "Closed", plain)).toBe(false)
    expect(nextLoadStatuses("Delivered", plain)).toEqual([])
    expect(nextLoadStatuses("Invoiced", plain)).toEqual([])
    // ...while every driver-reachable forward edge stays open.
    expect(nextLoadStatuses("Booked", plain)).toEqual(["Dispatched"])
    expect(nextLoadStatuses("Dispatched", plain)).toEqual(["In Transit"])
    expect(nextLoadStatuses("In Transit", plain)).toEqual(["Delivered"])
  })

  it("grants the finance-side forward edges to an operator", () => {
    expect(isValidLoadTransition("Delivered", "Invoiced", operator)).toBe(true)
    expect(isValidLoadTransition("Invoiced", "Closed", operator)).toBe(true)
    expect(nextLoadStatuses("Delivered", operator)).toEqual(["Invoiced"])
  })

  // Round-6 finding 5: entry into Awaiting Signature is owned by
  // lib/dispatch-gate.ts (direct SQL) and is refused to every PATCH caller.
  it("never allows any caller INTO Awaiting Signature", () => {
    expect([...GATE_OWNED_STATUSES]).toEqual(["Awaiting Signature"])
    for (const from of LOAD_STATUSES) {
      if (from === "Awaiting Signature") continue
      for (const opts of [plain, operator, ops]) {
        expect(isValidLoadTransition(from, "Awaiting Signature", opts)).toBe(false)
        expect(nextLoadStatuses(from, opts)).not.toContain("Awaiting Signature")
      }
    }
  })

  it("never allows Awaiting Signature -> Dispatched (rate-con gate owns it)", () => {
    expect(isValidLoadTransition("Awaiting Signature", "Dispatched")).toBe(false)
    expect(isValidLoadTransition("Awaiting Signature", "Dispatched", ops)).toBe(false)
    expect(nextLoadStatuses("Awaiting Signature")).toEqual([])
    // Round-6 finding 2: the "carrier withdrew" correction back to Booked is
    // gone -- it silently turned a later genuine signature into a no-op.
    expect(nextLoadStatuses("Awaiting Signature", ops)).toEqual([])
  })

  it("rejects backward correction edges by default", () => {
    expect(isValidLoadTransition("Dispatched", "Booked")).toBe(false)
    expect(isValidLoadTransition("In Transit", "Dispatched")).toBe(false)
    expect(isValidLoadTransition("Invoiced", "Delivered")).toBe(false)
    expect(isValidLoadTransition("Invoiced", "Delivered", { allowCorrections: false })).toBe(false)
  })

  it("allows only the documented correction edges with allowCorrections", () => {
    expect(isValidLoadTransition("Awaiting Signature", "Booked", ops)).toBe(false)
    expect(isValidLoadTransition("Dispatched", "Booked", ops)).toBe(true)
    expect(isValidLoadTransition("In Transit", "Dispatched", ops)).toBe(true)
    expect(isValidLoadTransition("Invoiced", "Delivered", ops)).toBe(true)
    expect(isValidLoadTransition("Delivered", "In Transit", ops)).toBe(false)
    expect(isValidLoadTransition("In Transit", "Booked", ops)).toBe(false)
    expect(nextLoadStatuses("Invoiced", operator)).toEqual(["Closed"])
    expect(nextLoadStatuses("Invoiced", ops)).toEqual(["Closed", "Delivered"])
  })

  it("rejects skips such as Booked->Closed and Dispatched->Delivered", () => {
    expect(isValidLoadTransition("Booked", "Closed", ops)).toBe(false)
    expect(isValidLoadTransition("Booked", "Delivered", ops)).toBe(false)
    expect(isValidLoadTransition("Dispatched", "Delivered", ops)).toBe(false)
  })

  it("checkLoadTransition returns a 409 body with error/from/to/allowed", () => {
    const r = checkLoadTransition("Booked", "Closed")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.httpStatus).toBe(409)
    expect(r.body).toEqual({
      error: expect.any(String),
      from: "Booked",
      to: "Closed",
      allowed: ["Dispatched"],
    })
    expect(r.body.error).toMatch(/Booked -> Closed/)
  })

  it("checkLoadTransition: allowed list reflects the caller's grants", () => {
    const driver = checkLoadTransition("Invoiced", "Delivered")
    expect(driver.ok).toBe(false)
    // A plain caller has NO edge out of Invoiced now -- Closed is operator-only.
    if (!driver.ok) expect(driver.body.allowed).toEqual([])
    const nonCorrectingOperator = checkLoadTransition("Invoiced", "Delivered", operator)
    expect(nonCorrectingOperator.ok).toBe(false)
    if (!nonCorrectingOperator.ok) expect(nonCorrectingOperator.body.allowed).toEqual(["Closed"])
    expect(checkLoadTransition("Invoiced", "Delivered", ops)).toEqual({ ok: true })
    const opsBad = checkLoadTransition("Invoiced", "Booked", ops)
    expect(opsBad.ok).toBe(false)
    if (!opsBad.ok) expect(opsBad.body.allowed).toEqual(["Closed", "Delivered"])
  })

  it("checkLoadTransition: Awaiting Signature -> Dispatched names confirm-carrier-signature", () => {
    for (const opts of [{}, ops]) {
      const r = checkLoadTransition("Awaiting Signature", "Dispatched", opts)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.httpStatus).toBe(409)
      expect(r.body.error).toContain("POST /api/loads/[id]/confirm-carrier-signature")
    }
  })

  it("checkLoadTransition returns 400 for an unknown status", () => {
    const r = checkLoadTransition("Booked", "Teleported")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.httpStatus).toBe(400)
  })
})

// Round-6 finding 5. The route used to accept Booked -> Awaiting Signature
// from any caller. That stranded manually-assigned loads: their only forward
// edge is the rate-con gate, which never fires for a load with no
// pipeline_load_id, so the DApp driver's PATCHes all 409 afterwards.
describe("checkLoadTransition: entry into Awaiting Signature is refused", () => {
  it("409s for every caller class, from every status", () => {
    for (const from of LOAD_STATUSES) {
      if (from === "Awaiting Signature") continue
      for (const opts of [plain, operator, ops]) {
        const r = checkLoadTransition(from, "Awaiting Signature", opts)
        expect(r.ok).toBe(false)
        if (r.ok) continue
        expect(r.httpStatus).toBe(409)
        expect(r.body.error).toContain(AWAITING_SIGNATURE_ENTRY_HINT)
        expect(r.body.allowed).not.toContain("Awaiting Signature")
      }
    }
  })

  it("409s even from an unknown / legacy stored status", () => {
    // The !isLoadStatus(from) escape hatch returns { ok: true } for anything
    // else; a gate-owned target must not slip through it.
    for (const from of ["Pending", null, undefined]) {
      const r = checkLoadTransition(from, "Awaiting Signature", ops)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.httpStatus).toBe(409)
    }
  })

  it("still treats a same-status re-send as a no-op", () => {
    expect(checkLoadTransition("Awaiting Signature", "Awaiting Signature", ops)).toEqual({ ok: true })
  })
})

// Round-6 finding 1. Blocking the Awaiting Signature -> Dispatched EDGE was
// not enough: Awaiting Signature -> Booked -> Dispatched rebuilt it in two
// moves. The gate therefore keys on the ROW.
describe("violatesRateConDispatchGate", () => {
  const cascadeUnsigned = { pipelineLoadId: "9001", carrierSignatureReceivedAt: null }

  it("is true only for Dispatched on an unsigned cascade load", () => {
    expect(violatesRateConDispatchGate("Dispatched", cascadeUnsigned)).toBe(true)
    // signed -> the gate already ran
    expect(
      violatesRateConDispatchGate("Dispatched", { pipelineLoadId: "9001", carrierSignatureReceivedAt: "2026-10-08T00:00:00Z" }),
    ).toBe(false)
    // not on the cascade path -> migration 049: manual assignment never
    // reaches the gate, and flips straight to Dispatched.
    expect(violatesRateConDispatchGate("Dispatched", { pipelineLoadId: null, carrierSignatureReceivedAt: null })).toBe(false)
    expect(violatesRateConDispatchGate("Dispatched", { pipelineLoadId: "", carrierSignatureReceivedAt: null })).toBe(false)
    // any other target is none of the gate's business
    for (const to of LOAD_STATUSES.filter((s) => s !== "Dispatched")) {
      expect(violatesRateConDispatchGate(to, cascadeUnsigned)).toBe(false)
    }
  })

  it("accepts a numeric pipeline_load_id as well as the Neon BIGINT string", () => {
    expect(violatesRateConDispatchGate("Dispatched", { pipelineLoadId: 9001, carrierSignatureReceivedAt: null })).toBe(true)
  })

  it("is false with no row facts -- a caller with no row cannot evaluate it", () => {
    expect(violatesRateConDispatchGate("Dispatched", undefined)).toBe(false)
  })
})

describe("checkLoadTransition: rate-con dispatch gate", () => {
  const unsigned = { pipelineLoadId: "9001", carrierSignatureReceivedAt: null }

  it("409s on Booked -> Dispatched for an unsigned cascade load, for every caller class", () => {
    for (const opts of [plain, operator, ops]) {
      const r = checkLoadTransition("Booked", "Dispatched", { ...opts, load: unsigned })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.httpStatus).toBe(409)
      expect(r.body.error).toContain(RATE_CON_DISPATCH_GATE_HINT)
      expect(r.body.error).toContain("POST /api/loads/[id]/confirm-carrier-signature")
      // The refused target must not be advertised back as allowed.
      expect(r.body.allowed).not.toContain("Dispatched")
    }
  })

  it("409s on In Transit -> Dispatched (the correction edge) for an unsigned cascade load", () => {
    const r = checkLoadTransition("In Transit", "Dispatched", { ...ops, load: unsigned })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.body.error).toContain(RATE_CON_DISPATCH_GATE_HINT)
  })

  it("allows Booked -> Dispatched once a signature is on record", () => {
    expect(
      checkLoadTransition("Booked", "Dispatched", {
        ...ops,
        load: { pipelineLoadId: "9001", carrierSignatureReceivedAt: "2026-10-08T00:00:00Z" },
      }),
    ).toEqual({ ok: true })
  })

  it("allows Booked -> Dispatched for a manually-assigned (non-cascade) load", () => {
    expect(
      checkLoadTransition("Booked", "Dispatched", { load: { pipelineLoadId: null, carrierSignatureReceivedAt: null } }),
    ).toEqual({ ok: true })
  })

  it("closes the two-click Awaiting Signature -> Booked -> Dispatched path end to end", () => {
    // Step 1 is now refused outright (finding 2) ...
    expect(checkLoadTransition("Awaiting Signature", "Booked", { ...ops, load: unsigned }).ok).toBe(false)
    // ... and even if a row reached Booked some other way, step 2 is refused.
    expect(checkLoadTransition("Booked", "Dispatched", { ...ops, load: unsigned }).ok).toBe(false)
  })
})

describe("canChangeStatus / OPERATOR_ROLES", () => {
  // Role vocabularies in this codebase (verified 2026-10-08):
  //   users.role CHECK (001-create-tables.sql:12) -> admin | ops | sales.
  //     app/api/auth/login/route.ts:66 puts exactly this in the JWT.
  //   tenant_users.role CHECK (027_multi_tenant_foundation.sql:89) ->
  //     owner | admin | operator | driver | viewer | service_admin.
  //   "dispatcher" / "shipper" / "carrier" appear in NO vocabulary, so a TMS
  //     JWT cannot carry them today; "driver" comes only from the DApp
  //     driver-login token (app/api/auth/driver-login/route.ts:60).
  const allowed = ["admin", "ops", "dispatcher", "operator"]
  const denied = [
    "sales",      // a real users.role, deliberately NOT an operator
    "driver",     // DApp token; middleware already keeps it off /loads/[id]
    "viewer",     // 027 read-only role
    "owner",      // 027 role, not admitted until the JWT actually carries it
    "service_admin",
    "shipper",
    "carrier",
    "Admin",      // case-sensitive on purpose: JWT claims are not normalised
    "",
    "totally-made-up-role",
  ]

  it("admits exactly OPERATOR_ROLES", () => {
    expect([...OPERATOR_ROLES]).toEqual(allowed)
    for (const role of allowed) expect(canChangeStatus(role)).toBe(true)
  })

  it("default-denies every other role, including unknown strings and nullish", () => {
    for (const role of denied) {
      expect(OPERATOR_ROLES as readonly string[]).not.toContain(role)
      expect(canChangeStatus(role)).toBe(false)
    }
    expect(canChangeStatus(null)).toBe(false)
    expect(canChangeStatus(undefined)).toBe(false)
  })

  it("every CORRECTION_ROLE can also change status (corrections are a subset)", () => {
    for (const role of CORRECTION_ROLES) expect(canChangeStatus(role)).toBe(true)
  })

  it("is a strictly wider gate than allowsCorrections", () => {
    // ops/operator get the control but only forward edges.
    expect(canChangeStatus("ops")).toBe(true)
    expect(allowsCorrections("ops")).toBe(false)
    expect(canChangeStatus("operator")).toBe(true)
    expect(allowsCorrections("operator")).toBe(false)
  })
})
