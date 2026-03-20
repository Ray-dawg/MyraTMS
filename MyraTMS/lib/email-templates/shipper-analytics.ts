/**
 * Monthly Shipper Analytics Report email template.
 * Table-based layout with inline styles for Gmail + Outlook compatibility.
 */

interface TopCarrier {
  name: string
  count: number
}

interface ShipperAnalyticsParams {
  companyName: string
  shipperName: string
  contactName?: string
  periodLabel: string
  totalLoads: number
  onTimePct: number
  avgTransitDays: number | null
  totalSpend: number
  topCarriers: TopCarrier[]
}

export function buildShipperAnalyticsHtml(params: ShipperAnalyticsParams): string {
  const {
    companyName,
    shipperName,
    contactName,
    periodLabel,
    totalLoads,
    onTimePct,
    avgTransitDays,
    totalSpend,
    topCarriers,
  } = params

  const greeting = contactName ? `Hi ${contactName},` : `Hi ${shipperName},`
  const formattedSpend = totalSpend.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
  const transitDisplay = avgTransitDays !== null ? `${avgTransitDays.toFixed(1)}` : "N/A"
  const onTimeDisplay = `${Math.round(onTimePct)}%`

  const carrierRows = topCarriers
    .map(
      (c, i) =>
        `<tr>
          <td style="padding:8px 16px;border-bottom:1px solid #f4f4f5;color:#71717a;font-size:13px;width:32px;">${i + 1}.</td>
          <td style="padding:8px 16px;border-bottom:1px solid #f4f4f5;color:#18181b;font-size:13px;">${c.name}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #f4f4f5;color:#71717a;font-size:13px;text-align:right;">${c.count} load${c.count !== 1 ? "s" : ""}</td>
        </tr>`
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
          Here is your shipping performance summary for <strong style="color:#18181b;">${periodLabel}</strong> with ${companyName}.
        </p>

        <!-- KPI Grid: 2x2 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td width="50%" style="padding:0 6px 12px 0;vertical-align:top;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border-radius:8px;border:1px solid #bae6fd;">
                <tr>
                  <td style="padding:16px;text-align:center;">
                    <p style="margin:0 0 4px;color:#0369a1;font-size:11px;font-weight:600;text-transform:uppercase;">Total Loads</p>
                    <p style="margin:0;color:#0c4a6e;font-size:28px;font-weight:700;">${totalLoads}</p>
                  </td>
                </tr>
              </table>
            </td>
            <td width="50%" style="padding:0 0 12px 6px;vertical-align:top;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
                <tr>
                  <td style="padding:16px;text-align:center;">
                    <p style="margin:0 0 4px;color:#15803d;font-size:11px;font-weight:600;text-transform:uppercase;">On-Time %</p>
                    <p style="margin:0;color:#14532d;font-size:28px;font-weight:700;">${onTimeDisplay}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td width="50%" style="padding:0 6px 0 0;vertical-align:top;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fefce8;border-radius:8px;border:1px solid #fde68a;">
                <tr>
                  <td style="padding:16px;text-align:center;">
                    <p style="margin:0 0 4px;color:#a16207;font-size:11px;font-weight:600;text-transform:uppercase;">Avg Transit Days</p>
                    <p style="margin:0;color:#713f12;font-size:28px;font-weight:700;">${transitDisplay}</p>
                  </td>
                </tr>
              </table>
            </td>
            <td width="50%" style="padding:0 0 0 6px;vertical-align:top;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf2f8;border-radius:8px;border:1px solid #fbcfe8;">
                <tr>
                  <td style="padding:16px;text-align:center;">
                    <p style="margin:0 0 4px;color:#be185d;font-size:11px;font-weight:600;text-transform:uppercase;">Total Spend</p>
                    <p style="margin:0;color:#831843;font-size:28px;font-weight:700;">${formattedSpend}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        ${
          topCarriers.length > 0
            ? `<!-- Top Carriers -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
          <tr>
            <td colspan="3" style="padding:12px 16px;background:#fafafa;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:12px;font-weight:600;text-transform:uppercase;">Top Carriers</td>
          </tr>
          ${carrierRows}
        </table>`
            : ""
        }

        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />

        <p style="margin:0;color:#a1a1aa;font-size:11px;line-height:1.5;">
          This monthly report was generated by Myra AI on behalf of ${companyName}.
          For questions or discrepancies, please contact your account representative.
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
