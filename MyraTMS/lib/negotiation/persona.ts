import { db } from '@/lib/pipeline/db-adapter';
import { selectPersona, type PersonaStats } from '@/lib/pipeline/persona-selector';
import { logger } from '@/lib/logger';

const CALL_TYPE_FOR_DIRECTION: Record<'sell' | 'buy', string> = {
  sell: 'outbound_shipper',
  buy: 'outbound_carrier',
};

export interface SelectedPersonaResult {
  personaName: string;
  retellAgentId: string | null;
  sampledValue: number;
}

export async function selectPersonaForDirection(
  direction: 'sell' | 'buy'
): Promise<SelectedPersonaResult> {
  const callType = CALL_TYPE_FOR_DIRECTION[direction];

  const result = await db.query<
    PersonaStats & { retell_agent_id_en: string | null; retell_agent_id_fr: string | null }
  >(
    `SELECT id, persona_name, alpha::numeric AS alpha, beta::numeric AS beta,
            total_calls, retell_agent_id_en, retell_agent_id_fr
       FROM personas
      WHERE is_active = true AND call_type = '${callType}'`
  );

  if (result.rows.length === 0) {
    throw new Error(`No active personas for call_type=${callType} — cannot select`);
  }

  const stats: PersonaStats[] = result.rows.map((r) => ({
    id: r.id,
    persona_name: r.persona_name,
    alpha: Number(r.alpha),
    beta: Number(r.beta),
    total_calls: r.total_calls,
  }));

  const winner = selectPersona(stats);
  const winnerRow = result.rows.find((r) => r.id === winner.persona_id);
  const retellAgentId = winnerRow?.retell_agent_id_en ?? null;
  if (!retellAgentId) {
    logger.warn(
      `[negotiation/persona] Persona ${winner.persona_name} (${callType}) has no retell_agent_id_en configured`
    );
  }

  return {
    personaName: winner.persona_name,
    retellAgentId,
    sampledValue: winner.sampled_value,
  };
}
