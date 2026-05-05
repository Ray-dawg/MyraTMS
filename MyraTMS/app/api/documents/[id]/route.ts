import { NextRequest, NextResponse } from "next/server"
import { requireTenantContext } from "@/lib/auth"
import { deleteDocument } from "@/lib/documents"

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params

  try {
    const result = await deleteDocument(ctx.tenantId, id)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof Error && err.message === "Document not found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    throw err
  }
}
