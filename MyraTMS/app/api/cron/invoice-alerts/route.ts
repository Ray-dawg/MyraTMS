import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import crypto from "crypto"

// ---------------------------------------------------------------------------
// POST /api/cron/invoice-alerts
//
// Vercel Cron job (daily at 08:00 UTC) that finds overdue invoices,
// updates days_outstanding, and creates deduplicated notifications.
//
// Auth: x-cron-secret header must match CRON_SECRET env var.
//       In development (NODE_ENV !== 'production') the check is skipped.
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
  let processed = 0
  let notificationsCreated = 0

  try {
    // 2. Find overdue invoices (not Paid / Cancelled, past due date)
    const overdueInvoices = await sql`
      SELECT
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
      LIMIT 100
    `

    // 3. Process each overdue invoice
    for (const invoice of overdueInvoices) {
      try {
        // a. Calculate days overdue
        const daysOverdue = Math.floor(
          (Date.now() - new Date(invoice.due_date).getTime()) / 86400000
        )

        // b. Update days_outstanding on the invoice
        await sql`
          UPDATE invoices
          SET days_outstanding = ${daysOverdue}
          WHERE id = ${invoice.id}
        `

        processed++

        // c. Dedup check — skip if a notification for this invoice was already created in the last 24 hours
        const existing = await sql`
          SELECT id FROM notifications
          WHERE title LIKE ${"%" + invoice.id + "%"}
            AND created_at > NOW() - INTERVAL '24 hours'
          LIMIT 1
        `

        if (existing.length > 0) {
          continue
        }

        // d. Insert notification
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

        await sql`
          INSERT INTO notifications (
            id,
            user_id,
            type,
            title,
            description,
            body,
            link,
            load_id,
            read,
            created_at
          ) VALUES (
            ${notifId},
            ${null},
            ${"invoice_overdue"},
            ${title},
            ${body},
            ${body},
            ${"/invoices"},
            ${invoice.load_id ?? null},
            ${false},
            NOW()
          )
        `

        notificationsCreated++
      } catch (err) {
        console.error(
          `[cron/invoice-alerts] Error processing invoice ${invoice.id}:`,
          err
        )
      }
    }
  } catch (err) {
    console.error("[cron/invoice-alerts] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  console.log(
    `[cron/invoice-alerts] Done: processed=${processed} notifications_created=${notificationsCreated}`
  )

  return NextResponse.json({ processed, notifications_created: notificationsCreated })
}
