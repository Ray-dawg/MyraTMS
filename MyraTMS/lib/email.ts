// ---------------------------------------------------------------------------
// Email utility for MyraTMS
//
// Uses nodemailer when SMTP env vars are configured.
// Returns false gracefully if SMTP is not set up (dev/staging).
// ---------------------------------------------------------------------------

import nodemailer from "nodemailer"

function getTransporter(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT || "587")
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) {
    return null
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

/**
 * Send a tracking link email with Myra branding.
 * Returns true if sent, false if SMTP is not configured or send fails.
 */
export async function sendTrackingEmail(
  to: string,
  trackingUrl: string,
  loadNumber: string,
  recipientName?: string
): Promise<boolean> {
  const transporter = getTransporter()
  if (!transporter) {
    console.log("[email] SMTP not configured — skipping email send")
    return false
  }

  const fromEmail = process.env.FROM_EMAIL || "noreply@myralogistics.com"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <!-- Header -->
    <tr>
      <td style="background:#0f172a;padding:24px 32px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:12px;">
              <div style="width:32px;height:32px;background:#e8601f;border-radius:8px;display:inline-block;"></div>
            </td>
            <td>
              <span style="color:#ffffff;font-size:18px;font-weight:600;">Myra</span>
              <span style="color:#e8601f;font-size:18px;font-weight:600;"> AI</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
          ${greeting}
        </p>
        <p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;">
          Your shipment <strong style="color:#18181b;">${loadNumber}</strong> is being tracked in real time.
          Click the button below to view live location, ETA, and delivery status.
        </p>

        <!-- CTA Button -->
        <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
          <tr>
            <td style="background:#e8601f;border-radius:8px;">
              <a href="${trackingUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                Track Your Shipment
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 8px;color:#71717a;font-size:12px;">
          Or copy this link into your browser:
        </p>
        <p style="margin:0 0 24px;color:#3b82f6;font-size:12px;word-break:break-all;">
          <a href="${trackingUrl}" style="color:#3b82f6;">${trackingUrl}</a>
        </p>

        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />

        <p style="margin:0;color:#a1a1aa;font-size:11px;line-height:1.5;">
          This tracking link was sent by Myra AI on behalf of your freight broker.
          Location data refreshes every 15 minutes. For urgent inquiries, contact your broker directly.
        </p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:#fafafa;padding:16px 32px;border-top:1px solid #e4e4e7;">
        <p style="margin:0;color:#a1a1aa;font-size:10px;">
          &copy; ${new Date().getFullYear()} Myra AI, Inc. &mdash; Freight Brokerage
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()

  try {
    await transporter.sendMail({
      from: `"Myra AI" <${fromEmail}>`,
      to,
      subject: `Track Your Shipment — ${loadNumber}`,
      html,
    })
    return true
  } catch (err) {
    console.error("[email] Failed to send tracking email:", err)
    return false
  }
}

/**
 * Send a rate confirmation PDF to a carrier's contact email.
 * Returns true if sent, false if SMTP is not configured or send fails.
 */
export async function sendRateConfirmationEmail(
  to: string,
  carrierName: string,
  loadReference: string,
  pdfBuffer: Buffer
): Promise<boolean> {
  const transporter = getTransporter()
  if (!transporter) {
    console.log("[email] SMTP not configured — skipping rate confirmation email send")
    return false
  }

  const fromEmail = process.env.FROM_EMAIL || "noreply@myralogistics.com"

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#0f172a;padding:24px 32px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:12px;">
              <div style="width:32px;height:32px;background:#e8601f;border-radius:8px;display:inline-block;"></div>
            </td>
            <td>
              <span style="color:#ffffff;font-size:18px;font-weight:600;">Myra</span>
              <span style="color:#e8601f;font-size:18px;font-weight:600;"> AI</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
          Hi ${carrierName},
        </p>
        <p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;">
          Please find the attached rate confirmation for load <strong style="color:#18181b;">${loadReference}</strong>.
          Review the terms, sign, and return at your earliest convenience.
        </p>

        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />

        <p style="margin:0;color:#a1a1aa;font-size:11px;line-height:1.5;">
          This rate confirmation was sent by Myra AI on behalf of your freight broker.
          For questions, contact your broker directly.
        </p>
      </td>
    </tr>

    <tr>
      <td style="background:#fafafa;padding:16px 32px;border-top:1px solid #e4e4e7;">
        <p style="margin:0;color:#a1a1aa;font-size:10px;">
          &copy; ${new Date().getFullYear()} Myra AI, Inc. &mdash; Freight Brokerage
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()

  try {
    await transporter.sendMail({
      from: `"Myra AI" <${fromEmail}>`,
      to,
      subject: `Rate Confirmation — ${loadReference}`,
      html,
      attachments: [
        {
          filename: `RC-${loadReference}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    })
    return true
  } catch (err) {
    console.error("[email] Failed to send rate confirmation email:", err)
    return false
  }
}

/**
 * Send the shipper written-confirmation request (E2-04 M2). Subject line
 * carries the load id per the PRD's own linking requirement -- the IMAP
 * poller (M4) and the manual-reply fallback both parse it back out of a
 * shipper's reply subject when the confirm-link click path isn't used.
 * Attaches the shipper-side rate-con PDF (lib/shipper-rate-confirmation.ts)
 * and asks the shipper to do BOTH: click the confirm link, AND reply with
 * a signed copy for the paper trail.
 *
 * `nudge: true` sends the shorter 45-minute reminder variant instead of the
 * initial request -- same subject prefix so it threads with the original in
 * the shipper's inbox, same load-id token in the subject for IMAP matching.
 * Returns true if sent, false if SMTP is not configured or send fails.
 */
export async function sendShipperConfirmationRequestEmail(
  to: string,
  shipperContactName: string | null,
  loadId: string,
  confirmUrl: string,
  pdfBuffer: Buffer,
  opts: { nudge?: boolean } = {},
): Promise<boolean> {
  const transporter = getTransporter()
  if (!transporter) {
    console.log("[email] SMTP not configured — skipping shipper confirmation email send")
    return false
  }

  const fromEmail = process.env.FROM_EMAIL || "noreply@myralogistics.com"
  const greeting = shipperContactName ? `Hi ${shipperContactName},` : "Hello,"
  const subject = opts.nudge
    ? `Reminder: Rate Confirmation Needed — Load ${loadId}`
    : `Rate Confirmation Needed — Load ${loadId}`
  const intro = opts.nudge
    ? `Just a reminder — we still need your written confirmation on load <strong style="color:#18181b;">${loadId}</strong> before we can move forward with carrier dispatch.`
    : `Your load <strong style="color:#18181b;">${loadId}</strong> has been booked at the rate discussed on the call. Before we dispatch a carrier, we need your written confirmation.`

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#0f172a;padding:24px 32px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:12px;">
              <div style="width:32px;height:32px;background:#e8601f;border-radius:8px;display:inline-block;"></div>
            </td>
            <td>
              <span style="color:#ffffff;font-size:18px;font-weight:600;">Myra</span>
              <span style="color:#e8601f;font-size:18px;font-weight:600;"> AI</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
          ${greeting}
        </p>
        <p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;">
          ${intro}
        </p>

        <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
          <tr>
            <td style="background:#e8601f;border-radius:8px;">
              <a href="${confirmUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                Confirm This Load
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 16px;color:#3f3f46;font-size:13px;line-height:1.6;">
          The attached PDF has the full agreed terms for your records. After confirming, please also
          reply to this email with a signed copy for our files.
        </p>

        <p style="margin:0 0 8px;color:#71717a;font-size:12px;">
          Or copy this link into your browser:
        </p>
        <p style="margin:0 0 24px;color:#3b82f6;font-size:12px;word-break:break-all;">
          <a href="${confirmUrl}" style="color:#3b82f6;">${confirmUrl}</a>
        </p>

        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />

        <p style="margin:0;color:#a1a1aa;font-size:11px;line-height:1.5;">
          Sent by Myra AI on behalf of your freight broker. For urgent questions, contact your broker directly.
        </p>
      </td>
    </tr>

    <tr>
      <td style="background:#fafafa;padding:16px 32px;border-top:1px solid #e4e4e7;">
        <p style="margin:0;color:#a1a1aa;font-size:10px;">
          &copy; ${new Date().getFullYear()} Myra AI, Inc. &mdash; Freight Brokerage
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()

  try {
    await transporter.sendMail({
      from: `"Myra AI" <${fromEmail}>`,
      to,
      subject,
      html,
      attachments: [
        {
          filename: `rate-confirmation-${loadId}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    })
    return true
  } catch (err) {
    console.error("[email] Failed to send shipper confirmation request email:", err)
    return false
  }
}

/**
 * Send a generic HTML email.
 * Returns true if sent, false if SMTP is not configured or send fails.
 */
export async function sendGenericEmail(
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  const transporter = getTransporter()
  if (!transporter) {
    console.log("[email] SMTP not configured — skipping generic email send")
    return false
  }

  const fromEmail = process.env.FROM_EMAIL || "noreply@myralogistics.com"

  try {
    await transporter.sendMail({
      from: `"Myra AI" <${fromEmail}>`,
      to,
      subject,
      html,
    })
    return true
  } catch (err) {
    console.error("[email] Failed to send generic email:", err)
    return false
  }
}
