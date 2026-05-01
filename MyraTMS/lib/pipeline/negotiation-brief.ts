// ============================================================================
// MYRA LOGISTICS — NEGOTIATION BRIEF: MASTER DATA CONTRACT
// ============================================================================
// Version: 2.0 | Date: April 3, 2026 | Owner: Patrice Penda
//
// This file defines three things:
//   1. The NegotiationBrief interface — the canonical schema
//   2. The RetellCallPayload — the transformed API request to Retell
//   3. The compileRetellPayload() function — the bridge between them
//
// DESIGN PRINCIPLE: The voice agent never computes anything. Every number,
// threshold, script, and boundary is pre-computed here. The voice agent
// is an executor, not a thinker.
// ============================================================================

// ============================================================================
// PART 1: THE NEGOTIATION BRIEF — CANONICAL SCHEMA
// ============================================================================
// This is compiled by Agent 5 (Brief Compiler) from:
//   - Agent 3 (Researcher) output: rates, costs, market intelligence
//   - Agent 4 (Carrier Ranker) output: carrier stack
//   - Pipeline DB: load details, shipper profile, call history
//   - Static config: objection playbook, compliance rules
// ============================================================================

export interface NegotiationBrief {

  // ── SECTION 1: BRIEF METADATA ──────────────────────────────────────────
  // Tracking, versioning, audit trail linkage
  meta: {
    briefId: number;                    // Auto-increment from negotiation_briefs table
    briefVersion: string;               // "2.0" — matches this schema version
    pipelineLoadId: number;             // FK to pipeline_loads table
    generatedAt: string;                // ISO 8601: "2026-04-15T09:32:00Z"
    generatedBy: string;                // "compiler-v2" — identifies compiler version
    parentBriefId: number | null;       // If this is a callback re-brief, link to original
    retryCount: number;                 // 0 = first attempt, 1 = first callback, etc.
  };

  // ── SECTION 2: LOAD DETAILS ────────────────────────────────────────────
  // What the call is about. Copied from pipeline_loads row.
  load: {
    loadId: string;                     // Load board reference: "DAT-89234571"
    loadBoardSource: LoadBoardSource;   // Where it was found
    origin: Location;
    destination: Location;
    pickupDate: string;                 // "2026-04-17"
    pickupTime: string | null;          // "08:00" or null if flexible
    pickupDateFormatted: string;        // "Thursday April 17th" — agent reads this aloud
    deliveryDate: string | null;
    deliveryTime: string | null;
    deliveryDateFormatted: string | null; // "Friday April 18th"
    equipmentType: EquipmentType;
    equipmentTypeDisplay: string;       // "dry van", "flatbed", "reefer" — spoken form
    commodity: string | null;
    weightLbs: number | null;
    distanceMiles: number;
    distanceKm: number;
    crossBorder: boolean;
    specialRequirements: string | null; // "tarps required", "driver assist", etc.
    isHazmat: boolean;
    temperatureControlled: boolean;
    temperatureRange: string | null;    // "35-38°F" for reefer
  };

  // ── SECTION 3: SHIPPER CONTACT ─────────────────────────────────────────
  // Who the voice agent is calling. Enriched with call history.
  shipper: {
    companyName: string | null;
    contactName: string | null;
    contactFirstName: string | null;    // Extracted for "Hi [FIRST NAME]" personalization
    phone: string;                      // E.164: "+17055551234"
    phoneFormatted: string;             // "(705) 555-1234" — for display/logging only
    email: string | null;
    preferredLanguage: Language;
    preferredCurrency: Currency;
    previousCallCount: number;          // Total calls to this number across all loads
    previousOutcomes: CallOutcome[];    // History: ["declined", "voicemail", "booked"]
    fatigueScore: number;               // 0 = fresh, 1-2 = warm, 3+ = cooling period
    isRepeatShipper: boolean;           // Has booked with Myra before
    lastBookedRate: number | null;      // Their most recent booked rate with us
    lastBookedDate: string | null;      // When they last booked
    averageResponseTime: number | null; // Avg seconds before shipper responds on calls
    knownObjections: string[];          // Objections raised in previous calls
    notes: string | null;               // Free-text from shipper_preferences table
  };

  // ── SECTION 4: RATE INTELLIGENCE ───────────────────────────────────────
  // All the math. Pre-computed. Agent references, never calculates.
  rates: {
    // Market data from Agent 3
    marketRateFloor: number;            // Lowest carriers accepting on this lane
    marketRateMid: number;              // Market average
    marketRateBest: number;             // Highest shippers paying
    rateConfidence: number;             // 0.0-1.0 — reliability of market data
    rateSources: RateSource[];          // Where rates came from
    dataAge: string;                    // "2 days" — how fresh the rate data is

    // Cost calculation from Agent 3
    totalCost: number;                  // What it costs Myra to move this load
    costBreakdown: {
      baseCost: number;                 // Carrier linehaul: miles × cost_per_mile
      deadheadCost: number;             // Empty miles to pickup
      fuelSurcharge: number;            // Current FSC estimate
      accessorials: number;             // Detention, TONU, lumper, etc.
      adminOverhead: number;            // $35 CAD per load standard
      crossBorderFees: number;          // Customs, border crossing — 0 if domestic
      factoringFee: number;             // Estimated cost to factor this receivable
      insuranceSurcharge: number;       // Additional coverage if needed
    };

    // Margin targets
    currency: Currency;
    minMargin: number;                  // $270 CAD — absolute floor, NEVER go below
    targetMargin: number;               // $470 CAD — where we want to land
    stretchMargin: number;              // $675 CAD — aspirational, aggressive ask

    // Per-mile rates for reference
    ratePerMile: number;                // totalCost / distanceMiles
    marketRatePerMile: number;          // marketRateMid / distanceMiles
  };

  // ── SECTION 5: NEGOTIATION ENVELOPE ────────────────────────────────────
  // The exact rate ladder the voice agent walks down during the call.
  // These are the ONLY numbers the agent is authorized to quote.
  negotiation: {
    initialOffer: number;               // Opening ask — highest number
    concessionStep1: number;            // First drop (~33% of range)
    concessionStep2: number;            // Second drop (~67% of range)
    finalOffer: number;                 // Absolute floor = totalCost + minMargin
    maxConcessions: number;             // 3 — hard limit

    // What to ask for in exchange for EACH concession (conditional trades)
    concessionAsks: [string, string, string]; // Exactly 3, one per step

    // Walk-away boundaries
    walkAwayRate: number;               // Same as finalOffer — below this, end call
    walkAwayScript: string;             // Verbatim script for graceful exit

    // Formatted strings for agent to speak aloud (no mental math required)
    initialOfferFormatted: string;      // "$2,400"
    concessionStep1Formatted: string;   // "$2,310"
    concessionStep2Formatted: string;   // "$2,220"
    finalOfferFormatted: string;        // "$2,120"
    currencyWord: string;               // "dollars" — for natural speech
  };

  // ── SECTION 6: STRATEGY ────────────────────────────────────────────────
  // High-level approach + talking points the agent weaves into conversation.
  strategy: {
    approach: NegotiationStrategy;
    reasoning: string;                  // "Good margin opportunity on established lane"
    keySellingPoints: string[];         // Agent picks from these during rapport building
    potentialObjections: string[];      // Predicted — helps agent prepare mentally
    urgencyFactors: string[];           // "Pickup is tomorrow", "Lane has limited capacity"
    rapportTopics: string[];            // "Ask about facility conditions", "Mention Sudbury corridor"
  };

  // ── SECTION 7: CARRIER STACK ───────────────────────────────────────────
  // Pre-matched carriers ready to dispatch if load books.
  // Agent never mentions carrier details to shipper — this is internal.
  carriers: CarrierMatch[];

  // ── SECTION 8: PERSONA ─────────────────────────────────────────────────
  // Which voice/personality the Retell agent uses for this call.
  persona: {
    personaName: PersonaType;
    personaLabel: string;               // "Friendly EN" — for logging
    retellAgentId: string;              // Retell dashboard agent ID
    selectionMethod: PersonaSelectionMethod;
    selectionScore: number;             // Thompson Sampling beta draw score
    voiceSettings: {
      speed: number;                    // 0.8-1.2 — adjusted per persona
      temperature: number;              // 0.3-0.7 — lower = more predictable
      emotion: string;                  // "warm", "confident", "calm"
    };
  };

  // ── SECTION 9: OBJECTION PLAYBOOK ──────────────────────────────────────
  // Complete response library. Indexed by objection type.
  // Prioritized: most likely objections first (based on strategy.potentialObjections).
  objectionPlaybook: ObjectionResponse[];

  // ── SECTION 10: COMPLIANCE ─────────────────────────────────────────────
  // Legal/regulatory gates. All must pass before brief enters call-queue.
  compliance: {
    consentType: ConsentType;
    consentSource: string;              // "dat_load_post", "website_form", etc.
    consentTimestamp: string | null;     // When consent was recorded
    callingHoursOk: boolean;            // Timezone-validated
    callingWindowStart: string;         // "08:00" local shipper time
    callingWindowEnd: string;           // "20:00" local shipper time
    dncChecked: boolean;                // National DNC list verified
    dncCheckTimestamp: string;          // When the DNC check ran
    recordingDisclosureRequired: boolean;
    disclosureScript: string | null;    // Must be spoken FIRST if required
    jurisdictionNotes: string | null;   // "Ontario — one-party consent"
  };

  // ── SECTION 11: CALL CONFIGURATION ─────────────────────────────────────
  // Operational settings for the Retell call.
  callConfig: {
    maxDurationSeconds: number;         // 300 = 5 minutes
    language: Language;
    timezone: string;                   // "America/Toronto"
    retellWebhookUrl: string;           // POST endpoint for call results
    retellFunctionUrl: string;          // POST endpoint for mid-call function calls
    callbackOnNoAnswer: boolean;        // Re-enqueue if no answer
    maxCallAttempts: number;            // 2
    callPriority: number;              // 1-10, higher = first in queue
    scheduledCallTime: string | null;   // ISO timestamp if this is a scheduled callback
  };
}


// ============================================================================
// SUPPORTING TYPE DEFINITIONS
// ============================================================================

type LoadBoardSource = 'DAT' | '123LB' | 'Truckstop' | 'Loadlink' | 'manual' | 'direct';
type EquipmentType = 'flatbed' | 'dry_van' | 'reefer' | 'tanker' | 'step_deck' | 'lowboy' | 'van' | 'container';
type Language = 'en' | 'fr';
type Currency = 'CAD' | 'USD';
type NegotiationStrategy = 'aggressive' | 'standard' | 'walk';
type PersonaType = 'assertive' | 'friendly' | 'analytical';
type PersonaSelectionMethod = 'thompson_sampling' | 'manual' | 'ab_test' | 'lane_override';
type RateSource = 'historical' | 'dat_rateview' | 'loadlink' | 'benchmark' | 'claude_estimate' | 'manual';
type ConsentType = 'implied_load_post' | 'explicit_written' | 'explicit_verbal' | 'existing_relationship';

type CallOutcome =
  | 'booked'
  | 'declined'
  | 'counter_pending'
  | 'callback'
  | 'voicemail'
  | 'no_answer'
  | 'wrong_contact'
  | 'escalated'
  | 'dropped'
  | 'busy';

interface Location {
  city: string;
  state: string;                        // Province code for CA: "ON", "QC", etc.
  country: string;                      // "CA" | "US"
}

interface CarrierMatch {
  carrierId: number;
  companyName: string;
  contactName: string;
  contactPhone: string;
  mcNumber: string | null;              // FMCSA MC number (US) or NSC (CA)
  rate: number;                         // What the carrier will charge Myra
  matchScore: number;                   // 0-100 from matching engine
  matchGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  availabilityConfidence: 'high' | 'medium' | 'low';
  equipmentConfirmed: boolean;
  onTimePercentage: number | null;
  totalLoadsWithMyra: number;
  paymentPreference: 'standard' | 'quick_pay' | 'factoring';
  lastLoadDate: string | null;
  driverLanguage: string | null;        // Useful for bilingual corridor
}

interface ObjectionResponse {
  objectionType: string;
  objectionLabel: string;               // Human-readable: "Rate Too High"
  response: string;                     // Primary script
  alternateResponse: string | null;     // Second attempt if first doesn't land
  followUpQuestion: string;             // Re-engagement question
  escalateAfter: number;                // 0 = never auto-escalate
  priority: number;                     // 1 = most likely to occur
}


// ============================================================================
// PART 2: THE RETELL API CALL PAYLOAD
// ============================================================================
// Retell's create-phone-call API accepts:
//   - retell_llm_dynamic_variables: Record<string, string> (FLAT key-value map)
//   - metadata: Record<string, any> (arbitrary JSON, returned in webhook)
//
// The dynamic variables get injected into the agent prompt via {{variable_name}}.
// The metadata passes through untouched to the webhook callback.
//
// CRITICAL: Dynamic variables must be STRINGS. No numbers, no objects, no arrays.
// ============================================================================

export interface RetellCreatePhoneCallPayload {
  from_number: string;                  // Myra's outbound number
  to_number: string;                    // Shipper's phone
  agent_id: string;                     // Retell agent ID (from persona selection)
  retell_llm_dynamic_variables: RetellDynamicVariables;
  metadata: RetellMetadata;
}

// Everything the voice agent prompt can reference via {{variable_name}}
export interface RetellDynamicVariables {
  // ── Agent identity ──
  agent_name: string;                   // "Sarah"
  brokerage_name: string;               // "Myra Logistics"

  // ── Load identification ──
  load_id: string;                      // "DAT-89234571"
  load_board_source: string;            // "DAT"

  // ── Lane details (spoken aloud) ──
  pickup_city: string;                  // "Toronto"
  pickup_province: string;              // "ON"
  pickup_full: string;                  // "Toronto, Ontario"
  delivery_city: string;                // "Sudbury"
  delivery_province: string;            // "ON"
  delivery_full: string;                // "Sudbury, Ontario"
  pickup_date: string;                  // "Thursday April 17th"
  delivery_date: string;                // "Friday April 18th" or "flexible"
  equipment_type: string;               // "flatbed"
  distance: string;                     // "250 miles" or "400 kilometres"
  commodity: string;                    // "grinding media" or "general freight"
  weight: string;                       // "42,000 lbs" or "not specified"

  // ── Shipper context ──
  shipper_company: string;              // "Northern Mine Supply Co" or "the shipper"
  shipper_first_name: string;           // "Jean-Marc" or "" if unknown
  shipper_is_repeat: string;            // "true" | "false"
  shipper_last_booked_rate: string;     // "$2,300" or "none"
  shipper_known_objections: string;     // "rate_too_high,have_broker" or "none"
  shipper_notes: string;                // Free text or ""

  // ── Rate negotiation ladder (ALL formatted as spoken currency) ──
  initial_rate: string;                 // "2400"
  concession_step_1: string;           // "2310"
  concession_step_2: string;           // "2220"
  final_offer: string;                  // "2120"
  min_acceptable_rate: string;          // "2120"
  currency: string;                     // "CAD"
  currency_word: string;                // "dollars"

  // ── Market context (for data-backed positioning) ──
  floor_rate: string;                   // "2100"
  mid_rate: string;                     // "2450"
  best_rate: string;                    // "2800"

  // ── Concession trade asks ──
  concession_ask_1: string;             // "flexibility on pickup appointment"
  concession_ask_2: string;             // "commitment to weekly loads on this lane"
  concession_ask_3: string;             // "extended delivery window to end of day"

  // ── Walk-away script ──
  walk_away_script: string;             // Full verbatim exit script

  // ── Strategy ──
  strategy_approach: string;            // "standard"
  strategy_reasoning: string;           // "Good margin opportunity..."
  selling_points: string;               // Newline-separated list
  urgency_factors: string;              // Newline-separated or "none"
  rapport_topics: string;               // Newline-separated conversation starters

  // ── Objection responses (top 5, flattened) ──
  objection_1_type: string;             // "rate_too_high"
  objection_1_response: string;         // Full script
  objection_1_followup: string;         // Re-engagement question
  objection_2_type: string;
  objection_2_response: string;
  objection_2_followup: string;
  objection_3_type: string;
  objection_3_response: string;
  objection_3_followup: string;
  objection_4_type: string;
  objection_4_response: string;
  objection_4_followup: string;
  objection_5_type: string;
  objection_5_response: string;
  objection_5_followup: string;

  // ── Compliance ──
  disclosure_script: string;            // Recording disclosure or ""
  consent_type: string;                 // "implied_load_post"

  // ── Special handling flags ──
  is_callback: string;                  // "true" | "false"
  is_cross_border: string;              // "true" | "false"
  is_hazmat: string;                    // "true" | "false"
  special_requirements: string;         // "tarps required" or "none"
  max_call_duration: string;            // "300"
}

// Metadata passed through to webhook — NOT visible to the agent prompt
export interface RetellMetadata {
  // Pipeline linkage (for webhook handler to update DB)
  pipelineLoadId: number;
  briefId: number;
  briefVersion: string;

  // Call context
  persona: string;
  language: string;
  currency: string;
  retryCount: number;
  parentBriefId: number | null;

  // Carrier info (for dispatch if booked — agent never sees this)
  primaryCarrierId: number;
  primaryCarrierRate: number;
  primaryCarrierPhone: string;

  // Rate boundaries (for webhook handler to validate parse results)
  initialOffer: number;
  finalOffer: number;
  minAcceptableRate: number;
  totalCost: number;
  targetMargin: number;

  // Timestamps
  briefGeneratedAt: string;
  callInitiatedAt: string;
}


// ============================================================================
// PART 3: THE BRIDGE — compileRetellPayload()
// ============================================================================
// Transforms a NegotiationBrief into a RetellCreatePhoneCallPayload.
// This is the function that Agent 5 calls after assembling the brief.
// ============================================================================

const OUTBOUND_NUMBERS = [
  '+14165551001',  // Toronto 416 number — rotation slot 1
  '+14165551002',  // Toronto 416 number — rotation slot 2
  '+17055551001',  // Sudbury 705 number — for Northern Ontario shippers
];

function selectOutboundNumber(shipperPhone: string): string {
  // Use 705 number when calling 705 area code (Northern Ontario rapport)
  if (shipperPhone.startsWith('+1705') || shipperPhone.startsWith('705')) {
    return OUTBOUND_NUMBERS[2];
  }
  // Rotate 416 numbers to prevent caller ID fatigue
  const slot = Date.now() % 2;
  return OUTBOUND_NUMBERS[slot];
}

function formatCurrency(amount: number, currency: Currency): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatWeight(lbs: number | null): string {
  if (!lbs) return 'not specified';
  return `${lbs.toLocaleString()} lbs`;
}

function formatDistance(miles: number, km: number, country: string): string {
  // Canadian shippers think in kilometres; cross-border uses miles
  if (country === 'CA') return `${km.toLocaleString()} kilometres`;
  return `${miles.toLocaleString()} miles`;
}

function padObjections(
  playbook: ObjectionResponse[],
  count: number
): ObjectionResponse[] {
  // Ensure exactly `count` entries. Pad with empty if fewer.
  const sorted = [...playbook].sort((a, b) => a.priority - b.priority);
  const padded = sorted.slice(0, count);
  while (padded.length < count) {
    padded.push({
      objectionType: 'none',
      objectionLabel: 'None',
      response: '',
      alternateResponse: null,
      followUpQuestion: '',
      escalateAfter: 0,
      priority: 99,
    });
  }
  return padded;
}


export function compileRetellPayload(
  brief: NegotiationBrief
): RetellCreatePhoneCallPayload {

  const obj = padObjections(brief.objectionPlaybook, 5);

  const dynamicVariables: RetellDynamicVariables = {
    // Agent identity
    agent_name: 'Sarah',
    brokerage_name: 'Myra Logistics',

    // Load identification
    load_id: brief.load.loadId,
    load_board_source: brief.load.loadBoardSource,

    // Lane details
    pickup_city: brief.load.origin.city,
    pickup_province: brief.load.origin.state,
    pickup_full: `${brief.load.origin.city}, ${brief.load.origin.state === 'ON' ? 'Ontario' : brief.load.origin.state}`,
    delivery_city: brief.load.destination.city,
    delivery_province: brief.load.destination.state,
    delivery_full: `${brief.load.destination.city}, ${brief.load.destination.state === 'ON' ? 'Ontario' : brief.load.destination.state}`,
    pickup_date: brief.load.pickupDateFormatted,
    delivery_date: brief.load.deliveryDateFormatted || 'flexible',
    equipment_type: brief.load.equipmentTypeDisplay,
    distance: formatDistance(
      brief.load.distanceMiles,
      brief.load.distanceKm,
      brief.load.origin.country
    ),
    commodity: brief.load.commodity || 'general freight',
    weight: formatWeight(brief.load.weightLbs),

    // Shipper context
    shipper_company: brief.shipper.companyName || 'the shipper',
    shipper_first_name: brief.shipper.contactFirstName || '',
    shipper_is_repeat: brief.shipper.isRepeatShipper ? 'true' : 'false',
    shipper_last_booked_rate: brief.shipper.lastBookedRate
      ? formatCurrency(brief.shipper.lastBookedRate, brief.rates.currency)
      : 'none',
    shipper_known_objections: brief.shipper.knownObjections.length > 0
      ? brief.shipper.knownObjections.join(',')
      : 'none',
    shipper_notes: brief.shipper.notes || '',

    // Rate ladder (raw numbers — agent prompt handles "$" prefix)
    initial_rate: brief.negotiation.initialOffer.toString(),
    concession_step_1: brief.negotiation.concessionStep1.toString(),
    concession_step_2: brief.negotiation.concessionStep2.toString(),
    final_offer: brief.negotiation.finalOffer.toString(),
    min_acceptable_rate: brief.negotiation.walkAwayRate.toString(),
    currency: brief.rates.currency,
    currency_word: brief.rates.currency === 'CAD' ? 'Canadian dollars' : 'US dollars',

    // Market context
    floor_rate: brief.rates.marketRateFloor.toString(),
    mid_rate: brief.rates.marketRateMid.toString(),
    best_rate: brief.rates.marketRateBest.toString(),

    // Concession trades
    concession_ask_1: brief.negotiation.concessionAsks[0],
    concession_ask_2: brief.negotiation.concessionAsks[1],
    concession_ask_3: brief.negotiation.concessionAsks[2],

    // Walk-away
    walk_away_script: brief.negotiation.walkAwayScript,

    // Strategy
    strategy_approach: brief.strategy.approach,
    strategy_reasoning: brief.strategy.reasoning,
    selling_points: brief.strategy.keySellingPoints.join('\n'),
    urgency_factors: brief.strategy.urgencyFactors.length > 0
      ? brief.strategy.urgencyFactors.join('\n')
      : 'none',
    rapport_topics: brief.strategy.rapportTopics.length > 0
      ? brief.strategy.rapportTopics.join('\n')
      : '',

    // Objections (flattened top 5)
    objection_1_type: obj[0].objectionType,
    objection_1_response: obj[0].response,
    objection_1_followup: obj[0].followUpQuestion,
    objection_2_type: obj[1].objectionType,
    objection_2_response: obj[1].response,
    objection_2_followup: obj[1].followUpQuestion,
    objection_3_type: obj[2].objectionType,
    objection_3_response: obj[2].response,
    objection_3_followup: obj[2].followUpQuestion,
    objection_4_type: obj[3].objectionType,
    objection_4_response: obj[3].response,
    objection_4_followup: obj[3].followUpQuestion,
    objection_5_type: obj[4].objectionType,
    objection_5_response: obj[4].response,
    objection_5_followup: obj[4].followUpQuestion,

    // Compliance
    disclosure_script: brief.compliance.disclosureScript || '',
    consent_type: brief.compliance.consentType,

    // Special flags
    is_callback: (brief.meta.retryCount > 0).toString(),
    is_cross_border: brief.load.crossBorder.toString(),
    is_hazmat: brief.load.isHazmat.toString(),
    special_requirements: brief.load.specialRequirements || 'none',
    max_call_duration: brief.callConfig.maxDurationSeconds.toString(),
  };

  const metadata: RetellMetadata = {
    pipelineLoadId: brief.meta.pipelineLoadId,
    briefId: brief.meta.briefId,
    briefVersion: brief.meta.briefVersion,
    persona: brief.persona.personaName,
    language: brief.callConfig.language,
    currency: brief.rates.currency,
    retryCount: brief.meta.retryCount,
    parentBriefId: brief.meta.parentBriefId,
    primaryCarrierId: brief.carriers[0]?.carrierId ?? 0,
    primaryCarrierRate: brief.carriers[0]?.rate ?? 0,
    primaryCarrierPhone: brief.carriers[0]?.contactPhone ?? '',
    initialOffer: brief.negotiation.initialOffer,
    finalOffer: brief.negotiation.finalOffer,
    minAcceptableRate: brief.negotiation.walkAwayRate,
    totalCost: brief.rates.totalCost,
    targetMargin: brief.rates.targetMargin,
    briefGeneratedAt: brief.meta.generatedAt,
    callInitiatedAt: new Date().toISOString(),
  };

  return {
    from_number: selectOutboundNumber(brief.shipper.phone),
    to_number: brief.shipper.phone,
    agent_id: brief.persona.retellAgentId,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata,
  };
}


// ============================================================================
// PART 4: BRIEF VALIDATION
// ============================================================================
// Run this BEFORE the brief enters the call-queue.
// Returns null if valid, or an error string if invalid.
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateBrief(brief: NegotiationBrief): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rate sanity
  if (brief.negotiation.initialOffer <= brief.negotiation.finalOffer) {
    errors.push(`Rate ladder inverted: initial ${brief.negotiation.initialOffer} <= final ${brief.negotiation.finalOffer}`);
  }
  if (brief.negotiation.finalOffer <= 0) {
    errors.push(`Final offer is zero or negative: ${brief.negotiation.finalOffer}`);
  }
  if (brief.negotiation.initialOffer <= brief.rates.totalCost) {
    errors.push(`Initial offer ${brief.negotiation.initialOffer} <= total cost ${brief.rates.totalCost}. Cannot make money.`);
  }
  if (brief.negotiation.concessionStep1 >= brief.negotiation.initialOffer) {
    errors.push(`Concession step 1 (${brief.negotiation.concessionStep1}) >= initial offer (${brief.negotiation.initialOffer})`);
  }
  if (brief.negotiation.concessionStep2 >= brief.negotiation.concessionStep1) {
    errors.push(`Concession step 2 (${brief.negotiation.concessionStep2}) >= step 1 (${brief.negotiation.concessionStep1})`);
  }
  if (brief.negotiation.finalOffer >= brief.negotiation.concessionStep2) {
    errors.push(`Final offer (${brief.negotiation.finalOffer}) >= step 2 (${brief.negotiation.concessionStep2})`);
  }

  // Carrier exists
  if (!brief.carriers || brief.carriers.length === 0) {
    errors.push('No carriers in stack. Cannot book without a carrier.');
  }

  // Phone valid (E.164 or 10-digit North American)
  const phoneRegex = /^(\+1\d{10}|\d{10})$/;
  if (!phoneRegex.test(brief.shipper.phone.replace(/[\s\-()]/g, ''))) {
    errors.push(`Invalid phone number: ${brief.shipper.phone}`);
  }

  // Compliance gates
  if (!brief.compliance.consentType) {
    errors.push('Missing consent type. Cannot call without consent basis.');
  }
  if (!brief.compliance.dncChecked) {
    errors.push('DNC not verified. Must check before calling.');
  }
  if (!brief.compliance.callingHoursOk) {
    errors.push('Outside calling hours for shipper timezone.');
  }

  // Fatigue check
  if (brief.shipper.fatigueScore >= 3) {
    errors.push(`Shipper fatigue score ${brief.shipper.fatigueScore} >= 3. Cooling period required.`);
  }

  // Load not expired (pickup must be > 4 hours from now)
  const pickupDate = new Date(brief.load.pickupDate);
  const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  if (pickupDate <= fourHoursFromNow) {
    errors.push(`Load pickup ${brief.load.pickupDate} is within 4 hours. Too late to call.`);
  }

  // Concession asks array length
  if (brief.negotiation.concessionAsks.length !== 3) {
    errors.push(`Expected exactly 3 concession asks, got ${brief.negotiation.concessionAsks.length}`);
  }

  // Warnings (non-blocking)
  if (brief.rates.rateConfidence < 0.5) {
    warnings.push(`Low rate confidence: ${brief.rates.rateConfidence}. Market data may be stale.`);
  }
  if (brief.rates.currency !== brief.shipper.preferredCurrency) {
    warnings.push(`Currency mismatch: brief is ${brief.rates.currency}, shipper prefers ${brief.shipper.preferredCurrency}`);
  }
  if (brief.carriers[0]?.availabilityConfidence === 'low') {
    warnings.push('Primary carrier availability is low confidence. Backup may be needed.');
  }
  if (brief.shipper.previousCallCount > 3) {
    warnings.push(`Shipper has been called ${brief.shipper.previousCallCount} times. Consider manual outreach.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}


// ============================================================================
// PART 5: EXAMPLE — FULLY POPULATED BRIEF (Sudbury Corridor)
// ============================================================================

export const EXAMPLE_BRIEF: NegotiationBrief = {
  meta: {
    briefId: 1042,
    briefVersion: "2.0",
    pipelineLoadId: 5891,
    generatedAt: "2026-04-15T09:32:00Z",
    generatedBy: "compiler-v2",
    parentBriefId: null,
    retryCount: 0,
  },
  load: {
    loadId: "DAT-89234571",
    loadBoardSource: "DAT",
    origin: { city: "Toronto", state: "ON", country: "CA" },
    destination: { city: "Sudbury", state: "ON", country: "CA" },
    pickupDate: "2026-04-17",
    pickupTime: "08:00",
    pickupDateFormatted: "Thursday April 17th",
    deliveryDate: "2026-04-17",
    deliveryTime: null,
    deliveryDateFormatted: "Thursday April 17th",
    equipmentType: "flatbed",
    equipmentTypeDisplay: "flatbed",
    commodity: "grinding media",
    weightLbs: 42000,
    distanceMiles: 250,
    distanceKm: 402,
    crossBorder: false,
    specialRequirements: null,
    isHazmat: false,
    temperatureControlled: false,
    temperatureRange: null,
  },
  shipper: {
    companyName: "Northern Mine Supply Co",
    contactName: "Jean-Marc Tremblay",
    contactFirstName: "Jean-Marc",
    phone: "+17055551234",
    phoneFormatted: "(705) 555-1234",
    email: "jm.tremblay@nmsco.ca",
    preferredLanguage: "en",
    preferredCurrency: "CAD",
    previousCallCount: 0,
    previousOutcomes: [],
    fatigueScore: 0,
    isRepeatShipper: false,
    lastBookedRate: null,
    lastBookedDate: null,
    averageResponseTime: null,
    knownObjections: [],
    notes: null,
  },
  rates: {
    marketRateFloor: 2100,
    marketRateMid: 2450,
    marketRateBest: 2800,
    rateConfidence: 0.82,
    rateSources: ["historical", "dat_rateview"],
    dataAge: "2 days",
    totalCost: 1850,
    costBreakdown: {
      baseCost: 1440,
      deadheadCost: 216,
      fuelSurcharge: 62,
      accessorials: 75,
      adminOverhead: 35,
      crossBorderFees: 0,
      factoringFee: 22,
      insuranceSurcharge: 0,
    },
    currency: "CAD",
    minMargin: 270,
    targetMargin: 470,
    stretchMargin: 675,
    ratePerMile: 7.40,
    marketRatePerMile: 9.80,
  },
  negotiation: {
    initialOffer: 2400,
    concessionStep1: 2310,
    concessionStep2: 2220,
    finalOffer: 2120,
    maxConcessions: 3,
    concessionAsks: [
      "flexibility on the pickup appointment time",
      "a commitment to weekly loads on this lane",
      "an extended delivery window to end of day"
    ],
    walkAwayRate: 2120,
    walkAwayScript: "I appreciate your time. I can't quite make the numbers work at that rate for this load, but I'd love to help with your next one. Keep us in mind — we run this corridor every week.",
    initialOfferFormatted: "$2,400",
    concessionStep1Formatted: "$2,310",
    concessionStep2Formatted: "$2,220",
    finalOfferFormatted: "$2,120",
    currencyWord: "Canadian dollars",
  },
  strategy: {
    approach: "standard",
    reasoning: "Good margin opportunity on established Sudbury corridor lane with reliable rate data and strong carrier match.",
    keySellingPoints: [
      "vetted carriers with Northern Ontario experience who know the Sudbury route",
      "live GPS tracking visible on your screen from pickup to delivery",
      "digital proof of delivery sent within minutes of drop-off",
      "dedicated founder-led service — you're not a number in a call center"
    ],
    potentialObjections: ["rate_too_high", "have_broker"],
    urgencyFactors: [
      "Pickup is in 2 days — limited flatbed availability on this lane"
    ],
    rapportTopics: [
      "Ask about facility conditions at the Sudbury delivery site",
      "Mention experience running the Toronto-Sudbury corridor",
      "Ask about their typical weekly shipping volume on this lane"
    ],
  },
  carriers: [
    {
      carrierId: 142,
      companyName: "Northern Express Transport",
      contactName: "Mike Pelletier",
      contactPhone: "+17055559876",
      mcNumber: null,
      rate: 1800,
      matchScore: 92,
      matchGrade: "A",
      availabilityConfidence: "high",
      equipmentConfirmed: true,
      onTimePercentage: 97,
      totalLoadsWithMyra: 8,
      paymentPreference: "quick_pay",
      lastLoadDate: "2026-04-10",
      driverLanguage: "en",
    },
    {
      carrierId: 87,
      companyName: "Cambrian Carriers Inc",
      contactName: "Denis Lafrenière",
      contactPhone: "+17055553421",
      mcNumber: null,
      rate: 1920,
      matchScore: 78,
      matchGrade: "B",
      availabilityConfidence: "medium",
      equipmentConfirmed: true,
      onTimePercentage: 93,
      totalLoadsWithMyra: 3,
      paymentPreference: "standard",
      lastLoadDate: "2026-03-28",
      driverLanguage: "fr",
    }
  ],
  persona: {
    personaName: "friendly",
    personaLabel: "Friendly EN",
    retellAgentId: "agent_friendly_en_001",
    selectionMethod: "thompson_sampling",
    selectionScore: 0.72,
    voiceSettings: {
      speed: 1.0,
      temperature: 0.4,
      emotion: "warm",
    },
  },
  objectionPlaybook: [
    {
      objectionType: "rate_too_high",
      objectionLabel: "Rate Too High",
      response: "I totally understand — price is a big factor. Let me ask: beyond rate, what matters most to you? On-time delivery? Communication? Because while we might not always be the cheapest option, our shippers stay with us because we're reliable. We don't just find the cheapest truck — we find the best truck for the job.",
      alternateResponse: "I hear you. Look, I can sharpen the pencil a bit, but I want to make sure you're getting quality service too. What if we could work together on this one and I show you the difference?",
      followUpQuestion: "What rate would work for you on this load?",
      escalateAfter: 0,
      priority: 1,
    },
    {
      objectionType: "have_broker",
      objectionLabel: "Already Have a Broker",
      response: "That's great — it means you know the value of good logistics support. We'd love to be a backup option for you. There will come a time when your go-to is full or can't cover a lane, and we'd be ready to step in without any scramble on your end.",
      alternateResponse: "Totally respect that. Quick question though — does your current broker cover this specific corridor? We specialize in the Northern Ontario mining lanes, which is a bit of a niche.",
      followUpQuestion: "What lanes does your current broker primarily cover for you?",
      escalateAfter: 0,
      priority: 2,
    },
    {
      objectionType: "dont_use_brokers",
      objectionLabel: "Don't Work with Brokers",
      response: "I understand — some shippers have had frustrating experiences with brokers. We think of ourselves more as a transportation partner than a middleman. We provide access to a vetted carrier network and manage the entire process. Would you be open to trying us for just this one load to see the difference?",
      alternateResponse: null,
      followUpQuestion: "What's been your biggest frustration with brokers in the past?",
      escalateAfter: 0,
      priority: 3,
    },
    {
      objectionType: "not_decision_maker",
      objectionLabel: "Not the Decision Maker",
      response: "No problem at all. Could you point me in the right direction? I'd love to connect with whoever handles transportation. What's the best way to reach them?",
      alternateResponse: null,
      followUpQuestion: "Do you have their name and direct number?",
      escalateAfter: 0,
      priority: 4,
    },
    {
      objectionType: "call_back",
      objectionLabel: "Call Me Back Later",
      response: "Absolutely, I understand you're busy. Let me put something on the calendar so I don't catch you at a bad time again. When would work best — morning or afternoon?",
      alternateResponse: null,
      followUpQuestion: "Would tomorrow morning work, or is there a specific day and time that's better?",
      escalateAfter: 0,
      priority: 5,
    },
    {
      objectionType: "send_email",
      objectionLabel: "Send Me an Email",
      response: "Happy to do that. What's the best email? I'll send a short overview. But let me ask — will you actually look at it, or will it land in a pile of 500 others? I ask because I'd rather have a quick 2-minute conversation now than send something that gets lost.",
      alternateResponse: null,
      followUpQuestion: "What's your email address?",
      escalateAfter: 0,
      priority: 6,
    },
    {
      objectionType: "handle_internally",
      objectionLabel: "We Handle Everything Internally",
      response: "That's impressive — you're running a tight operation. Let me ask: what happens when you're overloaded, or a lane opens up that your internal team can't cover? We're not looking to replace your team — just to be that safety net when you need extra capacity.",
      alternateResponse: null,
      followUpQuestion: "Have you ever had a carrier cancel last minute on a critical load?",
      escalateAfter: 0,
      priority: 7,
    },
    {
      objectionType: "better_offer",
      objectionLabel: "I Have a Better Offer",
      response: "I appreciate you sharing that — it's smart to compare. While I can't always match every rate, I can guarantee a high level of service and communication. Are you confident that the other offer comes with reliable capacity and the tracking visibility we provide?",
      alternateResponse: null,
      followUpQuestion: "What rate are you seeing from the other offer?",
      escalateAfter: 0,
      priority: 8,
    },
    {
      objectionType: "customer_routed",
      objectionLabel: "Customer-Routed Freight",
      response: "Oh nice, so your customer handles all the logistics headaches? No late trucks or last-minute cancellations to deal with? What about your inbound freight — is that something you guys manage yourselves?",
      alternateResponse: null,
      followUpQuestion: "Do you have any outbound freight or backhauls that you arrange independently?",
      escalateAfter: 0,
      priority: 9,
    },
  ],
  compliance: {
    consentType: "implied_load_post",
    consentSource: "dat_load_post",
    consentTimestamp: "2026-04-15T06:00:00Z",
    callingHoursOk: true,
    callingWindowStart: "08:00",
    callingWindowEnd: "20:00",
    dncChecked: true,
    dncCheckTimestamp: "2026-04-15T09:30:00Z",
    recordingDisclosureRequired: false,
    disclosureScript: null,
    jurisdictionNotes: "Ontario, Canada — one-party consent province. No disclosure required.",
  },
  callConfig: {
    maxDurationSeconds: 300,
    language: "en",
    timezone: "America/Toronto",
    retellWebhookUrl: "https://myratms.vercel.app/api/webhooks/retell-callback",
    retellFunctionUrl: "https://myratms.vercel.app/api/webhooks/retell-function",
    callbackOnNoAnswer: true,
    maxCallAttempts: 2,
    callPriority: 7,
    scheduledCallTime: null,
  },
};


// ============================================================================
// PART 6: EXAMPLE — COMPILED RETELL PAYLOAD
// ============================================================================
// This is what actually gets sent to Retell's create-phone-call API.
// Generated by: compileRetellPayload(EXAMPLE_BRIEF)
// ============================================================================

export const EXAMPLE_RETELL_PAYLOAD: RetellCreatePhoneCallPayload = compileRetellPayload(EXAMPLE_BRIEF);
