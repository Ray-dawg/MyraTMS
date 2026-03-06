import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser, hashPassword, comparePassword } from "@/lib/auth"

export async function GET(req: NextRequest) {
  try {
    const currentUser = getCurrentUser(req)

    if (!currentUser) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const sql = getDb()
    const rows = await sql`
      SELECT id, email, first_name, last_name, phone, role, avatar_url
      FROM users
      WHERE id = ${currentUser.userId}
    `

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      )
    }

    const user = rows[0]

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    })
  } catch (error) {
    console.error("Get current user error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const currentUser = getCurrentUser(req)

    if (!currentUser) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      )
    }

    const body = await req.json()
    const sql = getDb()

    // Fetch current user data
    const existingRows = await sql`
      SELECT id, email, first_name, last_name, phone, role, avatar_url, password_hash
      FROM users
      WHERE id = ${currentUser.userId}
    `

    if (existingRows.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      )
    }

    const existing = existingRows[0]

    // Handle password change
    if (body.currentPassword && body.newPassword) {
      const isValid = await comparePassword(
        body.currentPassword,
        existing.password_hash
      )

      if (!isValid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 400 }
        )
      }

      const newHash = await hashPassword(body.newPassword)
      await sql`
        UPDATE users SET password_hash = ${newHash}, updated_at = NOW()
        WHERE id = ${currentUser.userId}
      `
    }

    // Handle profile field updates - merge provided values with existing
    const { firstName, lastName, phone, avatarUrl } = body
    const hasProfileUpdates =
      firstName !== undefined ||
      lastName !== undefined ||
      phone !== undefined ||
      avatarUrl !== undefined

    if (hasProfileUpdates) {
      const newFirstName = firstName !== undefined ? firstName : existing.first_name
      const newLastName = lastName !== undefined ? lastName : existing.last_name
      const newPhone = phone !== undefined ? phone : existing.phone
      const newAvatarUrl = avatarUrl !== undefined ? avatarUrl : existing.avatar_url

      await sql`
        UPDATE users
        SET first_name = ${newFirstName},
            last_name = ${newLastName},
            phone = ${newPhone},
            avatar_url = ${newAvatarUrl},
            updated_at = NOW()
        WHERE id = ${currentUser.userId}
      `
    }

    // Fetch and return updated user
    const rows = await sql`
      SELECT id, email, first_name, last_name, phone, role, avatar_url
      FROM users
      WHERE id = ${currentUser.userId}
    `

    const user = rows[0]

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    })
  } catch (error) {
    console.error("Update user error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
