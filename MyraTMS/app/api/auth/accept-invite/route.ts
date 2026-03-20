import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { hashPassword, createToken } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// GET — Validate an invite token (public)
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (!token) return apiError("token is required", 400)

  const sql = getDb()
  const rows = await sql`
    SELECT id, email, role, first_name, last_name, status, expires_at
    FROM user_invites
    WHERE token = ${token}
    LIMIT 1
  `

  if (rows.length === 0) {
    return apiError("Invalid invite token", 404)
  }

  const invite = rows[0]

  if (invite.status !== "pending") {
    return apiError("This invitation has already been used", 410)
  }

  if (new Date(invite.expires_at as string) < new Date()) {
    return apiError("This invitation has expired", 410)
  }

  return NextResponse.json({
    invite: {
      email: invite.email,
      role: invite.role,
      firstName: invite.first_name,
      lastName: invite.last_name,
    },
  })
}

// POST — Accept invite and create account (public)
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { token, firstName, lastName, password } = body

  if (!token || !firstName || !lastName || !password) {
    return apiError("token, firstName, lastName, and password are required", 400)
  }

  if (password.length < 6) {
    return apiError("Password must be at least 6 characters", 400)
  }

  const sql = getDb()

  // Validate invite
  const rows = await sql`
    SELECT id, email, role, status, expires_at
    FROM user_invites
    WHERE token = ${token}
    LIMIT 1
  `

  if (rows.length === 0) {
    return apiError("Invalid invite token", 404)
  }

  const invite = rows[0]

  if (invite.status !== "pending") {
    return apiError("This invitation has already been used", 410)
  }

  if (new Date(invite.expires_at as string) < new Date()) {
    return apiError("This invitation has expired", 410)
  }

  // Check if email already has an account
  const existing = await sql`SELECT id FROM users WHERE email = ${invite.email}`
  if (existing.length > 0) {
    return apiError("An account with this email already exists", 409)
  }

  // Create the user
  const userId = `usr_${Date.now().toString(36)}`
  const passwordHash = await hashPassword(password)

  await sql`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role, created_at)
    VALUES (
      ${userId},
      ${invite.email},
      ${passwordHash},
      ${firstName.trim()},
      ${lastName.trim()},
      ${invite.role},
      NOW()
    )
  `

  // Mark invite as accepted
  await sql`
    UPDATE user_invites
    SET status = 'accepted', accepted_at = NOW()
    WHERE id = ${invite.id}
  `

  // Auto-login: create JWT and set cookie
  const jwt = createToken({
    userId,
    email: invite.email as string,
    role: invite.role as string,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
  })

  const response = NextResponse.json({
    user: {
      id: userId,
      email: invite.email,
      role: invite.role,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
    },
  }, { status: 201 })

  response.cookies.set("auth-token", jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 24h
    path: "/",
  })

  return response
}
