# T-12: CALL PARSER — TRANSCRIPT ANALYSIS SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

This document specifies the service that takes raw call transcripts from Retell AI and extracts structured data using Claude API. The parser is the bridge between voice and data — it turns a conversation into a machine-readable call result that drives the pipeline forward (book, decline, escalate, or callback).

---

## 1. Architecture

```
Retell AI → webhook → Call Parser → agent_calls table → pipeline stage advance
```

The parser runs as a webhook handler. When Retell completes a call, it sends a POST to the webhook URL with the transcript, recording URL, and call metadata. The parser:

1. Receives the webhook payload
2. Calls Claude API with the transcript + call context
3. Receives structured JSON back
4. Writes to `agent_calls` table
5. Updates `pipeline_loads` stage based on outcome
6. Enqueues next action (dispatch, callback, escalation, or nothing)

---

## 2. Retell Webhook Payload

The expected payload from Retell (fields may vary — adapt to actual Retell API):

```typescript
interface RetellWebhookPayload {
  call_id: string;
  agent_id: string;
  call_status: 'completed' | 'failed' | 'no_answer' | 'busy' | 'voicemail';
  from_number: string;
  to_number: string;
  duration_ms: number;
  start_time: string;
  end_time: string;
  transcript: string;
  recording_url: string | null;
  metadata: Record<string, any>;  // Contains our pipelineLoadId, briefId, etc.
  
  // Retell's own analysis (if available)
  call_analysis?: {
    sentiment: string;
    summary: string;
  };
}
```

---

## 3. Claude API Prompt for Extraction

### System Prompt

```
You are an expert freight brokerage call analyst. Your job is to analyze call transcripts between an AI freight broker agent and a shipper, and extract structured data.

You must return ONLY valid JSON matching the exact schema provided. No markdown, no preamble, no explanation — just the JSON object.

Be precise with rate extraction. If a rate is mentioned as "twenty-four hundred" that is 2400. If "two thousand four" that is 2400. If ambiguous, set final_rate to null and set confidence to the level of uncertainty.

Outcome definitions:
- "booked": Both parties explicitly agreed to a rate and the agent confirmed booking details
- "declined": Full conversation happened but shipper said no to the rate after negotiation
- "counter_pending": Shipper made a counter-offer that falls outside the agent's authority (below min_acceptable_rate)
- "callback": Shipper asked to be called back at a specific time
- "voicemail": Agent reached voicemail
- "no_answer": Phone rang with no answer and no voicemail
- "wrong_contact": Reached someone who is not the decision-maker
- "escalated": Conversation hit a scenario the agent couldn't handle
- "dropped": Call dropped or had technical issues
```

### User Prompt Template

```
Analyze this freight broker call transcript and extract the data as JSON.

CALL CONTEXT:
- Call Type: {{call_type}}
- Load ID: {{load_id}}
- Lane: {{origin_city}}, {{origin_state}} → {{destination_city}}, {{destination_state}}
- Equipment: {{equipment_type}}
- Initial Offer: ${{initial_offer}} {{currency}}
- Min Acceptable Rate: ${{min_acceptable_rate}} {{currency}}
- Persona Used: {{persona}}
- Language: {{language}}

TRANSCRIPT:
{{transcript}}

RETURN THIS EXACT JSON STRUCTURE:
{
  "outcome": "booked | declined | counter_pending | callback | voicemail | no_answer | wrong_contact | escalated | dropped",
  "final_rate": <number or null>,
  "final_rate_currency": "CAD | USD",
  "profit": <number or null>,
  "profit_tier": "excellent | good | acceptable | below_minimum | null",
  "auto_book_eligible": <boolean>,
  "objections": ["array of objection types encountered"],
  "concessions_made": <number 0-3>,
  "sentiment": "positive | neutral | negative",
  "confidence": <0.0 to 1.0>,
  "next_action": "send_confirmation | schedule_callback | escalate_human | retry_later | add_to_dnc | no_action",
  "callback_details": {
    "requested": <boolean>,
    "day": "<string or null>",
    "time": "<string or null>",
    "timezone": "<string or null>"
  },
  "decision_maker_referral": {
    "provided": <boolean>,
    "name": "<string or null>",
    "phone": "<string or null>",
    "email": "<string or null>"
  },
  "shipper_intel": {
    "weekly_volume": "<string or null>",
    "primary_lanes": ["array of lane descriptions or empty"],
    "current_broker": "<string or null>",
    "facility_notes": "<string or null>",
    "pain_points": ["array or empty"]
  },
  "analysis_notes": "<one sentence summary of what happened on the call>"
}
```

### Claude API Call Configuration

```typescript
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1000,
  system: SYSTEM_PROMPT,
  messages: [
    { role: 'user', content: userPrompt }
  ],
});

// Parse response — Claude returns the JSON directly
const parsed = JSON.parse(
  response.content[0].text.replace(/```json|```/g, '').trim()
);
```

**Model choice:** Claude Sonnet for cost efficiency. Call parsing is structured extraction, not creative reasoning. Sonnet handles this at 95%+ accuracy with 3–5x cost savings over Opus.

---

## 4. Output Schema Validation

After parsing, validate the output before writing to database:

```typescript
interface CallResult {
  outcome: 'booked' | 'declined' | 'counter_pending' | 'callback' | 
           'voicemail' | 'no_answer' | 'wrong_contact' | 'escalated' | 'dropped';
  final_rate: number | null;
  final_rate_currency: 'CAD' | 'USD' | null;
  profit: number | null;
  profit_tier: 'excellent' | 'good' | 'acceptable' | 'below_minimum' | null;
  auto_book_eligible: boolean;
  objections: string[];
  concessions_made: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  next_action: 'send_confirmation' | 'schedule_callback' | 'escalate_human' | 
               'retry_later' | 'add_to_dnc' | 'no_action';
  callback_details: {
    requested: boolean;
    day: string | null;
    time: string | null;
    timezone: string | null;
  };
  decision_maker_referral: {
    provided: boolean;
    name: string | null;
    phone: string | null;
    email: string | null;
  };
  shipper_intel: {
    weekly_volume: string | null;
    primary_lanes: string[];
    current_broker: string | null;
    facility_notes: string | null;
    pain_points: string[];
  };
  analysis_notes: string;
}
```

### Validation Rules

| Field | Rule | Action if Invalid |
|---|---|---|
| outcome | Must be one of valid enum values | Reject, log error, escalate |
| final_rate | If outcome is "booked", must not be null | Reject, escalate for human review |
| final_rate | If not null, must be positive number | Reject, log error |
| profit | If final_rate is set: profit = final_rate - totalCost from brief | Recompute, don't trust Claude's math |
| auto_book_eligible | Must match: profit >= minMargin from brief | Recompute based on actual profit |
| confidence | Must be 0.0 to 1.0 | Clamp to range |
| concessions_made | Must be 0 to maxConcessions from brief | Clamp to range |

**Critical rule: Never trust Claude's profit calculation.** Always recompute profit from the agreed rate and the cost data in the negotiation brief. Claude extracts the rate accurately but may compute profit incorrectly.

```typescript
// Always recompute profit
if (parsed.final_rate !== null) {
  const brief = await getBriefByPipelineLoadId(pipelineLoadId);
  parsed.profit = parsed.final_rate - brief.rates.totalCost;
  parsed.profit_tier = 
    parsed.profit >= 500 ? 'excellent' :
    parsed.profit >= 350 ? 'good' :
    parsed.profit >= 200 ? 'acceptable' : 'below_minimum';
  parsed.auto_book_eligible = parsed.profit >= brief.rates.minMargin;
}
```

---

## 5. Post-Parse Pipeline Actions

Based on the parsed outcome, the call parser triggers the appropriate next step:

| Outcome | Pipeline Stage | Next Action |
|---|---|---|
| booked + auto_book_eligible | `booked` | Enqueue to dispatch-queue |
| booked + NOT auto_book_eligible | `escalated` | Notify Patrice for manual review |
| counter_pending | `escalated` | Notify Patrice with counter details |
| declined | `declined` | Update shipper_preferences, increment fatigue |
| callback | `calling` (stays) | Create delayed job in callback-queue |
| voicemail | `calling` (stays) | If attempts < max: retry in 2 hours. Else: `declined` |
| no_answer | `calling` (stays) | If attempts < max: retry in 1 hour. Else: `declined` |
| wrong_contact | `escalated` | If referral provided: create new outreach. Else: `declined` |
| escalated | `escalated` | Notify Patrice with full context |
| dropped | `calling` (stays) | Retry immediately (1 attempt max) |

---

## 6. Shipper Intelligence Extraction

The parser captures valuable intelligence from every call, even failed ones. This data feeds into:

- **shipper_preferences table:** Language, currency, contact time preferences
- **lane_stats table:** Rate intelligence, objection patterns
- **shipper directory (TMS):** Company info, volume estimates, pain points

After every call, regardless of outcome:

```typescript
// Update shipper preferences
await db.query(`
  INSERT INTO shipper_preferences (phone, preferred_language, total_calls_received, last_objection_type)
  VALUES ($1, $2, 1, $3)
  ON CONFLICT (phone) DO UPDATE SET
    total_calls_received = shipper_preferences.total_calls_received + 1,
    last_objection_type = $3,
    updated_at = NOW()
`, [phone, language, parsed.objections[0] || null]);

// If booked, update booking stats
if (parsed.outcome === 'booked') {
  await db.query(`
    UPDATE shipper_preferences SET
      total_bookings = total_bookings + 1,
      avg_agreed_rate = (avg_agreed_rate * (total_bookings - 1) + $1) / total_bookings
    WHERE phone = $2
  `, [parsed.final_rate, phone]);
}
```

---

## 7. Accuracy Targets

| Metric | Target | Measurement |
|---|---|---|
| Outcome classification | 95%+ | Manual review of 50 calls/month |
| Rate extraction (when booked) | 98%+ | Compare parsed rate vs. rate con |
| Objection detection | 90%+ | Manual transcript review |
| Sentiment accuracy | 85%+ | Manual review |
| Decision-maker referral extraction | 95%+ | Check if name/phone captured when given |

### Accuracy Monitoring

Weekly: randomly sample 10 calls. Compare parsed results against manual transcript review. Track accuracy per field. If any field drops below target, review and update the Claude prompt.

---

## 8. Multi-Language Support

The parser handles English and French transcripts. The system prompt is always in English (Claude processes both). The user prompt includes `Language: {{language}}` to set context.

For French calls:
- Rate extraction works identically (numbers are language-agnostic)
- Objection classification may need French-specific examples in the prompt if accuracy drops
- Sentiment analysis adapts to French conversational norms

Future languages (Mandarin, Punjabi, Spanish) require prompt testing with sample transcripts before deployment.

---

## 9. Error Handling

| Error | Action |
|---|---|
| Claude API timeout | Retry once after 10s. If still fails: store transcript, mark as `parsing_failed`, retry in nightly batch |
| Claude returns invalid JSON | Attempt to clean (strip markdown, fix quotes). If still invalid: manual review |
| Claude returns confidence < 0.5 | Auto-escalate to human review regardless of outcome |
| Retell webhook missing transcript | Log the call with outcome `dropped`, attempt to fetch transcript from Retell API |
| Rate extraction ambiguous | Set final_rate to null, set next_action to `escalate_human` |

---

*End of document. The parser turns conversations into data. Accuracy here determines the entire pipeline's intelligence.*
