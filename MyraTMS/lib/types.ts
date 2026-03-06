// ============================================================
// Myra TMS - Canonical Type Definitions
// ============================================================

export type LoadStatus = "Booked" | "Dispatched" | "In Transit" | "Delivered" | "Invoiced" | "Closed"
export type LoadSource = "Load Board" | "Contract Shipper" | "One-off Shipper"

export interface Load {
  id: string
  origin: string
  destination: string
  shipper: string
  carrier: string
  source: LoadSource
  status: LoadStatus
  revenue: number
  carrierCost: number
  margin: number
  marginPercent: number
  pickupDate: string
  deliveryDate: string
  assignedRep: string
  equipment: string
  weight: string
  riskFlag: boolean
}

export interface Shipper {
  id: string
  company: string
  industry: string
  pipelineStage: string
  contractStatus: "Contracted" | "One-off" | "Prospect"
  annualRevenue: number
  assignedRep: string
  lastActivity: string
  conversionProbability: number
  contactName: string
  contactEmail: string
  contactPhone: string
}

export interface Carrier {
  id: string
  company: string
  mcNumber: string
  dotNumber: string
  insuranceStatus: "Active" | "Expiring" | "Expired"
  performanceScore: number
  onTimePercent: number
  lanesCovered: string[]
  riskFlag: boolean
  contactName: string
  contactPhone: string
  // Compliance fields
  authorityStatus: "Active" | "Inactive" | "Revoked"
  insuranceExpiry: string
  liabilityInsurance: number
  cargoInsurance: number
  safetyRating: "Satisfactory" | "Conditional" | "Unsatisfactory" | "Not Rated"
  lastFmcsaSync: string
  vehicleOosPercent: number
  driverOosPercent: number
}

export interface Invoice {
  id: string
  loadId: string
  shipper: string
  amount: number
  status: "Pending" | "Sent" | "Paid" | "Overdue"
  issueDate: string
  dueDate: string
  factoringStatus: "N/A" | "Submitted" | "Approved" | "Funded"
  daysOutstanding: number
}

export interface Document {
  id: string
  name: string
  type: "BOL" | "POD" | "Rate Confirmation" | "Insurance" | "Contract" | "Invoice"
  relatedTo: string
  relatedType: "Load" | "Shipper" | "Carrier"
  uploadDate: string
  status: "Complete" | "Missing" | "Pending Review"
  uploadedBy: string
}

export interface ActivityItem {
  id: string
  type: "call" | "email" | "note" | "status_change" | "ai_event" | "document"
  title: string
  description: string
  timestamp: string
  user: string
}

// ---------- LOAD BOARD ----------
export type LoadBoardSource = "DAT" | "Truckstop" | "123Loadboard"

export interface ExternalLoad {
  id: string
  source: LoadBoardSource
  origin: string
  originState: string
  destination: string
  destinationState: string
  equipment: string
  weight: string
  miles: number
  rate: number
  ratePerMile: number
  pickupDate: string
  deliveryDate: string
  shipperName: string
  age: string
  commodity: string
  matchesLane: boolean
}

// ---------- TRACKING ----------
export type TrackingStatus = "On Schedule" | "Delayed" | "Off Route" | "No Signal"

export interface TrackingPosition {
  loadId: string
  carrier: string
  origin: string
  destination: string
  currentLat: number
  currentLng: number
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  speed: number
  heading: string
  lastUpdate: string
  eta: string
  status: TrackingStatus
  progressPercent: number
  nextCheckCall: string
  driver: string
  driverPhone: string
}

// ---------- QUOTING ENGINE ----------
export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired"
export type ConfidenceLabel = "HIGH" | "MEDIUM" | "LOW"
export type RateSource = "historical" | "dat" | "truckstop" | "dat+historical" | "truckstop+historical" | "manual_cache" | "ai" | "benchmark"

export interface Quote {
  id: string
  reference: string
  shipperId: string | null
  shipperName: string
  originAddress: string
  originLat: number | null
  originLng: number | null
  originRegion: string
  destAddress: string
  destLat: number | null
  destLng: number | null
  destRegion: string
  equipmentType: string
  weightLbs: number
  commodity: string
  pickupDate: string
  distanceMiles: number
  distanceKm: number
  driveTimeHours: number
  ratePerMile: number
  carrierCostEstimate: number
  fuelSurcharge: number
  shipperRate: number
  marginPercent: number
  marginDollars: number
  rateSource: RateSource
  rateSourceDetail: Record<string, unknown>
  confidence: number
  confidenceLabel: ConfidenceLabel
  rateRangeLow: number
  rateRangeHigh: number
  status: QuoteStatus
  validUntil: string
  actualCarrierCost: number | null
  quoteAccuracy: number | null
  loadId: string | null
  createdAt: string
  updatedAt: string
}

export interface Integration {
  id: string
  provider: string
  apiKey: string
  apiSecret: string
  config: Record<string, unknown>
  enabled: boolean
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorMsg: string | null
}

export interface RateCacheEntry {
  id: string
  originRegion: string
  destRegion: string
  equipmentType: string
  ratePerMile: number
  totalRate: number
  source: string
  sourceDetail: Record<string, unknown>
  fetchedAt: string
  expiresAt: string
}

export interface FuelIndexEntry {
  id: string
  source: string
  pricePerLitre: number
  region: string
  effectiveDate: string
}

// ---------- COMPLIANCE ----------
export interface ComplianceAlert {
  id: string
  carrierId: string
  carrierName: string
  mcNumber: string
  type: "insurance_expiring" | "insurance_expired" | "authority_inactive" | "safety_concern" | "high_oos_rate"
  severity: "critical" | "warning" | "info"
  title: string
  description: string
  detectedAt: string
  resolved: boolean
}
