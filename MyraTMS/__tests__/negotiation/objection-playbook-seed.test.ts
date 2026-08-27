import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { OBJECTION_PLAYBOOK } from '@/lib/pipeline/objection-playbook';

describe('objection_playbook seed — zero drift', () => {
  it('has all 9 shipper entries matching the live OBJECTION_PLAYBOOK verbatim', async () => {
    const { rows } = await db.query<{
      objection_type: string; response: string; follow_up_question: string | null; escalate_after: number;
    }>(`SELECT objection_type, response, follow_up_question, escalate_after FROM objection_playbook WHERE counterparty_type = 'shipper'`);

    expect(rows.length).toBe(OBJECTION_PLAYBOOK.length);
    for (const source of OBJECTION_PLAYBOOK) {
      const row = rows.find((r) => r.objection_type === source.type);
      expect(row, `missing seeded row for ${source.type}`).toBeDefined();
      expect(row!.response).toBe(source.primary_response);
      expect(row!.follow_up_question).toBe(source.follow_up_question);
      expect(row!.escalate_after).toBe(source.escalation_threshold);
    }
  });

  it('has exactly 5 new carrier entries', async () => {
    const { rows } = await db.query<{ objection_type: string }>(
      `SELECT objection_type FROM objection_playbook WHERE counterparty_type = 'carrier'`,
    );
    const types = rows.map((r) => r.objection_type).sort();
    expect(types).toEqual(
      ['already_committed', 'bad_lane_history', 'equipment_unavailable', 'need_more_info', 'rate_too_low'].sort(),
    );
  });
});
