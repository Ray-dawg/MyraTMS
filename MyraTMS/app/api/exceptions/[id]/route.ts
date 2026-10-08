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

/**
 * T-30 — validates a tender BEFORE anything is claimed or inserted, so an
 * incomplete tender is a 400 that leaves both the exception and the
 * inbound_emails row untouched rather than a 500 from a NOT NULL violation
 * mid-transaction.
 *
 * `commodity` and `weightLbs` are deliberately NOT required: both columns are
 * nullable on pipeline_loads and extractTenderTerms() routinely returns null
 * for them on a terse tender PDF. Requiring them would make a perfectly
 * injectable tender un-approvable.
 */
function isCompleteTender(t: unknown): t is TenderInput {
  if (!t || typeof t !== "object") return false
  const v = t as Record<string, unknown>
  const required = [
    "originCity",
    "originState",
    "originCountry",
    "destinationCity",
    "destinationState",
    "destinationCountry",
    "equipmentType",
    "rateCurrency",
    "pickupDate",
  ]
  for (const key of required) {
    const field = v[key]
    if (typeof field !== "string" || field.trim() === "") return false
  }
  return typeof v.rate === "number" && Number.isFinite(v.rate) && v.rate > 0
}

/**
 * T-30 — thrown when the idempotent claim UPDATE on inbound_emails matches
 * zero rows, i.e. this tender has already been approved or rejected. A
 * distinct class so the handler can map exactly this case to 409 while every
 * OTHER throw inside the asServiceAdmin block falls through to the outer
 * catch (500) with the exception deliberately left ACTIVE.
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
        if (decision === 'approve' && !isCompleteTender(tender)) {
          return NextResponse.json(
            { error: "approve requires a complete tender (origin, destination, equipment type, rate, currency, pickup date)" },
            { status: 400 },
          )
        }

        const emailId = peek.inbound_email_id
        const approvedTender: TenderInput | null =
          decision === 'approve' && isCompleteTender(tender) ? tender : null

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
                [emailId, decision === 'approve' ? 'approved' : 'rejected'],
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
          if (err instanceof TenderAlreadyProcessedError) {
            return NextResponse.json({ error: "Tender already processed" }, { status: 409 })
          }
          // Anything else falls through to the outer catch (500) with the
          // exception still ACTIVE and the claim rolled back.
          throw err
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
