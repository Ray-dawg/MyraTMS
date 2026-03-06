import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

// ---------------------------------------------------------------------------
// GET /api/cron/invoice-alerts
//
// Vercel Cron job (daily at 08:00 UTC) that finds overdue invoices,
// updates their status to 'Overdue', recalculates days_outstanding,
// and creates notifications for the ops team.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const sql = getDb()
  let overdueCount = 0
  let notificationsCreated = 0
  let errors = 0

  try {
    // 1. Find 'Pending' invoices past due date
    const pendingOverdue = await sql`
      SELECT id, load_id, shipper_name, amount, due_date
      FROM invoices
      WHERE status = 'Pending'
        AND due_date < NOW()
    `

    for (const invoice of pendingOverdue) {
      try {
        const daysOutstanding = Math.floor(
          (Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24)
        )

        // Update invoice to Overdue
        await sql`
          UPDATE invoices
          SET status = 'Overdue',
              days_outstanding = ${daysOutstanding},
              updated_at = NOW()
          WHERE id = ${invoice.id}
        `

        // Create notification
        const amount = Number(invoice.amount || 0).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        })
        await sql`
          INSERT INTO notifications (title, description, type, read, created_at)
          VALUES (
            ${"Invoice Overdue: " + invoice.id},
            ${"Invoice " + invoice.id + " for " + (invoice.shipper_name || "Unknown Shipper") + " (" + amount + ") is " + daysOutstanding + " days past due. Load: " + (invoice.load_id || "N/A")},
            'warning',
            false,
            NOW()
          )
        `

        overdueCount++
        notificationsCreated++
      } catch (err) {
        console.error(`[cron/invoice-alerts] Error processing pending invoice ${invoice.id}:`, err)
        errors++
      }
    }

    // 2. Find 'Sent' invoices past due date
    const sentOverdue = await sql`
      SELECT id, load_id, shipper_name, amount, due_date
      FROM invoices
      WHERE status = 'Sent'
        AND due_date < NOW()
    `

    for (const invoice of sentOverdue) {
      try {
        const daysOutstanding = Math.floor(
          (Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24)
        )

        // Update invoice to Overdue
        await sql`
          UPDATE invoices
          SET status = 'Overdue',
              days_outstanding = ${daysOutstanding},
              updated_at = NOW()
          WHERE id = ${invoice.id}
        `

        // Create notification
        const amount = Number(invoice.amount || 0).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        })
        await sql`
          INSERT INTO notifications (title, description, type, read, created_at)
          VALUES (
            ${"Invoice Overdue: " + invoice.id},
            ${"Invoice " + invoice.id + " for " + (invoice.shipper_name || "Unknown Shipper") + " (" + amount + ") is " + daysOutstanding + " days past due. Load: " + (invoice.load_id || "N/A")},
            'warning',
            false,
            NOW()
          )
        `

        overdueCount++
        notificationsCreated++
      } catch (err) {
        console.error(`[cron/invoice-alerts] Error processing sent invoice ${invoice.id}:`, err)
        errors++
      }
    }
  } catch (err) {
    console.error("[cron/invoice-alerts] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  console.log(
    `[cron/invoice-alerts] Done: overdue=${overdueCount} notifications=${notificationsCreated} errors=${errors}`
  )
  return NextResponse.json({
    overdueCount,
    notificationsCreated,
    errors,
  })
}
