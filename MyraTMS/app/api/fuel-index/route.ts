import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { LEGACY_DEFAULT_TENANT_ID, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// fuel_index is a global (non-tenant-scoped) reference table — see migration
// 029. We still use withTenant for connection acquisition, with the tenant
// context defaulted to the active session's tenant on writes (audit trail).

export async function GET() {
  try {
    const rows = await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM fuel_index ORDER BY effective_date DESC LIMIT 20`,
      )
      return rows
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[fuel-index GET] error:", err)
    return apiError("Failed to fetch fuel index", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const body = await req.json()
    if (!body.pricePerLitre || !body.effectiveDate) {
      return apiError("pricePerLitre and effectiveDate are required", 400)
    }

    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO fuel_index (source, price_per_litre, region, effective_date)
         VALUES ($1, $2, $3, $4)`,
        [
          body.source || "manual",
          body.pricePerLitre,
          body.region || "Ontario",
          body.effectiveDate,
        ],
      )
    })

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error("[fuel-index POST] error:", err)
    return apiError("Failed to add fuel price", 500)
  }
}
