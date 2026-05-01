/**
 * persona-selector.ts
 * Thompson Sampling for voice persona selection
 * Used by compiler-worker and feedback-worker
 * ~80 lines of pure math wrapped in types
 */

/**
 * PersonaStats — The raw stats we pull from the personas table
 */
export interface PersonaStats {
  id: number;
  persona_name: string;
  alpha: number;
  beta: number;
  total_calls: number;
}

/**
 * SelectedPersona — The winning persona + the Thompson sample value
 */
export interface SelectedPersona {
  persona_name: string;
  persona_id: number;
  sampled_value: number;
}

/**
 * sampleBeta
 * Sample from Beta(alpha, beta) distribution using Jöhnk rejection sampling
 * Simple, pure algorithm. No external library.
 *
 * @param alpha Shape parameter α (success count + 1)
 * @param beta Shape parameter β (failure count + 1)
 * @returns Random draw from Beta(alpha, beta) on [0, 1]
 */
export function sampleBeta(alpha: number, beta: number): number {
  // Jöhnk algorithm for Beta(alpha, beta)
  // Rejection-based, works well for typical persona stats (α, β in [1, 20])

  const a = alpha;
  const b = beta;

  while (true) {
    // Generate two uniform random variates
    const u1 = Math.random();
    const u2 = Math.random();

    // Transform via power
    const x = Math.pow(u1, 1 / a);
    const y = Math.pow(u2, 1 / b);

    // Check acceptance condition
    if (x + y <= 1) {
      // Accept: return normalized sample
      return x / (x + y);
    }
    // Reject: loop again
  }
}

/**
 * selectPersona
 * Thompson Sampling: sample from Beta(α, β) for each persona, return highest
 *
 * @param personas Array of PersonaStats from the database
 * @returns The winning persona and its sampled value
 */
export function selectPersona(personas: PersonaStats[]): SelectedPersona {
  if (personas.length === 0) {
    throw new Error("selectPersona: no personas provided");
  }

  let winner: SelectedPersona | null = null;
  let maxSample = -1;

  for (const persona of personas) {
    const sample = sampleBeta(persona.alpha, persona.beta);
    if (sample > maxSample) {
      maxSample = sample;
      winner = {
        persona_name: persona.persona_name,
        persona_id: persona.id,
        sampled_value: sample,
      };
    }
  }

  return winner!;
}

/**
 * updatePersonaStats
 * Update alpha and beta based on call outcome
 *
 * @param alpha Current alpha (successes + 1)
 * @param beta Current beta (failures + 1)
 * @param outcome The call outcome
 * @returns Updated { alpha, beta }
 */
export function updatePersonaStats(
  alpha: number,
  beta: number,
  outcome: "booked" | "declined" | "callback" | "no_answer"
): { alpha: number; beta: number } {
  switch (outcome) {
    case "booked":
      // Success: increment alpha
      return { alpha: alpha + 1, beta };

    case "declined":
      // Failure: increment beta
      return { alpha, beta: beta + 1 };

    case "callback":
      // Partial success: split credit
      return {
        alpha: alpha + 0.3,
        beta: beta + 0.3,
      };

    case "no_answer":
      // Failure: slight increment to beta
      return {
        alpha,
        beta: beta + 0.5,
      };

    default:
      // Exhaustive check at compile time
      const _exhaustive: never = outcome;
      return _exhaustive;
  }
}
