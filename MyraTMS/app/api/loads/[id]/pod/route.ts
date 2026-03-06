import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { put } from "@vercel/blob"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id: loadId } = await params

  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      )
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "File must be an image" },
        { status: 400 }
      )
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size must be less than 10MB" },
        { status: 400 }
      )
    }

    const sql = getDb()

    // Verify load exists
    const loads = await sql`SELECT id, status FROM loads WHERE id = ${loadId} LIMIT 1`
    if (loads.length === 0) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    // Upload to Vercel Blob
    const filename = `pod/${loadId}/${Date.now()}-${file.name}`
    const blob = await put(filename, file, {
      access: "public",
      addRandomSuffix: false,
    })

    // Update load with POD URL and mark as delivered
    await sql`
      UPDATE loads
      SET pod_url = ${blob.url},
          status = 'Delivered',
          updated_at = now()
      WHERE id = ${loadId}
    `

    // Insert document record for audit trail
    const timestamp = Date.now().toString(36).toUpperCase()
    const docId = `DOC-${timestamp}`
    const uploadedBy = `${user.firstName} ${user.lastName}`

    await sql`
      INSERT INTO documents (id, name, type, related_to, related_type, blob_url, uploaded_by, upload_date)
      VALUES (${docId}, ${filename}, 'POD', ${loadId}, 'Load', ${blob.url}, ${uploadedBy}, now())
    `

    return NextResponse.json({
      podUrl: blob.url,
      status: "Delivered",
    })
  } catch (error) {
    console.error("POD upload error:", error)
    return NextResponse.json(
      { error: "Failed to upload POD" },
      { status: 500 }
    )
  }
}
