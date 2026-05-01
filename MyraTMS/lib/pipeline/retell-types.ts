/**
 * RETELL WEBHOOK TYPES
 *
 * Type definitions for the Retell AI webhook handler.
 * Covers: call payloads, database models, processing results, and queue jobs.
 *
 * @module retell-types
 * @version 1.0.0
 */

// ============================================================================
// RETELL INCOMING WEBHOOK PAYLOAD TYPES
// ============================================================================

/**
 * Complete webhook payload from Retell AI when a call completes.
 * This is the raw data structure POSTed to /api/webhooks/retell-callback
 */
export interface RetellWebhookPayload {
  /** Unique call ID from Retell */
  call_id: string;

  /** Retell agent ID that was used for this call */
  agent_id: string;

  /** Status of the call completion */
  call_status: 'completed' | 'failed' | 'no_answer' | 'busy' | 'voicemail';

  /** Outbound phone number used */
  from_number: string;

  /** Inbound phone number called */
  to_number: string;

  /** Call duration in milliseconds */
  duration_ms: number;

  /** ISO 8601 timestamp when call started */
  start_time: string;

  /** ISO 8601 timestamp when call ended */
  end_time: string;

  /** Full conversation transcript (speaker labels + text) */
  transcript: string;

  /** URL to the call recording audio file */
  recording_url: string | null;

  /** Custom metadata passed during call initiation */
  metadata: RetellWebhookMetadata;

  /** Optional: Retell's own analysis of call sentiment/summary */
  call_analysis?: {
    sentiment: 'positive' | 'neutral' | 'negative';
    summary: string;
  };
}

/**
 * Metadata object embedded in Retell webhook.
 * These are the custom fields we pass when initiating the call.
 */
export interface RetellWebhookMetadata {
  pipelineLoadId: number;
  briefId: number;
  briefVersion?: string;
  persona: string;
  language: string;
  currency: string;
  retryCount?: number;
  parentBriefId?: number | null;
  primaryCarrierId?: number;
  primaryCarrierRate?: number;
  primaryCarrierPhone?: string;
  initialOffer?: number;
  finalOffer?: number;
  minAcceptableRate?: number;
  totalCost?: number;
  targetMargin?: number;
  briefGeneratedAt?: string;
  callInitiatedAt?: string;
}

/**
 * Standard webhook request wrapper (Next.js Request object interface)
 */
export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  body: RetellWebhookPayload;
  json: () => Promise<RetellWebhookPayload>;
}

/**
 * Standard webhook response
 */
export interface WebhookResponse {
  status: number;
  body: {
    processed?: boolean;
    outcome?: string;
    error?: string;
    details?: Record<string, unknown> | string;
  };
}

// ============================================================================
// CALL PARSING RESULT TYPES (Output from Claude API)
// ============================================================================

/**
 * Structured call result returned by Claude API after transcript analysis.
 * This is what the call parser produces and what we write to agent_calls table.
 */
export interface CallResult {
  outcome: 'booked' | 'declined' | 'counter_pending' | 'callback' |
           'voicemail' | 'no_answer' | 'wrong_contact' | 'escalated' | 'dropped';

  final_rate: number | null;
  final_rate_currency: 'CAD' | 'USD' | null;

  profit: number | null;
  profit_tier: 'excellent' | 'good' | 'acceptable' | 'below_minimum' | null;

  auto_book_eligible: boolean;

  objections: string[];
  concessions_made: number;

  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;

  next_action: 'send_confirmation' | 'schedule_callback' | 'escalate_human' |
               'retry_later' | 'add_to_dnc' | 'no_action';

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

// ============================================================================
// DATABASE MODELS
// ============================================================================

/**
 * Row in agent_calls table — the full call record written to database
 */
export interface AgentCallRecord {
  // Linkage
  pipeline_load_id: number;
  call_id: string;

  // Metadata
  call_type: string;
  persona: string;
  language: string;
  currency: string;

  // Retell data
  retell_call_id: string;
  retell_agent_id: string;
  phone_number_called: string;

  // Timing
  call_initiated_at: Date;
  call_ended_at: Date;
  duration_seconds: number;

  // Brief reference
  negotiation_brief_id: number;
  initial_offer: number | null;
  min_acceptable_rate: number | null;
  target_rate: number | null;

  // Outcome from parser
  outcome: string;
  agreed_rate: number | null;
  profit: number | null;
  profit_tier: string | null;
  auto_book_eligible: boolean;

  // Analysis
  sentiment: string;
  objections: string[];
  concessions_made: number;

  // Next actions
  next_action: string;
  callback_scheduled_at: Date | null;
  decision_maker_name: string | null;
  decision_maker_phone: string | null;
  decision_maker_email: string | null;

  // Content
  transcript: string;
  recording_url: string | null;
  call_analysis: Record<string, any> | null;
  call_quality_score: number | null;
}

/**
 * Row in pipeline_loads table — state update after call
 */
export interface PipelineLoadUpdate {
  id: number;
  stage: string;
  stage_updated_at: Date;
  call_attempts: number;
  last_call_at: Date;
  call_outcome: string | null;
  agreed_rate: number | null;
  agreed_rate_currency: string | null;
  profit: number | null;
  profit_margin_pct: number | null;
  auto_booked: boolean;
  booked_at: Date | null;
  tms_load_id: number | null;
}

/**
 * Extracted metadata from webhook payload for context
 */
export interface CallMetadata {
  pipelineLoadId: number;
  briefId: number;
  persona: string;
  language: string;
  currency: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number;
  startTime: Date;
  endTime: Date;
  recordingUrl: string | null;
  retellCallId: string;
  retellAgentId: string;
}

// ============================================================================
// PROCESSING RESULT TYPES
// ============================================================================

/**
 * Result of processing a completed call
 */
export interface ProcessResult {
  success: boolean;
  pipelineLoadId: number;
  callId: string;
  outcome: string;
  nextAction: string;
  error?: string;
  details?: Record<string, any>;
  timestamp: Date;
}

/**
 * Signature verification result
 */
export interface SignatureVerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Consent check result (from T-13)
 */
export interface ConsentCheckResult {
  canCall: boolean;
  consentType: string | null;
  consentSource: string | null;
  reason: string;
  requiresDisclosure: boolean;
  disclosureScript: string | null;
}

// ============================================================================
// QUEUE JOB PAYLOADS
// ============================================================================

/**
 * Dispatch queue job payload — move booked load to dispatcher
 */
export interface DispatchQueuePayload {
  pipelineLoadId: number;
  loadId: string;
  agreedRate: number;
  agreedRateCurrency: string;
  profit: number;
  callId: string;
  timestamp: string;
}

/**
 * Callback queue job payload — scheduled follow-up call
 */
export interface CallbackQueuePayload {
  pipelineLoadId: number;
  briefId: number;
  phoneNumber: string;
  callbackTime: string; // ISO timestamp
  timestamp: string;
}

/**
 * Escalation queue job payload — human review needed
 */
export interface EscalationQueuePayload {
  pipelineLoadId: number;
  reason: string;
  callId: string;
  details?: Record<string, any>;
  timestamp: string;
}

/**
 * Callback queue job payload — retry on voicemail/no answer
 */
export interface RetryQueuePayload {
  pipelineLoadId: number;
  briefId: number;
  phoneNumber: string;
  retryCount: number;
  timestamp: string;
}

// ============================================================================
// SHIPPER PREFERENCES UPDATE
// ============================================================================

/**
 * Update to shipper_preferences table after call
 */
export interface ShipperPreferencesUpdate {
  phone: string;
  preferredLanguage?: string;
  preferredCurrency?: string;
  totalCallsReceived?: number;
  totalBookings?: number;
  avgAgreedRate?: number;
  lastObjectionType?: string;
  bestPerformingPersona?: string;
}

// ============================================================================
// AUDIT & COMPLIANCE
// ============================================================================

/**
 * Audit log entry for security and compliance
 */
export interface AuditLogEntry {
  timestamp: Date;
  eventType: string;
  pipelineLoadId: number;
  callId: string;
  phone: string;
  details: Record<string, any>;
  severity: 'info' | 'warning' | 'error';
}

/**
 * Error context for logging and debugging
 */
export interface ErrorContext {
  step: string;
  pipelineLoadId: number;
  callId: string;
  error: Error;
  payload?: any;
  retriesAttempted?: number;
}
