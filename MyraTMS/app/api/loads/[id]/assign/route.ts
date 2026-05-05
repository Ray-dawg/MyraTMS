import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { generateRateCon } from "@/lib/rate-confirmation"
import { attachDocument } from "@/lib/documents"
import { put } from "@vercel/blob"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = requireTenantContext(req)
    const { id: loadId } = await params
    const body = await req.json()
    const { carrier_id, driver_id, carrier_rate, match_score, assignment_method = "matched" } = body

    if (!carrier_id) {
      return NextResponse.json({ error: "carrier_id is required" }, { status: 400 })
    }

    const result = await withTenant(ctx.tenantId, async (client) => {
      const { rows: loads } = await client.query(
        `SELECT id, status, revenue, reference_number FROM loads WHERE id = $1`,
        [loadId],
      )
      if (loads.length === 0) return { notFound: "load" as const }

      const { rows: carriers } = await client.query(
        `SELECT id, company FROM carriers WHERE id = $1`,
        [carrier_id],
      )
      if (carriers.length === 0) return { notFound: "carrier" as const }

      const carrierName = carriers[0].company as string
      const revenue = Number(loads[0].revenue) || 0
      const carrierCost = carrier_rate || 0
      const margin = revenue - carrierCost
      const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0

      await client.query(
        `UPDATE loads SET
           carrier_id = $1, carrier_name = $2, carrier_cost = $3,
           margin = $4, margin_percent = $5, driver_id = $6,
           status = CASE WHEN status = 'Booked' THEN 'Dispatched' ELSE status END,
           updated_at = NOW()
         WHERE id = $7`,
        [
          carrier_id,
          carrierName,
          carrierCost || null,
          margin || null,
          marginPercent || null,
          driver_id || null,
          loadId,
        ],
      )

      if (match_score != null) {
        try {
          await client.query(
            `UPDATE match_results SET was_selected = TRUE
              WHERE load_id = $1 AND carrier_id = $2`,
            [loadId, carrier_id],
          )
        } catch {
          // tolerate missing match_results row
        }
      }

      if (driver_id) {
        try {
          await client.query(
            `UPDATE drivers SET status = 'on_load', updated_at = NOW() WHERE id = $1`,
            [driver_id],
          )
        } catch {
          // tolerate missing driver row
        }
      }

      return { ok: true as const, carrierName, referenceNumber: loads[0].reference_number }
    })

    if ("notFound" in result) {
      const which = result.notFound
      return NextResponse.json(
        { error: which === "load" ? "Load not found" : "Carrier not found" },
        { status: 404 },
      )
    }

    // Generate rate confirmation PDF (non-blocking)
    let rateCon: { url: string; docId: string } | undefined
    try {
      const pdfBuffer = await generateRateCon(ctx.tenantId, loadId)
      const filename = `rate-con/${loadId}/RC-${Date.now()}.pdf`
      const blob = await put(filename, pdfBuffer, { access: "public", addRandomSuffix: false })
      const doc = await attachDocument({
        tenantId: ctx.tenantId,
        loadId,
        docType: "Rate Confirmation",
        blobUrl: blob.url,
        fileName: `RC-${result.referenceNumber || loadId}.pdf`,
        fileSize: pdfBuffer.length,
        uploadedBy: "system",
      })
      rateCon = { url: blob.url, docId: doc.id as string }

      // Auto-send hook (non-blocking, currently logs only)
      await withTenant(ctx.tenantId, async (client) => {
        const { rows: autoSendRows } = await client.query(
          `SELECT settings_value FROM settings
            WHERE settings_key = 'auto_send_rate_con' AND user_id IS NULL`,
        )
        if (autoSendRows.length > 0 && autoSendRows[0].settings_value === true) {
          const { rows: carrierInfo } = await client.query(
            `SELECT contact_phone, contact_email FROM carriers WHERE id = $1`,
            [carrier_id],
          )
          if (carrierInfo.length > 0) {
            const contact = carrierInfo[0].contact_email || carrierInfo[0].contact_phone
            if (contact) console.log(`Rate con auto-send: ${contact}`)
          }
        }
      })
    } catch (rateConErr) {
      console.error("Rate con generation failed (assignment still successful):", rateConErr)
    }

    return NextResponse.json({
      load_id: loadId,
      carrier_id,
      carrier_name: result.carrierName,
      assignment_method,
      status: "assigned",
      rateCon,
    })
  } catch (err) {
    console.error("Assign error:", err)
    return NextResponse.json({ error: "Assignment failed" }, { status: 500 })
  }
}
