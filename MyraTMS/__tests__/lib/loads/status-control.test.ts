import { describe, it, expect } from "vitest"
import {
  CORRECTION_ROLES,
  LOAD_STATUSES,
  OPERATOR_ROLES,
  allowsCorrections,
  canChangeStatus,
  nextLoadStatuses,
} from "@/lib/loads/status-transitions"
import type { LoadStatus } from "@/lib/types"
import {
  LOAD_STEPPER_STEPS,
  canOfferCorrections,
  canOfferStatusControl,
  effectiveStatusRole,
  isCorrectionTransition,
  manualStatusOptions,
  stepperStepsFor,
} from "@/lib/loads/status-control"

describe("stepper sequence", () => {
  it("is the full lifecycle in order, with Awaiting Signature between Booked and Dispatched", () => {
    expect([...LOAD_STEPPER_STEPS]).toEqual([
      "Booked",
      "Awaiting Signature",
      "Dispatched",
      "In Transit",
      "Delivered",
      "Invoiced",
      "Closed",
    ])
    expect(LOAD_STEPPER_STEPS).toEqual(LOAD_STATUSES)
  })
})

describe("stepperStepsFor", () => {
  // Regression: the stepper used to render LOAD_STEPPER_STEPS unconditionally
  // with isComplete = (i < currentStepIndex), so every manually-assigned load
  // at Dispatched or later showed a green check for "Awaiting Signature" --
  // a status migration 049 says only the AI-cascade path can produce.
  const afterSignatureStep: LoadStatus[] = ["Dispatched", "In Transit", "Delivered", "Invoiced", "Closed"]

  it.each(afterSignatureStep)(
    "omits Awaiting Signature for a %s load with no carrier signature on record",
    (status) => {
      const steps = stepperStepsFor({ status, carrierSignatureReceivedAt: null })
      expect(steps).not.toContain("Awaiting Signature")
      // ...and it is never rendered as a completed step before the current one.
      expect(steps.slice(0, steps.indexOf(status))).not.toContain("Awaiting Signature")
    },
  )

  it("omits Awaiting Signature for a Booked load", () => {
    expect(stepperStepsFor({ status: "Booked" })).toEqual([
      "Booked",
      "Dispatched",
      "In Transit",
      "Delivered",
      "Invoiced",
      "Closed",
    ])
  })

  it("keeps Awaiting Signature while the load is sitting in it", () => {
    expect(stepperStepsFor({ status: "Awaiting Signature", carrierSignatureReceivedAt: null })).toEqual([
      ...LOAD_STATUSES,
    ])
  })

  it.each(afterSignatureStep)(
    "keeps Awaiting Signature for a %s load that really passed through it (signature timestamp present)",
    (status) => {
      const steps = stepperStepsFor({ status, carrierSignatureReceivedAt: "2026-10-07T12:00:00.000Z" })
      expect(steps).toContain("Awaiting Signature")
      expect(steps).toEqual([...LOAD_STATUSES])
    },
  )

  it("accepts a Date as well as the raw Neon string", () => {
    expect(stepperStepsFor({ status: "Delivered", carrierSignatureReceivedAt: new Date() })).toContain(
      "Awaiting Signature",
    )
  })

  it("treats a missing / undefined timestamp the same as null", () => {
    expect(stepperStepsFor({ status: "Closed" })).not.toContain("Awaiting Signature")
    expect(stepperStepsFor({ status: "Closed", carrierSignatureReceivedAt: undefined })).not.toContain(
      "Awaiting Signature",
    )
  })

  it("still returns the lifecycle for an unknown / legacy status (minus the conditional step)", () => {
    const steps = stepperStepsFor({ status: "Pending" })
    expect(steps).not.toContain("Awaiting Signature")
    expect(steps.indexOf("Pending" as never)).toBe(-1)
  })
})

// Round-6 finding 1, secondary symptom. Keying the conditional step on the
// signature TIMESTAMP alone hid the step on a cascade load that had really
// sat in Awaiting Signature but left it without a signature. Migration 049's
// header makes pipeline_load_id the correct signal: it is the only path that
// reaches the status at all.
describe("stepperStepsFor: pipeline_load_id as the conditional-step signal", () => {
  it("keeps Awaiting Signature for a cascade load with NO signature timestamp", () => {
    for (const status of ["Dispatched", "In Transit", "Delivered", "Invoiced", "Closed"] as LoadStatus[]) {
      const steps = stepperStepsFor({ status, pipelineLoadId: "9001", carrierSignatureReceivedAt: null })
      expect(steps).toContain("Awaiting Signature")
      expect(steps).toEqual([...LOAD_STATUSES])
    }
  })

  it("keeps it for a cascade load still at Booked (the step is ahead, not behind)", () => {
    expect(stepperStepsFor({ status: "Booked", pipelineLoadId: "9001" })).toEqual([...LOAD_STATUSES])
  })

  it("accepts a numeric pipeline_load_id as well as the Neon BIGINT string", () => {
    expect(stepperStepsFor({ status: "Delivered", pipelineLoadId: 9001 })).toContain("Awaiting Signature")
  })

  it("treats null / empty-string pipeline_load_id as a manual assignment", () => {
    for (const pipelineLoadId of [null, undefined, ""]) {
      expect(stepperStepsFor({ status: "Delivered", pipelineLoadId })).not.toContain("Awaiting Signature")
    }
  })

  it("leaves the current-step index at -1 for an unknown status", () => {
    // app/loads/[id]/page.tsx does exactly this findIndex; -1 means nothing
    // renders complete and nothing renders current, which is the intended
    // behaviour for a legacy/unknown loads.status rather than a crash.
    const steps = stepperStepsFor({ status: "Pending" })
    expect(steps.findIndex((s) => s === ("Pending" as LoadStatus))).toBe(-1)
  })
})

// Round-6 finding 3. profileLoading is NOT a safe guard: lib/workspace-context.tsx
// returns early on a failed /api/auth/me but still clears profileLoading in its
// `finally`, leaving fallbackProfile.role === "admin" in place.
describe("effectiveStatusRole", () => {
  it("returns null until the profile has actually loaded", () => {
    expect(effectiveStatusRole({ role: "admin", profileLoaded: false })).toBeNull()
    expect(effectiveStatusRole({ role: "sales", profileLoaded: false })).toBeNull()
  })

  it("returns null for a FAILED identity fetch even though profileLoading is false", () => {
    // The exact regression: role is the fallback "admin", nothing loaded.
    const role = effectiveStatusRole({ role: "admin", profileLoaded: false })
    expect(role).toBeNull()
    expect(manualStatusOptions("Invoiced", role)).toEqual([])
    expect(canOfferStatusControl(role)).toBe(false)
  })

  it("returns the real role once the fetch succeeded", () => {
    expect(effectiveStatusRole({ role: "admin", profileLoaded: true })).toBe("admin")
    expect(effectiveStatusRole({ role: "sales", profileLoaded: true })).toBe("sales")
    // ...and a `sales` user still gets no control, from the role whitelist.
    expect(manualStatusOptions("Invoiced", effectiveStatusRole({ role: "sales", profileLoaded: true }))).toEqual([])
  })

  it("returns null for a missing / empty role on a loaded profile", () => {
    for (const role of [null, undefined, ""]) {
      expect(effectiveStatusRole({ role, profileLoaded: true })).toBeNull()
    }
  })
})

describe("canOfferCorrections", () => {
  it("IS the transition module's predicate -- not a second role list", () => {
    // Drift guard: if these ever become independent literals again, this fails.
    expect(canOfferCorrections).toBe(allowsCorrections)
  })

  it("is true for exactly the CORRECTION_ROLES", () => {
    for (const role of CORRECTION_ROLES) expect(canOfferCorrections(role)).toBe(true)
    for (const r of ["driver", "carrier", "shipper", "ops", "sales", "", null, undefined]) {
      expect(CORRECTION_ROLES as readonly string[]).not.toContain(r)
      expect(canOfferCorrections(r as string | null | undefined)).toBe(false)
    }
  })
})

describe("canOfferStatusControl", () => {
  it("IS the transition module's operator predicate -- not a second role list", () => {
    expect(canOfferStatusControl).toBe(canChangeStatus)
  })
})

describe("isCorrectionTransition", () => {
  it("is true for the backward ops edges", () => {
    expect(isCorrectionTransition("Invoiced", "Delivered")).toBe(true)
    expect(isCorrectionTransition("Dispatched", "Booked")).toBe(true)
    expect(isCorrectionTransition("In Transit", "Dispatched")).toBe(true)
    // "Awaiting Signature" -> "Booked" was removed in round 6 (finding 2), so
    // it is no longer a correction edge -- it is no edge at all.
    expect(isCorrectionTransition("Awaiting Signature", "Booked")).toBe(false)
  })

  it("is false for forward lifecycle moves, no-ops and unknown statuses", () => {
    expect(isCorrectionTransition("Booked", "Dispatched")).toBe(false)
    expect(isCorrectionTransition("Delivered", "Invoiced")).toBe(false)
    expect(isCorrectionTransition("Delivered", "Delivered")).toBe(false)
    expect(isCorrectionTransition("Pending", "Delivered")).toBe(false)
    expect(isCorrectionTransition("Invoiced", "Lost")).toBe(false)
  })

  it("flags every correction edge the Select can offer to an ops role", () => {
    for (const status of LOAD_STATUSES) {
      const fwd = manualStatusOptions(status, "ops")
      for (const target of manualStatusOptions(status, "admin")) {
        expect(isCorrectionTransition(status, target)).toBe(!fwd.includes(target))
      }
    }
  })
})

describe("manualStatusOptions", () => {
  // Forward options come straight from nextLoadStatuses, minus Awaiting Signature.
  it.each(LOAD_STATUSES)("offers exactly nextLoadStatuses(%s) minus Awaiting Signature, per role class", (status) => {
    // Every role that reaches the control is an OPERATOR_ROLE, so the option
    // list always carries the finance-side forward edges.
    const expectedFwd = nextLoadStatuses(status, { allowOperatorForward: true }).filter(
      (s) => s !== "Awaiting Signature",
    )
    const expectedOps = nextLoadStatuses(status, {
      allowCorrections: true,
      allowOperatorForward: true,
    }).filter((s) => s !== "Awaiting Signature")
    // Forward-only operators (ops, operator): forward edges, no corrections.
    expect(manualStatusOptions(status, "ops")).toEqual(expectedFwd)
    expect(manualStatusOptions(status, "operator")).toEqual(expectedFwd)
    // Correction-capable operators.
    expect(manualStatusOptions(status, "admin")).toEqual(expectedOps)
    expect(manualStatusOptions(status, "dispatcher")).toEqual(expectedOps)
  })

  // The PATCH route leaves every FORWARD edge open to any authenticated
  // caller (DApp drivers need Dispatched / In Transit / Delivered), so the
  // option list is what keeps a non-operator from being handed a working
  // one-click Booked -> ... -> Closed, finance statuses included. Default-deny.
  it.each(LOAD_STATUSES)("offers nothing from %s to a non-operator role", (status) => {
    for (const role of ["sales", "driver", "viewer", "owner", "shipper", "carrier", "", "nonsense", null, undefined]) {
      expect(OPERATOR_ROLES as readonly string[]).not.toContain(role)
      expect(manualStatusOptions(status, role as string | null | undefined)).toEqual([])
    }
  })

  it("offers nothing while the profile is still loading (role passed as null)", () => {
    // app/loads/[id]/page.tsx passes null until the workspace profile resolves,
    // so the control stays hidden rather than guessing the fallback "admin".
    expect(manualStatusOptions("Invoiced", null)).toEqual([])
  })

  it("never offers Awaiting Signature as a manual target", () => {
    for (const status of LOAD_STATUSES) {
      for (const role of ["admin", "dispatcher", "ops", "operator", "driver", null]) {
        expect(manualStatusOptions(status, role)).not.toContain("Awaiting Signature")
      }
    }
  })

  it("Booked: Dispatched only (Awaiting Signature is owned by confirm-carrier-signature)", () => {
    expect(manualStatusOptions("Booked", "admin")).toEqual(["Dispatched"])
    expect(manualStatusOptions("Booked", "ops")).toEqual(["Dispatched"])
  })

  // Round-6 finding 2: the "Booked" correction is gone. A later genuine
  // signed rate-con would have become a silent no-op --
  // completeDispatchOnSignedRateCon() returns 'not_awaiting_signature' and
  // lib/email/imap-poller.ts discards that, having already marked the email
  // handled. Awaiting Signature is now a dead end for the manual control:
  // only the gate's own endpoint moves a load out of it.
  it("Awaiting Signature: offers nothing at all, to any role", () => {
    for (const role of ["admin", "dispatcher", "ops", "operator"]) {
      expect(manualStatusOptions("Awaiting Signature", role)).toEqual([])
    }
  })

  it("In Transit: Delivered for every operator, plus Dispatched correction for admin/dispatcher", () => {
    expect(manualStatusOptions("In Transit", "ops")).toEqual(["Delivered"])
    expect(manualStatusOptions("In Transit", "dispatcher")).toEqual(["Delivered", "Dispatched"])
  })

  // Round-6 finding 4: the finance edges are operator-only server-side now,
  // and the option list must still offer them to the operators that have them
  // -- hiding them here while the route grants them would be the inverse
  // drift. (Non-operators get [] from the default-deny test above.)
  it("still offers the finance-side edges to operators", () => {
    expect(manualStatusOptions("Delivered", "ops")).toEqual(["Invoiced"])
    expect(manualStatusOptions("Invoiced", "ops")).toEqual(["Closed"])
    expect(manualStatusOptions("Invoiced", "admin")).toEqual(["Closed", "Delivered"])
  })

  it("Closed is terminal for every role", () => {
    expect(manualStatusOptions("Closed", "admin")).toEqual([])
  })

  it("returns [] for an unknown / legacy status", () => {
    expect(manualStatusOptions("Pending", "admin")).toEqual([])
    expect(manualStatusOptions("", "admin")).toEqual([])
  })
})
