// scripts/052_seed_objection_playbook.ts
//
// Seeds objection_playbook by importing the LIVE OBJECTION_PLAYBOOK array
// rather than retyping its text — this is what makes "zero drift" a
// structural guarantee instead of a promise. Carrier-side entries are
// authored fresh: dispatch_one_v1.json (the file the base T-22 spec expected
// to source these from) is confirmed absent from this repository and not
// available to this session (see plan's Global Constraints) — same
// resolution already taken for lib/pricing/buy-envelope.ts's envelope math.

import { db } from '../lib/pipeline/db-adapter';
import { OBJECTION_PLAYBOOK } from '../lib/pipeline/objection-playbook';

interface CarrierObjectionSeed {
  type: string;
  label: string;
  response: string;
  followUpQuestion: string | null;
  escalateAfter: number;
}

const CARRIER_OBJECTIONS: CarrierObjectionSeed[] = [
  {
    type: 'already_committed',
    label: 'Already committed to another load',
    response: "I hear you — if your truck's already spoken for, no hard feelings. Can I ask when you'd next be open? I'd like to keep this lane in mind for you.",
    followUpQuestion: 'What does your availability look like later this week?',
    escalateAfter: 1,
  },
  {
    type: 'rate_too_low',
    label: 'Rate offered is too low',
    response: "I understand — let me see what I can do. I have a little room to move here given the lane and timing.",
    followUpQuestion: 'What rate would make this work for you today?',
    escalateAfter: 2,
  },
  {
    type: 'equipment_unavailable',
    label: 'Right equipment not available',
    response: "No problem — I appreciate you letting me know rather than stringing this out. Do you run this equipment type on other days I could plan around?",
    followUpQuestion: 'When would you have that equipment free next?',
    escalateAfter: 1,
  },
  {
    type: 'bad_lane_history',
    label: 'Carrier reports a bad experience on this lane before',
    response: "I'm sorry to hear that — that's not the experience we want you to have. Can you tell me a bit about what happened so I can make sure this run goes better?",
    followUpQuestion: 'Was that a facility issue, a detention issue, or something else?',
    escalateAfter: 1,
  },
  {
    type: 'need_more_info',
    label: 'Needs more load details before deciding',
    response: "Of course — happy to walk through the details. What would be most useful to know first: the facility appointment, the commodity, or the rate?",
    followUpQuestion: null,
    escalateAfter: 0,
  },
];

async function main(): Promise<void> {
  for (const [idx, source] of OBJECTION_PLAYBOOK.entries()) {
    await db.query(
      `INSERT INTO objection_playbook
         (counterparty_type, objection_type, objection_label, response, alternate_response, follow_up_question, escalate_after, priority, is_active)
       VALUES ('shipper', $1, $2, $3, NULL, $4, $5, $6, true)
       ON CONFLICT (counterparty_type, objection_type) DO UPDATE SET
         objection_label = EXCLUDED.objection_label, response = EXCLUDED.response,
         follow_up_question = EXCLUDED.follow_up_question, escalate_after = EXCLUDED.escalate_after`,
      [source.type, source.label, source.primary_response, source.follow_up_question, source.escalation_threshold, idx + 1],
    );
  }

  for (const [idx, c] of CARRIER_OBJECTIONS.entries()) {
    await db.query(
      `INSERT INTO objection_playbook
         (counterparty_type, objection_type, objection_label, response, alternate_response, follow_up_question, escalate_after, priority, is_active)
       VALUES ('carrier', $1, $2, $3, NULL, $4, $5, $6, true)
       ON CONFLICT (counterparty_type, objection_type) DO UPDATE SET
         objection_label = EXCLUDED.objection_label, response = EXCLUDED.response,
         follow_up_question = EXCLUDED.follow_up_question, escalate_after = EXCLUDED.escalate_after`,
      [c.type, c.label, c.response, c.followUpQuestion, c.escalateAfter, idx + 1],
    );
  }

  console.log(`Seeded ${OBJECTION_PLAYBOOK.length} shipper + ${CARRIER_OBJECTIONS.length} carrier objection_playbook rows.`);
}

main().catch((err) => {
  console.error('[052-seed] failed:', err);
  process.exit(1);
});
