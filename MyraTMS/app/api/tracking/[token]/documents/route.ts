import { NextRequest, NextResponse } from "next/server"
import { withTenant, resolveTrackingToken } from "@/lib/db/tenant-context"
import { apiError } from "@/lib/api-error"
import { withCors } from "@/lib/cors"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const resolved = await resolveTrackingToken(token)
  if (!resolved) return apiError("Invalid or expired tracking token", 404)

  const documents = await withTenant(resolved.tenantId, async (client) => {
    const { rows: tokens } = await client.query(
      `SELECT load_id, expires_at FROM tracking_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )
    if (tokens.length === 0) return null
    if (tokens[0].expires_at && new Date(tokens[0].expires_at) < new Date()) return null

    const { rows } = await client.query(
      `SELECT id, name, type, upload_date, blob_url, file_size
         FROM documents
        WHERE related_to = $1
          AND related_type = 'Load'
          AND type IN ('BOL', 'POD', 'Invoice')
        ORDER BY upload_date DESC, created_at DESC`,
      [tokens[0].load_id],
    )
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      uploadDate: r.upload_date,
      blobUrl: r.blob_url,
      fileSize: r.file_size,
    }))
  })

  if (!documents) return apiError("Invalid or expired tracking token", 404)

  return withCors(NextResponse.json({ documents }), request)
}
