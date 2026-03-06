import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import crypto from "crypto"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id: loadId } = await params
  const sql = getDb()

  const rows = await sql`
    SELECT * FROM load_events
    WHERE load_id = ${loadId}
    ORDER BY created_at DESC
  `

  return NextResponse.json(rows)
}

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
    const body = await req.json()
    const { event_type, status, location, note } = body

    if (!event_type) {
      return NextResponse.json(
        { error: "event_type is required" },
        { status: 400 }
      )
    }

    const sql = getDb()
    const id = crypto.randomUUID()

    await sql`
      INSERT INTO load_events (id, load_id, event_type, status, location, note, created_by, created_at)
      VALUES (${id}, ${loadId}, ${event_type}, ${status || null}, ${location || null}, ${note || null}, ${user.userId}, now())
    `

    return NextResponse.json({ id, loadId, event_type, status, note }, { status: 201 })
  } catch (error) {
    console.error("Create load event error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
