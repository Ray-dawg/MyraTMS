import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getCurrentUser } from "@/lib/auth"
import type { ImportType, ImportResult } from "@/lib/import/types"
import { sanitizeRecord } from "@/lib/sanitize-csv"

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req)
    const assignedRep = user ? `${user.firstName} ${user.lastName}` : "Unknown"

    const body = await req.json()
    const { import_type, rows } = body as {
      import_type: ImportType
      rows: { row_number: number; data: Record<string, string> }[]
    }

    if (!import_type || !["carriers", "shippers", "loads"].includes(import_type)) {
      return NextResponse.json(
        { error: "import_type must be carriers, shippers, or loads" },
        { status: 400 }
      )
    }

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: "No rows to import" },
        { status: 400 }
      )
    }

    // Use a transaction-capable connection
    const sql = neon(process.env.DATABASE_URL!)

    const result: ImportResult = {
      import_type,
      created: 0,
      skipped: 0,
      skipped_details: [],
    }

    if (import_type === "carriers") {
      for (const row of rows) {
        try {
          const d = sanitizeRecord(row.data as Record<string, unknown>) as Record<string, string>
          const id = `CAR-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`

          await sql`
            INSERT INTO carriers (
              id, company, mc_number, dot_number, contact_name, contact_phone,
              authority_status, insurance_expiry, liability_insurance, cargo_insurance,
              safety_rating, lanes_covered
            ) VALUES (
              ${id},
              ${d.company_name?.trim() || ""},
              ${d.mc_number?.trim() || ""},
              ${d.dot_number?.trim() || ""},
              ${d.contact_name?.trim() || ""},
              ${d.contact_phone?.trim() || ""},
              ${d.authority_status?.trim() || "Active"},
              ${d.insurance_expiry?.trim() || null},
              ${Number(d.liability_insurance) || 0},
              ${Number(d.cargo_insurance) || 0},
              ${d.safety_rating?.trim() || "Not Rated"},
              ${d.lanes_covered ? d.lanes_covered.split(",").map((s: string) => s.trim()) : []}
            )
          `
          result.created++
        } catch (err) {
          result.skipped++
          result.skipped_details.push({
            row_number: row.row_number,
            reason: err instanceof Error ? err.message : "Insert failed",
          })
        }
      }
    } else if (import_type === "shippers") {
      for (const row of rows) {
        try {
          const d = sanitizeRecord(row.data as Record<string, unknown>) as Record<string, string>
          const id = `SHP-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`

          await sql`
            INSERT INTO shippers (
              id, company, contact_name, contact_email, contact_phone,
              industry, contract_status, annual_revenue, pipeline_stage
            ) VALUES (
              ${id},
              ${d.company_name?.trim() || ""},
              ${d.contact_name?.trim() || ""},
              ${d.contact_email?.trim() || ""},
              ${d.contact_phone?.trim() || ""},
              ${d.industry?.trim() || ""},
              ${d.contract_status?.trim() || "Prospect"},
              ${Number(d.annual_revenue) || 0},
              ${d.contract_status?.trim() || "Prospect"}
            )
          `
          result.created++
        } catch (err) {
          result.skipped++
          result.skipped_details.push({
            row_number: row.row_number,
            reason: err instanceof Error ? err.message : "Insert failed",
          })
        }
      }
    } else if (import_type === "loads") {
      // For loads, attempt to match shipper/carrier by name
      const matchSql = neon(process.env.DATABASE_URL!)

      for (const row of rows) {
        try {
          const d = sanitizeRecord(row.data as Record<string, unknown>) as Record<string, string>
          const id = `LD-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`

          // Match shipper by name (case-insensitive)
          let shipperId: string | null = null
          let shipperName = d.shipper_name?.trim() || ""
          if (shipperName) {
            const matches = await matchSql`
              SELECT id, company FROM shippers
              WHERE LOWER(company) = ${shipperName.toLowerCase()}
              LIMIT 1
            `
            if (matches.length > 0) {
              shipperId = matches[0].id as string
              shipperName = matches[0].company as string
            }
          }

          // Match carrier by name (case-insensitive)
          let carrierId: string | null = null
          let carrierName = d.carrier_name?.trim() || ""
          if (carrierName) {
            const matches = await matchSql`
              SELECT id, company FROM carriers
              WHERE LOWER(company) = ${carrierName.toLowerCase()}
              LIMIT 1
            `
            if (matches.length > 0) {
              carrierId = matches[0].id as string
              carrierName = matches[0].company as string
            }
          }

          const revenue = Number(d.revenue) || 0
          const carrierCost = Number(d.carrier_cost) || 0
          const margin = revenue - carrierCost
          const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0

          // Normalize equipment name
          let equipment = d.equipment?.trim() || ""
          const equipMap: Record<string, string> = {
            dry_van: "Dry Van",
            reefer: "Reefer",
            flatbed: "Flatbed",
            step_deck: "Step Deck",
          }
          if (equipMap[equipment.toLowerCase()]) {
            equipment = equipMap[equipment.toLowerCase()]
          }

          const status = carrierId ? "Booked" : "Booked"
          const source = d.source?.trim() || "Load Board"

          await sql`
            INSERT INTO loads (
              id, origin, destination, shipper_id, shipper_name, carrier_id, carrier_name,
              source, status, revenue, carrier_cost, margin, margin_percent,
              pickup_date, delivery_date, equipment, weight, assigned_rep
            ) VALUES (
              ${id},
              ${d.origin?.trim() || ""},
              ${d.destination?.trim() || ""},
              ${shipperId},
              ${shipperName},
              ${carrierId},
              ${carrierName},
              ${source},
              ${status},
              ${revenue},
              ${carrierCost},
              ${margin},
              ${marginPercent},
              ${d.pickup_date?.trim() || null},
              ${d.delivery_date?.trim() || null},
              ${equipment},
              ${d.weight?.trim() || ""},
              ${assignedRep}
            )
          `
          result.created++
        } catch (err) {
          result.skipped++
          result.skipped_details.push({
            row_number: row.row_number,
            reason: err instanceof Error ? err.message : "Insert failed",
          })
        }
      }
    }

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error("Import execution error:", err)
    return NextResponse.json({ error: "Import failed" }, { status: 500 })
  }
}
