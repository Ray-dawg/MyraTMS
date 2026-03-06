import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const sql = getDb()

  await sql`
    UPDATE notifications SET read = true
    WHERE id = ${id}
      AND (user_id = ${user.userId} OR user_id IS NULL)
  `

  return NextResponse.json({ success: true })
}
