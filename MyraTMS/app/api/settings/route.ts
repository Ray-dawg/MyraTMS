import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"

export async function GET(req: NextRequest) {
  try {
    const user = getCurrentUser(req)

    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const sql = getDb()
    const rows = await sql`
      SELECT settings_key, settings_value
      FROM settings
      WHERE user_id = ${user.userId}
    `

    // Build a { key: value } object from rows
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      settings[row.settings_key] = row.settings_value
    }

    return NextResponse.json({ settings })
  } catch (error) {
    console.error("Get settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = getCurrentUser(req)

    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const body = await req.json()
    const sql = getDb()

    // Support both single { key, value } and batch { settings: { key: value, ... } }
    let entries: Array<{ key: string; value: unknown }> = []

    if (body.settings && typeof body.settings === "object") {
      // Batch mode
      entries = Object.entries(body.settings).map(([key, value]) => ({
        key,
        value,
      }))
    } else if (body.key !== undefined) {
      // Single mode
      entries = [{ key: body.key, value: body.value }]
    } else {
      return NextResponse.json(
        { error: "Request must include { key, value } or { settings: { ... } }" },
        { status: 400 }
      )
    }

    // Upsert each setting
    for (const entry of entries) {
      await sql`
        INSERT INTO settings (id, user_id, settings_key, settings_value, updated_at)
        VALUES (gen_random_uuid(), ${user.userId}, ${entry.key}, ${JSON.stringify(entry.value)}::jsonb, NOW())
        ON CONFLICT (user_id, settings_key)
        DO UPDATE SET settings_value = ${JSON.stringify(entry.value)}::jsonb, updated_at = NOW()
      `
    }

    // Return all settings for the user
    const rows = await sql`
      SELECT settings_key, settings_value
      FROM settings
      WHERE user_id = ${user.userId}
    `

    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      settings[row.settings_key] = row.settings_value
    }

    return NextResponse.json({ settings })
  } catch (error) {
    console.error("Update settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
