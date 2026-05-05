import { withTenant } from "@/lib/db/tenant-context"
import { del } from "@vercel/blob"

const ALLOWED_DOC_TYPES = ["BOL", "POD", "Rate Confirmation", "Insurance", "Contract", "Invoice"] as const
type DocType = (typeof ALLOWED_DOC_TYPES)[number]

interface AttachDocumentParams {
  tenantId: number
  loadId: string
  docType: DocType
  blobUrl: string
  fileName: string
  fileSize: number
  uploadedBy: string
  notes?: string
}

export async function attachDocument({
  tenantId,
  loadId,
  docType,
  blobUrl,
  fileName,
  fileSize,
  uploadedBy,
}: AttachDocumentParams) {
  if (!ALLOWED_DOC_TYPES.includes(docType)) {
    throw new Error(`Invalid document type: ${docType}. Must be one of: ${ALLOWED_DOC_TYPES.join(", ")}`)
  }

  const id = `DOC-${Date.now().toString(36).toUpperCase()}`

  const row = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO documents (id, name, type, related_to, related_type, status, uploaded_by, blob_url, file_size)
       VALUES ($1, $2, $3, $4, 'Load', 'Pending Review', $5, $6, $7)
       RETURNING *`,
      [id, fileName, docType, loadId, uploadedBy, blobUrl, fileSize],
    )
    return rows[0]
  })

  return row
}

export async function getLoadDocuments(tenantId: number, loadId: string) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM documents
        WHERE related_to = $1 AND related_type = 'Load'
        ORDER BY created_at DESC`,
      [loadId],
    )
    return rows
  })
}

export async function deleteDocument(tenantId: number, docId: string) {
  const blobUrl = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT blob_url FROM documents WHERE id = $1 LIMIT 1`,
      [docId],
    )
    if (rows.length === 0) {
      throw new Error("Document not found")
    }
    return rows[0].blob_url as string | null
  })

  if (blobUrl) {
    try {
      await del(blobUrl)
    } catch {
      // Blob may already be deleted, continue with DB cleanup
    }
  }

  await withTenant(tenantId, async (client) => {
    await client.query(`DELETE FROM documents WHERE id = $1`, [docId])
  })

  return { success: true }
}
