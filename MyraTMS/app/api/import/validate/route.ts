import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { parseCSV, validateHeaders } from "@/lib/import/csv-parser"
import {
  validateCarrierRow,
  validateShipperRow,
  validateLoadRow,
} from "@/lib/import/validators"
import {
  CARRIER_HEADERS,
  SHIPPER_HEADERS,
  LOAD_HEADERS,
  type ImportType,
  type ValidatedRow,
  type ValidationResult,
} from "@/lib/import/types"
import { sanitizeRecord } from "@/lib/sanitize-csv"

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_ROWS = 5000

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null
    const importType = formData.get("import_type") as ImportType | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }
    if (!importType || !["carriers", "shippers", "loads"].includes(importType)) {
      return NextResponse.json(
        { error: "import_type must be carriers, shippers, or loads" },
        { status: 400 }
      )
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File exceeds 5MB limit" },
        { status: 400 }
      )
    }

    const csvText = await file.text()
    const parsed = parseCSV(csvText)

    if (parsed.errors.length > 0) {
      return NextResponse.json(
        { error: "CSV parsing errors", details: parsed.errors },
        { status: 400 }
      )
    }

    if (parsed.rows.length === 0) {
      return NextResponse.json(
        { error: "CSV file contains no data rows" },
        { status: 400 }
      )
    }

    if (parsed.rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (${parsed.rows.length}). Maximum is ${MAX_ROWS}.` },
        { status: 400 }
      )
    }

    // Validate headers based on type
    const requiredHeaders =
      importType === "carriers"
        ? ["company_name", "contact_name", "contact_phone"]
        : importType === "shippers"
          ? ["company_name", "contact_name", "contact_email", "contact_phone"]
          : ["origin", "destination", "pickup_date", "delivery_date"]

    const headerErrors = validateHeaders(parsed, requiredHeaders)
    if (headerErrors.length > 0) {
      return NextResponse.json(
        { error: "Missing required columns", details: headerErrors },
        { status: 400 }
      )
    }

    // Fetch existing records for duplicate detection
    const sql = getDb()
    let validatedRows: ValidatedRow[] = []

    if (importType === "carriers") {
      const existingCarriers = await sql`
        SELECT UPPER(mc_number) as mc, UPPER(dot_number) as dot
        FROM carriers
        WHERE mc_number != '' OR dot_number != ''
      `
      const mcSet = new Set(existingCarriers.map((r) => String(r.mc)).filter(Boolean))
      const dotSet = new Set(existingCarriers.map((r) => String(r.dot)).filter(Boolean))

      validatedRows = parsed.rows.map((row, i) =>
        validateCarrierRow(row, i + 1, mcSet, dotSet)
      )
    } else if (importType === "shippers") {
      const existingShippers = await sql`
        SELECT LOWER(contact_email) as email FROM shippers WHERE contact_email != ''
      `
      const emailSet = new Set(existingShippers.map((r) => String(r.email)))

      validatedRows = parsed.rows.map((row, i) =>
        validateShipperRow(row, i + 1, emailSet)
      )
    } else {
      validatedRows = parsed.rows.map((row, i) =>
        validateLoadRow(row, i + 1)
      )
    }

    // Sanitize all string fields in each row to prevent CSV formula injection.
    // This ensures preview data and the data later submitted to /api/import/execute
    // cannot contain spreadsheet formula payloads (=, +, -, @).
    validatedRows = validatedRows.map((row) => ({
      ...row,
      data: sanitizeRecord(row.data as Record<string, unknown>) as Record<string, string>,
    }))

    const result: ValidationResult = {
      import_type: importType,
      total_rows: validatedRows.length,
      valid_rows: validatedRows.filter((r) => r.status === "valid").length,
      error_rows: validatedRows.filter((r) => r.status === "error").length,
      duplicate_rows: validatedRows.filter((r) => r.status === "duplicate").length,
      rows: validatedRows,
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("Import validation error:", err)
    return NextResponse.json({ error: "Validation failed" }, { status: 500 })
  }
}
