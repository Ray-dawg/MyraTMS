import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function PATCH(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()

  await sql`
    UPDATE notifications SET read = true
    WHERE read = false
      AND (user_id = ${user.userId} OR user_id IS NULL)
  `

  return NextResponse.json({ success: true })
}
