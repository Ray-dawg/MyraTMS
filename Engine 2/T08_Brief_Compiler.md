# T-08: BRIEF COMPILER — NEGOTIATION BRIEF SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

This document defines the `negotiation_brief` — the single most important data contract in the entire Myra agent pipeline. The brief is the complete, self-contained JSON document that Agent 6 (Voice Agent) receives before making a call. It contains everything the voice agent needs to negotiate, book, or decline a load. If the brief is wrong, the call fails. If the brief is complete, the voice agent's job becomes simple execution.

Agent 5 (Brief Compiler) produces this document by merging output from Agent 3 (Researcher) and Agent 4 (Carrier Ranker), adding persona selection and objection playbook.

---

## 1. Design Principles

1. **The voice agent never computes anything.** Every number, every threshold, every rate boundary is pre-computed and included in the brief. The voice agent is an executor, not a thinker.

2. **One brief per call.** If a load requires a second call (callback), a new brief is generated with updated context.

3. **The brief is the audit trail.** After the call, the brief is stored in the `negotiation_briefs` table alongside the call result. This allows post-hoc analysis: was the research correct? Was the carrier stack relevant? Was the strategy appropriate?

4. **No external lookups during the call.** Everything the voice agent might need is in the brief. No database queries, no API calls, no real-time rate checks. All of that happens before the brief is compiled.

---

## 2. The Complete negotiation_brief Schema

```typescript
interface NegotiationBrief {
  // Brief metadata
  meta: {
    briefId: number;
    briefVersion: string;          // "1.0"
    pipelineLoadId: number;
    generatedAt: string;           // ISO timestamp
    generatedBy: string;           // "compiler-v1"
  };
  
  // Load details — what the call is about
  load: {
    loadId: string;
    loadBoardSource: string;       // "DAT" | "123LB" | "Truckstop" | "Loadlink" | "manual"
    origin: {
      city: string;
      state: string;
      country: string;             // "CA" | "US"
    };
    destination: {
      city: string;
      state: string;
      country: string;
    };
    pickupDate: string;            // "2026-04-15"
    pickupTime: string | null;     // "08:00" or null if flexible
    deliveryDate: string | null;
    deliveryTime: string | null;
    equipmentType: string;         // "flatbed" | "dry_van" | "tanker" | "reefer"
    commodity: string | null;
    weightLbs: number | null;
    distanceMiles: number;
    distanceKm: number;
    crossBorder: boolean;
    specialRequirements: string | null;
  };
  
  // Shipper contact — who to call
  shipper: {
    companyName: string | null;
    contactName: string | null;
    phone: string;
    email: string | null;
    preferredLanguage: string;     // "en" | "fr"
    preferredCurrency: string;     // "CAD" | "USD"
    previousCallCount: number;     // How many times we've called this number
    previousOutcomes: string[];    // ["declined", "voicemail"] from past calls
    fatigueScore: number;          // 0 = fresh, 3+ = wait before calling again
    isRepeatShipper: boolean;      // Have they posted loads before?
    lastBookedRate: number | null; // Rate from their last booking with us
  };
  
  // Rate intelligence — the math behind the negotiation
  rates: {
    // Market data
    marketRateFloor: number;       // Lowest rate carriers are accepting on this lane
    marketRateMid: number;         // Average market rate
    marketRateBest: number;        // Highest rate shippers are paying
    rateConfidence: number;        // 0.0 to 1.0 — how reliable is the market data
    rateSources: string[];         // ["historical", "dat_rateview", "benchmark"]
    
    // Cost calculation
    totalCost: number;             // What it costs Myra to move this load
    costBreakdown: {
      baseCost: number;            // miles × cost_per_mile
      deadheadCost: number;        // deadhead miles × cost_per_mile
      fuelSurcharge: number;
      accessorials: number;
      adminOverhead: number;
      crossBorderFees: number;     // 0 if not cross-border
      factoringFee: number;        // Estimated factoring cost
    };
    
    // Margin targets
    currency: string;              // "CAD" | "USD"
    minMargin: number;             // $200 USD / $270 CAD — NEVER go below
    targetMargin: number;          // $350 USD / $470 CAD
    stretchMargin: number;         // $500 USD / $675 CAD
  };
  
  // Negotiation envelope — the boundaries for the call
  negotiation: {
    initialOffer: number;          // What the agent opens with
    concessionStep1: number;       // First concession (33% of max range)
    concessionStep2: number;       // Second concession (67% of max range)
    finalOffer: number;            // Absolute floor (total_cost + min_margin)
    maxConcessions: number;        // 3
    
    // What to ask for in exchange for each concession
    concessionAsks: string[];      // ["flexibility on pickup time", "commitment to future loads", "extended delivery window"]
    
    // Walk-away logic
    walkAwayRate: number;          // Below this, end the call gracefully
    walkAwayScript: string;        // What to say when walking away
  };
  
  // Strategy — how to approach this call
  strategy: {
    approach: 'aggressive' | 'standard' | 'walk';
    reasoning: string;             // One sentence: "High margin opportunity, limited competition on this lane"
    keySellingPoints: string[];    // ["reliable vetted carriers", "live GPS tracking", "digital POD", "founder-led service"]
    potentialObjections: string[]; // ["rate too high", "already have a broker"]
  };
  
  // Carrier stack — who we'll use if the load books
  carriers: Array<{
    carrierId: number;
    companyName: string;
    contactName: string;
    contactPhone: string;
    rate: number;                  // What the carrier will charge us
    matchScore: number;            // 0-100 from matching engine
    matchGrade: string;            // "A" | "B" | "C" | "D" | "F"
    availabilityConfidence: 'high' | 'medium' | 'low';
    equipmentConfirmed: boolean;
    onTimePercentage: number | null;
    totalLoadsWithMyra: number;
    paymentPreference: string;
  }>;
  
  // Persona — which voice agent personality to use
  persona: {
    personaName: string;           // "assertive" | "friendly" | "analytical"
    retellAgentId: string;         // Retell agent ID for this persona+language combo
    selectionMethod: string;       // "thompson_sampling" | "manual" | "ab_test"
    selectionScore: number;        // Thompson Sampling score that led to this selection
  };
  
  // Objection playbook — pre-scripted responses
  objectionPlaybook: Array<{
    objectionType: string;         // "rate_too_high" | "have_broker" | "dont_use_brokers" | "not_decision_maker" | "call_back" | "send_email" | "handle_internally" | "better_offer" | "customer_routed"
    response: string;              // The script the agent should use
    followUpQuestion: string;      // The question to ask after responding
    escalateAfter: number;         // Number of times this objection can occur before escalating (0 = never escalate)
  }>;
  
  // Compliance
  compliance: {
    consentType: string;           // "implied_load_post" | "explicit_written" | etc.
    consentSource: string;
    callingHoursOk: boolean;       // Has timezone check passed?
    dncChecked: boolean;           // Has DNC list been verified?
    recordingDisclosureRequired: boolean; // Does this jurisdiction require disclosure?
    disclosureScript: string | null; // "This call may be recorded for quality purposes"
  };
  
  // Call configuration
  callConfig: {
    maxDurationSeconds: number;    // 300 (5 minutes max)
    language: string;              // "en" | "fr"
    timezone: string;              // Shipper's timezone
    retellWebhookUrl: string;      // Where Retell sends the call result
    callbackOnNoAnswer: boolean;   // Should we retry if no answer?
    maxCallAttempts: number;       // 2
  };
}
```

---

## 3. Brief Compilation Logic

Agent 5 receives two inputs and produces one output:

**Input A:** `ResearchResult` from Agent 3
**Input B:** `CarrierStack` from Agent 4
**Output:** `NegotiationBrief`

### Step-by-Step Compilation

```
1. LOAD DATA
   Copy from pipeline_loads row. No transformation needed.

2. SHIPPER PROFILE
   Query shipper_preferences table by phone number.
   Query agent_calls for previous outcomes with this phone.
   Compute fatigue_score = count of 'declined' outcomes in last 7 days.

3. RATE ENVELOPE
   Take totalCost from Agent 3.
   Compute:
     initialOffer = totalCost + targetMargin (capped at marketRateBest × 1.02)
     concessionStep1 = initialOffer - ((initialOffer - finalOffer) × 0.33)
     concessionStep2 = initialOffer - ((initialOffer - finalOffer) × 0.67)
     finalOffer = totalCost + minMargin

4. STRATEGY SELECTION
   If estimatedMargin > stretchMargin AND rateConfidence > 0.7: "aggressive"
   If estimatedMargin > targetMargin: "standard"
   If estimatedMargin < minMargin: "walk" (still call, but don't expect a booking)

5. PERSONA SELECTION (Thompson Sampling)
   For each active persona:
     alpha = persona.total_bookings + 1
     beta = (persona.total_calls - persona.total_bookings) + 1
     sample = random draw from Beta(alpha, beta)
   Select persona with highest sample.
   
   Lane-specific override: if lane_stats has 50+ calls for this lane,
   use lane-specific persona stats instead of global stats.

6. OBJECTION PLAYBOOK
   Include all objection responses from C-04.
   If shipper has previous call history, prioritize the objection
   they raised last time.

7. COMPLIANCE CHECK
   Run checkConsentStatus(phone, 'load_booking').
   Run checkDNC(phone).
   Run checkCallingHours(phone, timezone).
   If any fail: DO NOT compile brief. Log reason and halt.

8. ASSEMBLE AND STORE
   Merge all sections into NegotiationBrief JSON.
   Insert into negotiation_briefs table.
   Enqueue to call-queue with brief attached.
```

---

## 4. Brief Validation Rules

Before a brief is accepted into the call-queue, validate:

| Rule | Check | Action if Failed |
|---|---|---|
| Rate sanity | initialOffer > finalOffer > 0 | Reject brief, log error |
| Carrier exists | carriers array has ≥ 1 entry | Reject brief, cannot book without carrier |
| Phone valid | shipper.phone matches E.164 or 10-digit format | Reject brief, log error |
| Consent valid | compliance.consentType is not null | Reject brief, compliance block |
| DNC clear | compliance.dncChecked is true | Reject brief, compliance block |
| Calling hours | compliance.callingHoursOk is true | Delay job to next valid calling window |
| Fatigue check | shipper.fatigueScore < 3 | Delay 7 days, then retry |
| Not expired | load.pickupDate > now + 4 hours | Reject brief, load too close to pickup |
| Currency match | rates.currency matches shipper.preferredCurrency | Warning only — brief proceeds |

---

## 5. Brief Examples

### Example A: Standard Sudbury Corridor Load

```json
{
  "meta": {
    "briefId": 1042,
    "briefVersion": "1.0",
    "pipelineLoadId": 5891,
    "generatedAt": "2026-04-15T09:32:00Z",
    "generatedBy": "compiler-v1"
  },
  "load": {
    "loadId": "DAT-89234571",
    "loadBoardSource": "DAT",
    "origin": { "city": "Toronto", "state": "ON", "country": "CA" },
    "destination": { "city": "Sudbury", "state": "ON", "country": "CA" },
    "pickupDate": "2026-04-17",
    "pickupTime": "08:00",
    "deliveryDate": "2026-04-17",
    "deliveryTime": null,
    "equipmentType": "flatbed",
    "commodity": "grinding media",
    "weightLbs": 42000,
    "distanceMiles": 250,
    "distanceKm": 402,
    "crossBorder": false,
    "specialRequirements": null
  },
  "shipper": {
    "companyName": "Northern Mine Supply Co",
    "contactName": "Jean-Marc Tremblay",
    "phone": "+17055551234",
    "email": "jm.tremblay@nmsco.ca",
    "preferredLanguage": "en",
    "preferredCurrency": "CAD",
    "previousCallCount": 0,
    "previousOutcomes": [],
    "fatigueScore": 0,
    "isRepeatShipper": false,
    "lastBookedRate": null
  },
  "rates": {
    "marketRateFloor": 2100,
    "marketRateMid": 2450,
    "marketRateBest": 2800,
    "rateConfidence": 0.82,
    "rateSources": ["historical", "dat_rateview"],
    "totalCost": 1850,
    "costBreakdown": {
      "baseCost": 1440,
      "deadheadCost": 216,
      "fuelSurcharge": 62,
      "accessorials": 75,
      "adminOverhead": 35,
      "crossBorderFees": 0,
      "factoringFee": 22
    },
    "currency": "CAD",
    "minMargin": 270,
    "targetMargin": 470,
    "stretchMargin": 675
  },
  "negotiation": {
    "initialOffer": 2400,
    "concessionStep1": 2310,
    "concessionStep2": 2220,
    "finalOffer": 2120,
    "maxConcessions": 3,
    "concessionAsks": [
      "flexibility on pickup appointment",
      "commitment to weekly loads on this lane",
      "extended delivery window to end of day"
    ],
    "walkAwayRate": 2120,
    "walkAwayScript": "I can't make the numbers work at that rate, but I'd love to help with your next load. Keep me in mind."
  },
  "strategy": {
    "approach": "standard",
    "reasoning": "Good margin opportunity on established lane with reliable rate data.",
    "keySellingPoints": [
      "vetted carriers with Northern Ontario experience",
      "live GPS tracking visible on your screen",
      "digital proof of delivery within minutes",
      "dedicated founder-led service"
    ],
    "potentialObjections": ["rate_too_high", "have_broker"]
  },
  "carriers": [
    {
      "carrierId": 142,
      "companyName": "Northern Express Transport",
      "contactName": "Mike Pelletier",
      "contactPhone": "+17055559876",
      "rate": 1800,
      "matchScore": 92,
      "matchGrade": "A",
      "availabilityConfidence": "high",
      "equipmentConfirmed": true,
      "onTimePercentage": 97,
      "totalLoadsWithMyra": 8,
      "paymentPreference": "quick_pay"
    }
  ],
  "persona": {
    "personaName": "friendly",
    "retellAgentId": "agent_friendly_en_001",
    "selectionMethod": "thompson_sampling",
    "selectionScore": 0.72
  },
  "objectionPlaybook": [
    {
      "objectionType": "rate_too_high",
      "response": "I understand that price is important. Our focus is on reliable service with vetted carriers. We don't find the cheapest truck — we find the best truck for the job. Can we work together on this rate?",
      "followUpQuestion": "What rate would work for you?",
      "escalateAfter": 0
    },
    {
      "objectionType": "have_broker",
      "response": "That's great. We'd love to be a backup option. There will come a time when your go-to is unavailable, and we'd be happy to step in. Can I send you my contact info?",
      "followUpQuestion": "What lanes does your current broker cover?",
      "escalateAfter": 0
    }
  ],
  "compliance": {
    "consentType": "implied_load_post",
    "consentSource": "dat_load_post",
    "callingHoursOk": true,
    "dncChecked": true,
    "recordingDisclosureRequired": false,
    "disclosureScript": null
  },
  "callConfig": {
    "maxDurationSeconds": 300,
    "language": "en",
    "timezone": "America/Toronto",
    "retellWebhookUrl": "https://myratms.vercel.app/api/webhooks/retell-callback",
    "callbackOnNoAnswer": true,
    "maxCallAttempts": 2
  }
}
```

---

## 6. Implementation Notes

### No AI Required in Agent 5

The Brief Compiler is pure template merge logic. It takes structured data from Agent 3 and Agent 4 and assembles it into the brief schema. The negotiation math (concession steps, walk-away rate) is arithmetic. Persona selection is Thompson Sampling (a random draw from a Beta distribution). Objection playbook is a static lookup keyed to the predicted objection types.

This makes Agent 5 the fastest, most reliable agent in the pipeline. Target execution time: < 100ms per brief.

### Brief Immutability

Once a brief is generated and stored, it is never modified. If conditions change (e.g., carrier becomes unavailable), a new brief is generated with a new ID. The old brief remains in the database as the historical record of what the agent was told to do.

### Rate Currency Consistency

All rates in a single brief must be in the same currency. If the shipper prefers CAD but the carrier quotes in USD, the compiler converts at the daily exchange rate and notes the conversion in the costBreakdown.

---

*End of document. The brief is the contract between intelligence and execution. Get this right and the voice agent's job becomes simple.*
