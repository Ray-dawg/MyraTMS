import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { put } from "@vercel/blob"
import { attachDocument } from "@/lib/documents"
import { createNotification } from "@/lib/notifications"
import { generateRatingToken } from "@/lib/rating-token"
import { buildDeliveryConfirmationHtml } from "@/lib/email-templates/delivery-confirmation"
import { sendGenericEmail } from "@/lib/email"
import nodemailer from "nodemailer"

async function sendFactoringEmail(load: Record<string, unknown>, invoiceId: string, podUrl: string) {
  const factoringEmail = process.env.FACTORING_EMAIL
  if (!factoringEmail) {
    console.log("[factoring] FACTORING_EMAIL not configured — skipping")
    return false
  }

  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT || "587")
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) {
    console.log("[factoring] SMTP not configured — skipping factoring email")
    return false
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })

  const fromEmail = process.env.FROM_EMAIL || "noreply@myralogistics.com"
  const refNum = load.reference_number || load.id

  try {
    await transporter.sendMail({
      from: `"Myra AI" <${fromEmail}>`,
      to: factoringEmail,
      subject: `New POD Ready for Factoring — ${refNum}`,
      text: [
        `Load: ${refNum}`,
        `Shipper: ${load.shipper_name}`,
        `Route: ${load.origin} → ${load.destination}`,
        `Invoice Amount: $${Number(load.revenue).toLocaleString()}`,
        `POD Document: ${podUrl}`,
        `Invoice ID: ${invoiceId}`,
      ].join("\n"),
    })
    return true
  } catch (err) {
    console.error("[factoring] Failed to send factoring email:", err)
    return false
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id: loadId } = await params

  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      )
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "File must be an image" },
        { status: 400 }
      )
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size must be less than 10MB" },
        { status: 400 }
      )
    }

    const sql = getDb()

    // Fetch full load details
    const loads = await sql`
      SELECT id, driver_id, reference_number, origin, destination, shipper_id, shipper_name,
             carrier_id, carrier_name, revenue, carrier_cost, status
      FROM loads WHERE id = ${loadId} LIMIT 1
    `
    if (loads.length === 0) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    const load = loads[0]

    // IDOR check: only the assigned driver may upload POD
    if (user.role === "driver" && load.driver_id !== user.id) {
      return apiError("Forbidden", 403)
    }

    // Upload to Vercel Blob
    const filename = `pod/${loadId}/${Date.now()}-${file.name}`
    const blob = await put(filename, file, {
      access: "public",
      addRandomSuffix: false,
    })

    // Update load: set POD URL, status to Delivered, delivered_at to now
    await sql`
      UPDATE loads
      SET pod_url = ${blob.url},
          status = 'Delivered',
          delivered_at = NOW(),
          updated_at = NOW()
      WHERE id = ${loadId}
    `

    // Attach document record via service
    const uploadedBy = `${user.firstName} ${user.lastName}`
    await attachDocument({
      loadId,
      docType: "POD",
      blobUrl: blob.url,
      fileName: file.name,
      fileSize: file.size,
      uploadedBy,
    })

    // Auto-create invoice if one doesn't already exist
    let invoiceId: string | null = null
    let invoiceCreated = false

    const existingInvoices = await sql`
      SELECT id FROM invoices WHERE load_id = ${loadId} LIMIT 1
    `

    if (existingInvoices.length === 0) {
      invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`

      await sql`
        INSERT INTO invoices (id, load_id, shipper_name, amount, status, issue_date, due_date, factoring_status)
        VALUES (
          ${invoiceId},
          ${loadId},
          ${load.shipper_name},
          ${load.revenue},
          'Pending',
          CURRENT_DATE,
          CURRENT_DATE + 30,
          'N/A'
        )
      `

      // Update load status to Invoiced
      await sql`
        UPDATE loads SET status = 'Invoiced', updated_at = NOW()
        WHERE id = ${loadId}
      `

      invoiceCreated = true
    } else {
      invoiceId = existingInvoices[0].id as string
    }

    // Send POD received notification (broadcast)
    const refNum = load.reference_number || loadId
    const invoiceNote = invoiceCreated ? " — Invoice auto-generated" : ""

    await createNotification({
      type: "success",
      title: `POD Received — ${refNum}`,
      body: `${load.origin} → ${load.destination}${invoiceNote}`,
      link: `/loads/${loadId}`,
      loadId,
      userId: null,
    })

    // Send carrier rating prompt notification (broadcast)
    if (load.carrier_name && load.carrier_id) {
      await createNotification({
        type: "info",
        title: `Rate Carrier — ${load.carrier_name}`,
        body: `Load ${refNum} delivered. How did ${load.carrier_name} perform?`,
        link: `/carriers/${load.carrier_id}?rate=true`,
        loadId,
        userId: null,
      })
    }

    // Send factoring email (non-blocking, logs skip if not configured)
    sendFactoringEmail(load, invoiceId, blob.url).catch(() => {
      // Already logged inside the function
    })

    // Send delivery confirmation email to shipper (fire-and-forget)
    ;(async () => {
      try {
        if (!load.shipper_id) return

        const shipperRows = await sql`
          SELECT contact_email, contact_name FROM shippers WHERE id = ${load.shipper_id} LIMIT 1
        `
        if (shipperRows.length === 0 || !shipperRows[0].contact_email) return

        const shipperEmail = shipperRows[0].contact_email as string
        const shipperContactName = shipperRows[0].contact_name as string | undefined

        // Get company name from settings
        const settingsRows = await sql`
          SELECT value FROM settings WHERE key = 'company_name' LIMIT 1
        `
        const companyName = settingsRows.length > 0
          ? (settingsRows[0].value as string)
          : "Myra Logistics"

        const ratingToken = generateRatingToken(loadId, load.shipper_id as string)
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
        const ratingUrl = `${baseUrl}/rate/${ratingToken}`

        const deliveredAt = new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })

        const html = buildDeliveryConfirmationHtml({
          loadRef: refNum,
          origin: load.origin as string,
          destination: load.destination as string,
          deliveredAt,
          podUrl: blob.url,
          ratingUrl,
          recipientName: shipperContactName,
          companyName,
        })

        await sendGenericEmail(
          shipperEmail,
          `Delivery Confirmation — ${refNum}`,
          html
        )
      } catch (err) {
        console.error("[pod] Failed to send delivery confirmation email:", err)
      }
    })()

    return NextResponse.json({
      podUrl: blob.url,
      status: invoiceCreated ? "Invoiced" : "Delivered",
      invoiceId,
      invoiceCreated,
      notificationSent: true,
    })
  } catch (error) {
    console.error("POD upload error:", error)
    return NextResponse.json(
      { error: "Failed to upload POD" },
      { status: 500 }
    )
  }
}
