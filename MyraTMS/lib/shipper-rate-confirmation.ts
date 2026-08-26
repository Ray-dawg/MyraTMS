/**
 * SHIPPER-SIDE RATE CONFIRMATION PDF
 *
 * E2-04 M2. Generates the PDF attached to the shipper confirmation-request
 * email (lib/workers/shipper-confirmation-worker.ts) after a load reaches
 * `pipeline_loads.stage='booked'`. Deliberately separate from
 * lib/rate-confirmation.ts, which is the CARRIER-facing document generated
 * later in the flow (E2-03 dispatch-gate.ts) — same document family, two
 * different counterparties, two different terms blocks, two different data
 * sources (this one reads `pipeline_loads` directly since no TMS `loads` row
 * exists yet at the `booked` stage; the carrier one reads `loads`+`carriers`
 * post-dispatch).
 *
 * @module lib/shipper-rate-confirmation
 */

import PDFDocument from "pdfkit"
import { PassThrough } from "stream"
import { db } from "@/lib/pipeline/db-adapter"

const DEFAULT_TERMS = `This rate confirmation reflects the agreed all-in rate for the load described below. Rate is subject to standard accessorials (detention, layover, TONU) as separately agreed. Shipper confirms accuracy of pickup/delivery details and authorizes Myra Logistics to arrange transportation on the terms above. Please reply to the confirmation email with your signed copy of this document for our records.`

interface ShipperRateConPipelineLoad {
  id: number
  load_id: string
  origin_city: string
  origin_state: string
  destination_city: string
  destination_state: string
  pickup_date: string
  delivery_date: string | null
  equipment_type: string
  commodity: string | null
  weight_lbs: number | null
  shipper_company: string | null
  shipper_contact_name: string | null
  shipper_phone: string | null
  shipper_email: string | null
  agreed_rate: string | null
  agreed_rate_currency: string | null
}

export async function generateShipperRateConfirmation(pipelineLoadId: number): Promise<Buffer> {
  const { rows } = await db.query<ShipperRateConPipelineLoad>(
    `SELECT id, load_id, origin_city, origin_state, destination_city, destination_state,
            pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
            shipper_company, shipper_contact_name, shipper_phone, shipper_email,
            agreed_rate, agreed_rate_currency
       FROM pipeline_loads
      WHERE id = $1`,
    [pipelineLoadId],
  )
  if (rows.length === 0) throw new Error(`pipeline_loads ${pipelineLoadId} not found`)
  const load = rows[0]

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  const year = new Date().getFullYear()
  const docRef = `SRC-${year}-${load.load_id.slice(-8)}`

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 })
    const passthrough = new PassThrough()
    const chunks: Buffer[] = []

    passthrough.on("data", (chunk: Buffer) => chunks.push(chunk))
    passthrough.on("end", () => resolve(Buffer.concat(chunks)))
    passthrough.on("error", reject)
    doc.pipe(passthrough)

    const pageWidth = doc.page.width - 100

    // ── HEADER ──
    doc.font("Helvetica-Bold").fontSize(20).text("RATE CONFIRMATION", { align: "center" })
    doc.moveDown(0.3)
    doc.font("Helvetica").fontSize(12).text("Myra Logistics", { align: "center" })
    doc.fillColor("#000000")
    doc.moveDown(0.5)

    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#cccccc").lineWidth(0.5).stroke()
    doc.moveDown(0.5)

    doc.fontSize(9).fillColor("#666666")
    doc.text(`Document: ${docRef}`, 50, doc.y, { align: "right" })
    doc.text(`Date: ${today}`, { align: "right" })
    doc.fillColor("#000000")
    doc.moveDown(1)

    // ── SHIPPER INFORMATION ──
    const shipperBoxY = doc.y
    doc.fontSize(8).fillColor("#999999").text("SHIPPER", 60, shipperBoxY + 10)
    doc.fillColor("#000000")
    doc.fontSize(11).font("Helvetica-Bold").text(String(load.shipper_company || "N/A"), 60, shipperBoxY + 24)
    doc.font("Helvetica").fontSize(9)
    doc.text(`Contact: ${load.shipper_contact_name || "N/A"}  |  Phone: ${load.shipper_phone || "N/A"}`, 60, shipperBoxY + 40)
    doc.text(`Load Reference: ${load.load_id}`, 60, shipperBoxY + 54)

    const shipperBoxH = 74
    doc.rect(50, shipperBoxY, pageWidth, shipperBoxH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = shipperBoxY + shipperBoxH + 15

    // ── LOAD DETAILS ──
    const detailsY = doc.y
    const halfWidth = (pageWidth - 20) / 2

    doc.fontSize(8).fillColor("#999999").text("PICKUP", 60, detailsY + 10)
    doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold")
    doc.text(`${load.origin_city}, ${load.origin_state}`, 60, detailsY + 24, { width: halfWidth - 20 })
    doc.font("Helvetica").fontSize(9)
    const pickupDate = load.pickup_date
      ? new Date(load.pickup_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "TBD"
    doc.text(pickupDate, 60, doc.y + 2, { width: halfWidth - 20 })

    const rightX = 50 + halfWidth + 20
    doc.fontSize(8).fillColor("#999999").text("DELIVERY", rightX + 10, detailsY + 10)
    doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold")
    doc.text(`${load.destination_city}, ${load.destination_state}`, rightX + 10, detailsY + 24, { width: halfWidth - 20 })
    doc.font("Helvetica").fontSize(9)
    const deliveryDate = load.delivery_date
      ? new Date(load.delivery_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "TBD"
    doc.text(deliveryDate, rightX + 10, doc.y + 2, { width: halfWidth - 20 })

    const detailsH = 74
    doc.rect(50, detailsY, halfWidth, detailsH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.rect(50 + halfWidth + 20, detailsY, halfWidth, detailsH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = detailsY + detailsH + 10

    doc.fontSize(9).fillColor("#333333")
    const details = [
      load.equipment_type ? `Equipment: ${load.equipment_type}` : null,
      load.weight_lbs ? `Weight: ${load.weight_lbs.toLocaleString("en-US")} lbs` : null,
      load.commodity ? `Commodity: ${load.commodity}` : null,
    ]
      .filter(Boolean)
      .join("  |  ")
    if (details) doc.text(details, 55)
    doc.fillColor("#000000")
    doc.moveDown(1)

    // ── RATE ──
    const rateY = doc.y
    doc.fontSize(8).fillColor("#999999").text("AGREED RATE", 60, rateY + 10)
    doc.fillColor("#000000")
    const rate = Number(load.agreed_rate) || 0
    const currency = load.agreed_rate_currency || "CAD"
    doc.font("Helvetica-Bold").fontSize(14)
    doc.text(`${currency} $${rate.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, 60, rateY + 26)
    doc.font("Helvetica").fontSize(9)
    doc.text("All-in rate, as agreed on the confirmation call.", 60, rateY + 46)

    const rateH = 64
    doc.rect(50, rateY, pageWidth, rateH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = rateY + rateH + 20

    // ── TERMS ──
    doc.fontSize(8).fillColor("#999999").text("TERMS")
    doc.moveDown(0.3)
    doc.fillColor("#333333").fontSize(8).font("Helvetica")
    doc.text(DEFAULT_TERMS, { width: pageWidth, lineGap: 2 })
    doc.fillColor("#000000")
    doc.moveDown(1.5)

    // ── ACCEPTANCE ──
    doc.fontSize(9).text("Please confirm this load via the link in the accompanying email, or reply to that email with a signed copy of this document.")
    doc.moveDown(1.5)
    doc.text("Signature: _________________________________    Date: _______________")
    doc.moveDown(1)
    doc.text("Printed Name: _________________________________")

    doc.end()
  })
}
