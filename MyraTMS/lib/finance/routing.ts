//
// T-27 §5/§6.3 — reproduces Pilot 1's own T1-T4 routing table verbatim.
// Note: the routing table (§6.3) only lists 'Strong' payer credit for the
// non-decline routes, but the condition below (and the spec's own code)
// branches only on weak/unknown — 'acceptable' credit falls through to the
// same routes as 'strong'. Kept verbatim, not narrowed, since narrowing it
// would be inventing a rule Pilot 1's document doesn't state.
export type PayerCreditLevel = 'unknown' | 'weak' | 'acceptable' | 'strong';
export type Route = 'T1' | 'T2' | 'T3' | 'T4' | 'DECLINE';

export interface RouteDecisionInput {
  payerCreditLevel: PayerCreditLevel;
  carrierWantsQuickPay: boolean;
  floatCapacityAvailable: boolean;
}

export interface RouteDecisionResult {
  route: Route;
  reasoning: string;
}

export function decideRoute(input: RouteDecisionInput): RouteDecisionResult {
  if (input.payerCreditLevel === 'unknown' || input.payerCreditLevel === 'weak') {
    return { route: 'DECLINE', reasoning: 'Weak or unknown payer credit — neither floated nor factored, regardless of margin (Pilot 1 §6.3)' };
  }

  if (!input.carrierWantsQuickPay) {
    return { route: 'T1', reasoning: 'Strong payer, net-30 carrier — best margin and best facility use' };
  }

  if (input.floatCapacityAvailable) {
    return { route: 'T2', reasoning: 'Strong payer, fast-pay carrier, facility has slack — highest margin per load, deploy surplus capacity' };
  }
  return { route: 'T3', reasoning: 'Strong payer, fast-pay carrier, facility at capacity — factor to preserve capacity for T1 loads' };
}
