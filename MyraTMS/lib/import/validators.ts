import type { ValidatedRow, RowStatus } from "./types"
import {
  VALID_EQUIPMENT,
  VALID_AUTHORITY_STATUS,
  VALID_SAFETY_RATING,
  VALID_CONTRACT_STATUS,
  VALID_LOAD_SOURCE,
} from "./types"

// ── Common validators ──────────────────────────────────────────────

function isRequired(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "")
  return digits.length >= 10
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false
  const d = new Date(value.trim())
  return !isNaN(d.getTime())
}

function isValidNumber(value: string): boolean {
  const n = Number(value)
  return !isNaN(n) && n >= 0
}

function isPositiveNumber(value: string): boolean {
  const n = Number(value)
  return !isNaN(n) && n > 0
}

// ── Carrier validation ─────────────────────────────────────────────

export function validateCarrierRow(
  data: Record<string, string>,
  rowNumber: number,
  existingMcNumbers: Set<string>,
  existingDotNumbers: Set<string>
): ValidatedRow {
  const errors: string[] = []

  if (!isRequired(data.company_name)) {
    errors.push("company_name is required")
  }
  if (!isRequired(data.contact_name)) {
    errors.push("contact_name is required")
  }
  if (!isRequired(data.contact_phone)) {
    errors.push("contact_phone is required")
  } else if (!isValidPhone(data.contact_phone)) {
    errors.push("contact_phone: must contain at least 10 digits")
  }

  if (data.insurance_expiry && data.insurance_expiry.trim() && !isValidDate(data.insurance_expiry)) {
    errors.push("insurance_expiry: invalid date format (use YYYY-MM-DD)")
  }

  if (data.liability_insurance && data.liability_insurance.trim() && !isValidNumber(data.liability_insurance)) {
    errors.push("liability_insurance: must be a valid number")
  }

  if (data.cargo_insurance && data.cargo_insurance.trim() && !isValidNumber(data.cargo_insurance)) {
    errors.push("cargo_insurance: must be a valid number")
  }

  if (data.authority_status && data.authority_status.trim()) {
    if (!VALID_AUTHORITY_STATUS.includes(data.authority_status.trim())) {
      errors.push(`authority_status: must be one of ${VALID_AUTHORITY_STATUS.join(", ")}`)
    }
  }

  if (data.safety_rating && data.safety_rating.trim()) {
    if (!VALID_SAFETY_RATING.includes(data.safety_rating.trim())) {
      errors.push(`safety_rating: must be one of ${VALID_SAFETY_RATING.join(", ")}`)
    }
  }

  // Duplicate detection
  let isDuplicate = false
  const mc = (data.mc_number || "").trim()
  const dot = (data.dot_number || "").trim()

  if (mc && existingMcNumbers.has(mc.toUpperCase())) {
    isDuplicate = true
    errors.push(`Duplicate: carrier with MC number ${mc} already exists`)
  }
  if (dot && existingDotNumbers.has(dot.toUpperCase())) {
    isDuplicate = true
    errors.push(`Duplicate: carrier with DOT number ${dot} already exists`)
  }

  let status: RowStatus = "valid"
  if (isDuplicate) status = "duplicate"
  else if (errors.length > 0) status = "error"

  return { row_number: rowNumber, status, data, errors }
}

// ── Shipper validation ─────────────────────────────────────────────

export function validateShipperRow(
  data: Record<string, string>,
  rowNumber: number,
  existingEmails: Set<string>
): ValidatedRow {
  const errors: string[] = []

  if (!isRequired(data.company_name)) {
    errors.push("company_name is required")
  }
  if (!isRequired(data.contact_name)) {
    errors.push("contact_name is required")
  }
  if (!isRequired(data.contact_email)) {
    errors.push("contact_email is required")
  } else if (!isValidEmail(data.contact_email)) {
    errors.push("contact_email: invalid email format")
  }
  if (!isRequired(data.contact_phone)) {
    errors.push("contact_phone is required")
  } else if (!isValidPhone(data.contact_phone)) {
    errors.push("contact_phone: must contain at least 10 digits")
  }

  if (data.contract_status && data.contract_status.trim()) {
    if (!VALID_CONTRACT_STATUS.includes(data.contract_status.trim())) {
      errors.push(`contract_status: must be one of ${VALID_CONTRACT_STATUS.join(", ")}`)
    }
  }

  if (data.annual_revenue && data.annual_revenue.trim() && !isValidNumber(data.annual_revenue)) {
    errors.push("annual_revenue: must be a valid number")
  }

  // Duplicate detection
  let isDuplicate = false
  const email = (data.contact_email || "").trim().toLowerCase()
  if (email && existingEmails.has(email)) {
    isDuplicate = true
    errors.push(`Duplicate: shipper with email ${email} already exists`)
  }

  let status: RowStatus = "valid"
  if (isDuplicate) status = "duplicate"
  else if (errors.length > 0) status = "error"

  return { row_number: rowNumber, status, data, errors }
}

// ── Load validation ────────────────────────────────────────────────

export function validateLoadRow(
  data: Record<string, string>,
  rowNumber: number
): ValidatedRow {
  const errors: string[] = []

  if (!isRequired(data.origin)) {
    errors.push("origin is required")
  }
  if (!isRequired(data.destination)) {
    errors.push("destination is required")
  }
  if (!isRequired(data.pickup_date)) {
    errors.push("pickup_date is required")
  } else if (!isValidDate(data.pickup_date)) {
    errors.push("pickup_date: invalid date format (use YYYY-MM-DD)")
  }
  if (!isRequired(data.delivery_date)) {
    errors.push("delivery_date is required")
  } else if (!isValidDate(data.delivery_date)) {
    errors.push("delivery_date: invalid date format (use YYYY-MM-DD)")
  }

  // delivery_date >= pickup_date
  if (
    data.pickup_date &&
    data.delivery_date &&
    isValidDate(data.pickup_date) &&
    isValidDate(data.delivery_date)
  ) {
    if (new Date(data.delivery_date) < new Date(data.pickup_date)) {
      errors.push("delivery_date must be on or after pickup_date")
    }
  }

  if (data.equipment && data.equipment.trim()) {
    const normalized = data.equipment.trim()
    if (!VALID_EQUIPMENT.some((e) => e.toLowerCase() === normalized.toLowerCase())) {
      errors.push(`equipment: must be one of Dry Van, Reefer, Flatbed, Step Deck`)
    }
  }

  if (data.weight && data.weight.trim() && !isValidNumber(data.weight)) {
    errors.push("weight: must be a valid number")
  }

  if (data.revenue && data.revenue.trim() && !isPositiveNumber(data.revenue)) {
    errors.push("revenue: must be a positive number")
  }

  if (data.carrier_cost && data.carrier_cost.trim() && !isPositiveNumber(data.carrier_cost)) {
    errors.push("carrier_cost: must be a positive number")
  }

  if (data.source && data.source.trim()) {
    if (!VALID_LOAD_SOURCE.includes(data.source.trim())) {
      errors.push(`source: must be one of ${VALID_LOAD_SOURCE.join(", ")}`)
    }
  }

  const status: RowStatus = errors.length > 0 ? "error" : "valid"
  return { row_number: rowNumber, status, data, errors }
}
