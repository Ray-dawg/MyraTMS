/**
 * Type definitions for Claude Service module
 * Used by Agent 3 (Research Agent), Agent 5 (Brief Compiler), and Call Parser
 */

// ===== Claude API Configuration =====

export interface ClaudeConfig {
  /** Base URL for Claude API (default: https://api.anthropic.com) */
  baseUrl?: string;
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Max tokens per request (default: 2000) */
  maxTokens?: number;
}

// ===== Token Tracking =====

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenCostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
  modelName: string;
}

export interface JobTokenBudget {
  jobId: string;
  dailyTokenBudget: number;
  perCallTokenBudget: number;
  tokensUsedToday: number;
  tokensUsedThisCall: number;
  remainingDaily: number;
  remainingThisCall: number;
}

// ===== Error Classes =====

export interface ErrorContext {
  message: string;
  code?: string;
  statusCode?: number;
  retryable: boolean;
}

// ===== Research Agent Types (T-06) =====

export interface RateCascadeResult {
  floorRate: number;
  midRate: number;
  bestRate: number;
  confidence: number;
  sources: string[];
  currency: 'CAD' | 'USD';
}

export interface CostBreakdown {
  baseCost: number;
  deadheadCost: number;
  fuelSurcharge: number;
  accessorials: number;
  adminOverhead: number;
  crossBorderFees: number;
  factoringFee: number;
  total: number;
}

export interface NegotiationParams {
  initialOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;
  walkAwayRate: number;
  minMargin: number;
  targetMargin: number;
  stretchMargin: number;
  marginEnvelope: {
    floor: number;
    target: number;
    stretch: number;
  };
}

export interface ShipperProfile {
  preferredLanguage: string;
  preferredCurrency: 'CAD' | 'USD';
  previousCallCount: number;
  previousOutcomes: string[];
  postingFrequency: number;
  bestPerformingPersona: string | null;
  lastBookedRate: number | null;
  fatigueScore: number;
}

export interface LoadIntelligence {
  rates: RateCascadeResult;
  cost: CostBreakdown;
  negotiation: NegotiationParams;
  shipperProfile: ShipperProfile;
  strategy: {
    approach: 'aggressive' | 'standard' | 'walk';
    reasoning: string;
  };
  distance: {
    miles: number;
    km: number;
    durationHours: number;
  };
}

// ===== Brief Compiler Types (T-08) =====

export interface NegotiationBrief {
  meta: {
    briefId: number;
    briefVersion: string;
    pipelineLoadId: number;
    generatedAt: string;
    generatedBy: string;
  };
  load: {
    loadId: string;
    loadBoardSource: string;
    origin: {
      city: string;
      state: string;
      country: string;
    };
    destination: {
      city: string;
      state: string;
      country: string;
    };
    pickupDate: string;
    pickupTime: string | null;
    deliveryDate: string | null;
    deliveryTime: string | null;
    equipmentType: string;
    commodity: string | null;
    weightLbs: number | null;
    distanceMiles: number;
    distanceKm: number;
    crossBorder: boolean;
    specialRequirements: string | null;
  };
  shipper: {
    companyName: string | null;
    contactName: string | null;
    phone: string;
    email: string | null;
    preferredLanguage: string;
    preferredCurrency: string;
    previousCallCount: number;
    previousOutcomes: string[];
    fatigueScore: number;
    isRepeatShipper: boolean;
    lastBookedRate: number | null;
  };
  rates: {
    marketRateFloor: number;
    marketRateMid: number;
    marketRateBest: number;
    rateConfidence: number;
    rateSources: string[];
    totalCost: number;
    costBreakdown: CostBreakdown;
    currency: string;
    minMargin: number;
    targetMargin: number;
    stretchMargin: number;
  };
  negotiation: {
    initialOffer: number;
    concessionStep1: number;
    concessionStep2: number;
    finalOffer: number;
    maxConcessions: number;
    concessionAsks: string[];
    walkAwayRate: number;
    walkAwayScript: string;
  };
  strategy: {
    approach: 'aggressive' | 'standard' | 'walk';
    reasoning: string;
    keySellingPoints: string[];
    potentialObjections: string[];
  };
  carriers: Array<{
    carrierId: number;
    companyName: string;
    contactName: string;
    contactPhone: string;
    rate: number;
    matchScore: number;
    matchGrade: string;
    availabilityConfidence: 'high' | 'medium' | 'low';
    equipmentConfirmed: boolean;
    onTimePercentage: number | null;
    totalLoadsWithMyra: number;
    paymentPreference: string;
  }>;
  persona: {
    personaName: string;
    retellAgentId: string;
    selectionMethod: string;
    selectionScore: number;
  };
  objectionPlaybook: Array<{
    objectionType: string;
    response: string;
    followUpQuestion: string;
    escalateAfter: number;
  }>;
  compliance: {
    consentType: string;
    consentSource: string;
    callingHoursOk: boolean;
    dncChecked: boolean;
    recordingDisclosureRequired: boolean;
    disclosureScript: string | null;
  };
  callConfig: {
    maxDurationSeconds: number;
    language: string;
    timezone: string;
    retellWebhookUrl: string;
    callbackOnNoAnswer: boolean;
    maxCallAttempts: number;
  };
}

// ===== Call Parser Types (T-12) =====

export interface CallParserContext {
  callType: string;
  loadId: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  equipmentType: string;
  initialOffer: number;
  minAcceptableRate: number;
  currency: 'CAD' | 'USD';
  persona: string;
  language: string;
}

export interface CallParseResult {
  outcome:
    | 'booked'
    | 'declined'
    | 'counter_pending'
    | 'callback'
    | 'voicemail'
    | 'no_answer'
    | 'wrong_contact'
    | 'escalated'
    | 'dropped';
  final_rate: number | null;
  final_rate_currency: 'CAD' | 'USD' | null;
  profit: number | null;
  profit_tier: 'excellent' | 'good' | 'acceptable' | 'below_minimum' | null;
  auto_book_eligible: boolean;
  objections: string[];
  concessions_made: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  next_action:
    | 'send_confirmation'
    | 'schedule_callback'
    | 'escalate_human'
    | 'retry_later'
    | 'add_to_dnc'
    | 'no_action';
  callback_details: {
    requested: boolean;
    day: string | null;
    time: string | null;
    timezone: string | null;
  };
  decision_maker_referral: {
    provided: boolean;
    name: string | null;
    phone: string | null;
    email: string | null;
  };
  shipper_intel: {
    weekly_volume: string | null;
    primary_lanes: string[];
    current_broker: string | null;
    facility_notes: string | null;
    pain_points: string[];
  };
  analysis_notes: string;
}

// ===== Retry Configuration =====

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

// ===== Prompt Template Parameters =====

export interface ResearchPromptParams {
  loadId: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  distanceMiles: number;
  equipmentType: string;
  pickupDate: string;
  originCountry: string;
}

export interface BriefCompilerPromptParams {
  briefId: number;
  pipelineLoadId: number;
  loadDetails: string;
  rateEnvelope: string;
  shipperContext: string;
  strategyReasoning: string;
}

export interface CallParserPromptParams {
  callType: string;
  loadId: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  equipmentType: string;
  initialOffer: number;
  minAcceptableRate: number;
  currency: string;
  persona: string;
  language: string;
  transcript: string;
}

// ===== Service Response Types =====

export interface StructuredOutput<T> {
  data: T;
  tokens: TokenUsage;
  extractedAt: string;
  modelUsed: string;
}

export interface BudgetStatus {
  dailyBudgetOK: boolean;
  callBudgetOK: boolean;
  remainingDaily: number;
  remainingCall: number;
  warningThreshold: number;
}
