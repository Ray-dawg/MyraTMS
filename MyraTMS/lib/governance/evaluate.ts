import type { AuthorityEnvelopeRow, EvaluationResult } from './types';

const BUDGET_CONTEXT_KEYS: Record<string, string> = {
  max_concurrent: 'concurrentCount',
  max_actions_per_day: 'actionsToday',
  max_spend_per_day_cad: 'spendTodayCad',
};

function checkBudget(budget: Record<string, number>, context: Record<string, unknown>): string | null {
  for (const [budgetKey, contextKey] of Object.entries(BUDGET_CONTEXT_KEYS)) {
    const limit = budget[budgetKey];
    const actual = context[contextKey];
    if (typeof limit === 'number' && typeof actual === 'number' && actual > limit) {
      return `budget exceeded: ${contextKey}=${actual} > ${budgetKey}=${limit}`;
    }
  }
  return null;
}

/**
 * Recognized escalation triggers, matching the worked example in T-18 §5.
 * An unrecognized trigger name never matches (fails safe) rather than
 * throwing, so a typo in an envelope's JSONB can't crash evaluation.
 */
function evaluateTrigger(
  trigger: string,
  envelope: AuthorityEnvelopeRow,
  context: Record<string, unknown>,
): boolean {
  switch (trigger) {
    case 'fraud_signal_detected':
      return context.fraudSignalDetected === true;
    case 'margin_below_floor': {
      const marginPct = context.marginPct;
      const floor = envelope.policies.margin_floor_pct;
      return typeof marginPct === 'number' && typeof floor === 'number' && marginPct < floor;
    }
    case 'confidence_below_threshold': {
      const confidence = context.confidence;
      return typeof confidence === 'number' && confidence < envelope.confidence_threshold;
    }
    case 'profit_above_auto_book_threshold': {
      const profit = context.profit;
      const threshold = envelope.policies.auto_book_profit_threshold_cad;
      return typeof profit === 'number' && typeof threshold === 'number' && profit > threshold;
    }
    default:
      return false;
  }
}

function levelToDecision(level: 'L1' | 'L2' | 'L3'): 'allow' | 'escalate' | 'deny' {
  return level === 'L3' ? 'escalate' : 'allow';
}

/**
 * Pure decision core (T-18 §6, steps 2-5). No I/O — loading the envelope
 * and persisting the result are the DB wrapper's job (evaluate-authority.ts).
 */
export function applyEnvelope(
  envelope: AuthorityEnvelopeRow,
  action: string,
  context: Record<string, unknown>,
): EvaluationResult {
  if (envelope.permissions.cannot.includes(action)) {
    return {
      decision: 'deny',
      autonomyLevelApplied: 'L3',
      reason: `action '${action}' is explicitly forbidden by envelope '${envelope.envelope_name}'`,
      envelopeId: envelope.id,
    };
  }

  const budgetBreach = checkBudget(envelope.budget, context);
  if (budgetBreach) {
    return {
      decision: 'escalate',
      autonomyLevelApplied: 'L3',
      reason: budgetBreach,
      envelopeId: envelope.id,
    };
  }

  for (const rule of envelope.escalation_rules) {
    if (evaluateTrigger(rule.trigger, envelope, context)) {
      return {
        decision: levelToDecision(rule.level),
        autonomyLevelApplied: rule.level,
        reason: `escalation rule matched: ${rule.trigger} -> ${rule.level}`,
        envelopeId: envelope.id,
      };
    }
  }

  return {
    decision: levelToDecision(envelope.autonomy_default),
    autonomyLevelApplied: envelope.autonomy_default,
    reason: 'no escalation rule matched; applied envelope autonomy_default',
    envelopeId: envelope.id,
  };
}
