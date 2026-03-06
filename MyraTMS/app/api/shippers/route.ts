import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const search = req.nextUrl.searchParams.get("search")

  let rows
  if (search) {
    rows = await sql`SELECT * FROM shippers WHERE company ILIKE ${"%" + search + "%"} OR contact_name ILIKE ${"%" + search + "%"} OR id ILIKE ${"%" + search + "%"} ORDER BY created_at DESC`
  } else {
    rows = await sql`SELECT * FROM shippers ORDER BY created_at DESC`
  }

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const sql = getDb()
  const id = `SHP-${Date.now().toString(36).toUpperCase()}`
  const assignedRep = `${user.firstName || ""} ${user.lastName || ""}`.trim()

  await sql`
    INSERT INTO shippers (id, company, industry, pipeline_stage, contract_status, assigned_rep, contact_name, contact_email, contact_phone, conversion_probability)
    VALUES (${id}, ${body.company}, ${body.industry || ""}, ${body.pipelineStage || "Prospect"}, ${body.contractStatus || "Prospect"}, ${assignedRep}, ${body.contactName || ""}, ${body.contactEmail || ""}, ${body.contactPhone || ""}, ${body.conversionProbability || 0})
  `

  return NextResponse.json({ id }, { status: 201 })
}
