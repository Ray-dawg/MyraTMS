/**
 * COMPLIANCE MODULE TYPES
 * Myra Logistics Build 4: Legal Gate for All Outbound Calls
 *
 * Specifies TypeScript interfaces for CASL/TCPA compliance checking.
 * These types ensure type safety across all compliance operations.
 */

/**
 * Consent Types - Defined in T-13 Section 2
 */
export type ConsentType =
  | 'implied_load_post'      // Shipper posted load on public load board
  | 'implied_business'       // Existing business relationship (2-year window)
  | 'explicit_written'       // Written consent (email opt-in, web form)
  | 'explicit_verbal'        // Consent captured during call recording
  | 'opt_in_form';           // Website form submission

/**
 * Consent Sources - Where the consent came from
 */
export type ConsentSource =
  | 'dat_load_post'
  | '123lb_load_post'
  | 'truckstop_load_post'
  | 'website_form'
  | 'manual_entry'
  | 'call_recording';

/**
 * Call Types - Different calling contexts require different consent rules
 */
export type CallType =
  | 'load_booking'      // Agent calling about a specific load posted on load board
  | 'shipper_outreach'  // Cold outreach to shipper (requires explicit consent)
  | 'carrier_recruitment'; // Recruiting carriers (implied consent from public listing)

/**
 * DNC List Sources - Why a number was added
 */
export type DNCSource =
  | 'opt_out_during_call'
  | 'opt_out_email'
  | 'manual_entry'
  | 'regulatory_list'
  | 'complaint';

/**
 * Consent Status - Result of consent check
 */
export interface ConsentCheckResult {
  canCall: boolean;
  consentType: ConsentType | null;
  consentSource: ConsentSource | null;
  consentExpiresAt: Date | null;
  reason: string;
  requiresDisclosure: boolean;
  disclosureScript: string | null;
  // Compliance audit trail
  checkedAt: Date;
  callType: CallType;
}

/**
 * DNC Check Result
 */
export interface DNCCheckResult {
  isBlocked: boolean;
  reason: string | null;
  source: DNCSource | null;
  addedAt: Date | null;
}

/**
 * Calling Hours Result - Checks if we're within legal calling windows
 */
export interface CallingHoursResult {
  canCallNow: boolean;
  timezone: string;
  localTime: string;
  localHour: number;
  localMinute: number;
  dayOfWeek: string;
  isWeekday: boolean;
  nextValidWindow: Date | null;
  reason: string;
}

/**
 * Recording Disclosure - Tracks if recording notice required
 */
export interface RecordingDisclosureInfo {
  requiresDisclosure: boolean;
  state?: string;
  province?: string;
  disclosureScript: string | null;
}

/**
 * Shipper Fatigue Check - Prevents call fatigue
 */
export interface ShipperFatigueResult {
  canContact: boolean;
  fatigueScore: number;
  reason: string;
  nextContactDate: Date | null;
  callsToday: number;
  callsThisWeek: number;
}

/**
 * Master Compliance Check - Run before every call
 */
export interface FullComplianceCheckResult {
  canCall: boolean;
  checks: {
    dncCheck: DNCCheckResult;
    consentCheck: ConsentCheckResult;
    callingHoursCheck: CallingHoursResult;
    recordingDisclosureCheck: RecordingDisclosureInfo;
    fatigueCheck: ShipperFatigueResult;
  };
  blockers: string[];
  warnings: string[];
  disclosureScript: string | null;
  checkedAt: Date;
  nextRetryAt: Date | null;
}

/**
 * Consent Log Entry - Audit trail for CASL 3-year retention
 */
export interface ConsentLogEntry {
  id: number;
  phone: string;
  consentType: ConsentType;
  consentSource: ConsentSource;
  consentDate: Date;
  consentProof: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * DNC List Entry
 */
export interface DNCListEntry {
  id: number;
  phone: string;
  addedAt: Date;
  source: DNCSource;
  reason: string | null;
  addedBy: string;
  notes: string | null;
}

/**
 * Compliance Audit Log - Every check is logged
 */
export interface ComplianceAuditLog {
  id: number;
  phone: string;
  checkType:
    | 'consent_check'
    | 'dnc_check'
    | 'calling_hours_check'
    | 'recording_disclosure_check'
    | 'fatigue_check'
    | 'full_compliance_check';
  result: 'pass' | 'block' | 'warn';
  details: Record<string, unknown>;
  pipelineLoadId?: number;
  callId?: string;
  checkedAt: Date;
}

/**
 * Shipper Preferences - Learned over time
 */
export interface ShipperPreference {
  id: number;
  phone: string;
  preferredLanguage: 'en' | 'fr';
  preferredCurrency: 'CAD' | 'USD';
  preferredUnits: 'imperial' | 'metric';
  preferredContactTime?: string;
  totalCallsReceived: number;
  totalBookings: number;
  avgAgreedRate: number | null;
  lastObjectionType?: string;
  bestPerformingPersona?: string;
  companyName?: string;
  contactName?: string;
  shipperTier?: string;
  shipperFatigueScore: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Timezone mapping for North America
 */
export interface TimezoneInfo {
  timezone: string;
  province?: string;
  state?: string;
  region: 'canada' | 'us';
}

/**
 * Compliance Configuration
 */
export interface ComplianceConfig {
  // CASL (Canada) standard calling hours
  caslWindowStart: number;     // minutes since midnight (540 = 9:00 AM)
  caslWindowEnd: number;       // minutes since midnight (1020 = 5:00 PM)

  // More conservative Myra standard for AI calls
  myraAIWindowStart: number;   // 9:00 AM
  myraAIWindowEnd: number;     // 5:00 PM

  // Shipper fatigue limits
  maxCallsPerDay: number;      // max calls to same phone per day
  maxCallsPerWeek: number;     // max calls to same phone per week
  consecutiveDeclineThreshold: number; // trigger fatigue wait
  fatigueScoreThreshold: number;       // when fatigue > this, wait 7 days

  // Consent expiry windows
  impliedLoadPostExpiry: number;  // days until implied consent from load post expires
  impliedBusinessExpiry: number;  // days until business relationship consent expires

  // Retry and escalation
  maxCallAttempts: number;
  brokerage: {
    name: string;
    address: string;
    phone: string;
  };
}

/**
 * State/Province timezone lookup entry
 */
export interface StateTimezoneMap {
  [key: string]: string; // e.g., { 'ON': 'America/Toronto', 'CA': 'America/Los_Angeles' }
}
