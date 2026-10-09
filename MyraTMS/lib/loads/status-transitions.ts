/**
 * Load status state machine -- the single source of truth for which
 * loads.status transitions a caller may request through
 * PATCH /api/loads/[id].
 *
 * Pure module (no DB, no Next.js imports) so the UI can import it to build a
 * status dropdown that only offers legal next states.
 *
 * THREE edge tables, split by who may REQUEST the edge:
 *   FORWARD_LOAD_TRANSITIONS            any authenticated caller (DApp drivers)
 *     Booked -> Dispatched -> In Transit -> Delivered
 *   OPERATOR_FORWARD_LOAD_TRANSITIONS   OPERATOR_ROLES only (finance side)
 *     Delivered -> Invoiced -> Closed
 *   CORRECTION_LOAD_TRANSITIONS         CORRECTION_ROLES only (backward edges)
 *
 * Why the finance edges are split out (round-5 review finding 4): the route
 * applied its role check to the BACKWARD edges only, so every forward edge --
 * Delivered -> Invoiced -> Closed included -- was open to any authenticated
 * principal, i.e. a `sales` user or a DApp driver bearer token could invoice
 * and close a load. The only forward edges anything driver-shaped needs are
 * Dispatched / In Transit / Delivered (see "Callers that DO go through this
 * table" below), so Invoiced and Closed are operator-only and OPERATOR_ROLES
 * is enforced SERVER-SIDE, not just by hiding dropdown options. Backward
 * edges remain CORRECTION_ROLES-only: without that split, a driver re-sending
 * "Delivered" after the POD flow had already moved the load to Invoiced would
 * silently regress it and re-fire status_change workflows + quote feedback.
 *
 * TWO targets are refused to EVERY caller, because another endpoint owns
 * entry into them:
 *   - "Awaiting Signature" (GATE_OWNED_STATUSES). Written only by
 *     lib/dispatch-gate.ts, by direct SQL, on the AI-cascade path. Accepting
 *     it here let any caller STRAND a manually-assigned load: its only way
 *     out is the rate-con gate, which never fires for a load with no
 *     pipeline_load_id, so every subsequent driver PATCH 409s and only an
 *     admin correction unsticks it.
 *   - "Dispatched" for a load on the AI-cascade path with no carrier
 *     signature on record -- violatesRateConDispatchGate() + LoadGateFacts.
 *     Without that check, Awaiting Signature -> Booked -> Dispatched was a
 *     two-click reconstruction of the very edge the next paragraph forbids,
 *     landing a Dispatched load with carrier_signature_received_at NULL, no
 *     signed rate-con document, no tracking_tokens row and no
 *     carrier_acceptance_state / events row.
 *
 * Awaiting Signature -> Dispatched is deliberately NOT an edge here: dispatch
 * from Awaiting Signature happens only through the E2-04 rate-con gate
 * (lib/dispatch-gate.ts on a signed rate-con, or the manual override
 * POST /api/loads/[id]/confirm-carrier-signature). Anything not listed is
 * rejected with HTTP 409 by the route.
 *
 * Writers that do NOT go through this table (they write loads.status by
 * direct SQL and are intentionally unaffected):
 *   - POST /api/loads/[id]/assign            (Booked -> Dispatched, manual assign)
 *   - lib/dispatch-gate.ts                   (-> Awaiting Signature -> Dispatched, AI cascade)
 *   - POST /api/loads/[id]/pod               (-> Delivered / Invoiced)
 *   - POST /api/loads/[id]/confirm-carrier-signature
 *   - lib/workflow-engine.ts update_status action
 *
 * Callers that DO go through this table (verified 2026-10-08):
 *   - DApp app/page.tsx handleStatusUpdate: sends 'Dispatched' (en_route_pickup),
 *     'In Transit' (en_route_delivery), 'Delivered' (delivered).
 *   - DApp components/request-load.tsx acceptLoad: sends 'Dispatched' on a
 *     Booked load (Booked -> Dispatched).
 *   - MyraTMS lib/api.ts updateLoad() from the broker UI -- the only caller
 *     that ever sends Invoiced / Closed, and it is reachable only from the
 *     operator-gated status control on app/loads/[id]/page.tsx.
 *   - The Engine 2 Dispatcher worker does NOT PATCH this route.
 */
import type { LoadStatus } from "@/lib/types"

/**
 * Forward edges open to EVERY authenticated caller -- the driver-reachable
 * part of the lifecycle. Booked -> "Awaiting Signature" is absent on purpose
 * (GATE_OWNED_STATUSES) and Delivered -> Invoiced / Invoiced -> Closed moved
 * to OPERATOR_FORWARD_LOAD_TRANSITIONS.
 */
export const FORWARD_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Booked: ["Dispatched"], // manual assignment / DApp driver accepting a load
  "Awaiting Signature": [], // dispatch only via the rate-con gate (see header)
  Dispatched: ["In Transit"], // driver picked up (DApp en_route_delivery)
  "In Transit": ["Delivered"], // driver delivered or ops marks delivered
  Delivered: [], // -> Invoiced is operator-only, see below
  Invoiced: [], // -> Closed is operator-only, see below
  Closed: [], // terminal
}

/**
 * Forward edges restricted to OPERATOR_ROLES -- the finance side. Nothing
 * driver-shaped needs these, and leaving them in FORWARD_LOAD_TRANSITIONS let
 * any authenticated principal invoice and close a load.
 */
export const OPERATOR_FORWARD_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Booked: [],
  "Awaiting Signature": [],
  Dispatched: [],
  "In Transit": [],
  Delivered: ["Invoiced"], // invoice raised
  Invoiced: ["Closed"], // paid / settled
  Closed: [],
}

/**
 * Backward ops-correction edges -- only with { allowCorrections: true }.
 *
 * "Awaiting Signature" -> "Booked" was REMOVED in round 6 (review finding 2).
 * It read as a harmless ops correction ("carrier withdrew") but it silently
 * disarmed the sell-side loop: completeDispatchOnSignedRateCon()
 * (lib/dispatch-gate.ts) returns 'not_awaiting_signature' for a load that is
 * no longer in that status, and its only automated caller --
 * lib/email/imap-poller.ts -- discards the return value and marks the inbound
 * email handled. So an ops correction at minute 80 of the 90-minute signature
 * SLA turned a genuine signed rate-con arriving at minute 85 into a no-op: no
 * dispatch, no document attached, nothing logged at error level. A
 * confirmation prompt cannot fix that -- the operator has no way to know
 * whether a signature is already in flight -- so the edge is gone. A load
 * that really must leave Awaiting Signature goes through the gate's own
 * endpoint, POST /api/loads/[id]/confirm-carrier-signature.
 */
export const CORRECTION_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Booked: [],
  "Awaiting Signature": [], // deliberately empty -- see the note above
  Dispatched: ["Booked"], // carrier unassigned / fell off
  "In Transit": ["Dispatched"], // pickup was marked prematurely
  Delivered: [],
  Invoiced: ["Delivered"], // invoice voided, needs re-billing
  Closed: [],
}

/**
 * Every LoadStatus, in lifecycle order. Derived from the Record keys, which the
 * Record<LoadStatus, ...> type forces to be exhaustive -- a new union member
 * missing from FORWARD_LOAD_TRANSITIONS is a compile error.
 */
export const LOAD_STATUSES: readonly LoadStatus[] = Object.keys(FORWARD_LOAD_TRANSITIONS) as LoadStatus[]

/** Union of all three tables (the full table, as seen by a privileged caller). */
export const VALID_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = Object.fromEntries(
  LOAD_STATUSES.map((s) => [
    s,
    [...FORWARD_LOAD_TRANSITIONS[s], ...OPERATOR_FORWARD_LOAD_TRANSITIONS[s], ...CORRECTION_LOAD_TRANSITIONS[s]],
  ]),
) as unknown as Record<LoadStatus, readonly LoadStatus[]>

/**
 * Statuses no PATCH caller may request as a target, at any role, from any
 * current status: another endpoint owns entry into them and writes them by
 * direct SQL. See the header for why accepting "Awaiting Signature" here
 * stranded manually-assigned loads.
 */
export const GATE_OWNED_STATUSES: readonly LoadStatus[] = ["Awaiting Signature"]

/**
 * The subset of a `loads` row the E2-04 rate-con dispatch gate needs in order
 * to decide whether "Dispatched" may be requested. Mapped by the caller from
 * the raw snake_case Neon row.
 */
export interface LoadGateFacts {
  /**
   * loads.pipeline_load_id. Non-null identifies the Engine 2 AI-cascade path,
   * which per migration 049's own header is the only path that ever produces
   * "Awaiting Signature" -- and therefore the only path whose dispatch is
   * owned by the rate-con gate.
   */
  pipelineLoadId?: string | number | null
  /** loads.carrier_signature_received_at -- proof the signed rate-con came back. */
  carrierSignatureReceivedAt?: string | Date | null
}

export interface LoadTransitionOptions {
  /** Permit backward ops-correction edges. Grant only to CORRECTION_ROLES. */
  allowCorrections?: boolean
  /**
   * Permit the finance-side forward edges (Delivered -> Invoiced -> Closed).
   * Grant only to OPERATOR_ROLES -- i.e. pass canChangeStatus(role).
   */
  allowOperatorForward?: boolean
  /**
   * The row facts the rate-con dispatch gate needs. OMITTING this disables
   * the gate, so PATCH /api/loads/[id] must always pass it (pinned by
   * __tests__/api/loads-patch-status.test.ts, which asserts both columns are
   * in the route's SELECT ... FOR UPDATE). Pure/UI callers that only want the
   * shape of the state machine -- e.g. lib/loads/status-control.ts building
   * the dropdown -- legitimately have no row to supply.
   */
  load?: LoadGateFacts
}

/**
 * The ONLY list of JWT roles granted the backward ops-correction edges above.
 *
 * Single source of truth on purpose: both PATCH /api/loads/[id] (the
 * authority) and lib/loads/status-control.ts (which decides what the UI
 * Select *offers*) import `allowsCorrections` from here. Each used to carry
 * its own ["admin","dispatcher"] literal, so the two could drift silently --
 * the UI would offer an edge the server rejects, or hide one it accepts.
 */
export const CORRECTION_ROLES = ["admin", "dispatcher"] as const

export type CorrectionRole = (typeof CORRECTION_ROLES)[number]

/** True if this JWT role may request a backward ops-correction edge. */
export function allowsCorrections(role: string | null | undefined): role is CorrectionRole {
  return typeof role === "string" && (CORRECTION_ROLES as readonly string[]).includes(role)
}

/**
 * The ONLY list of JWT roles the load detail page offers the manual status
 * Select to, and -- since round 6 -- the roles PATCH /api/loads/[id] accepts
 * the finance-side forward edges (Delivered -> Invoiced -> Closed) from.
 * Default-DENY: an unrecognised role gets no control and no finance edge.
 *
 * Why a second list rather than reusing CORRECTION_ROLES: the route leaves
 * the DRIVER-reachable forward edges open to any authenticated caller,
 * because DApp driver tokens (role "driver") drive Dispatched / In Transit /
 * Delivered through it. Those three are the only forward edges anything
 * driver-shaped needs, so Invoiced and Closed are gated on this list instead
 * (OPERATOR_FORWARD_LOAD_TRANSITIONS above).
 *
 * Role vocabulary (verified 2026-10-08) -- three disjoint sets exist:
 *   - users.role CHECK (001-create-tables.sql:12): admin | ops | sales.
 *     This is what app/api/auth/login/route.ts:66 puts in the JWT, so it is
 *     the only vocabulary a real TMS session can present.
 *   - tenant_users.role CHECK (027_multi_tenant_foundation.sql:89):
 *     owner | admin | operator | driver | viewer | service_admin. Not in the
 *     JWT today; middleware copies the JWT claim into x-myra-tenant-role.
 *   - Strings the code branches on: admin, dispatcher, shipper, carrier,
 *     driver -- "dispatcher", "shipper" and "carrier" are in NO vocabulary
 *     and cannot appear in a TMS JWT today.
 *
 * So the roles that can actually reach the control are admin, ops and sales
 * (plus "driver" from the DApp token). `ops` is an operator; `sales` is not
 * and is excluded. Note middleware.ts has NEVER executed in production, so
 * its driver-JWT path restriction is not an enforcement point -- which is
 * exactly why the finance edges are now checked here, server-side.
 * `dispatcher` and `operator` are admitted defensively: `dispatcher` because
 * the PATCH route's correction contract already names it, `operator` because
 * it is 027's operator role and this list must not silently lock operators out
 * if the JWT ever moves to that vocabulary. 027's `owner` / `service_admin`
 * are deliberately NOT admitted yet: neither can reach a TMS JWT today, and
 * default-deny is the safe direction -- add them here (one place, covered by
 * __tests__/lib/loads/status-transitions.test.ts) if the JWT ever carries them.
 */
export const OPERATOR_ROLES = ["admin", "ops", "dispatcher", "operator"] as const

export type OperatorRole = (typeof OPERATOR_ROLES)[number]

/**
 * True if this JWT role is an operator: offered the manual status control in
 * the UI, and granted OPERATOR_FORWARD_LOAD_TRANSITIONS by the PATCH route.
 */
export function canChangeStatus(role: string | null | undefined): role is OperatorRole {
  return typeof role === "string" && (OPERATOR_ROLES as readonly string[]).includes(role)
}

export function isLoadStatus(value: unknown): value is LoadStatus {
  return typeof value === "string" && (LOAD_STATUSES as readonly string[]).includes(value)
}

/**
 * Legal next statuses from `from` for this caller (excludes the no-op
 * same-status). Does NOT apply the rate-con dispatch gate -- that needs row
 * facts, not just the current status; see checkLoadTransition.
 */
export function nextLoadStatuses(from: LoadStatus, opts: LoadTransitionOptions = {}): LoadStatus[] {
  const forward = FORWARD_LOAD_TRANSITIONS[from] ?? []
  const operator = opts.allowOperatorForward ? (OPERATOR_FORWARD_LOAD_TRANSITIONS[from] ?? []) : []
  const corrections = opts.allowCorrections ? (CORRECTION_LOAD_TRANSITIONS[from] ?? []) : []
  return [...forward, ...operator, ...corrections]
}

/** Same-status is a no-op and therefore always valid. */
export function isValidLoadTransition(from: LoadStatus, to: LoadStatus, opts: LoadTransitionOptions = {}): boolean {
  if (from === to) return true
  return nextLoadStatuses(from, opts).includes(to)
}

export type LoadTransitionCheck =
  | { ok: true }
  | {
      ok: false
      httpStatus: 400 | 409
      body: { error: string; from: string | null; to: unknown; allowed: LoadStatus[] }
    }

export const CONFIRM_CARRIER_SIGNATURE_HINT =
  "Dispatch from Awaiting Signature goes through POST /api/loads/[id]/confirm-carrier-signature (or a signed rate-con via the dispatch gate)."

export const AWAITING_SIGNATURE_ENTRY_HINT =
  "Awaiting Signature is written only by the E2-04 dispatch gate (lib/dispatch-gate.ts) on the AI-cascade path; PATCH /api/loads/[id] never accepts it as a target."

export const RATE_CON_DISPATCH_GATE_HINT =
  "This load is on the Engine 2 AI-cascade path (pipeline_load_id is set) and has no carrier signature on record, so the E2-04 rate-con gate owns its dispatch. Use POST /api/loads/[id]/confirm-carrier-signature (or let the dispatch gate match a signed rate-con) instead of setting the status by hand."

/**
 * True if requesting `to` would bypass the E2-04 rate-con dispatch gate.
 *
 * The gate exists because Dispatched on the AI-cascade path must imply a
 * countersigned rate-con. Refusing only the direct Awaiting Signature ->
 * Dispatched edge was not enough: Awaiting Signature -> Booked -> Dispatched
 * reached the same forbidden state in two moves, landing a Dispatched load
 * with carrier_signature_received_at NULL and no signed rate-con document.
 * So this predicate keys on the ROW, not on the previous status -- no
 * sequence of individually-legal edges can get there.
 *
 * Returns false when `facts` is undefined: a caller with no row cannot
 * evaluate the gate. Every AUTHORIZATION caller must therefore pass facts.
 */
export function violatesRateConDispatchGate(to: unknown, facts?: LoadGateFacts): boolean {
  if (to !== "Dispatched" || !facts) return false
  // Neon returns BIGINT as a JS string; "" is treated as absent too.
  const onCascadePath = facts.pipelineLoadId != null && facts.pipelineLoadId !== ""
  return onCascadePath && facts.carrierSignatureReceivedAt == null
}

/**
 * Validate a requested status change against the current row's status.
 * Returns a ready-to-serialize error body the route maps straight to HTTP.
 * `allowed` reflects what THIS caller may do (operator-forward and
 * correction edges only if granted).
 *   - unknown target status    -> 400
 *   - gate-owned target status -> 409 (AWAITING_SIGNATURE_ENTRY_HINT)
 *   - rate-con gate bypass     -> 409 (RATE_CON_DISPATCH_GATE_HINT)
 *   - illegal edge             -> 409
 */
export function checkLoadTransition(
  from: string | null | undefined,
  to: unknown,
  opts: LoadTransitionOptions = {},
): LoadTransitionCheck {
  if (!isLoadStatus(to)) {
    return {
      ok: false,
      httpStatus: 400,
      body: {
        error: `Unknown load status ${JSON.stringify(to)}. Expected one of: ${LOAD_STATUSES.join(", ")}`,
        from: from ?? null,
        to,
        allowed: isLoadStatus(from) ? nextLoadStatuses(from, opts) : [...LOAD_STATUSES],
      },
    }
  }
  // Refusals that depend on the TARGET (or on the row) rather than on the
  // edge run BEFORE the unknown-`from` escape hatch below -- a legacy/null
  // stored status must not become a way around a gate-owned status or the
  // rate-con dispatch gate.
  const allowedFrom = (): LoadStatus[] => (isLoadStatus(from) ? nextLoadStatuses(from, opts) : [...LOAD_STATUSES])

  if (from !== to && GATE_OWNED_STATUSES.includes(to)) {
    return {
      ok: false,
      httpStatus: 409,
      body: {
        error: `Invalid load status transition: ${from ?? "null"} -> ${to}. ${AWAITING_SIGNATURE_ENTRY_HINT}`,
        from: from ?? null,
        to,
        allowed: allowedFrom(),
      },
    }
  }

  if (from !== to && violatesRateConDispatchGate(to, opts.load)) {
    return {
      ok: false,
      httpStatus: 409,
      body: {
        error: `Invalid load status transition: ${from ?? "null"} -> ${to}. ${RATE_CON_DISPATCH_GATE_HINT}`,
        from: from ?? null,
        to,
        allowed: allowedFrom().filter((s) => s !== "Dispatched"),
      },
    }
  }

  // loads_status_check (migration 049) guarantees the stored value is a known
  // status; a null/legacy value cannot be reasoned about, so allow it through.
  if (!isLoadStatus(from)) return { ok: true }
  if (isValidLoadTransition(from, to, opts)) return { ok: true }
  const allowed = nextLoadStatuses(from, opts)
  let error = `Invalid load status transition: ${from} -> ${to}. Allowed from ${from}: ${
    allowed.length ? allowed.join(", ") : "none"
  }`
  if (from === "Awaiting Signature" && to === "Dispatched") error += `. ${CONFIRM_CARRIER_SIGNATURE_HINT}`
  return { ok: false, httpStatus: 409, body: { error, from, to, allowed } }
}
