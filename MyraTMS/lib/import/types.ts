export type ImportType = "carriers" | "shippers" | "loads"

export type RowStatus = "valid" | "error" | "duplicate"

export interface ValidationError {
  field: string
  message: string
}

export interface ValidatedRow {
  row_number: number
  status: RowStatus
  data: Record<string, string>
  errors: string[]
}

export interface ValidationResult {
  import_type: ImportType
  total_rows: number
  valid_rows: number
  error_rows: number
  duplicate_rows: number
  rows: ValidatedRow[]
}

export interface ImportResult {
  import_type: ImportType
  created: number
  skipped: number
  skipped_details: { row_number: number; reason: string }[]
}

// CSV template headers mapped to DB columns

export const CARRIER_HEADERS = [
  "company_name",
  "mc_number",
  "dot_number",
  "contact_name",
  "contact_phone",
  "authority_status",
  "insurance_expiry",
  "liability_insurance",
  "cargo_insurance",
  "safety_rating",
  "lanes_covered",
] as const

export const SHIPPER_HEADERS = [
  "company_name",
  "contact_name",
  "contact_email",
  "contact_phone",
  "industry",
  "contract_status",
  "annual_revenue",
] as const

export const LOAD_HEADERS = [
  "origin",
  "destination",
  "pickup_date",
  "delivery_date",
  "equipment",
  "weight",
  "shipper_name",
  "carrier_name",
  "revenue",
  "carrier_cost",
  "source",
  "special_instructions",
] as const

export const CARRIER_TEMPLATE = `company_name,mc_number,dot_number,contact_name,contact_phone,authority_status,insurance_expiry,liability_insurance,cargo_insurance,safety_rating,lanes_covered
"Northern Express Transport","MC-123456","DOT-789012","Jean Tremblay","705-555-5678","Active","2027-06-15","1000000","100000","Satisfactory","TX-OK,TX-LA"
`

export const SHIPPER_TEMPLATE = `company_name,contact_name,contact_email,contact_phone,industry,contract_status,annual_revenue
"Sudbury Mining Corp","Sarah Chen","sarah@sudburymining.ca","705-555-1234","Mining","Contracted","500000"
`

export const LOAD_TEMPLATE = `origin,destination,pickup_date,delivery_date,equipment,weight,shipper_name,carrier_name,revenue,carrier_cost,source,special_instructions
"Toronto, ON","Sudbury, ON","2026-03-10","2026-03-11","Dry Van","42000","Sudbury Mining Corp","Northern Express","1340","1095","Contract Shipper","Oversized load - requires permits"
`

export const TEMPLATES: Record<ImportType, string> = {
  carriers: CARRIER_TEMPLATE,
  shippers: SHIPPER_TEMPLATE,
  loads: LOAD_TEMPLATE,
}

export const VALID_EQUIPMENT = [
  "Dry Van",
  "Reefer",
  "Flatbed",
  "Step Deck",
  "dry_van",
  "reefer",
  "flatbed",
  "step_deck",
]

export const VALID_AUTHORITY_STATUS = ["Active", "Inactive", "Revoked"]
export const VALID_SAFETY_RATING = ["Satisfactory", "Conditional", "Unsatisfactory", "Not Rated"]
export const VALID_CONTRACT_STATUS = ["Contracted", "One-off", "Prospect"]
export const VALID_LOAD_SOURCE = ["Load Board", "Contract Shipper", "One-off Shipper"]
