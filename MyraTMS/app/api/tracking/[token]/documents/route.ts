import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"
import { withCors } from "@/lib/cors"

/**
 * GET /api/tracking/[token]/documents
 * Public endpoint — no auth required. The token IS the auth.
 * Returns BOL, POD, and Invoice documents for the tracked load.
 * Never exposes Insurance, Contract, or Rate Confirmation documents.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const sql = getDb()

  // Validate tracking token
  const tokens = await sql`
    SELECT load_id, expires_at
    FROM tracking_tokens
    WHERE token = ${token}
    LIMIT 1
  `

  if (tokens.length === 0) {
    return apiError("Invalid or expired tracking token", 404)
  }

  const { load_id: loadId, expires_at } = tokens[0]

  if (expires_at && new Date(expires_at) < new Date()) {
    return apiError("Invalid or expired tracking token", 404)
  }

  // Fetch only public-safe document types
  const rows = await sql`
    SELECT id, name, type, upload_date, blob_url, file_size
    FROM documents
    WHERE related_to = ${loadId}
      AND related_type = 'Load'
      AND type IN ('BOL', 'POD', 'Invoice')
    ORDER BY upload_date DESC, created_at DESC
  `

  const documents = rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    uploadDate: r.upload_date,
    blobUrl: r.blob_url,
    fileSize: r.file_size,
  }))

  return withCors(NextResponse.json({ documents }), request)
}
