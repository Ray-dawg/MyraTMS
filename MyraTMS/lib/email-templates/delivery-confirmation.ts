/**
 * Delivery Confirmation email template with 5-star rating.
 * Table-based layout with inline styles for Gmail + Outlook compatibility.
 */

interface DeliveryConfirmationParams {
  loadRef: string
  origin: string
  destination: string
  deliveredAt: string
  podUrl: string
  ratingUrl: string
  recipientName?: string
  companyName?: string
}

export function buildDeliveryConfirmationHtml(params: DeliveryConfirmationParams): string {
  const {
    loadRef,
    origin,
    destination,
    deliveredAt,
    podUrl,
    ratingUrl,
    recipientName,
    companyName,
  } = params

  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const companyLine = companyName ? ` on behalf of ${companyName}` : ""

  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<td align="center" style="padding:0 4px;">` +
        `<a href="${ratingUrl}?stars=${n}" style="text-decoration:none;font-size:32px;color:${n <= 3 ? "#fbbf24" : "#f59e0b"};" title="${n} star${n > 1 ? "s" : ""}">&#9733;</a>` +
        `</td>`
    )
    .join("")

  return `<!DOCTYPE html>
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
        <p style="margin:0 0 24px;color:#3f3f46;font-size:14px;line-height:1.6;">
          Great news! Your shipment <strong style="color:#18181b;">${loadRef}</strong> has been delivered successfully.
        </p>

        <!-- Shipment Details Table -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:12px 16px;background:#fafafa;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:12px;font-weight:600;text-transform:uppercase;">Shipment Details</td>
          </tr>
          <tr>
            <td style="padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#71717a;font-size:13px;width:120px;">Load #</td>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#18181b;font-size:13px;font-weight:600;">${loadRef}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#71717a;font-size:13px;">Origin</td>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#18181b;font-size:13px;">${origin}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#71717a;font-size:13px;">Destination</td>
                  <td style="padding:10px 16px;border-bottom:1px solid #f4f4f5;color:#18181b;font-size:13px;">${destination}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;color:#71717a;font-size:13px;">Delivered</td>
                  <td style="padding:10px 16px;color:#18181b;font-size:13px;">${deliveredAt}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- POD Image -->
        <p style="margin:0 0 8px;color:#3f3f46;font-size:14px;font-weight:600;">Proof of Delivery</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td>
              <a href="${podUrl}" style="color:#3b82f6;font-size:13px;">
                <img src="${podUrl}" alt="Proof of Delivery" width="300" style="max-width:100%;border-radius:8px;border:1px solid #e4e4e7;display:block;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:6px;">
              <a href="${podUrl}" style="color:#3b82f6;font-size:12px;">View full POD image</a>
            </td>
          </tr>
        </table>

        <!-- Rating Section -->
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />
        <p style="margin:0 0 8px;color:#18181b;font-size:15px;font-weight:600;text-align:center;">
          How was your experience?
        </p>
        <p style="margin:0 0 16px;color:#71717a;font-size:13px;text-align:center;">
          Tap a star to rate this delivery
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
          <tr>
            ${stars}
          </tr>
        </table>

        <!-- CTA Button -->
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
          <tr>
            <td style="background:#e8601f;border-radius:8px;" align="center">
              <a href="${ratingUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                Rate This Delivery
              </a>
            </td>
          </tr>
        </table>

        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />

        <p style="margin:0;color:#a1a1aa;font-size:11px;line-height:1.5;">
          This delivery confirmation was sent by Myra AI${companyLine}.
          If you have questions about this shipment, please contact your broker directly.
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
</html>`
}
