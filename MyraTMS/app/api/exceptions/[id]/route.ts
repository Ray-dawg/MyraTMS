import { NextRequest, NextResponse } from "next/server"
import { withTenant, asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { db } from "@/lib/pipeline/db-adapter"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id } = await params

  try {
    const body = await req.json()
    const { action } = body as { action: string }

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
      const { rows: peekRows } = await db.query<{ source_module: string; type: string }>(
        `SELECT source_module, type FROM exceptions WHERE id = $1`,
        [id],
      );
      const isGoLiveRequest = peekRows[0]?.source_module === 'tenant_onboarding' && peekRows[0]?.type === 'go_live_requested';
      if (isGoLiveRequest && !user.isSuperAdmin) {
        return NextResponse.json({ error: "Only a super-admin may approve a tenant go-live request" }, { status: 403 });
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

      return NextResponse.json(exc)
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (err) {
    console.error("[PATCH /api/exceptions/:id] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
