import { NextRequest, NextResponse } from "next/server"
import { forEachActiveTenant } from "@/lib/db/tenant-context"
import crypto from "crypto"

// ===========================================================================
// UNREACHABLE AS CONFIGURED -- THIS CRON HAS NEVER EXECUTED (found 2026-10-08)
//
// vercel.json registers it ({ "path": "/api/cron/invoice-alerts",
// "schedule": "0 8 * * *" }), but a Vercel cron invocation is:
//     GET /api/cron/invoice-alerts
//     Authorization: Bearer $CRON_SECRET
// This route exports POST only, so Next answers 405 Method Not Allowed from
// the router -- before any handler code, and therefore before the auth check
// below ever runs. TWO independent mismatches, either one fatal:
//     method  Vercel sends GET          <-> route exports POST only
//     header  Vercel sends Authorization: Bearer  <-> route reads x-cron-secret
//
// Consequences to keep in mind when reading this file:
//   * the fail-closed hardening of the credential check below is INERT -- it
//     has never evaluated in production and cannot until the method is fixed;
//   * the SELF_AUTHENTICATING_PATHS entry for this path in middleware.ts is
//     likewise inert (the 405 precedes the handler either way);
//   * any claim that this job runs on its registered schedule is false.
//     Treat its effects as never having happened.
//
// DELIBERATELY NOT FIXED. Enabling it starts real outbound email (notifications to
// shippers about overdue invoices) across every active tenant, retroactively
// covering however many invoices have aged since this job silently stopped
// mattering. Starting outbound email is reserved for the operator.
// Compare the five crons that DO work -- exception-bridge, exception-detect,
// feedback-aggregation, pipeline-health, pipeline-scan -- each exports GET and
// reads `authorization` as `Bearer ${CRON_SECRET}`. Making this one work means
// matching that shape, and that is the operator's decision, not a drive-by.
// ===========================================================================
//
// POST /api/cron/invoice-alerts
//
// Vercel Cron (daily 08:00 UTC). For each active tenant: find overdue
// invoices, refresh days_outstanding, and create deduped notifications.
//
// Auth: x-cron-secret header must match CRON_SECRET env var. Fails closed when
//       CRON_SECRET is unset. Skipped only when NODE_ENV === 'development'.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const providedSecret = request.headers.get("x-cron-secret")
  // Fail closed. `NODE_ENV !== "production"` skipped the check ENTIRELY for
  // anything that is not a production build (preview, test, an unset NODE_ENV),
  // and an unset CRON_SECRET must never mean "open". The local-development
  // affordance is kept but narrowed to NODE_ENV === "development", matching
  // app/api/cron/fmcsa-reverify/route.ts. This route is bypassed by middleware
  // (it carries its own credential), so this is the only gate.
  const isDev = process.env.NODE_ENV === "development"
  if (!isDev && (!cronSecret || providedSecret !== cronSecret)) {
    console.warn("[cron/invoice-alerts] Unauthorized -- invalid or missing x-cron-secret")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const summary = await forEachActiveTenant(
      "cron:invoice-alerts",
      async ({ client }) => {
        let processed = 0
        let notificationsCreated = 0

        const { rows: overdueInvoices } = await client.query(
          `SELECT
             invoices.id,
             invoices.load_id,
             invoices.shipper_name,
             invoices.amount,
             invoices.status,
             invoices.due_date,
             loads.reference_number,
             shippers.company AS shipper_company
           FROM invoices
           LEFT JOIN loads    ON invoices.load_id     = loads.id
           LEFT JOIN shippers ON invoices.shipper_name = shippers.company
           WHERE invoices.status NOT IN ('Paid', 'paid', 'Cancelled', 'cancelled')
             AND invoices.due_date IS NOT NULL
             AND invoices.due_date < NOW()
           LIMIT 100`,
        )

        for (const invoice of overdueInvoices) {
          try {
            const daysOverdue = Math.floor(
              (Date.now() - new Date(invoice.due_date).getTime()) / 86400000,
            )

            await client.query(
              `UPDATE invoices SET days_outstanding = $1 WHERE id = $2`,
              [daysOverdue, invoice.id],
            )

            processed++

            // Dedup: skip if a notification for this invoice exists in the last 24h.
            const { rows: existing } = await client.query(
              `SELECT id FROM notifications
                WHERE title LIKE $1
                  AND created_at > NOW() - INTERVAL '24 hours'
                LIMIT 1`,
              [`%${invoice.id}%`],
            )
            if (existing.length > 0) continue

            const shipperName =
              invoice.shipper_company || invoice.shipper_name || "Unknown"
            const amount = Number(invoice.amount || 0).toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
            })
            const dueDate = new Date(invoice.due_date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })

            const notifId = `NTF-${Date.now().toString(36).toUpperCase()}-${crypto
              .randomUUID()
              .slice(0, 6)
              .toUpperCase()}`
            const title = `Overdue Invoice — ${invoice.id} — ${daysOverdue} days`
            const body = `Invoice for ${shipperName} — ${amount} was due ${dueDate}`

            await client.query(
              `INSERT INTO notifications (
                 id, user_id, type, title, description, body, link, load_id, read, created_at
               ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, false, NOW())`,
              [
                notifId,
                "invoice_overdue",
                title,
                body,
                body,
                "/invoices",
                invoice.load_id ?? null,
              ],
            )

            notificationsCreated++
          } catch (err) {
            console.error(
              `[cron/invoice-alerts] Error processing invoice ${invoice.id}:`,
              err,
            )
          }
        }

        return { processed, notifications_created: notificationsCreated }
      },
    )

    const totals = summary.results.reduce(
      (acc, r) => {
        if (r.ok && r.result) {
          acc.processed += r.result.processed
          acc.notifications_created += r.result.notifications_created
        }
        return acc
      },
      { processed: 0, notifications_created: 0 },
    )

    console.log(
      `[cron/invoice-alerts] tenants=${summary.totalTenants} ok=${summary.succeeded} failed=${summary.failed} processed=${totals.processed} notifications_created=${totals.notifications_created} duration=${summary.durationMs}ms`,
    )

    return NextResponse.json({ ...summary, totals })
  } catch (err) {
    console.error("[cron/invoice-alerts] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
