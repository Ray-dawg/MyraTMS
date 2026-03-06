import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const search = req.nextUrl.searchParams.get("search")

  let rows
  if (search) {
    rows = await sql`SELECT * FROM carriers WHERE company ILIKE ${"%" + search + "%"} OR mc_number ILIKE ${"%" + search + "%"} OR id ILIKE ${"%" + search + "%"} ORDER BY created_at DESC`
  } else {
    rows = await sql`SELECT * FROM carriers ORDER BY created_at DESC`
  }

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const sql = getDb()
  const id = `CAR-${Date.now().toString(36).toUpperCase()}`

  await sql`
    INSERT INTO carriers (id, company, mc_number, dot_number, contact_name, contact_phone, lanes_covered, authority_status, insurance_expiry, liability_insurance, cargo_insurance, safety_rating)
    VALUES (${id}, ${body.company}, ${body.mcNumber || ""}, ${body.dotNumber || ""}, ${body.contactName || ""}, ${body.contactPhone || ""}, ${body.lanesCovered || []}, ${body.authorityStatus || "Active"}, ${body.insuranceExpiry || null}, ${body.liabilityInsurance || 0}, ${body.cargoInsurance || 0}, ${body.safetyRating || "Not Rated"})
  `

  return NextResponse.json({ id }, { status: 201 })
}
