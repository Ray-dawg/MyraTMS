# T-09: AGENT 6 — VOICE AGENT (RETELL AI) INTEGRATION SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

Agent 6 is the only agent that interacts with the outside world. It receives a negotiation brief from Agent 5, initiates a phone call via Retell AI, and returns a structured call result. This document specifies the complete Retell AI integration: agent configuration, dynamic context injection, function calls, webhook handling, and concurrency management.

**T-01 confirms:** Retell AI is not referenced anywhere in the current codebase. This is entirely new infrastructure.

---

## 1. Retell AI Account Setup

### Agents to Create

| Agent | Persona | Language | Retell Agent ID |
|---|---|---|---|
| Myra Assertive EN | Direct, confident, efficient | English | `agent_assertive_en_001` |
| Myra Assertive FR | Direct, confiant, efficace | French | `agent_assertive_fr_001` |
| Myra Friendly EN | Warm, personable, conversational | English | `agent_friendly_en_001` |
| Myra Friendly FR | Chaleureux, authentique, conversationnel | French | `agent_friendly_fr_001` |
| Myra Analytical EN | Precise, data-driven, methodical | English | `agent_analytical_en_001` |
| Myra Analytical FR | Précis, logique, méthodique | French | `agent_analytical_fr_001` |

Total: 6 Retell agents (3 personas × 2 languages).

### Phone Numbers

Provision Canadian numbers through Retell (or Twilio as backup):
- At least 2 outbound numbers to rotate (prevents carrier ID fatigue)
- Area code: 416 (Toronto) or 705 (Sudbury/Northern Ontario)

---

## 2. Dynamic Context Injection

Every Retell call receives the negotiation brief as dynamic variables. The brief is injected via Retell's API when initiating the call.

### Call Initiation

```typescript
// /lib/workers/voice.worker.ts

async function initiateRetellCall(brief: NegotiationBrief): Promise<string> {
  const response = await fetch('https://api.retellai.com/v2/create-phone-call', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: selectOutboundNumber(),
      to_number: brief.shipper.phone,
      agent_id: brief.persona.retellAgentId,
      
      // Dynamic variables injected into the agent's prompt
      retell_llm_dynamic_variables: {
        agent_name: 'Sarah',  // Consistent human-sounding name
        brokerage_name: 'Myra Logistics',
        load_id: brief.load.loadId,
        load_board_source: brief.load.loadBoardSource,
        pickup_city: brief.load.origin.city,
        pickup_state: brief.load.origin.state,
        delivery_city: brief.load.destination.city,
        delivery_state: brief.load.destination.state,
        pickup_date: brief.load.pickupDate,
        delivery_date: brief.load.deliveryDate || 'flexible',
        equipment_type: brief.load.equipmentType,
        initial_rate: brief.negotiation.initialOffer.toString(),
        concession_step_1: brief.negotiation.concessionStep1.toString(),
        concession_step_2: brief.negotiation.concessionStep2.toString(),
        final_offer: brief.negotiation.finalOffer.toString(),
        min_acceptable_rate: brief.negotiation.walkAwayRate.toString(),
        floor_rate: brief.rates.marketRateFloor.toString(),
        mid_rate: brief.rates.marketRateMid.toString(),
        best_rate: brief.rates.marketRateBest.toString(),
        currency: brief.rates.currency,
        strategy: brief.strategy.approach,
        walk_away_script: brief.negotiation.walkAwayScript,
        disclosure_script: brief.compliance.disclosureScript || '',
      },
      
      // Metadata passed through to webhook
      metadata: {
        pipelineLoadId: brief.meta.pipelineLoadId,
        briefId: brief.meta.briefId,
        persona: brief.persona.personaName,
        language: brief.callConfig.language,
        currency: brief.rates.currency,
      },
    }),
  });
  
  const data = await response.json();
  return data.call_id;
}
```

### Retell Agent Prompt Template (Friendly EN — Primary)

The prompt template is stored in the `personas` table and configured in Retell's agent settings. Dynamic variables are injected per call via `{{variable_name}}` syntax.

```
You are a friendly, warm freight broker named {{agent_name}} calling from {{brokerage_name}}. You are calling about a specific load posted on a load board.

{{disclosure_script}}

CRITICAL RULES:
1. Reference load ID {{load_id}} and specific lane details in your opening.
2. Your goal is to negotiate a rate of at least ${{min_acceptable_rate}} {{currency}}.
3. Start with an initial offer of ${{initial_rate}} {{currency}}.
4. You can make up to 3 concessions: ${{concession_step_1}}, then ${{concession_step_2}}, then ${{final_offer}}.
5. NEVER go below ${{min_acceptable_rate}} {{currency}}.
6. If they want lower than ${{min_acceptable_rate}}: "{{walk_away_script}}"
7. Always confirm details before booking: lane, rate, pickup date, email for rate confirmation.
8. If asked to call back, get a SPECIFIC day and time.
9. If they say they're not the right person, ask for the correct contact's name and phone.

CONTEXT:
- Load: {{equipment_type}} from {{pickup_city}}, {{pickup_state}} to {{delivery_city}}, {{delivery_state}}
- Pickup: {{pickup_date}}
- Market rates: ${{floor_rate}} to ${{best_rate}} {{currency}}
- Strategy: {{strategy}}

OPENING:
"Hi! This is {{agent_name}} from {{brokerage_name}}. How's your day going? I'm reaching out about load {{load_id}} — the {{equipment_type}} from {{pickup_city}} to {{delivery_city}}. Are you the person I should talk to?"

[Build rapport — ask about load requirements and facility conditions]

"Based on current market conditions, I can move this for ${{initial_rate}} {{currency}} all-in. What do you think?"

HANDLING "RATE TOO HIGH":
"I totally understand — price is important. Let me ask: what matters most beyond rate? On-time delivery? Communication? Because while we might not always be cheapest, our shippers stay with us for reliability."

BOOKING CONFIRMATION:
"Excellent. So to confirm: {{equipment_type}} from {{pickup_city}} to {{delivery_city}}, picking up {{pickup_date}}, for $[AGREED_RATE] {{currency}} all-in. I'll send the rate confirmation right away. What's the best email?"

TONE: Warm, genuine, conversational. Build rapport first. Listen twice as much as you talk.
```

---

## 3. Retell Function Calls

Functions allow the agent to trigger MyraTMS actions during the call.

### Function 1: send_rate_confirmation

Called when the shipper confirms booking and provides email.

```typescript
// Retell function definition
{
  name: 'send_rate_confirmation',
  description: 'Send the rate confirmation document to the shipper via email',
  parameters: {
    type: 'object',
    properties: {
      shipper_email: { type: 'string', description: 'Email address for rate confirmation' },
      agreed_rate: { type: 'number', description: 'The final agreed rate' },
    },
    required: ['shipper_email', 'agreed_rate']
  }
}

// MyraTMS endpoint called by Retell
// POST /api/webhooks/retell-function
// Reuses existing rate con PDF generation from /api/loads/[id]/assign
```

### Function 2: schedule_follow_up

Called when the shipper requests a callback at a specific time.

```typescript
{
  name: 'schedule_follow_up',
  description: 'Schedule a follow-up call at a specific date and time',
  parameters: {
    type: 'object',
    properties: {
      follow_up_day: { type: 'string', description: 'Day for callback (e.g., Monday, Tuesday)' },
      follow_up_time: { type: 'string', description: 'Time for callback (e.g., 2:00 PM)' },
    },
    required: ['follow_up_day', 'follow_up_time']
  }
}
```

### Function 3: get_shipper_info (optional)

Called if the agent needs to look up additional shipper data mid-call. Rarely needed since the brief is pre-loaded.

---

## 4. Webhook Handler

When Retell completes a call, it sends a POST to the configured webhook URL.

```typescript
// /app/api/webhooks/retell-callback/route.ts

export async function POST(request: Request) {
  const payload: RetellWebhookPayload = await request.json();
  
  // Verify webhook authenticity (Retell signature or API key check)
  if (!verifyRetellSignature(request, payload)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  const { pipelineLoadId, briefId, persona, language, currency } = payload.metadata;
  
  // Update pipeline_loads call tracking
  await db.query(`
    UPDATE pipeline_loads SET
      call_attempts = call_attempts + 1,
      last_call_at = NOW()
    WHERE id = $1
  `, [pipelineLoadId]);
  
  // Handle non-conversation outcomes immediately
  if (['no_answer', 'busy', 'voicemail'].includes(payload.call_status)) {
    await handleNonConversation(pipelineLoadId, payload);
    return Response.json({ processed: true });
  }
  
  // For completed calls: parse transcript via Claude API (T-12)
  const brief = await db.query('SELECT brief FROM negotiation_briefs WHERE id = $1', [briefId]);
  const callResult = await parseCallTranscript(payload.transcript, brief.rows[0].brief, payload);
  
  // Write to agent_calls table
  await db.query(`
    INSERT INTO agent_calls (
      call_id, pipeline_load_id, call_type, persona, language, currency,
      retell_call_id, retell_agent_id, phone_number_called,
      call_initiated_at, call_ended_at, duration_seconds,
      negotiation_brief_id, initial_offer, min_acceptable_rate, target_rate,
      outcome, agreed_rate, profit, profit_tier, auto_book_eligible,
      sentiment, objections, concessions_made,
      next_action, callback_scheduled_at,
      decision_maker_name, decision_maker_phone, decision_maker_email,
      transcript, recording_url, call_analysis, call_quality_score
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
  `, [/* all params from payload + callResult */]);
  
  // Advance pipeline based on outcome (logic from T-12 Section 5)
  await advancePipeline(pipelineLoadId, callResult, briefId);
  
  // Update shipper preferences
  await updateShipperPreferences(payload.to_number, callResult, persona);
  
  // Update persona metrics for Thompson Sampling
  await updatePersonaMetrics(persona, callResult);
  
  return Response.json({ processed: true, outcome: callResult.outcome });
}
```

### Non-Conversation Handler

```typescript
async function handleNonConversation(pipelineLoadId: number, payload: RetellWebhookPayload) {
  const maxAttempts = 2;
  const load = await db.query('SELECT call_attempts FROM pipeline_loads WHERE id = $1', [pipelineLoadId]);
  
  if (load.rows[0].call_attempts < maxAttempts) {
    // Retry: re-enqueue to call-queue with delay
    const delay = payload.call_status === 'no_answer' ? 3600000 : 1800000; // 1h or 30min
    await callQueue.add('retry-call', { pipelineLoadId }, { delay });
  } else {
    // Max attempts reached — mark as declined
    await db.query(`
      UPDATE pipeline_loads SET stage = 'declined', stage_updated_at = NOW()
      WHERE id = $1
    `, [pipelineLoadId]);
  }
}
```

---

## 5. Pipeline Advancement Logic

```typescript
async function advancePipeline(pipelineLoadId: number, result: CallResult, briefId: number) {
  switch (result.outcome) {
    case 'booked':
      if (result.auto_book_eligible) {
        await db.query("UPDATE pipeline_loads SET stage = 'booked', stage_updated_at = NOW(), agreed_rate = $2, profit = $3, auto_booked = true, booked_at = NOW() WHERE id = $1",
          [pipelineLoadId, result.final_rate, result.profit]);
        await dispatchQueue.add('dispatch', buildDispatchPayload(pipelineLoadId, result, briefId));
      } else {
        await db.query("UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW(), agreed_rate = $2, profit = $3 WHERE id = $1",
          [pipelineLoadId, result.final_rate, result.profit]);
        await escalationQueue.add('review', { pipelineLoadId, reason: 'Booked below auto-book threshold', profit: result.profit });
      }
      break;
      
    case 'declined':
      await db.query("UPDATE pipeline_loads SET stage = 'declined', stage_updated_at = NOW(), call_outcome = 'declined' WHERE id = $1", [pipelineLoadId]);
      break;
      
    case 'callback':
      if (result.callback_details.requested && result.callback_details.day) {
        const callbackTime = parseCallbackTime(result.callback_details);
        await callbackQueue.add('callback', { pipelineLoadId, briefId }, { delay: callbackTime - Date.now() });
      }
      break;
      
    case 'counter_pending':
      await db.query("UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW() WHERE id = $1", [pipelineLoadId]);
      await escalationQueue.add('review', { pipelineLoadId, reason: 'Counter-offer outside envelope', counterRate: result.final_rate });
      break;
      
    case 'wrong_contact':
      if (result.decision_maker_referral.provided) {
        await db.query("UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW() WHERE id = $1", [pipelineLoadId]);
        await escalationQueue.add('referral', { pipelineLoadId, referral: result.decision_maker_referral });
      } else {
        await db.query("UPDATE pipeline_loads SET stage = 'declined', stage_updated_at = NOW() WHERE id = $1", [pipelineLoadId]);
      }
      break;
      
    case 'escalated':
      await db.query("UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW() WHERE id = $1", [pipelineLoadId]);
      await escalationQueue.add('review', { pipelineLoadId, reason: 'Agent escalated', notes: result.analysis_notes });
      break;
  }
}
```

---

## 6. Concurrency Management

### Retell Concurrent Call Limits

Retell supports dozens of concurrent calls. Myra's limits are set by the `call-queue` concurrency in T-03:

| Phase | Max Concurrent Calls | Daily Volume |
|---|---|---|
| Pilot (month 1) | 5 | 50–100 |
| Scale (month 2–3) | 20 | 100–300 |
| Full (month 4+) | 100 | 300–1000 |

### Call Pacing

To avoid overwhelming a single shipper's phone line or triggering spam filters, enforce minimum intervals:

```typescript
// Before initiating each call, check recent calls to same area code
const recentCallsToArea = await db.query(`
  SELECT COUNT(*) FROM agent_calls
  WHERE phone_number_called LIKE $1
  AND call_initiated_at > NOW() - INTERVAL '5 minutes'
`, [`${areaCode}%`]);

if (parseInt(recentCallsToArea.rows[0].count) > 10) {
  // Too many calls to same area — delay this job by 2 minutes
  throw new Error('RATE_LIMIT_AREA'); // BullMQ retries with backoff
}
```

---

## 7. Voice Quality and Detection Mitigation

### Voice Settings

- Use Retell's most human-sounding voice (ElevenLabs or PlayHT integration)
- Speaking rate: 1.0x (match natural speech speed)
- Add subtle pause variability (Retell supports this in agent settings)
- Agent name: use a common, non-robotic name ("Sarah", "Mike", "Alex")

### AI Detection Handling

If the shipper asks "Is this a recording?" or "Are you a robot?":

```
DETECTION RESPONSE:
"No, I'm not a recording — I'm calling from Myra Logistics about the load you posted. I just have a lot of calls to make today so I try to be efficient. How's your day going?"
```

**Expected detection rate:** 10–15% in month 1, declining as voice quality improves.

---

## 8. Cost Estimation

| Volume | Retell Cost | Claude Parsing | Total |
|---|---|---|---|
| 50 calls/day | ~$300/month | ~$15/month | ~$315/month |
| 200 calls/day | ~$1,200/month | ~$60/month | ~$1,260/month |
| 500 calls/day | ~$3,000/month | ~$150/month | ~$3,150/month |

Based on Retell's per-minute pricing (~$0.10–0.15/min) at average call duration of 3 minutes.

---

## 9. New API Routes Required

| Route | Method | Purpose |
|---|---|---|
| `/api/webhooks/retell-callback` | POST | Receives call completion from Retell |
| `/api/webhooks/retell-function` | POST | Handles function calls from Retell during active calls |
| `/api/pipeline/calls` | GET | List agent calls with filters (for dashboard) |
| `/api/pipeline/calls/[id]` | GET | Get call detail with transcript and analysis |
| `/api/pipeline/escalations` | GET | List escalated loads for Patrice review |
| `/api/pipeline/escalations/[id]` | PATCH | Resolve escalation (approve, reject, modify) |

---

*End of document. The voice agent is the face of Myra to the market. Quality here = revenue. Failure here = burned relationships.*
