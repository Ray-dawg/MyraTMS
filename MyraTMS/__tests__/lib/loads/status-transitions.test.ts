import { describe, it, expect } from "vitest"
import {
  LOAD_STATUSES,
  VALID_LOAD_TRANSITIONS,
  FORWARD_LOAD_TRANSITIONS,
  CORRECTION_LOAD_TRANSITIONS,
  isValidLoadTransition,
  nextLoadStatuses,
  checkLoadTransition,
} from "@/lib/loads/status-transitions"

const ops = { allowCorrections: true }

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
    for (const table of [FORWARD_LOAD_TRANSITIONS, CORRECTION_LOAD_TRANSITIONS, VALID_LOAD_TRANSITIONS]) {
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

  it("allows the full forward lifecycle without corrections", () => {
    expect(isValidLoadTransition("Booked", "Awaiting Signature")).toBe(true)
    expect(isValidLoadTransition("Delivered", "Invoiced")).toBe(true)
    expect(isValidLoadTransition("Invoiced", "Closed")).toBe(true)
  })

  it("never allows Awaiting Signature -> Dispatched (rate-con gate owns it)", () => {
    expect(isValidLoadTransition("Awaiting Signature", "Dispatched")).toBe(false)
    expect(isValidLoadTransition("Awaiting Signature", "Dispatched", ops)).toBe(false)
    expect(nextLoadStatuses("Awaiting Signature")).toEqual([])
    expect(nextLoadStatuses("Awaiting Signature", ops)).toEqual(["Booked"])
  })

  it("rejects backward correction edges by default", () => {
    expect(isValidLoadTransition("Awaiting Signature", "Booked")).toBe(false)
    expect(isValidLoadTransition("Dispatched", "Booked")).toBe(false)
    expect(isValidLoadTransition("In Transit", "Dispatched")).toBe(false)
    expect(isValidLoadTransition("Invoiced", "Delivered")).toBe(false)
    expect(isValidLoadTransition("Invoiced", "Delivered", { allowCorrections: false })).toBe(false)
  })

  it("allows only the documented correction edges with allowCorrections", () => {
    expect(isValidLoadTransition("Awaiting Signature", "Booked", ops)).toBe(true)
    expect(isValidLoadTransition("Dispatched", "Booked", ops)).toBe(true)
    expect(isValidLoadTransition("In Transit", "Dispatched", ops)).toBe(true)
    expect(isValidLoadTransition("Invoiced", "Delivered", ops)).toBe(true)
    expect(isValidLoadTransition("Delivered", "In Transit", ops)).toBe(false)
    expect(isValidLoadTransition("In Transit", "Booked", ops)).toBe(false)
    expect(nextLoadStatuses("Invoiced")).toEqual(["Closed"])
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
      allowed: ["Awaiting Signature", "Dispatched"],
    })
    expect(r.body.error).toMatch(/Booked -> Closed/)
  })

  it("checkLoadTransition: allowed list reflects the corrections option", () => {
    const driver = checkLoadTransition("Invoiced", "Delivered")
    expect(driver.ok).toBe(false)
    if (!driver.ok) expect(driver.body.allowed).toEqual(["Closed"])
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
