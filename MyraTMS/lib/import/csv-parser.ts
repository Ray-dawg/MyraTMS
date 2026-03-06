import Papa from "papaparse"

export interface ParsedCSV {
  headers: string[]
  rows: Record<string, string>[]
  errors: string[]
}

/**
 * Parse a CSV string into structured data.
 * Handles BOM, auto-detects delimiter (comma or semicolon), trims values.
 */
export function parseCSV(csvText: string): ParsedCSV {
  // Strip BOM if present
  const cleaned = csvText.replace(/^\uFEFF/, "")

  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimitersToGuess: [",", ";", "\t"],
    transformHeader: (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    transform: (value: string) => value.trim(),
  })

  const errors: string[] = []
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      if (err.type === "Quotes") {
        errors.push(`Row ${(err.row ?? 0) + 1}: Malformed quoted field`)
      } else if (err.type === "FieldMismatch") {
        errors.push(`Row ${(err.row ?? 0) + 1}: Column count mismatch (expected ${result.meta.fields?.length ?? "?"} fields)`)
      } else {
        errors.push(`Row ${(err.row ?? 0) + 1}: ${err.message}`)
      }
    }
  }

  return {
    headers: result.meta.fields || [],
    rows: result.data,
    errors,
  }
}

/**
 * Validate that required headers are present in the parsed CSV.
 */
export function validateHeaders(
  parsed: ParsedCSV,
  requiredHeaders: readonly string[]
): string[] {
  const errors: string[] = []
  const headerSet = new Set(parsed.headers)

  for (const h of requiredHeaders) {
    if (!headerSet.has(h)) {
      errors.push(`Missing required column: "${h}"`)
    }
  }

  return errors
}
