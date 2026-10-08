/**
 * Load status state machine -- the single source of truth for which
 * loads.status transitions a caller may request through
 * PATCH /api/loads/[id].
 *
 * Pure module (no DB, no Next.js imports) so the UI can import it to build a
 * status dropdown that only offers legal next states.
 *
 * Forward lifecycle (FORWARD_LOAD_TRANSITIONS, open to every caller):
 *   Booked -> Awaiting Signature
 *   Booked -> Dispatched -> In Transit -> Delivered -> Invoiced -> Closed
 *
 * Backward edges live in CORRECTION_LOAD_TRANSITIONS and are only honoured
 * when the caller passes { allowCorrections: true }. The PATCH route grants
 * that to the "admin" and "dispatcher" roles only -- never to DApp driver
 * tokens (role "driver"). Without that split, a driver re-sending "Delivered"
 * after the POD flow had already moved the load to Invoiced would silently
 * regress it and re-fire status_change workflows + quote feedback.
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
 * Callers that DO go through this table (verified 2026-10-07):
 *   - DApp app/page.tsx handleStatusUpdate: sends 'Dispatched' (en_route_pickup),
 *     'In Transit' (en_route_delivery), 'Delivered' (delivered).
 *   - DApp components/request-load.tsx acceptLoad: sends 'Dispatched' on a
 *     Booked load (Booked -> Dispatched).
 *   - MyraTMS lib/api.ts updateLoad() from the broker UI.
 *   - The Engine 2 Dispatcher worker does NOT PATCH this route.
 */
import type { LoadStatus } from "@/lib/types"

/** Forward edges -- allowed for every authenticated caller. */
export const FORWARD_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Booked: [
    "Awaiting Signature", // rate-con sent, waiting on carrier signature (AI-cascade path)
    "Dispatched", // manual assignment / DApp driver accepting a load
  ],
  "Awaiting Signature": [], // dispatch only via the rate-con gate (see header)
  Dispatched: ["In Transit"], // driver picked up (DApp en_route_delivery)
  "In Transit": ["Delivered"], // driver delivered or ops marks delivered
  Delivered: ["Invoiced"], // invoice raised
  Invoiced: ["Closed"], // paid / settled
  Closed: [], // terminal
}

/** Backward ops-correction edges -- only with { allowCorrections: true }. */
export const CORRECTION_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = {
  Booked: [],
  "Awaiting Signature": ["Booked"], // carrier withdrew / signature never coming
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

/** Union of forward + correction edges (the full table, as seen by a privileged caller). */
export const VALID_LOAD_TRANSITIONS: Readonly<Record<LoadStatus, readonly LoadStatus[]>> = Object.fromEntries(
  LOAD_STATUSES.map((s) => [s, [...FORWARD_LOAD_TRANSITIONS[s], ...CORRECTION_LOAD_TRANSITIONS[s]]]),
) as unknown as Record<LoadStatus, readonly LoadStatus[]>

export interface LoadTransitionOptions {
  /** Permit backward ops-correction edges. Grant only to admin/dispatcher. */
  allowCorrections?: boolean
}

export function isLoadStatus(value: unknown): value is LoadStatus {
  return typeof value === "string" && (LOAD_STATUSES as readonly string[]).includes(value)
}

/** Legal next statuses from `from` for this caller (excludes the no-op same-status). */
export function nextLoadStatuses(from: LoadStatus, opts: LoadTransitionOptions = {}): LoadStatus[] {
  const forward = FORWARD_LOAD_TRANSITIONS[from] ?? []
  const corrections = opts.allowCorrections ? (CORRECTION_LOAD_TRANSITIONS[from] ?? []) : []
  return [...forward, ...corrections]
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

/**
 * Validate a requested status change against the current row's status.
 * Returns a ready-to-serialize error body the route maps straight to HTTP.
 * `allowed` reflects what THIS caller may do (corrections only if granted).
 *   - unknown target status -> 400
 *   - illegal edge          -> 409
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
