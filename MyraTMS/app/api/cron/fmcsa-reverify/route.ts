import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

// ---------------------------------------------------------------------------
// GET /api/cron/fmcsa-reverify
//
// Vercel Cron job (daily at 06:00 UTC) that re-verifies carriers whose
// last_fmcsa_sync is older than 30 days. Calls the internal compliance/verify
// endpoint for each stale carrier.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const sql = getDb()
  let checked = 0
  let updated = 0
  let errors = 0

  try {
    // Find carriers with stale FMCSA data (>30 days or never synced)
    const staleCarriers = await sql`
      SELECT id, mc_number, dot_number
      FROM carriers
      WHERE last_fmcsa_sync < NOW() - INTERVAL '30 days'
         OR last_fmcsa_sync IS NULL
      LIMIT 10
    `

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "")

    for (const carrier of staleCarriers) {
      checked++
      try {
        const res = await fetch(`${appUrl}/api/compliance/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            carrierId: carrier.id,
            mcNumber: carrier.mc_number,
          }),
        })

        if (res.ok) {
          updated++
        } else {
          const errBody = await res.text()
          console.error(
            `[cron/fmcsa-reverify] Failed for carrier ${carrier.id}: ${res.status} ${errBody}`
          )
          errors++
        }
      } catch (err) {
        console.error(`[cron/fmcsa-reverify] Error verifying carrier ${carrier.id}:`, err)
        errors++
      }
    }
  } catch (err) {
    console.error("[cron/fmcsa-reverify] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  console.log(`[cron/fmcsa-reverify] Done: checked=${checked} updated=${updated} errors=${errors}`)
  return NextResponse.json({ checked, updated, errors })
}
