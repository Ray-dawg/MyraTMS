import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"

export async function GET(req: NextRequest) {
  try {
    const user = getCurrentUser(req)
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
    const ctx = requireTenantContext(req)

    const scope = req.nextUrl.searchParams.get("scope")
    const key = req.nextUrl.searchParams.get("key")

    const rows = await withTenant(ctx.tenantId, async (client) => {
      if (scope === "global") {
        if (key) {
          const { rows } = await client.query(
            `SELECT settings_key, settings_value FROM settings
              WHERE user_id IS NULL AND settings_key = $1`,
            [key],
          )
          return rows
        }
        const { rows } = await client.query(
          `SELECT settings_key, settings_value FROM settings WHERE user_id IS NULL`,
        )
        return rows
      }
      if (key) {
        const { rows } = await client.query(
          `SELECT settings_key, settings_value FROM settings
            WHERE user_id = $1 AND settings_key = $2`,
          [user.userId, key],
        )
        return rows
      }
      const { rows } = await client.query(
        `SELECT settings_key, settings_value FROM settings WHERE user_id = $1`,
        [user.userId],
      )
      return rows
    })

    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      settings[row.settings_key] = row.settings_value
    }
    return NextResponse.json({ settings })
  } catch (error) {
    console.error("Get settings error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = getCurrentUser(req)
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
    const ctx = requireTenantContext(req)

    const body = await req.json()

    let entries: Array<{ key: string; value: unknown }> = []
    if (body.settings && typeof body.settings === "object") {
      entries = Object.entries(body.settings).map(([key, value]) => ({ key, value }))
    } else if (body.key !== undefined) {
      entries = [{ key: body.key, value: body.value }]
    } else {
      return NextResponse.json(
        { error: "Request must include { key, value } or { settings: { ... } }" },
        { status: 400 },
      )
    }

    const scope = body.scope

    const settings = await withTenant(ctx.tenantId, async (client) => {
      for (const entry of entries) {
        const valueJson = JSON.stringify(entry.value)
        if (scope === "global") {
          await client.query(
            `INSERT INTO settings (id, user_id, settings_key, settings_value, updated_at)
             VALUES (gen_random_uuid(), NULL, $1, $2::jsonb, NOW())
             ON CONFLICT (settings_key) WHERE user_id IS NULL
             DO UPDATE SET settings_value = $2::jsonb, updated_at = NOW()`,
            [entry.key, valueJson],
          )
        } else {
          await client.query(
            `INSERT INTO settings (id, user_id, settings_key, settings_value, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW())
             ON CONFLICT (user_id, settings_key)
             DO UPDATE SET settings_value = $3::jsonb, updated_at = NOW()`,
            [user.userId, entry.key, valueJson],
          )
        }
      }

      const { rows } =
        scope === "global"
          ? await client.query(
              `SELECT settings_key, settings_value FROM settings WHERE user_id IS NULL`,
            )
          : await client.query(
              `SELECT settings_key, settings_value FROM settings WHERE user_id = $1`,
              [user.userId],
            )

      const out: Record<string, unknown> = {}
      for (const row of rows) {
        out[row.settings_key] = row.settings_value
      }
      return out
    })

    return NextResponse.json({ settings })
  } catch (error) {
    console.error("Update settings error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
