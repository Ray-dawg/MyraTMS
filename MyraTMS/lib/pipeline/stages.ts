/**
 * Pipeline Stage Machine
 *
 * Defines all valid stages in the Myra load processing pipeline and provides
 * validation functions for stage transitions. Every load flows through these
 * stages from initial scan to final scoring.
 *
 * @module lib/pipeline/stages
 */

/**
 * Valid pipeline stages a load can occupy.
 * Stages represent the current state of a load in the pipeline.
 * Only stage transitions defined in VALID_TRANSITIONS are allowed.
 */
export enum PipelineStage {
  /** Load ingested from load board, not yet evaluated */
  SCANNED = 'scanned',

  /** Passed Agent 2 filters, has profit potential */
  QUALIFIED = 'qualified',

  /** Failed Agent 2 filters, dead end */
  DISQUALIFIED = 'disqualified',

  /** Agent 3 (Researcher) completed rate analysis */
  RESEARCHED = 'researched',

  /** Agent 4 (Carrier Ranker) ranked carriers */
  MATCHED = 'matched',

  /** Agent 5 (Brief Compiler) created negotiation brief */
  BRIEFED = 'briefed',

  /** Agent 6 (Voice) actively on a call */
  CALLING = 'calling',

  /** Call succeeded, load booked */
  BOOKED = 'booked',

  /** Call completed, shipper declined */
  DECLINED = 'declined',

  /** Agent couldn't resolve, needs human review */
  ESCALATED = 'escalated',

  /** Agent 7 (Dispatcher) created load in TMS */
  DISPATCHED = 'dispatched',

  /** Load delivered, POD captured */
  DELIVERED = 'delivered',

  /** Feedback Agent processed post-delivery data */
  SCORED = 'scored',

  /** Load aged out (pickup date passed without booking) */
  EXPIRED = 'expired',

  /** Load callback scheduled by Agent 6 */
  CALLBACK = 'callback',
}

export const VALID_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  [PipelineStage.SCANNED]: [PipelineStage.QUALIFIED, PipelineStage.DISQUALIFIED],
  [PipelineStage.QUALIFIED]: [PipelineStage.RESEARCHED, PipelineStage.MATCHED, PipelineStage.DISQUALIFIED, PipelineStage.ESCALATED],
  [PipelineStage.DISQUALIFIED]: [],
  [PipelineStage.RESEARCHED]: [PipelineStage.MATCHED, PipelineStage.ESCALATED],
  [PipelineStage.MATCHED]: [PipelineStage.BRIEFED, PipelineStage.ESCALATED],
  [PipelineStage.BRIEFED]: [PipelineStage.CALLING, PipelineStage.ESCALATED],
  [PipelineStage.CALLING]: [PipelineStage.BOOKED, PipelineStage.DECLINED, PipelineStage.CALLBACK, PipelineStage.ESCALATED, PipelineStage.EXPIRED],
  [PipelineStage.BOOKED]: [PipelineStage.DISPATCHED, PipelineStage.ESCALATED],
  [PipelineStage.DECLINED]: [PipelineStage.ESCALATED, PipelineStage.EXPIRED],
  [PipelineStage.ESCALATED]: [PipelineStage.BRIEFED, PipelineStage.CALLING, PipelineStage.EXPIRED],
  [PipelineStage.DISPATCHED]: [PipelineStage.DELIVERED, PipelineStage.ESCALATED],
  [PipelineStage.DELIVERED]: [PipelineStage.SCORED, PipelineStage.ESCALATED],
  [PipelineStage.SCORED]: [],
  [PipelineStage.EXPIRED]: [],
  [PipelineStage.CALLBACK]: [PipelineStage.CALLING, PipelineStage.EXPIRED],
};

export const TERMINAL_STAGES = new Set([PipelineStage.DISQUALIFIED, PipelineStage.SCORED, PipelineStage.EXPIRED]);
export const ACTIVE_STAGES = new Set([PipelineStage.RESEARCHED, PipelineStage.MATCHED, PipelineStage.CALLING, PipelineStage.DISPATCHED]);

export function isValidTransition(fromStage: PipelineStage, toStage: PipelineStage): boolean {
  const allowed = VALID_TRANSITIONS[fromStage];
  return allowed ? allowed.includes(toStage) : false;
}

export function getValidNextStages(currentStage: PipelineStage): PipelineStage[] {
  return VALID_TRANSITIONS[currentStage] || [];
}

export function isTerminalStage(stage: PipelineStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function isActiveStage(stage: PipelineStage): boolean {
  return ACTIVE_STAGES.has(stage);
}

export function getStageName(stage: PipelineStage): string {
  const names: Record<PipelineStage, string> = {
    [PipelineStage.SCANNED]: 'Load Scanned',
    [PipelineStage.QUALIFIED]: 'Qualified',
    [PipelineStage.DISQUALIFIED]: 'Disqualified',
    [PipelineStage.RESEARCHED]: 'Rate Research Complete',
    [PipelineStage.MATCHED]: 'Carriers Matched',
    [PipelineStage.BRIEFED]: 'Brief Compiled',
    [PipelineStage.CALLING]: 'Calling Shipper',
    [PipelineStage.BOOKED]: 'Booked',
    [PipelineStage.DECLINED]: 'Declined',
    [PipelineStage.ESCALATED]: 'Escalated',
    [PipelineStage.DISPATCHED]: 'Dispatched to TMS',
    [PipelineStage.DELIVERED]: 'Delivered',
    [PipelineStage.SCORED]: 'Feedback Scored',
    [PipelineStage.EXPIRED]: 'Expired',
    [PipelineStage.CALLBACK]: 'Callback Scheduled',
  };
  return names[stage] || stage;
}

export const ALL_STAGES = Object.values(PipelineStage);
