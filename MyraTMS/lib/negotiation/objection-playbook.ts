import { db } from '@/lib/pipeline/db-adapter';
import type { ObjectionPlaybookEntry } from './types';

interface ObjectionPlaybookRow {
  objection_type: string;
  objection_label: string;
  response: string;
  alternate_response: string | null;
  follow_up_question: string | null;
  escalate_after: number;
  priority: number;
}

export async function getObjectionPlaybook(
  counterpartyType: 'shipper' | 'carrier',
  knownObjectionTypes: string[],
): Promise<ObjectionPlaybookEntry[]> {
  const { rows } = await db.query<ObjectionPlaybookRow>(
    `SELECT objection_type, objection_label, response, alternate_response, follow_up_question, escalate_after, priority
       FROM objection_playbook
      WHERE counterparty_type = $1 AND is_active = true
      ORDER BY priority`,
    [counterpartyType],
  );

  const known = new Set(knownObjectionTypes);
  const sorted = [...rows].sort((a, b) => {
    const aKnown = known.has(a.objection_type) ? 0 : 1;
    const bKnown = known.has(b.objection_type) ? 0 : 1;
    return aKnown - bKnown;
  });

  return sorted.map((r, idx) => ({
    objectionType: r.objection_type,
    objectionLabel: r.objection_label,
    response: r.response,
    alternateResponse: r.alternate_response,
    followUpQuestion: r.follow_up_question,
    escalateAfter: r.escalate_after,
    priority: idx + 1,
  }));
}
