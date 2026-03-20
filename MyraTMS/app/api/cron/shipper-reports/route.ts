import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { buildShipperAnalyticsHtml } from "@/lib/email-templates/shipper-analytics"
import { sendGenericEmail } from "@/lib/email"

// ---------------------------------------------------------------------------
// POST /api/cron/shipper-reports
//
// Vercel Cron job (1st of each month at 06:00 UTC) that sends monthly
// analytics reports to shippers who had delivered loads in the prior month.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // 1. Verify cron secret
  const cronSecret = process.env.CRON_SECRET
  const isDevelopment = process.env.NODE_ENV !== "production"

  if (!isDevelopment) {
    const incoming = request.headers.get("x-cron-secret")
    if (!cronSecret || incoming !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const sql = getDb()

  // 2. Determine prior month
  const now = new Date()
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  const month = now.getMonth() === 0 ? 12 : now.getMonth()

  const monthNames = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  const periodLabel = `${monthNames[month]} ${year}`

  let processed = 0
  let sent = 0
  let skipped = 0
  let errors = 0

  try {
    // 3. Get company name from settings
    const settingsRows = await sql`
      SELECT settings_value FROM settings WHERE settings_key = 'company_name' AND user_id IS NULL LIMIT 1
    `
    const companyName = settingsRows.length > 0
      ? (settingsRows[0].settings_value as string)
      : "Myra Logistics"

    // 4. Query shippers with delivered loads in prior month
    const shippers = await sql`
      SELECT s.id, s.company, s.contact_name, s.contact_email,
        COUNT(l.id)::int AS total_loads,
        AVG(EXTRACT(DAY FROM (l.delivered_at::timestamp - l.pickup_date::timestamp))) AS avg_transit_days,
        SUM(l.revenue)::float AS total_spend,
        CASE WHEN COUNT(l.id) > 0 THEN
          SUM(CASE WHEN l.delivered_at <= l.delivery_date THEN 1 ELSE 0 END)::float / COUNT(l.id) * 100
        ELSE 0 END AS on_time_pct
      FROM shippers s JOIN loads l ON l.shipper_id = s.id
      WHERE l.status IN ('Delivered','Invoiced','Closed')
        AND s.contact_email IS NOT NULL AND s.contact_email != ''
        AND EXTRACT(YEAR FROM l.delivered_at::timestamp) = ${year}
        AND EXTRACT(MONTH FROM l.delivered_at::timestamp) = ${month}
      GROUP BY s.id, s.company, s.contact_name, s.contact_email
    `

    // 5. Process each shipper
    for (const shipper of shippers) {
      processed++

      try {
        const shipperId = shipper.id as string
        const contactEmail = shipper.contact_email as string

        // Dedup check
        const existing = await sql`
          SELECT id FROM shipper_report_log
          WHERE shipper_id = ${shipperId}
            AND period_year = ${year}
            AND period_month = ${month}
          LIMIT 1
        `
        if (existing.length > 0) {
          skipped++
          continue
        }

        // Get top 3 carriers for this shipper in the period
        const topCarriers = await sql`
          SELECT c.company AS name, COUNT(l.id)::int AS count
          FROM loads l
          JOIN carriers c ON l.carrier_id = c.id
          WHERE l.shipper_id = ${shipperId}
            AND l.status IN ('Delivered','Invoiced','Closed')
            AND EXTRACT(YEAR FROM l.delivered_at::timestamp) = ${year}
            AND EXTRACT(MONTH FROM l.delivered_at::timestamp) = ${month}
            AND l.carrier_id IS NOT NULL
          GROUP BY c.company
          ORDER BY count DESC
          LIMIT 3
        `

        // Build and send email
        const html = buildShipperAnalyticsHtml({
          companyName,
          shipperName: (shipper.company || "Shipper") as string,
          contactName: shipper.contact_name as string | undefined,
          periodLabel,
          totalLoads: shipper.total_loads as number,
          onTimePct: Number(shipper.on_time_pct) || 0,
          avgTransitDays: shipper.avg_transit_days != null ? Number(shipper.avg_transit_days) : null,
          totalSpend: Number(shipper.total_spend) || 0,
          topCarriers: topCarriers.map((c) => ({
            name: c.name as string,
            count: c.count as number,
          })),
        })

        const subject = `Your ${periodLabel} Shipping Report — ${companyName}`
        const emailSent = await sendGenericEmail(contactEmail, subject, html)

        if (emailSent) {
          // Log successful send
          const logId = `SRL-${Date.now().toString(36).toUpperCase()}`
          await sql`
            INSERT INTO shipper_report_log (id, shipper_id, period_year, period_month, email_to, loads_count)
            VALUES (${logId}, ${shipperId}, ${year}, ${month}, ${contactEmail}, ${shipper.total_loads as number})
          `
          sent++
        } else {
          skipped++
        }
      } catch (err) {
        console.error(`[cron/shipper-reports] Error for shipper ${shipper.id}:`, err)
        errors++
      }
    }
  } catch (err) {
    console.error("[cron/shipper-reports] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  console.log(
    `[cron/shipper-reports] Done: processed=${processed} sent=${sent} skipped=${skipped} errors=${errors}`
  )

  return NextResponse.json({ processed, sent, skipped, errors })
}
