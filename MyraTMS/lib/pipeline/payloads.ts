/**
 * Job Payload Interfaces
 *
 * Defines TypeScript interfaces for every job payload passed between agents
 * in the pipeline. These are the contracts between agents — strict typing
 * ensures correctness and enables static analysis.
 *
 * @module lib/pipeline/payloads
 */

/**
 * Base payload fields present in every job payload.
 * All pipeline jobs extend this interface.
 */
export interface BaseJobPayload {
  /** Database ID of the pipeline_loads row */
  pipelineLoadId: number;

  /** External load ID from the source (DAT, Truckstop, etc) */
  loadId: string;

  /** Load board source ('dat' | '123lb' | 'truckstop' | 'loadlink' | 'manual') */
  loadBoardSource: string;

  /** ISO timestamp when job was enqueued */
  enqueuedAt: string;

  /** Priority score for queue ordering (higher = processed first) */
  priority: number;
}

/**
 * Geography tuple used across multiple payloads.
 */
export interface Location {
  city: string;
  state: string;
  country: string;
}

// ============================================================================
// QUALIFY QUEUE (Agent 1 → Agent 2)
// ============================================================================

/**
 * Payload for qualify-queue jobs.
 * Scanner enqueues this for every scanned load.
 * Qualifier processes and filters based on profitability.
 */
export interface QualifyJobPayload extends BaseJobPayload {
  /** Origin location */
  origin: Location;

  /** Destination location */
  destination: Location;

  /** Equipment type (normalized: 'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck') */
  equipmentType: string;

  /** Posted rate (null if "call for rate") */
  postedRate: number | null;

  /** Currency code ('CAD' | 'USD') */
  postedRateCurrency: string;

  /** Distance in miles */
  distanceMiles: number;

  /** Pickup date (ISO date) */
  pickupDate: string;

  /** Shipper phone number for consent check */
  shipperPhone: string | null;
}

/**
 * Result of qualification (stored in pipeline_loads).
 */
export interface QualificationResult {
  /** Whether load passed qualification */
  passed: boolean;

  /** Reason for pass/fail */
  reason: string;

  /** Priority score for downstream processing (0-100) */
  priorityScore: number;

  /** Low end of estimated profit margin */
  estimatedMarginLow: number;

  /** High end of estimated profit margin */
  estimatedMarginHigh: number;

  /** How many carriers can move this load */
  carrierMatchCount: number;
}

// ============================================================================
// RESEARCH QUEUE (Agent 2 → Agent 3)
// ============================================================================

/**
 * Qualified load details passed to research agent.
 */
export interface QualifiedLoad {
  origin: Location;
  destination: Location;
  equipmentType: string;
  distanceMiles: number;
  distanceKm: number;
  postedRate: number | null;
  postedRateCurrency: string;
  pickupDate: string;
  deliveryDate: string | null;
  commodity: string | null;
  weightLbs: number | null;
}

/**
 * Payload for research-queue jobs.
 * Qualifier enqueues this. Researcher analyzes rates and computes negotiation envelope.
 */
export interface ResearchJobPayload extends BaseJobPayload {
  /** Complete qualified load details */
  qualifiedLoad: QualifiedLoad;

  /** Priority score from qualification */
  priorityScore: number;

  /** Estimated margin range from qualification */
  estimatedMarginRange: {
    low: number;
    high: number;
  };
}

/**
 * Result of rate research (stored in pipeline_loads and negotiation_brief).
 */
export interface ResearchResult {
  /** Lowest market rate (carriers accepting) */
  marketRateFloor: number;

  /** Average market rate */
  marketRateMid: number;

  /** Highest rate shippers paying */
  marketRateBest: number;

  /** Estimated total cost to Myra */
  totalCost: number;

  /** Margin envelope: floor, target, stretch */
  marginEnvelope: {
    floor: number;
    target: number;
    stretch: number;
  };

  /** Recommended negotiation strategy */
  recommendedStrategy: 'aggressive' | 'standard' | 'walk';

  /** Shipper profile and history */
  shipperProfile: {
    postingFrequency: number;
    historicalRates: number[];
    preferredLanguage: string;
  };

  /** Rate confidence (0-1) */
  rateConfidence: number;

  /** Which sources provided the rates */
  rateSources: string[];
}

// ============================================================================
// MATCH QUEUE (Agent 2 → Agent 4)
// ============================================================================

/**
 * Load details for carrier matching.
 */
export interface MatchableLoad {
  origin: Location;
  destination: Location;
  equipmentType: string;
  distanceMiles: number;
  pickupDate: string;
  weightLbs: number | null;
}

/**
 * Payload for match-queue jobs.
 * Qualifier enqueues this (parallel with research-queue).
 * Ranker matches and ranks carriers.
 */
export interface MatchJobPayload extends BaseJobPayload {
  /** Complete load details for matching */
  qualifiedLoad: MatchableLoad;
}

/**
 * Single carrier entry in the ranked stack.
 */
export interface CarrierStackEntry {
  /** TMS carrier ID */
  carrierId: number;

  /** Company legal name */
  companyName: string;

  /** Primary contact name */
  contactName: string;

  /** Phone number for dispatch */
  contactPhone: string;

  /** Email address */
  contactEmail: string | null;

  /** Match score (0.0-1.0) from matching engine */
  matchScore: number;

  /** Letter grade (A-F) */
  matchGrade: 'A' | 'B' | 'C' | 'D' | 'F';

  /** Breakdown of match score components */
  breakdown: {
    laneFamiliarity: number; // 0-1
    proximity: number; // 0-1
    rate: number; // 0-1
    reliability: number; // 0-1
    relationship: number; // 0-1
  };

  /** Expected rate carrier charges for this lane */
  expectedRate: number;

  /** Rate currency */
  rateCurrency: 'CAD' | 'USD';

  /** On-time delivery percentage */
  onTimePercentage: number | null;

  /** Communication rating (1-5 stars) */
  communicationRating: number | null;

  /** Total loads this carrier has done with Myra */
  totalLoadsWithMyra: number;

  /** Veteran status */
  veteranStatus: 'NEW' | 'PROVEN' | 'VETERAN';

  /** Availability confidence */
  availabilityConfidence: 'high' | 'medium' | 'low';

  /** Equipment confirmed (vs estimated) */
  equipmentConfirmed: boolean;
}

/**
 * Result of carrier matching (stored in pipeline_loads).
 */
export interface MatchResult {
  /** Ranked carrier stack (top 3-5) */
  carrierStack: CarrierStackEntry[];

  /** Number of carriers available */
  carrierCount: number;
}

// ============================================================================
// BRIEF QUEUE (Completion gate → Agent 5)
// ============================================================================

/**
 * Payload for brief-queue jobs.
 * Completion gate enqueues this after both Agent 3 and Agent 4 complete.
 * Brief Compiler merges research and carriers into negotiation brief.
 */
export interface BriefJobPayload extends BaseJobPayload {
  /** Research result from Agent 3 */
  researchResult: ResearchResult;

  /** Ranked carrier stack from Agent 4 */
  carrierStack: CarrierStackEntry[];
}

/**
 * Complete negotiation brief that Agent 6 receives.
 * See T-08 for full spec — this is the summary of key fields.
 */
export interface NegotiationBrief {
  /** Brief metadata */
  meta: {
    briefId: number;
    briefVersion: string;
    pipelineLoadId: number;
    generatedAt: string;
    generatedBy: string;
  };

  /** Load details */
  load: {
    loadId: string;
    loadBoardSource: string;
    origin: Location;
    destination: Location;
    pickupDate: string;
    pickupTime: string | null;
    deliveryDate: string | null;
    equipmentType: string;
    commodity: string | null;
    weightLbs: number | null;
    distanceMiles: number;
    distanceKm: number;
    crossBorder: boolean;
    specialRequirements: string | null;
  };

  /** Shipper contact and history */
  shipper: {
    companyName: string | null;
    contactName: string | null;
    phone: string;
    email: string | null;
    preferredLanguage: 'en' | 'fr';
    preferredCurrency: 'CAD' | 'USD';
    previousCallCount: number;
    previousOutcomes: string[];
    fatigueScore: number;
    isRepeatShipper: boolean;
    lastBookedRate: number | null;
  };

  /** Rate intelligence */
  rates: {
    marketRateFloor: number;
    marketRateMid: number;
    marketRateBest: number;
    totalCost: number;
    currency: 'CAD' | 'USD';
    rateConfidence: number;
    rateSources: string[];
    costBreakdown: {
      baseCost: number;
      deadheadCost: number;
      fuelSurcharge: number;
      accessorials: number;
      adminOverhead: number;
    };
  };

  /** Negotiation parameters */
  negotiation: {
    initialOffer: number;
    targetRate: number;
    walkAwayRate: number;
    concessionStep1: number;
    concessionStep2: number;
    finalOffer: number;
    walkAwayScript: string;
    strategy: 'aggressive' | 'standard' | 'walk';
  };

  /** Selected persona for this call */
  persona: {
    personaName: string;
    retellAgentId: string;
    tone: string;
  };

  /** Carrier stack with context */
  carrierStack: CarrierStackEntry[];

  /** Compliance and objection handling */
  compliance: {
    disclosureScript: string;
    dncCheck: boolean;
    consentStatus: 'implied' | 'explicit' | 'none';
  };

  /** Objection playbook */
  objectionPlaybook: Record<
    string,
    {
      objection: string;
      response: string;
      counterOffer?: number;
    }
  >;

  /** Call configuration */
  callConfig: {
    language: 'en' | 'fr';
    maxDuration: number; // seconds
    retryOnFail: boolean;
    escalationThreshold: number;
  };
}

/**
 * Brief compilation result.
 */
export interface BriefCompileResult {
  /** ID of created negotiation_brief */
  briefId: number;

  /** Complete brief object */
  brief: NegotiationBrief;

  /** Persona selected */
  personaSelected: string;
}

// ============================================================================
// CALL QUEUE (Agent 5 → Agent 6 via Retell)
// ============================================================================

/**
 * Payload for call-queue jobs.
 * Brief Compiler enqueues this. Voice Agent initiates call via Retell.
 */
export interface CallJobPayload extends BaseJobPayload {
  /** ID of negotiation brief in database */
  briefId: number;

  /** Complete negotiation brief */
  brief: NegotiationBrief;

  /** Retell agent ID to use ('agent_assertive_en_001', etc) */
  retellAgentId: string;

  /** Shipper phone number to call */
  phoneNumber: string;

  /** Language for call ('en' | 'fr') */
  language: string;
}

/**
 * Result of a call (stored in agent_calls).
 */
export interface CallResult {
  /** Call outcome */
  outcome:
    | 'booked'
    | 'declined'
    | 'callback'
    | 'voicemail'
    | 'no_answer'
    | 'wrong_contact'
    | 'escalated'
    | 'dropped'
    | 'busy';

  /** If booked: agreed rate */
  agreedRate?: number;

  /** If booked: profit */
  profit?: number;

  /** Call duration in seconds */
  durationSeconds: number;

  /** Retell call ID for linking */
  retellCallId: string;

  /** Transcript (if available) */
  transcript?: string;

  /** If callback scheduled: when to call back */
  callbackScheduledAt?: string;

  /** Next action for dispatcher or human */
  nextAction: string;
}

// ============================================================================
// DISPATCH QUEUE (Agent 6 → Agent 7)
// ============================================================================

/**
 * Payload for dispatch-queue jobs.
 * Voice Agent enqueues this after booking a load.
 * Dispatcher creates load in TMS and assigns carrier.
 */
export interface DispatchJobPayload extends BaseJobPayload {
  /** Rate agreed with shipper */
  agreedRate: number;

  /** Currency of agreed rate */
  agreedRateCurrency: 'CAD' | 'USD';

  /** Profit (agreedRate - carrierRate) */
  profit: number;

  /** Carrier ID (from carrier stack) */
  carrierId: number;

  /** Carrier's rate for this load */
  carrierRate: number;

  /** Shipper email for notifications */
  shipperEmail: string;

  /** Retell call ID (audit trail) */
  callId: string;

  /** Brief ID used for this call */
  briefId: number;
}

/**
 * Result of dispatch.
 */
export interface DispatchResult {
  /** TMS load ID created */
  tmsLoadId: number;

  /** Carrier assigned */
  carrierId: number;

  /** Load status in TMS */
  status: string;

  /** Rate confirmation PDF URL */
  ratePdfUrl: string;

  /** Tracking token for shipper */
  trackingToken: string;
}

// ============================================================================
// FEEDBACK QUEUE (Agent 7 → Feedback Agent)
// ============================================================================

/**
 * Payload for feedback-queue jobs.
 * Dispatcher enqueues this after dispatch is complete.
 * Feedback Agent scores load and updates learning loop.
 */
export interface FeedbackJobPayload extends BaseJobPayload {
  /** TMS load ID (for outcome lookup) */
  tmsLoadId: number;

  /** Call ID (for call analysis) */
  callId: string;
}

/**
 * Result of feedback analysis.
 */
export interface FeedbackResult {
  /** Rate prediction accuracy (0-1) */
  ratePredictionAccuracy: number;

  /** Cost estimate accuracy (0-1) */
  costEstimateAccuracy: number;

  /** Carrier on-time performance */
  carrierOnTime: boolean;

  /** Carrier rating from shipper */
  carrierRating: number | null;

  /** Strategy effectiveness rating */
  strategyEffectiveness: 'excellent' | 'good' | 'fair' | 'poor';
}

// ============================================================================
// CALLBACK QUEUE (Agent 6 → Agent 6)
// ============================================================================

/**
 * Payload for callback-queue jobs.
 * Voice Agent enqueues this when shipper requests callback.
 * Callback handler re-initiates call at scheduled time.
 */
export interface CallbackJobPayload extends BaseJobPayload {
  /** Original negotiation brief ID */
  briefId: number;

  /** Shipper phone number */
  phoneNumber: string;

  /** When to call (ISO timestamp) */
  callbackAt: string;

  /** Previous call ID (context) */
  previousCallId: string;

  /** Notes from previous call */
  context: string;
}

// ============================================================================
// ESCALATION QUEUE (Any agent → Notification service)
// ============================================================================

/**
 * Payload for escalation-queue jobs.
 * Any agent enqueues this when escalation is needed.
 * Notification service sends alert email/Slack.
 */
export interface EscalationJobPayload extends BaseJobPayload {
  /** Escalation type */
  escalationType:
    | 'stuck_load'
    | 'failed_research'
    | 'failed_carrier_match'
    | 'call_failure'
    | 'dispatch_failure'
    | 'dead_letter';

  /** Urgency level */
  urgency: 'low' | 'medium' | 'high' | 'critical';

  /** Human-readable message */
  message: string;

  /** Error details (if applicable) */
  error?: {
    code: string;
    message: string;
    stack?: string;
  };

  /** Action required from human */
  requiredAction: string;

  /** Metadata for context */
  metadata: Record<string, any>;
}

/**
 * Union type for all job payloads.
 * Useful for generic handlers.
 */
export type AnyJobPayload =
  | QualifyJobPayload
  | ResearchJobPayload
  | MatchJobPayload
  | BriefJobPayload
  | CallJobPayload
  | DispatchJobPayload
  | FeedbackJobPayload
  | CallbackJobPayload
  | EscalationJobPayload;

/**
 * Type guard to check if payload is a specific type.
 *
 * @example
 * ```typescript
 * if (isQualifyPayload(payload)) {
 *   // payload is typed as QualifyJobPayload
 * }
 * ```
 */
export function isQualifyPayload(
  payload: BaseJobPayload
): payload is QualifyJobPayload {
  return 'origin' in payload && 'destination' in payload;
}

export function isResearchPayload(
  payload: BaseJobPayload
): payload is ResearchJobPayload {
  return 'qualifiedLoad' in payload && 'estimatedMarginRange' in payload;
}

export function isCallPayload(
  payload: BaseJobPayload
): payload is CallJobPayload {
  return 'briefId' in payload && 'brief' in payload && 'retellAgentId' in payload;
}

export function isDispatchPayload(
  payload: BaseJobPayload
): payload is DispatchJobPayload {
  return 'agreedRate' in payload && 'carrierId' in payload;
}
