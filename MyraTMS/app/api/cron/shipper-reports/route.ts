import { NextRequest, NextResponse } from "next/server"
import { forEachActiveTenant } from "@/lib/db/tenant-context"
import { buildShipperAnalyticsHtml } from "@/lib/email-templates/shipper-analytics"
import { sendGenericEmail } from "@/lib/email"

// ---------------------------------------------------------------------------
// POST /api/cron/shipper-reports
//
// Vercel Cron (1st of each month, 06:00 UTC). For each active tenant, sends
// monthly analytics reports to shippers who had delivered loads in the prior
// month. Per-tenant company name comes from the tenant's settings row.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const isDevelopment = process.env.NODE_ENV !== "production"

  if (!isDevelopment) {
    const incoming = request.headers.get("x-cron-secret")
    if (!cronSecret || incoming !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  // Determine prior month (shared across all tenants).
  const now = new Date()
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  const month = now.getMonth() === 0 ? 12 : now.getMonth()
  const monthNames = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  const periodLabel = `${monthNames[month]} ${year}`

  const summary = await forEachActiveTenant(
    "cron:shipper-reports",
    async ({ client }) => {
      let processed = 0
      let sent = 0
      let skipped = 0
      let errors = 0

      // Per-tenant company name (defaults to tenant slug-friendly fallback).
      const { rows: settingsRows } = await client.query(
        `SELECT settings_value FROM settings
          WHERE settings_key = 'company_name' AND user_id IS NULL
          LIMIT 1`,
      )
      const companyName = settingsRows.length > 0
        ? (settingsRows[0].settings_value as string)
        : "Myra Logistics"

      const { rows: shippers } = await client.query(
        `SELECT s.id, s.company, s.contact_name, s.contact_email,
                COUNT(l.id)::int AS total_loads,
                AVG(EXTRACT(DAY FROM (l.delivered_at::timestamp - l.pickup_date::timestamp))) AS avg_transit_days,
                SUM(l.revenue)::float AS total_spend,
                CASE WHEN COUNT(l.id) > 0 THEN
                  SUM(CASE WHEN l.delivered_at <= l.delivery_date THEN 1 ELSE 0 END)::float / COUNT(l.id) * 100
                ELSE 0 END AS on_time_pct
           FROM shippers s
           JOIN loads l ON l.shipper_id = s.id
          WHERE l.status IN ('Delivered','Invoiced','Closed')
            AND s.contact_email IS NOT NULL AND s.contact_email != ''
            AND EXTRACT(YEAR FROM l.delivered_at::timestamp) = $1
            AND EXTRACT(MONTH FROM l.delivered_at::timestamp) = $2
          GROUP BY s.id, s.company, s.contact_name, s.contact_email`,
        [year, month],
      )

      for (const shipper of shippers) {
        processed++
        try {
          const shipperId = shipper.id as string
          const contactEmail = shipper.contact_email as string

          const { rows: existing } = await client.query(
            `SELECT id FROM shipper_report_log
              WHERE shipper_id = $1 AND period_year = $2 AND period_month = $3
              LIMIT 1`,
            [shipperId, year, month],
          )
          if (existing.length > 0) {
            skipped++
            continue
          }

          const { rows: topCarriers } = await client.query(
            `SELECT c.company AS name, COUNT(l.id)::int AS count
               FROM loads l
               JOIN carriers c ON l.carrier_id = c.id
              WHERE l.shipper_id = $1
                AND l.status IN ('Delivered','Invoiced','Closed')
                AND EXTRACT(YEAR FROM l.delivered_at::timestamp) = $2
                AND EXTRACT(MONTH FROM l.delivered_at::timestamp) = $3
                AND l.carrier_id IS NOT NULL
              GROUP BY c.company
              ORDER BY count DESC
              LIMIT 3`,
            [shipperId, year, month],
          )

          const html = buildShipperAnalyticsHtml({
            companyName,
            shipperName: (shipper.company || "Shipper") as string,
            contactName: shipper.contact_name as string | undefined,
            periodLabel,
            totalLoads: shipper.total_loads as number,
            onTimePct: Number(shipper.on_time_pct) || 0,
            avgTransitDays:
              shipper.avg_transit_days != null
                ? Number(shipper.avg_transit_days)
                : null,
            totalSpend: Number(shipper.total_spend) || 0,
            topCarriers: topCarriers.map((c) => ({
              name: c.name as string,
              count: c.count as number,
            })),
          })

          const subject = `Your ${periodLabel} Shipping Report — ${companyName}`
          const emailSent = await sendGenericEmail(contactEmail, subject, html)

          if (emailSent) {
            const logId = `SRL-${Date.now().toString(36).toUpperCase()}`
            await client.query(
              `INSERT INTO shipper_report_log (id, shipper_id, period_year, period_month, email_to, loads_count)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [logId, shipperId, year, month, contactEmail, shipper.total_loads as number],
            )
            sent++
          } else {
            skipped++
          }
        } catch (err) {
          console.error(`[cron/shipper-reports] Error for shipper ${shipper.id}:`, err)
          errors++
        }
      }

      return { processed, sent, skipped, errors }
    },
  )

  const totals = summary.results.reduce(
    (acc, r) => {
      if (r.ok && r.result) {
        acc.processed += r.result.processed
        acc.sent += r.result.sent
        acc.skipped += r.result.skipped
        acc.errors += r.result.errors
      }
      return acc
    },
    { processed: 0, sent: 0, skipped: 0, errors: 0 },
  )

  console.log(
    `[cron/shipper-reports] tenants=${summary.totalTenants} ok=${summary.succeeded} failed=${summary.failed} processed=${totals.processed} sent=${totals.sent} skipped=${totals.skipped} errors=${totals.errors} duration=${summary.durationMs}ms`,
  )

  return NextResponse.json({ ...summary, totals, period: { year, month, label: periodLabel } })
}
