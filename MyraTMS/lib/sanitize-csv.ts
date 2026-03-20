/**
 * Sanitizes a string value to prevent CSV formula injection.
 * Strings starting with =, +, -, @ are prefixed with a tab
 * to neutralize formula execution in spreadsheet applications.
 */
export function sanitizeCsvField(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (/^[=+\-@]/.test(value)) {
    return "\t" + value
  }
  return value
}

/**
 * Recursively sanitizes all string values in a record.
 */
export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sanitizeCsvField(value)
  }
  return sanitized
}
