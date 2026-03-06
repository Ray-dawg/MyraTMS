import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { generateRateCon } from "@/lib/rate-confirmation"
import { attachDocument } from "@/lib/documents"
import { put } from "@vercel/blob"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: loadId } = await params
    const body = await req.json()
    const {
      carrier_id,
      driver_id,
      carrier_rate,
      match_score,
      assignment_method = "matched",
    } = body

    if (!carrier_id) {
      return NextResponse.json({ error: "carrier_id is required" }, { status: 400 })
    }

    const sql = getDb()

    // Verify load exists
    const loads = await sql`SELECT id, status, revenue FROM loads WHERE id = ${loadId}`
    if (loads.length === 0) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    // Verify carrier exists
    const carriers = await sql`SELECT id, company FROM carriers WHERE id = ${carrier_id}`
    if (carriers.length === 0) {
      return NextResponse.json({ error: "Carrier not found" }, { status: 404 })
    }

    const carrierName = carriers[0].company as string

    // Calculate margin if carrier_rate provided
    const revenue = Number(loads[0].revenue) || 0
    const carrierCost = carrier_rate || 0
    const margin = revenue - carrierCost
    const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0

    // Update the load with carrier assignment
    await sql`
      UPDATE loads SET
        carrier_id = ${carrier_id},
        carrier_name = ${carrierName},
        carrier_cost = ${carrierCost || null},
        margin = ${margin || null},
        margin_percent = ${marginPercent || null},
        driver_id = ${driver_id || null},
        status = CASE WHEN status = 'Booked' THEN 'Dispatched' ELSE status END,
        updated_at = NOW()
      WHERE id = ${loadId}
    `

    // Mark this carrier as selected in match_results
    if (match_score != null) {
      await sql`
        UPDATE match_results
        SET was_selected = TRUE
        WHERE load_id = ${loadId} AND carrier_id = ${carrier_id}
      `.catch(() => {})
    }

    // If driver assigned, update driver status
    if (driver_id) {
      await sql`
        UPDATE drivers SET status = 'on_load', updated_at = NOW()
        WHERE id = ${driver_id}
      `.catch(() => {})
    }

    // Generate rate confirmation PDF (non-blocking — don't fail assignment)
    let rateCon: { url: string; docId: string } | undefined
    try {
      const pdfBuffer = await generateRateCon(loadId)
      const filename = `rate-con/${loadId}/RC-${Date.now()}.pdf`
      const blob = await put(filename, pdfBuffer, { access: "public", addRandomSuffix: false })
      const doc = await attachDocument({
        loadId,
        docType: "Rate Confirmation",
        blobUrl: blob.url,
        fileName: `RC-${loads[0].reference_number || loadId}.pdf`,
        fileSize: pdfBuffer.length,
        uploadedBy: "system",
      })
      rateCon = { url: blob.url, docId: doc.id as string }

      // Check auto-send setting
      const autoSendRows = await sql`
        SELECT settings_value FROM settings
        WHERE settings_key = 'auto_send_rate_con' AND user_id IS NULL
      `
      if (autoSendRows.length > 0 && autoSendRows[0].settings_value === true) {
        const carrierInfo = await sql`
          SELECT contact_phone, contact_email FROM carriers WHERE id = ${carrier_id}
        `
        if (carrierInfo.length > 0) {
          const contact = carrierInfo[0].contact_email || carrierInfo[0].contact_phone
          if (contact) console.log(`Rate con auto-send: ${contact}`)
        }
      }
    } catch (rateConErr) {
      console.error("Rate con generation failed (assignment still successful):", rateConErr)
    }

    return NextResponse.json({
      load_id: loadId,
      carrier_id,
      carrier_name: carrierName,
      assignment_method,
      status: "assigned",
      rateCon,
    })
  } catch (err) {
    console.error("Assign error:", err)
    return NextResponse.json({ error: "Assignment failed" }, { status: 500 })
  }
}
