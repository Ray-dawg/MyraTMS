/**
 * Pure helpers behind the manual status control and stepper on the load detail
 * page (app/loads/[id]/page.tsx). No React / DB imports so they unit-test cleanly.
 *
 * The legal-edge table lives ONLY in lib/loads/status-transitions.ts; nothing
 * here restates it. The server (PATCH /api/loads/[id]) is the authority -- the
 * client role only decides which options to *offer*.
 */
import {
  CORRECTION_LOAD_TRANSITIONS,
  GATE_OWNED_STATUSES,
  LOAD_STATUSES,
  allowsCorrections,
  canChangeStatus,
  isLoadStatus,
  nextLoadStatuses,
} from "@/lib/loads/status-transitions"
import type { LoadStatus } from "@/lib/types"

/**
 * Transitions INTO these statuses are owned by another endpoint and must never
 * be offered as a manual target. "Awaiting Signature" is entered only via the
 * E2-04 dispatch gate / POST /api/loads/[id]/confirm-carrier-signature.
 *
 * Defence in depth ONLY. Since round 6 the state machine itself has no edge
 * into a gate-owned status and PATCH /api/loads/[id] refuses one outright, so
 * nextLoadStatuses() can no longer return one. Hiding an option was never the
 * fix -- it is the class of defect this gap exists to close -- so the list is
 * derived from GATE_OWNED_STATUSES rather than restating it.
 */
const NOT_MANUALLY_SELECTABLE: readonly LoadStatus[] = [...GATE_OWNED_STATUSES]

/**
 * Statuses that are NOT part of every load's lifecycle and must therefore only
 * appear in the stepper when this particular load actually went through them.
 *
 * "Awaiting Signature" is reached only on the AI-cascade path -- migration
 * 049's own header: "Only the AI-cascade path (loads.pipeline_load_id IS NOT
 * NULL) ever produces this status ... manual human assignments through the
 * same /assign route never reach that gate and keep flipping straight to
 * 'Dispatched'". Rendering it unconditionally made every manually-assigned
 * load at Dispatched or later show a green check for a rate-con signature
 * that never existed -- an affirmative falsehood, worse than the omission it
 * replaced.
 */
const CONDITIONAL_STEPS: readonly LoadStatus[] = ["Awaiting Signature"]

/** Full lifecycle order (derived from the transition table, not a second list). */
export const LOAD_STEPPER_STEPS: readonly LoadStatus[] = LOAD_STATUSES

/** The subset of a `loads` row the stepper needs. snake_case: raw Neon row. */
export interface StepperLoadFacts {
  /** loads.status */
  status: string | null | undefined
  /**
   * loads.pipeline_load_id -- non-null means the load is on the Engine 2
   * AI-cascade path, which per migration 049's header is the ONLY path that
   * reaches "Awaiting Signature" at all. This, not the timestamp, is the
   * signal for whether the step belongs in THIS load's lifecycle.
   */
  pipelineLoadId?: string | number | null
  /** loads.carrier_signature_received_at (migration 049) -- proof the load really was Awaiting Signature. */
  carrierSignatureReceivedAt?: string | Date | null
}

/**
 * Steps to render for ONE load: the full lifecycle minus any conditional step
 * this load has no evidence of. A conditional step is kept when the load is
 * sitting in it right now, when the row is on the path that OWNS the step
 * (pipeline_load_id), or when the row carries the timestamp proving it passed
 * through.
 *
 * pipelineLoadId is consulted as well as the timestamp because the timestamp
 * alone was not sufficient: a cascade load that left Awaiting Signature
 * WITHOUT a signature had carrier_signature_received_at NULL, so the step was
 * HIDDEN on a load that demonstrably sat in it. Hiding a step a load really
 * passed through is the same class of lie as showing one it never did.
 */
export function stepperStepsFor(facts: StepperLoadFacts): LoadStatus[] {
  // Neon returns BIGINT as a JS string; "" is treated as absent too.
  const onCascadePath = facts.pipelineLoadId != null && facts.pipelineLoadId !== ""
  return LOAD_STEPPER_STEPS.filter((step) => {
    if (!CONDITIONAL_STEPS.includes(step)) return true
    if (facts.status === step) return true
    if (step !== "Awaiting Signature") return false
    return onCascadePath || facts.carrierSignatureReceivedAt != null
  })
}

/**
 * Re-export of the transition module's single source of truth, so the UI and
 * the PATCH route can never disagree about who gets correction edges.
 */
export const canOfferCorrections = allowsCorrections

/**
 * Re-export of the operator whitelist, so the page gates the control on the
 * same predicate the option list uses (see manualStatusOptions below).
 */
export const canOfferStatusControl = canChangeStatus

/**
 * Statuses the manual Select should offer for a load currently in `current`.
 * Returns []:
 *   - for an unknown / legacy status (nothing can be reasoned about), and
 *   - for a role outside OPERATOR_ROLES.
 *
 * The role gate is here as well as at the render site on purpose -- but it is
 * NOT the enforcement point. Since round 6 PATCH /api/loads/[id] enforces
 * OPERATOR_ROLES on the finance-side forward edges (Delivered -> Invoiced ->
 * Closed) itself; the DRIVER-reachable forward edges (Dispatched / In
 * Transit / Delivered) stay open to any authenticated caller because the DApp
 * drives them. So if the render gate were ever dropped, this list is what
 * stops the control becoming a working one-click Booked -> ... -> Delivered
 * for roles that should not have it. Returning [] here makes that regression
 * inert and unit-tested.
 */
export function manualStatusOptions(current: string, role: string | null | undefined): LoadStatus[] {
  if (!isLoadStatus(current)) return []
  if (!canOfferStatusControl(role)) return []
  return nextLoadStatuses(current, {
    allowCorrections: canOfferCorrections(role),
    // Reaching this line means canOfferStatusControl(role) already passed, so
    // the caller is an OPERATOR_ROLE and gets the finance-side forward edges.
    allowOperatorForward: true,
  }).filter((s) => !NOT_MANUALLY_SELECTABLE.includes(s))
}

/**
 * The role the manual status control may act on, given workspace context.
 *
 * Default-DENY on anything but a CONFIRMED successful identity load.
 * lib/workspace-context.tsx seeds `profile` with fallbackProfile, whose role
 * is "admin", and clears `profileLoading` in a `finally` -- so a FAILED or
 * errored /api/auth/me left profileLoading=false with role "admin" still in
 * place, and a users.role='sales' user whose profile fetch 500d was rendered
 * the full admin option set, backward correction edges included. Gating on
 * `profileLoaded` -- which the provider sets ONLY after /api/auth/me returned
 * a user -- makes an unknown or failed identity mean "no role" instead of
 * "admin". Deliberately NOT fixed by changing fallbackProfile.role: that
 * object also feeds the sidebar, settings and profile screens.
 */
export function effectiveStatusRole(args: {
  role?: string | null
  /** True only once /api/auth/me returned a user. NOT `!profileLoading`. */
  profileLoaded: boolean
}): string | null {
  if (!args.profileLoaded) return null
  return typeof args.role === "string" && args.role.length > 0 ? args.role : null
}

/**
 * True if `next` is a BACKWARD ops-correction edge out of `current` (e.g.
 * Invoiced -> Delivered), as opposed to a forward lifecycle move.
 *
 * The page uses this to require an explicit confirmation: a correction
 * round-trip re-enters statuses whose side effects (status_change workflows,
 * and historically the quote-feedback sample) already ran once.
 */
export function isCorrectionTransition(current: string, next: string): boolean {
  if (!isLoadStatus(current) || !isLoadStatus(next)) return false
  return (CORRECTION_LOAD_TRANSITIONS[current] ?? []).includes(next)
}
