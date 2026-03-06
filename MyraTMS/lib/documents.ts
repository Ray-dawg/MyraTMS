import { getDb } from "@/lib/db"
import { del } from "@vercel/blob"

const ALLOWED_DOC_TYPES = ["BOL", "POD", "Rate Confirmation", "Insurance", "Contract", "Invoice"] as const
type DocType = (typeof ALLOWED_DOC_TYPES)[number]

interface AttachDocumentParams {
  loadId: string
  docType: DocType
  blobUrl: string
  fileName: string
  fileSize: number
  uploadedBy: string
  notes?: string
}

export async function attachDocument({ loadId, docType, blobUrl, fileName, fileSize, uploadedBy, notes }: AttachDocumentParams) {
  if (!ALLOWED_DOC_TYPES.includes(docType)) {
    throw new Error(`Invalid document type: ${docType}. Must be one of: ${ALLOWED_DOC_TYPES.join(", ")}`)
  }

  const sql = getDb()
  const id = `DOC-${Date.now().toString(36).toUpperCase()}`

  const rows = await sql`
    INSERT INTO documents (id, name, type, related_to, related_type, status, uploaded_by, blob_url, file_size)
    VALUES (${id}, ${fileName}, ${docType}, ${loadId}, 'Load', 'Pending Review', ${uploadedBy}, ${blobUrl}, ${fileSize})
    RETURNING *
  `

  return rows[0]
}

export async function getLoadDocuments(loadId: string) {
  const sql = getDb()
  const rows = await sql`
    SELECT * FROM documents WHERE related_to = ${loadId} AND related_type = 'Load' ORDER BY created_at DESC
  `
  return rows
}

export async function deleteDocument(docId: string) {
  const sql = getDb()

  const rows = await sql`SELECT blob_url FROM documents WHERE id = ${docId} LIMIT 1`
  if (rows.length === 0) {
    throw new Error("Document not found")
  }

  if (rows[0].blob_url) {
    try {
      await del(rows[0].blob_url)
    } catch {
      // Blob may already be deleted, continue with DB cleanup
    }
  }

  await sql`DELETE FROM documents WHERE id = ${docId}`
  return { success: true }
}
