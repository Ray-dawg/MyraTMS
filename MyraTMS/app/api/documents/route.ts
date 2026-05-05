import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const relatedTo = req.nextUrl.searchParams.get("relatedTo")
  const relatedType = req.nextUrl.searchParams.get("relatedType")
  const search = req.nextUrl.searchParams.get("search")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (relatedTo && relatedType) {
      const { rows } = await client.query(
        `SELECT * FROM documents
          WHERE related_to = $1 AND related_type = $2
          ORDER BY created_at DESC`,
        [relatedTo, relatedType],
      )
      return rows
    }
    if (search) {
      const like = `%${escapeLikeMeta(search)}%`
      const { rows } = await client.query(
        `SELECT * FROM documents
          WHERE name ILIKE $1 OR related_to ILIKE $1
          ORDER BY created_at DESC`,
        [like],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM documents ORDER BY created_at DESC`,
    )
    return rows
  })

  return NextResponse.json(rows)
}
