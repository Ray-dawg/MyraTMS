import { NextRequest, NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { getCurrentUser } from "@/lib/auth"
import { attachDocument } from "@/lib/documents"

export async function POST(request: NextRequest) {
  try {
    const user = getCurrentUser(request)
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const formData = await request.formData()
    const file = formData.get("file") as File
    const docType = (formData.get("type") as string) || "BOL"
    const relatedTo = formData.get("relatedTo") as string
    const relatedType = (formData.get("relatedType") as string) || "Load"

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })

    const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"]
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: "File type not allowed. Accepted: PDF, PNG, JPG, XLSX, CSV" }, { status: 400 })
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "File size exceeds 10MB limit" }, { status: 400 })
    }

    const blob = await put(`myra-tms/${relatedType.toLowerCase()}/${relatedTo}/${file.name}`, file, {
      access: "public",
    })

    const uploadedBy = `${user.firstName || ""} ${user.lastName || ""}`.trim()

    const doc = await attachDocument({
      loadId: relatedTo || "",
      docType: docType as any,
      blobUrl: blob.url,
      fileName: file.name,
      fileSize: file.size,
      uploadedBy,
    })

    return NextResponse.json({
      id: doc.id,
      name: doc.name,
      url: blob.url,
      size: file.size,
      type: docType,
    }, { status: 201 })
  } catch (error) {
    console.error("Upload error:", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
