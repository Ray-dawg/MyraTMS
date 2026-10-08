import { NextRequest, NextResponse } from "next/server"
import { withTenant, asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { db } from "@/lib/pipeline/db-adapter"

/**
 * T-30 — the operator-supplied tender that accompanies an `approve` decision
 * on a contract_intake/tender_pending_approval exception. Mirrors the shape
 * of ExtractedTenderTerms (lib/documents/tender-terms.ts), but with the
 * lane/equipment/rate fields non-nullable: pipeline_loads declares all of
 * them NOT NULL, so a tender missing any of them cannot be injected at all.
 */
interface TenderInput {
  originCity: string
  originState: string
  originCountry: string
  destinationCity: string
  destinationState: string
  destinationCountry: string
  equipmentType: string
  rate: number
  rateCurrency: string
  pickupDate: string
  commodity?: string | null
  weightLbs?: number | null
}

// Exactly the vocabularies extractTenderTerms() normalizes to, and exactly
// what pipeline_loads' VARCHAR(2)/VARCHAR(3) columns can hold.
const TENDER_COUNTRIES = ["US", "CA"]
const TENDER_CURRENCIES = ["USD", "CAD"]

// Target column widths on pipeline_loads, so plausible operator input is a
// 400 rather than an opaque 500 from a value-too-long error mid-transaction.
const TENDER_STRING_WIDTHS: Record<string, number> = {
  originCity: 100,
  originState: 10,
  destinationCity: 100,
  destinationState: 10,
  equipmentType: 50,
}

/** posted_rate is NUMERIC(10,2): 8 integer digits, and 0.01 is its smallest
 * non-zero value — 1e-7 passes a naive `> 0` check and then stores as 0.00. */
const MIN_POSTED_RATE = 0.01
const MAX_POSTED_RATE = 99999999.99
/** weight_lbs is INTEGER. */
const MAX_WEIGHT_LBS = 2147483647
/** commodity is VARCHAR(200). */
const MAX_COMMODITY_LENGTH = 200

/**
 * pickup_date is TIMESTAMP NOT NULL, and Postgres is stricter than V8 about
 * what a date string may be. `Date.parse()` alone accepts both '1' (year 2001)
 * and '2026-02-30' (which it silently rolls forward to 2026-03-02); Postgres
 * rejects both, i.e. they reach the DB as the opaque 500 this validation
 * exists to replace. So: require the YYYY-MM-DD shape extractTenderTerms()
 * emits, then round-trip it to catch an impossible calendar date.
 */
function isStorableDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 10) === raw
}

type TenderValidation =
  | { ok: true; value: TenderInput }
  | { ok: false; error: string }

/**
 * T-30 — validates a tender BEFORE anything is claimed or inserted, so an
 * incomplete or unstorable tender is a 400 that leaves both the exception and
 * the inbound_emails row untouched rather than a 500 from a NOT NULL, enum,
 * width, range or cast violation mid-transaction.
 *
 * Every rejection names the offending field: this is a human-in-the-loop
 * endpoint, and an operator who gets "invalid tender" has to open a support
 * ticket to find out which of twelve fields to fix. Shape follows
 * validateOverrideAmount() in app/api/tenants/[id]/contract-shippers/route.ts.
 *
 * `commodity` and `weightLbs` are deliberately NOT required: both columns are
 * nullable on pipeline_loads and extractTenderTerms() routinely returns null
 * for them on a terse tender PDF. Requiring them would make a perfectly
 * injectable tender un-approvable. They are still range- and type-checked
 * when present.
 */
function validateTender(raw: unknown): TenderValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "approve requires a tender object" }
  }
  const v = raw as Record<string, unknown>

  for (const [field, maxLength] of Object.entries(TENDER_STRING_WIDTHS)) {
    const value = v[field]
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: `tender.${field} is required and must be a non-empty string` }
    }
    if (value.length > maxLength) {
      return { ok: false, error: `tender.${field} must be at most ${maxLength} characters` }
    }
  }

  for (const field of ["originCountry", "destinationCountry"]) {
    const value = v[field]
    if (typeof value !== "string" || !TENDER_COUNTRIES.includes(value)) {
      return { ok: false, error: `tender.${field} must be one of ${TENDER_COUNTRIES.join(", ")}` }
    }
  }

  if (typeof v.rateCurrency !== "string" || !TENDER_CURRENCIES.includes(v.rateCurrency)) {
    return { ok: false, error: `tender.rateCurrency must be one of ${TENDER_CURRENCIES.join(", ")}` }
  }

  if (typeof v.pickupDate !== "string" || !isStorableDate(v.pickupDate)) {
    return { ok: false, error: "tender.pickupDate must be a real calendar date in YYYY-MM-DD form" }
  }

  if (typeof v.rate !== "number" || !Number.isFinite(v.rate)) {
    return { ok: false, error: "tender.rate must be a number (an all-in dollar amount)" }
  }
  if (v.rate < MIN_POSTED_RATE || v.rate > MAX_POSTED_RATE) {
    return { ok: false, error: `tender.rate must be between ${MIN_POSTED_RATE} and ${MAX_POSTED_RATE}` }
  }

  if (v.weightLbs !== undefined && v.weightLbs !== null) {
    if (typeof v.weightLbs !== "number" || !Number.isInteger(v.weightLbs)) {
      return {
        ok: false,
        error: "tender.weightLbs must be a whole number of pounds — round it if the extraction was fractional",
      }
    }
    if (v.weightLbs < 0 || v.weightLbs > MAX_WEIGHT_LBS) {
      return { ok: false, error: `tender.weightLbs must be between 0 and ${MAX_WEIGHT_LBS}` }
    }
  }

  if (v.commodity !== undefined && v.commodity !== null) {
    if (typeof v.commodity !== "string") {
      return { ok: false, error: "tender.commodity must be a string or null" }
    }
    if (v.commodity.length > MAX_COMMODITY_LENGTH) {
      return { ok: false, error: `tender.commodity must be at most ${MAX_COMMODITY_LENGTH} characters` }
    }
  }

  return { ok: true, value: v as unknown as TenderInput }
}

/**
 * T-30 — thrown when the idempotent claim UPDATE on inbound_emails matches
 * zero rows, i.e. this tender has already been approved or rejected. A
 * distinct class so the handler can map exactly this case to 409 (or detect a
 * resumed wedge, see below) while every OTHER throw inside the asServiceAdmin
 * block falls through to the outer catch (500) with the exception
 * deliberately left ACTIVE.
 */
class TenderAlreadyProcessedError extends Error {
  constructor() {
    super("Tender already processed")
    this.name = "TenderAlreadyProcessedError"
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id } = await params

  try {
    const body = await req.json()
    const { action, decision, tender } = body as {
      action: string
      decision?: unknown
      tender?: unknown
    }

    if (action === "acknowledge") {
      const row = await withTenant(ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE exceptions
              SET acknowledged_at = NOW(), status = 'acknowledged'
            WHERE id = $1
            RETURNING *`,
          [id],
        )
        return rows[0] ?? null
      })
      if (!row) return NextResponse.json({ error: "Exception not found" }, { status: 404 })
      return NextResponse.json(row)
    }

    if (action === "resolve") {
      // T-28 — a resolved tenant_onboarding/go_live_requested exception
      // activates a tenant (a privileged trust decision, spec §4.4).
      // Gate BEFORE the resolve itself runs, so a non-super-admin request
      // for exactly this exception type is rejected outright rather than
      // silently resolved-without-activating.
      //
      // T-30 additively reads inbound_email_id + tenant_id off the same peek.
      const { rows: peekRows } = await db.query<{
        source_module: string
        type: string
        inbound_email_id: number | null
        tenant_id: string | number | null
      }>(
        `SELECT source_module, type, inbound_email_id, tenant_id FROM exceptions WHERE id = $1`,
        [id],
      );
      const isGoLiveRequest = peekRows[0]?.source_module === 'tenant_onboarding' && peekRows[0]?.type === 'go_live_requested';
      if (isGoLiveRequest && !user.isSuperAdmin) {
        return NextResponse.json({ error: "Only a super-admin may approve a tenant go-live request" }, { status: 403 });
      }

      // T-30 — contract-intake tender approve/reject. This is the ONLY code
      // path in the entire module allowed to INSERT a pipeline_loads row; no
      // other T-30 file creates one and none may be added.
      //
      // Deliberately ordered side-effects-BEFORE-resolve, the inverse of the
      // T-28 activation block further down (and of the plan's own sketch): a
      // tender whose injection fails must leave the exception ACTIVE so the
      // operator can retry. Resolving first and then swallowing the failure
      // would close the exception and lose the tender silently.
      const peek = peekRows[0]
      let createdPipelineLoadId: number | null = null
      if (peek?.source_module === 'contract_intake' && peek?.type === 'tender_pending_approval') {
        // The base resolve UPDATE below relies on withTenant() alone, and RLS
        // is OFF (migration 029's policies exist but were never enabled), so
        // nothing else would stop another tenant from resolving this
        // exception and injecting a load against it. This branch therefore
        // checks tenancy itself. exceptions.tenant_id is BIGINT and comes
        // back from Neon as a JS string — coerce both sides before comparing.
        if (Number(peek.tenant_id) !== Number(ctx.tenantId)) {
          return NextResponse.json({ error: "Exception not found" }, { status: 404 })
        }
        if (peek.inbound_email_id === null) {
          return NextResponse.json(
            { error: "Contract-intake exception has no linked inbound email" },
            { status: 422 },
          )
        }
        if (decision !== 'approve' && decision !== 'reject') {
          return NextResponse.json(
            { error: "decision must be 'approve' or 'reject'" },
            { status: 400 },
          )
        }

        let approvedTender: TenderInput | null = null
        if (decision === 'approve') {
          const validated = validateTender(tender)
          if (!validated.ok) {
            return NextResponse.json({ error: validated.error }, { status: 400 })
          }
          approvedTender = validated.value
        }

        const emailId = peek.inbound_email_id
        const claimedStatus = decision === 'approve' ? 'approved' : 'rejected'

        try {
          createdPipelineLoadId = await asServiceAdmin(
            `T-30 contract-intake ${decision} of exception ${id} (inbound email ${emailId}) by user ${user.userId}`,
            async (adminClient) => {
              // Idempotent claim FIRST. Only a row still in 'pending_review'
              // may be acted on, so a double-submit can never produce a
              // second pipeline_loads row — and because this runs inside the
              // same transaction as the INSERT below, any later throw rolls
              // the claim back with it.
              const claimed = await adminClient.query(
                `UPDATE inbound_emails
                    SET intake_status = $2
                  WHERE id = $1 AND intake_status = 'pending_review'
                  RETURNING id`,
                [emailId, claimedStatus],
              )
              if (claimed.rows.length === 0) throw new TenderAlreadyProcessedError()
              if (!approvedTender) return null

              const loadId = `email_tender-${emailId}-${Date.now()}`
              const inserted = await adminClient.query<{ id: number }>(
                `INSERT INTO pipeline_loads (
                   load_id, load_board_source, origin_city, origin_state, origin_country,
                   destination_city, destination_state, destination_country,
                   pickup_date, equipment_type, posted_rate, posted_rate_currency,
                   commodity, weight_lbs, stage, source_type, created_by
                 ) VALUES (
                   $1, 'email_tender', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   'qualified', 'email_tender', 'contract-intake'
                 )
                 RETURNING id`,
                [
                  loadId,
                  approvedTender.originCity,
                  approvedTender.originState,
                  approvedTender.originCountry,
                  approvedTender.destinationCity,
                  approvedTender.destinationState,
                  approvedTender.destinationCountry,
                  approvedTender.pickupDate,
                  approvedTender.equipmentType,
                  approvedTender.rate,
                  approvedTender.rateCurrency,
                  approvedTender.commodity ?? null,
                  approvedTender.weightLbs ?? null,
                ],
              )
              const newPipelineLoadId = inserted.rows[0].id
              await adminClient.query(
                `UPDATE inbound_emails SET created_pipeline_load_id = $1 WHERE id = $2`,
                [newPipelineLoadId, emailId],
              )
              return newPipelineLoadId
            },
          )
        } catch (err) {
          if (!(err instanceof TenderAlreadyProcessedError)) {
            // Anything else falls through to the outer catch (500) with the
            // exception still ACTIVE and the claim rolled back with its
            // transaction.
            throw err
          }

          // The claim committed in its OWN transaction; the base resolve
          // below runs in a second one. If that second transaction fails
          // (pool exhaustion, a dropped connection — both plausible on
          // Vercel) the tender is claimed and, on approve, the
          // pipeline_loads row exists, yet the exception is unresolved.
          // Without the recovery below, every retry would hit
          // `WHERE intake_status = 'pending_review'`, claim nothing, and 409
          // forever: the exception would be permanently unresolvable through
          // this route.
          //
          // The disqualifying state is a DENYLIST of exactly one value —
          // 'resolved' — not an allowlist of the states we expect. A genuine
          // double-submit always has status='resolved', because the first
          // submit's resolve completed; anything else (active, acknowledged,
          // or any status added later) is by definition an unfinished
          // resolve, i.e. a wedge, and must be allowed to finish. An earlier
          // revision allowlisted 'active' and so left an acknowledged-then-
          // wedged exception permanently stuck — the very bug this recovery
          // exists to remove, surviving in an unenumerated state.
          //
          // The stored intake_status must still match THIS request's
          // decision, so a decision flip (stored 'approved', request
          // 'reject') remains a 409 rather than silently overwriting it.
          const { rows: wedgeRows } = await db.query<{
            intake_status: string | null
            created_pipeline_load_id: number | null
            status: string
          }>(
            `SELECT ie.intake_status, ie.created_pipeline_load_id, e.status
               FROM exceptions e
               JOIN inbound_emails ie ON ie.id = e.inbound_email_id
              WHERE e.id = $1`,
            [id],
          )
          const wedge = wedgeRows[0]
          if (!wedge || wedge.intake_status !== claimedStatus || wedge.status === 'resolved') {
            return NextResponse.json({ error: "Tender already processed" }, { status: 409 })
          }
          createdPipelineLoadId =
            wedge.created_pipeline_load_id === null ? null : Number(wedge.created_pipeline_load_id)
        }
      }

      const exc = await withTenant(ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE exceptions
              SET resolved_at = NOW(), status = 'resolved'
            WHERE id = $1
            RETURNING *`,
          [id],
        )
        const exception = rows[0]
        if (!exception) return null

        if (exception.load_id) {
          const { rows: others } = await client.query(
            `SELECT 1 FROM exceptions
              WHERE load_id = $1 AND status = 'active' AND id != $2
              LIMIT 1`,
            [exception.load_id, id],
          )
          if (others.length === 0) {
            await client.query(
              `UPDATE loads SET has_exception = false WHERE id = $1`,
              [exception.load_id],
            )
          }
        }
        return exception
      })
      if (!exc) return NextResponse.json({ error: "Exception not found" }, { status: 404 })

      // T-24 §5 — additive: log a permanent T-17 event for every resolution
      // regardless of source_module, so the record covers both the 8
      // original rules and the new bridged categories uniformly. Never
      // blocks or alters the response above — a logging failure here must
      // never turn a successful resolve into an error response.
      try {
        await db.query(
          `INSERT INTO events (
             tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
             source, actor_type, payload, occurred_at, derived_from_table, derived_from_id
           ) VALUES ($1, 'exception.resolved', 'exception', $2, $3, 'exceptions-api', 'human',
             $4, LOCALTIMESTAMP, 'exceptions', $2)`,
          [
            ctx.tenantId, 0, exc.pipeline_load_id ?? null,
            JSON.stringify({ exceptionId: exc.id, type: exc.type, source_module: exc.source_module }),
          ],
        )
      } catch (err) {
        console.error("[PATCH /api/exceptions/:id] resolution-event logging failed (non-blocking):", err)
      }

      // T-28 — additive: a resolved tenant_onboarding/go_live_requested
      // exception is this module's only approval mechanism (spec §4.4 —
      // no new approval table or UI). Never blocks or alters the response
      // above, same discipline as the T-17 event-logging block just above.
      if (exc.source_module === 'tenant_onboarding' && exc.type === 'go_live_requested') {
        // Runs via asServiceAdmin, not withTenant(ctx.tenantId, ...) — this
        // activates a DIFFERENT tenant than the approving super-admin's own
        // request context, and must work correctly regardless of RLS
        // enablement state (migration 029). asServiceAdmin wraps both
        // UPDATEs in one transaction and writes its own audit log entry.
        try {
          await asServiceAdmin(
            `T-28 go-live approval for tenant ${exc.tenant_id} by super-admin ${user.userId}`,
            async (adminClient) => {
              await adminClient.query(`UPDATE tenants SET status = 'active', updated_at = NOW() WHERE id = $1`, [exc.tenant_id])
              await adminClient.query(
                `UPDATE tenant_onboarding_sessions
                    SET current_step = 'live', status = 'completed', completed_at = NOW()
                  WHERE tenant_id = $1 AND current_step = 'go_live_requested'`,
                [exc.tenant_id],
              )
            },
          )
        } catch (err) {
          console.error("[PATCH /api/exceptions/:id] tenant go-live activation failed (non-blocking):", err)
        }
      }

      if (createdPipelineLoadId !== null) {
        return NextResponse.json({ ...exc, createdPipelineLoadId })
      }
      return NextResponse.json(exc)
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (err) {
    console.error("[PATCH /api/exceptions/:id] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
