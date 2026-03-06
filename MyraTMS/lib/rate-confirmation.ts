import PDFDocument from "pdfkit"
import { PassThrough } from "stream"
import { getDb } from "@/lib/db"

const DEFAULT_TERMS = `Carrier warrants active FMCSA operating authority and insurance meeting minimum requirements. Carrier is liable for loss or damage to cargo from pickup to delivery. Detention: 2 hours free time at each stop, $75/hour thereafter. TONU: $250 if cancelled after truck is dispatched. Carrier may not broker, re-broker, or assign this load without written consent.`

export async function generateRateCon(loadId: string): Promise<Buffer> {
  const sql = getDb()

  const rows = await sql`
    SELECT l.*, c.company AS carrier_company, c.mc_number, c.dot_number,
           c.contact_name AS carrier_contact, c.contact_phone AS carrier_phone,
           c.insurance_expiry
    FROM loads l
    LEFT JOIN carriers c ON l.carrier_id = c.id
    WHERE l.id = ${loadId}
  `

  if (rows.length === 0) throw new Error(`Load ${loadId} not found`)
  const load = rows[0]

  // Fetch global settings: terms + brokerage branding in one query
  const settingsRows = await sql`
    SELECT settings_key, settings_value FROM settings
    WHERE settings_key IN ('rate_con_terms', 'company_name', 'broker_mc', 'broker_website')
      AND user_id IS NULL
  `
  const settingsMap = Object.fromEntries(
    settingsRows.map((r: { settings_key: string; settings_value: unknown }) => [
      r.settings_key,
      String(r.settings_value).replace(/^"|"$/g, ""),
    ])
  )
  const terms = settingsMap.rate_con_terms || DEFAULT_TERMS
  const companyName = settingsMap.company_name || "Myra Logistics"
  const brokerMC = settingsMap.broker_mc || "MC# 123456"
  const brokerWebsite = settingsMap.broker_website || "myralogistics.com"

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  const year = new Date().getFullYear()
  const docRef = `RC-${year}-${loadId.slice(-4)}`

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 })
    const passthrough = new PassThrough()
    const chunks: Buffer[] = []

    passthrough.on("data", (chunk: Buffer) => chunks.push(chunk))
    passthrough.on("end", () => resolve(Buffer.concat(chunks)))
    passthrough.on("error", reject)
    doc.pipe(passthrough)

    const pageWidth = doc.page.width - 100 // accounting for margins

    // ── HEADER ──
    doc.font("Helvetica-Bold").fontSize(20).text("RATE CONFIRMATION", { align: "center" })
    doc.moveDown(0.3)
    doc.font("Helvetica").fontSize(12).text(companyName, { align: "center" })
    doc.fontSize(10).fillColor("#666666").text(`${brokerMC} | ${brokerWebsite}`, { align: "center" })
    doc.fillColor("#000000")
    doc.moveDown(0.5)

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#cccccc").lineWidth(0.5).stroke()
    doc.moveDown(0.5)

    // Document ref + date
    doc.fontSize(9).fillColor("#666666")
    doc.text(`Document: ${docRef}`, 50, doc.y, { align: "right" })
    doc.text(`Date: ${today}`, { align: "right" })
    doc.fillColor("#000000")
    doc.moveDown(1)

    // ── CARRIER INFORMATION ──
    const carrierBoxY = doc.y
    doc.fontSize(8).fillColor("#999999").text("CARRIER", 60, carrierBoxY + 10)
    doc.fillColor("#000000")
    doc.fontSize(11).font("Helvetica-Bold").text(String(load.carrier_company || load.carrier_name || "TBD"), 60, carrierBoxY + 24)
    doc.font("Helvetica").fontSize(9)
    doc.text(`MC# ${load.mc_number || "N/A"}  |  DOT# ${load.dot_number || "N/A"}`, 60, carrierBoxY + 40)
    doc.text(`Contact: ${load.carrier_contact || "N/A"}  |  Phone: ${load.carrier_phone || "N/A"}`, 60, carrierBoxY + 54)

    const carrierBoxH = 74
    doc.rect(50, carrierBoxY, pageWidth, carrierBoxH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = carrierBoxY + carrierBoxH + 15

    // ── LOAD DETAILS ──
    const detailsY = doc.y
    const halfWidth = (pageWidth - 20) / 2

    // Pickup (left)
    doc.fontSize(8).fillColor("#999999").text("PICKUP", 60, detailsY + 10)
    doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold")
    doc.text(String(load.origin || "N/A"), 60, detailsY + 24, { width: halfWidth - 20 })
    doc.font("Helvetica").fontSize(9)
    const pickupDate = load.pickup_date
      ? new Date(load.pickup_date as string).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "TBD"
    let pickupTime = pickupDate
    if (load.pickup_window_start) {
      pickupTime += `  ${load.pickup_window_start}`
      if (load.pickup_window_end) pickupTime += ` - ${load.pickup_window_end}`
    }
    doc.text(pickupTime, 60, doc.y + 2, { width: halfWidth - 20 })

    // Delivery (right)
    const rightX = 50 + halfWidth + 20
    doc.fontSize(8).fillColor("#999999").text("DELIVERY", rightX + 10, detailsY + 10)
    doc.fillColor("#000000").fontSize(10).font("Helvetica-Bold")
    doc.text(String(load.destination || "N/A"), rightX + 10, detailsY + 24, { width: halfWidth - 20 })
    doc.font("Helvetica").fontSize(9)
    const deliveryDate = load.delivery_date
      ? new Date(load.delivery_date as string).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "TBD"
    doc.text(deliveryDate, rightX + 10, doc.y + 2, { width: halfWidth - 20 })

    // Draw two boxes side by side
    const detailsH = 74
    doc.rect(50, detailsY, halfWidth, detailsH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.rect(50 + halfWidth + 20, detailsY, halfWidth, detailsH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = detailsY + detailsH + 10

    // Equipment / Weight / Commodity / Reference
    doc.fontSize(9).fillColor("#333333")
    const details = [
      load.equipment ? `Equipment: ${load.equipment}` : null,
      load.weight ? `Weight: ${load.weight}` : null,
      load.commodity ? `Commodity: ${load.commodity}` : null,
    ].filter(Boolean).join("  |  ")
    if (details) doc.text(details, 55)

    if (load.reference_number) {
      doc.text(`Reference: ${load.reference_number}`, 55)
    }
    doc.fillColor("#000000")
    doc.moveDown(1)

    // ── COMPENSATION ──
    const compY = doc.y
    doc.fontSize(8).fillColor("#999999").text("COMPENSATION", 60, compY + 10)
    doc.fillColor("#000000")
    const carrierCost = Number(load.carrier_cost) || 0
    doc.font("Helvetica-Bold").fontSize(14)
    doc.text(`Carrier Rate: $${carrierCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, 60, compY + 26)
    doc.font("Helvetica").fontSize(9)
    doc.text("Payment Terms: Net 30 days upon receipt of signed BOL and POD", 60, compY + 46)

    const compH = 64
    doc.rect(50, compY, pageWidth, compH).strokeColor("#dddddd").lineWidth(0.5).stroke()
    doc.y = compY + compH + 20

    // ── TERMS & CONDITIONS ──
    doc.fontSize(8).fillColor("#999999").text("TERMS & CONDITIONS")
    doc.moveDown(0.3)
    doc.fillColor("#333333").fontSize(8).font("Helvetica")
    doc.text(terms, { width: pageWidth, lineGap: 2 })
    doc.fillColor("#000000")
    doc.moveDown(1.5)

    // ── ACCEPTANCE ──
    doc.fontSize(9).text("By proceeding with this load, carrier accepts the terms and rate above.")
    doc.moveDown(1.5)
    doc.text("Signature: _________________________________    Date: _______________")
    doc.moveDown(1)
    doc.text("Printed Name: _________________________________")

    doc.end()
  })
}
