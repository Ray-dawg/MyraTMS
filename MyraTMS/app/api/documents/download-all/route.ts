import { NextRequest, NextResponse } from "next/server"
import { PassThrough } from "stream"
import archiver from "archiver"
import { requireTenantContext } from "@/lib/auth"
import { getLoadDocuments } from "@/lib/documents"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const loadId = req.nextUrl.searchParams.get("loadId")
  if (!loadId) {
    return NextResponse.json({ error: "loadId is required" }, { status: 400 })
  }

  const docs = await getLoadDocuments(ctx.tenantId, loadId)
  if (docs.length === 0) {
    return NextResponse.json({ error: "No documents found for this load" }, { status: 404 })
  }

  const passthrough = new PassThrough()
  const archive = archiver("zip", { zlib: { level: 5 } })
  archive.pipe(passthrough)

  for (const doc of docs) {
    if (!doc.blob_url) continue
    try {
      const res = await fetch(doc.blob_url)
      if (!res.ok) continue
      const buffer = Buffer.from(await res.arrayBuffer())
      archive.append(buffer, { name: doc.name || `document-${doc.id}` })
    } catch {
      // Skip documents that fail to download
    }
  }

  archive.finalize()

  const stream = new ReadableStream({
    start(controller) {
      passthrough.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      passthrough.on("end", () => {
        controller.close()
      })
      passthrough.on("error", (err) => {
        controller.error(err)
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="load-${loadId}-documents.zip"`,
    },
  })
}
