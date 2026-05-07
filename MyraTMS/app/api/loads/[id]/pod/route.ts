import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { put } from "@vercel/blob"
import { attachDocument } from "@/lib/documents"
import { tenantBlobKey } from "@/lib/blob/tenant-paths"
import { createNotification } from "@/lib/notifications"
import { generateRatingToken } from "@/lib/rating-token"
import { buildDeliveryConfirmationHtml } from "@/lib/email-templates/delivery-confirmation"
import { sendGenericEmail } from "@/lib/email"
import nodemailer from "nodemailer"

async function sendFactoringEmail(load: Record<string, unknown>, invoiceId: string, podUrl: string) {
  const factoringEmail = process.env.FACTORING_EMAIL
  if (!factoringEmail) return false

  const host = process.env.SMTP_HOST
  const port = Number.parseInt(process.env.SMTP_PORT || "587")
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !user || !pass) return false

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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id: loadId } = await params

  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "File must be an image" }, { status: 400 })
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "File size must be less than 10MB" }, { status: 400 })
    }

    // Pre-fetch load + IDOR + reserve invoice id
    const pre = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, driver_id, reference_number, origin, destination, shipper_id, shipper_name,
                carrier_id, carrier_name, revenue, carrier_cost, status
           FROM loads WHERE id = $1 LIMIT 1`,
        [loadId],
      )
      if (rows.length === 0) return { notFound: true as const }
      const load = rows[0]
      if (user.role === "driver" && load.driver_id !== (user as unknown as { id: string }).id) {
        return { forbidden: true as const }
      }
      return { load }
    })

    if ("notFound" in pre) return NextResponse.json({ error: "Load not found" }, { status: 404 })
    if ("forbidden" in pre) return apiError("Forbidden", 403)

    const load = pre.load

    // Upload to Vercel Blob — namespaced under tenants/{tenantId}/pods/ per Phase 3.4
    const blobKey = tenantBlobKey(
      ctx.tenantId,
      "pods",
      `${loadId}-${Date.now()}-${file.name}`,
    )
    const blob = await put(blobKey, file, { access: "public", addRandomSuffix: false })

    // Update DB + create invoice
    const result = await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE loads
            SET pod_url = $1, status = 'Delivered', delivered_at = NOW(), updated_at = NOW()
          WHERE id = $2`,
        [blob.url, loadId],
      )

      const { rows: existingInvoices } = await client.query(
        `SELECT id FROM invoices WHERE load_id = $1 LIMIT 1`,
        [loadId],
      )

      let invoiceId: string
      let invoiceCreated = false
      if (existingInvoices.length === 0) {
        invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`
        await client.query(
          `INSERT INTO invoices (id, load_id, shipper_name, amount, status, issue_date, due_date, factoring_status)
           VALUES ($1, $2, $3, $4, 'Pending', CURRENT_DATE, CURRENT_DATE + 30, 'N/A')`,
          [invoiceId, loadId, load.shipper_name, load.revenue],
        )
        await client.query(
          `UPDATE loads SET status = 'Invoiced', updated_at = NOW() WHERE id = $1`,
          [loadId],
        )
        invoiceCreated = true
      } else {
        invoiceId = existingInvoices[0].id as string
      }

      return { invoiceId, invoiceCreated }
    })

    const { invoiceId, invoiceCreated } = result

    // Attach document via service
    const uploadedBy = `${user.firstName} ${user.lastName}`
    await attachDocument({
      tenantId: ctx.tenantId,
      loadId,
      docType: "POD",
      blobUrl: blob.url,
      fileName: file.name,
      fileSize: file.size,
      uploadedBy,
    })

    const refNum = load.reference_number || loadId
    const invoiceNote = invoiceCreated ? " — Invoice auto-generated" : ""

    await createNotification({
      tenantId: ctx.tenantId,
      type: "success",
      title: `POD Received — ${refNum}`,
      body: `${load.origin} → ${load.destination}${invoiceNote}`,
      link: `/loads/${loadId}`,
      loadId,
      userId: null,
    })

    if (load.carrier_name && load.carrier_id) {
      await createNotification({
        tenantId: ctx.tenantId,
        type: "info",
        title: `Rate Carrier — ${load.carrier_name}`,
        body: `Load ${refNum} delivered. How did ${load.carrier_name} perform?`,
        link: `/carriers/${load.carrier_id}?rate=true`,
        loadId,
        userId: null,
      })
    }

    sendFactoringEmail(load, invoiceId, blob.url).catch(() => {})

    // Fire-and-forget delivery confirmation email
    ;(async () => {
      try {
        if (!load.shipper_id) return

        const shipper = await withTenant(ctx.tenantId, async (client) => {
          const { rows: shipperRows } = await client.query(
            `SELECT contact_email, contact_name FROM shippers WHERE id = $1 LIMIT 1`,
            [load.shipper_id],
          )
          if (shipperRows.length === 0 || !shipperRows[0].contact_email) return null

          const { rows: settingsRows } = await client.query(
            `SELECT value FROM settings WHERE key = 'company_name' LIMIT 1`,
          )
          return {
            email: shipperRows[0].contact_email as string,
            contactName: shipperRows[0].contact_name as string | undefined,
            companyName: settingsRows.length > 0 ? (settingsRows[0].value as string) : "Myra Logistics",
          }
        })
        if (!shipper) return

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
          loadRef: refNum as string,
          origin: load.origin as string,
          destination: load.destination as string,
          deliveredAt,
          podUrl: blob.url,
          ratingUrl,
          recipientName: shipper.contactName,
          companyName: shipper.companyName,
        })

        await sendGenericEmail(shipper.email, `Delivery Confirmation — ${refNum}`, html)
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
    return NextResponse.json({ error: "Failed to upload POD" }, { status: 500 })
  }
}
