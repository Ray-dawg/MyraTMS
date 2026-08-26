/**
 * E2-03 M2 §6.3 — pure cascade decision logic. Given a call outcome plus
 * where the cascade currently stands, decides what happens next. No DB, no
 * I/O — the webhook (which knows the stack + cascade position from Retell
 * metadata) and the worker's defensive out-of-bounds check both call this
 * as the single source of truth for cascade transitions, so the state
 * machine described in the PRD only exists in one place.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

export type CarrierCascadeOutcome =
  | 'accept'
  | 'decline'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'disconnected';

export type CascadeAction =
  | { type: 'accept' }
  | { type: 'advance'; nextPosition: number }
  | { type: 'retry_same'; position: number; delayMs: number }
  | { type: 'exhausted' };

export const VOICEMAIL_RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // +2h, per PRD §6.3

const UNREACHABLE_OUTCOMES = new Set<CarrierCascadeOutcome>([
  'voicemail',
  'no_answer',
  'busy',
  'disconnected',
]);

export function decideCascadeAction(params: {
  outcome: CarrierCascadeOutcome;
  position: number;
  stackLength: number;
  voicemailRetryCount: number;
}): CascadeAction {
  const { outcome, position, stackLength, voicemailRetryCount } = params;

  if (outcome === 'accept') {
    return { type: 'accept' };
  }

  if (UNREACHABLE_OUTCOMES.has(outcome) && voicemailRetryCount < 1) {
    return { type: 'retry_same', position, delayMs: VOICEMAIL_RETRY_DELAY_MS };
  }

  // Either a decline, or an unreachable outcome that already used its one
  // retry — both advance to the next position (or exhaust if there is none).
  const nextPosition = position + 1;
  if (nextPosition >= stackLength) {
    return { type: 'exhausted' };
  }
  return { type: 'advance', nextPosition };
}

/**
 * Cascade exhaustion (all N ranked carriers declined or were unreachable
 * through their retry) escalates to a human — same Alert Center `exceptions`
 * pattern E2-03 M0's `escalateCarrierConfirmation()` established, so this
 * shows up in the same operator surface, not a new one.
 */
export async function escalateCascadeExhausted(params: {
  pipelineLoadId: number;
  loadId: string;
  stack: string[];
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
}): Promise<void> {
  const { pipelineLoadId, loadId, stack, originCity, originState, destinationCity, destinationState } = params;

  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [pipelineLoadId],
  );

  const title = `Carrier cascade exhausted: ${originCity}, ${originState} → ${destinationCity}, ${destinationState}`;
  const detail =
    `AI carrier calling exhausted the ranked stack (${stack.length} carrier${stack.length === 1 ? '' : 's'}: ` +
    `${stack.join(', ')}) — all declined or were unreachable through their voicemail retry. ` +
    `Secure a carrier for this load by phone.`;
  const suggestedAction = 'Secure a carrier by phone — the AI cascade tried every ranked carrier without success.';

  await db.query(
    `INSERT INTO exceptions (
       load_id, carrier_id, type, severity, title, detail,
       pipeline_load_id, source_module, suggested_action, sla_due_at
     ) VALUES (
       NULL, NULL, 'carrier_cascade_exhausted', 'high', $1, $2,
       $3, 'carrier_cascade_exhausted', $4, NOW() + INTERVAL '4 hours'
     )`,
    [title, detail, pipelineLoadId, suggestedAction],
  );

  logger.warn(
    `[CarrierCascade] Load ${pipelineLoadId} (${loadId}) escalated: cascade exhausted after ${stack.length} carriers`,
  );
}
