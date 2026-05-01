/**
 * OBJECTION PLAYBOOK
 * Myra Logistics — Voice Agent Conversation Playbook
 *
 * This is a typed constant array of all objection types with scripted responses.
 * Source: C-04: Voice Agent Conversation Playbook
 *
 * Each objection entry maps to a Retell AI agent configuration node.
 * The voice agent uses this lookup to respond to shipper objections during calls.
 */

export interface ObjectionEntry {
  /**
   * Machine-readable objection type identifier
   * Used as lookup key in negotiation_brief.objectionPlaybook
   */
  type: string;

  /**
   * Human-readable label for dashboards and reporting
   */
  label: string;

  /**
   * Phrases the shipper might say that indicate this objection.
   * Used by matchObjection() for transcript keyword matching.
   */
  detection_phrases: string[];

  /**
   * The scripted response the agent should deliver when this objection arises.
   * Extracted directly from C-04 node scripts.
   */
  primary_response: string;

  /**
   * The follow-up question to ask after delivering the response.
   * Keeps the conversation progressing and gathers more information.
   */
  follow_up_question: string;

  /**
   * How many times this objection can be raised before escalating.
   * 0 = never escalate (agent should negotiate)
   * 1 = escalate after 1st raise
   * 2 = escalate after 2nd raise
   * 3 = escalate after 3rd raise
   */
  escalation_threshold: number;

  /**
   * Severity classification for filtering and prioritization.
   * 'soft' = easy to overcome (e.g., "call me back later")
   * 'medium' = moderate difficulty (e.g., "already have a broker")
   * 'hard' = difficult to overcome (e.g., "don't use brokers")
   */
  severity: "soft" | "medium" | "hard";

  /**
   * Strategic concession to offer if applicable.
   * For rate objections: could be "lower rate" or "flexibility on appointment"
   * For other objections: null if no concession strategy applies
   */
  recommended_concession: string | null;
}

/**
 * Complete objection playbook with all 9 objection types.
 * Source: C-04 Voice Agent Conversation Playbook, Part 4, Nodes 3.2.1–4.8
 */
export const OBJECTION_PLAYBOOK: ObjectionEntry[] = [
  {
    type: "rate_too_high",
    label: "Rate Too High",
    detection_phrases: [
      "too expensive",
      "too high",
      "can you lower",
      "can you come down",
      "that's more than",
      "we can't afford",
      "what's your best rate",
      "price is too much",
      "the rate is high",
    ],
    primary_response:
      "I understand that price is a major factor. While you might find a cheaper rate out there, our focus is on providing reliable service with vetted carriers to ensure your load is delivered on time and without issues. We don't just find the cheapest truck — we find the best truck for the job. That's the value we bring. Can we work together on this rate?",
    follow_up_question: "What rate would work for you?",
    escalation_threshold: 3,
    severity: "medium",
    recommended_concession: "lower rate in exchange for flexibility on pickup time",
  },

  {
    type: "better_offer",
    label: "Better Offer",
    detection_phrases: [
      "i have a better offer",
      "i got a quote",
      "someone quoted me",
      "another broker quoted",
      "i have a lower rate",
      "someone else offered",
      "i received an offer",
      "better rate elsewhere",
    ],
    primary_response:
      "I appreciate you sharing that. It's smart to shop around. While I can't always match every rate, I can guarantee a high level of service and communication. Are you confident that the other offer comes with a reliable carrier and the peace of mind that we provide?",
    follow_up_question:
      "Can you tell me who made that offer and what their rate was?",
    escalation_threshold: 3,
    severity: "medium",
    recommended_concession: "match or beat their rate if within margin threshold",
  },

  {
    type: "already_have_carrier",
    label: "Already Have a Broker/Carrier",
    detection_phrases: [
      "we already have a broker",
      "we have a carrier",
      "we work with someone",
      "we have a partner",
      "we use someone already",
      "we're set",
      "we have capacity",
      "our carrier handles this",
    ],
    primary_response:
      "That's great to hear you have a reliable partner. We aim to build long-term relationships, and we'd love to be a backup option for you. There will likely come a time when your go-to carrier is unavailable or you have a last-minute shipment, and we'd be happy to step in. Can I send you my contact information for future reference?",
    follow_up_question:
      "What lanes does your current broker or carrier primarily cover?",
    escalation_threshold: 0,
    severity: "soft",
    recommended_concession: null,
  },

  {
    type: "dont_use_brokers",
    label: "We Don't Use Brokers",
    detection_phrases: [
      "we don't use brokers",
      "we don't work with brokers",
      "we avoid middlemen",
      "we go direct",
      "brokers are middlemen",
      "we handle it ourselves",
      "no brokers",
      "bad experience with brokers",
    ],
    primary_response:
      "I understand that some shippers have had negative experiences with brokers in the past. We see ourselves as a transportation partner, not just a middleman. We provide access to a network of vetted, reliable carriers and manage the entire process for you. Would you be open to trying our service for this one load to see the difference?",
    follow_up_question:
      "What was the negative experience you had with a broker before?",
    escalation_threshold: 2,
    severity: "hard",
    recommended_concession: "trial booking with service guarantee",
  },

  {
    type: "not_decision_maker",
    label: "Not the Decision-Maker",
    detection_phrases: [
      "i'm not the right person",
      "you need to talk to",
      "that's not my department",
      "let me transfer you",
      "ask for the manager",
      "someone else handles this",
      "i don't make that decision",
      "you want operations",
    ],
    primary_response:
      "No problem at all. Could you please point me in the right direction? I'd be happy to reach out to the person who handles your transportation needs. What's the best way to get in touch with them?",
    follow_up_question: "What's their name and phone number?",
    escalation_threshold: 0,
    severity: "soft",
    recommended_concession: null,
  },

  {
    type: "call_back_later",
    label: "Call Me Back Later",
    detection_phrases: [
      "call me back",
      "i'm busy right now",
      "can you call later",
      "not a good time",
      "call next week",
      "i can't talk now",
      "call me at a different time",
      "i'm in the middle of something",
    ],
    primary_response:
      "I understand you're busy right now. When would be a better time for me to call back? I can put it on my calendar to make sure I reach you at a convenient time.",
    follow_up_question:
      "What specific day and time would work best for you to discuss this?",
    escalation_threshold: 2,
    severity: "soft",
    recommended_concession: null,
  },

  {
    type: "send_email",
    label: "Send Me an Email",
    detection_phrases: [
      "send me an email",
      "email me the details",
      "i prefer email",
      "email it over",
      "send me information",
      "i'll read it in email",
      "let me get that via email",
    ],
    primary_response:
      "Absolutely. What's the best email? I'll send a short, tailored overview. Will you actually look at it, or will it sit with 500 others? I ask because I'd rather have a 2-minute conversation now than send something that gets lost.",
    follow_up_question: "Are you open to a quick conversation about this load?",
    escalation_threshold: 1,
    severity: "soft",
    recommended_concession: null,
  },

  {
    type: "handle_internally",
    label: "We Handle Everything Internally",
    detection_phrases: [
      "we handle everything internally",
      "we manage it ourselves",
      "we have an internal team",
      "we don't need outside help",
      "we do it in-house",
      "we're self-sufficient",
      "we don't outsource",
    ],
    primary_response:
      "That's impressive — you're running a tight ship. Let me ask: what happens when you're overloaded, or a lane opens up that you can't cover? We're not looking to replace your internal team — just to be that extra support when you need it.",
    follow_up_question:
      "Do you ever have times when you're overloaded or need backup capacity?",
    escalation_threshold: 0,
    severity: "medium",
    recommended_concession: null,
  },

  {
    type: "needs_covered",
    label: "Our Needs Are Covered",
    detection_phrases: [
      "our needs are covered",
      "we're all set",
      "we don't need anything",
      "we have capacity",
      "we're good",
      "we don't have demand",
      "not looking for carriers",
    ],
    primary_response:
      "I hear you. Let me share a quick story — we had a similar client whose carrier canceled last minute on a critical load. Because they had us in their corner as a backup, they were covered in 30 minutes. No scramble, no stress. Can I be that option for you?",
    follow_up_question:
      "Have you ever had a carrier cancel or become unavailable last minute?",
    escalation_threshold: 0,
    severity: "soft",
    recommended_concession: null,
  },
];

/**
 * Helper: Get objection entry by type string
 * @param type - The objection type identifier (e.g., "rate_too_high")
 * @returns ObjectionEntry if found, undefined otherwise
 */
export function getObjectionByType(
  type: string
): ObjectionEntry | undefined {
  return OBJECTION_PLAYBOOK.find((obj) => obj.type === type);
}

/**
 * Helper: Match a transcript fragment against detection phrases
 * Simple keyword matching to identify objection type from shipper speech
 * @param transcript - A phrase or sentence from the shipper
 * @returns ObjectionEntry if a match is found, null otherwise
 */
export function matchObjection(transcript: string): ObjectionEntry | null {
  if (!transcript) return null;

  const lowerTranscript = transcript.toLowerCase();

  for (const objection of OBJECTION_PLAYBOOK) {
    for (const phrase of objection.detection_phrases) {
      if (lowerTranscript.includes(phrase.toLowerCase())) {
        return objection;
      }
    }
  }

  return null;
}

/**
 * Brief summary of an objection for inclusion in negotiation brief
 */
export interface BriefObjectionSummary {
  objectionType: string;
  response: string;
  followUpQuestion: string;
  escalateAfter: number;
}

/**
 * Helper: Get condensed objection summaries for negotiation brief
 * Extracts only the fields needed by the voice agent during the call
 * @returns Array of BriefObjectionSummary objects
 */
export function getObjectionsForBrief(): BriefObjectionSummary[] {
  return OBJECTION_PLAYBOOK.map((objection) => ({
    objectionType: objection.type,
    response: objection.primary_response,
    followUpQuestion: objection.follow_up_question,
    escalateAfter: objection.escalation_threshold,
  }));
}
