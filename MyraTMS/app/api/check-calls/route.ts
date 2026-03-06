import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

/**
 * GET /api/check-calls?load_id=xxx
 * Auth-gated. Returns check-calls for a load, ordered by created_at DESC.
 */
export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) {
    return apiError("Unauthorized", 401)
  }

  const loadId = request.nextUrl.searchParams.get("load_id")

  let rows
  if (loadId) {
    rows = await getDb()`
      SELECT * FROM check_calls
      WHERE load_id = ${loadId}
      ORDER BY created_at DESC
    `
  } else {
    rows = await getDb()`
      SELECT * FROM check_calls
      ORDER BY created_at DESC
      LIMIT 100
    `
  }

  return NextResponse.json(rows)
}

/**
 * POST /api/check-calls
 * Auth-gated. Create a new check-call entry.
 * Body: { loadId, location, status, notes, nextCheckCall }
 *
 * Also creates a corresponding load_event (event_type: 'check_call').
 */
export async function POST(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) {
    return apiError("Unauthorized", 401)
  }

  const body = await request.json()
  const { loadId, location, status, notes, nextCheckCall } = body

  if (!loadId) {
    return apiError("loadId is required", 400)
  }

  const sql = getDb()

  // Verify load exists
  const loads = await sql`SELECT id FROM loads WHERE id = ${loadId} LIMIT 1`
  if (loads.length === 0) {
    return apiError("Load not found", 404)
  }

  const checkCallId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const createdBy = `${user.firstName} ${user.lastName}`

  // INSERT check-call
  await sql`
    INSERT INTO check_calls (id, load_id, location, status, notes, next_check_call, created_by)
    VALUES (
      ${checkCallId},
      ${loadId},
      ${location || null},
      ${status || null},
      ${notes || null},
      ${nextCheckCall || null},
      ${createdBy}
    )
  `

  // INSERT load_event for the check-call
  await sql`
    INSERT INTO load_events (id, load_id, event_type, status, location, note)
    VALUES (
      ${eventId},
      ${loadId},
      'check_call',
      ${status || 'Check Call'},
      ${location || null},
      ${notes || null}
    )
  `

  // Fetch and return the created check-call
  const created = await sql`
    SELECT * FROM check_calls WHERE id = ${checkCallId} LIMIT 1
  `

  return NextResponse.json(created[0], { status: 201 })
}
