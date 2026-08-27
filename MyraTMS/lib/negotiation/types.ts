// lib/negotiation/types.ts
//
// T-22 §4.1 — generalized brief shape. This is the in-memory/API contract,
// not a new table (each direction's brief is still persisted the same way
// its existing worker persists it: negotiation_briefs.brief for sell,
// pipeline_loads.carrier_brief for buy — this type does not change either
// of those, it's what compileEnvelope() in THIS module returns).

import type { NegotiationEnvelope } from '@/lib/pricing/pricing-engine';

export type Language = 'en' | 'fr';
// Deliberately plain string, not a narrow union: sell-side previousOutcomes
// comes from agent_calls.outcome and buy-side comes from
// carrier_outcome_events.event_type -- two different vocabularies
// (booked/declined/voicemail/... vs offered/accepted/completed_on_time/...)
// that don't share one enum. Matches this codebase's existing looseness
// here (compiler-worker.ts casts the same field `as any`), not a new
// departure.

export interface LoadDetails {
  loadId: string;
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  pickupDate: string;
  pickupDateFormatted: string;
  deliveryDate: string | null;
  deliveryDateFormatted: string | null;
  equipmentType: string;
  equipmentTypeDisplay: string;
  commodity: string | null;
  weightLbs: number | null;
  distanceMiles: number;
  distanceKm: number;
  crossBorder: boolean;
}

export interface Counterparty {
  counterpartyType: 'shipper' | 'carrier';
  companyName: string | null;
  contactName: string | null;
  phone: string;
  phoneFormatted: string;
  email: string | null;
  preferredLanguage: Language;
  previousCallCount: number;
  previousOutcomes: string[];
  isRepeat: boolean;
  // Carrier-specific — null for shipper direction
  mcNumber: string | null;
  myraCarrierScore: number | null;
}

export interface NegotiationBriefStrategy {
  approach: 'aggressive' | 'standard' | 'walk';
  reasoning: string;
  keyTalkingPoints: string[];
}

export interface ObjectionPlaybookEntry {
  objectionType: string;
  objectionLabel: string;
  response: string;
  alternateResponse: string | null;
  followUpQuestion: string | null;
  escalateAfter: number;
  priority: number;
}

export interface ComplianceBlock {
  consentType: string;
  callingHoursOk: boolean;
  callingWindowStart: string;
  callingWindowEnd: string;
  dncChecked: boolean;
  jurisdictionNotes: string;
}

export interface CallConfigBlock {
  maxDurationSeconds: number;
  language: Language;
  timezone: string;
  maxCallAttempts: number;
}

export interface PersonaSelection {
  personaName: string;
  retellAgentId: string | null;
  selectionMethod: 'thompson_sampling';
  selectionScore: number;
}

export interface NegotiationBrief {
  meta: { briefId: number; direction: 'sell' | 'buy'; pipelineLoadId: number; tenantId: number; generatedAt: string };
  load: LoadDetails;
  counterparty: Counterparty;
  pricing: NegotiationEnvelope;
  strategy: NegotiationBriefStrategy;
  objectionPlaybook: ObjectionPlaybookEntry[];
  persona: PersonaSelection;
  compliance: ComplianceBlock;
  callConfig: CallConfigBlock;
}
