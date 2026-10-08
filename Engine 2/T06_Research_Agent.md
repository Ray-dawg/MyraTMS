# T-06: AGENT 3 — RESEARCH AGENT SERVICE SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

Agent 3 (Researcher) performs deep analysis on every qualified load. It runs the rate cascade, computes the margin envelope (floor/target/stretch), profiles the shipper, and outputs a strategy recommendation. This is the first agent that uses AI (Claude API) — and the intelligence it produces determines whether the voice agent makes a good call or a bad one.

Agent 3 runs in **parallel** with Agent 4 (Carrier Ranker). Both are triggered simultaneously when a load enters the `qualified` stage. They converge at the completion gate before Agent 5 compiles the brief.

---

## 1. Existing Foundation (from T-01 Audit)

The quoting engine is Agent 3's backbone. Most of the rate intelligence infrastructure already exists:

| Component | Status | Location | Notes |
|---|---|---|---|
| Rate cascade (6-source) | WORKING | `/api/quotes` route, `/lib/quoting/` | Priority: Historical (≥5 loads) → DAT → Truckstop → Manual cache → AI (Grok) → Benchmark |
| Distance service | WORKING | Mapbox Directions API with haversine fallback | 30-day cache in `distance_cache` table |
| Region mapper | WORKING | 20 Ontario cities with radius circles | Fallback to rural/province |
| Fuel surcharge calc | WORKING | Canadian Trucking Standard formula | (price - $1.25/L) × (40L/100km) × distance |
| Dynamic margin calculator | WORKING | Base 15%, new shipper 11%, loyalty 16.5%, urgent 20% | Confidence-adjusted |
| Benchmark rates | WORKING | 5 distance bands × 4 equipment types | Seasonal multipliers (peak/winter) |
| Quote feedback loop | WORKING | Records actual vs. estimated, correction factors per source | Already learning from completed quotes |
| AI rate estimation | WORKING | Grok-3-mini-fast with lane context | Returns rate/mile + range |
| `quotes` table | EXISTS | Full schema with confidence scoring | 7-step pipeline already produces structured output |

### What Needs to Be Built

- **Claude API integration** to replace or supplement Grok for research output. T-01 confirms: "Only xAI/Grok is integrated. No `@anthropic-ai/sdk` in dependencies."
- **Negotiation math** — the rate cascade produces a target rate, but the negotiation envelope (initial offer, concession steps, walk-away) doesn't exist yet. T-01 confirms: "Missing: negotiation ranges (walk-away price, target price, opening offer), counter-offer strategies."
- **Shipper profiling** — lookup shipper posting history, previous call outcomes, language preference.
- **Strategy recommendation** output (aggressive/standard/walk).
- **Structured JSON output** matching the `load_intelligence` interface that Agent 5 expects.

---

## 2. Research Pipeline

For each qualified load, Agent 3 executes these steps in sequence:

```
Step 1: DISTANCE       — Compute or retrieve distance (Mapbox, cached)
Step 2: RATE CASCADE   — Query all 6 rate sources, select best
Step 3: COST MODEL     — Calculate total cost to Myra
Step 4: MARGIN ENVELOPE — Compute floor/target/stretch/walk-away
Step 5: NEGOTIATION PARAMS — Initial offer, concession steps, final offer
Step 6: SHIPPER PROFILE — History, preferences, fatigue
Step 7: STRATEGY        — Claude API structured output: aggressive/standard/walk
```

### Step 1: Distance

```typescript
// Reuse existing distance service
const distance = await getDistance(
  { city: load.originCity, state: load.originState },
  { city: load.destinationCity, state: load.destinationState }
);
// Returns: { miles: number, km: number, duration_hours: number }
```

### Step 2: Rate Cascade

Adapt the existing 7-step quoting pipeline. The cascade already runs in priority order:

```typescript
interface RateCascadeResult {
  floorRate: number;    // Lowest market rate (carriers accepting)
  midRate: number;      // Average market rate
  bestRate: number;     // Highest market rate (shippers paying)
  confidence: number;   // 0.0–1.0
  sources: string[];    // Which sources contributed
  currency: string;     // 'CAD' | 'USD'
}

async function runRateCascade(load: QualifiedLoad): Promise<RateCascadeResult> {
  // Source 1: Historical loads on this lane (existing in quoting engine)
  const historical = await queryHistoricalRates(load.originRegion, load.destRegion, load.equipmentType);
  if (historical && historical.loadCount >= 5) {
    return { floorRate: historical.min, midRate: historical.avg, bestRate: historical.max, confidence: 0.95, sources: ['historical'], currency: 'CAD' };
  }
  
  // Source 2: DAT RateView API (existing integration slot)
  const dat = await queryDATRateView(load);
  if (dat) {
    return { floorRate: dat.low, midRate: dat.avg, bestRate: dat.high, confidence: 0.85, sources: ['dat_rateview'], currency: 'USD' };
  }
  
  // Source 3: Truckstop API (existing integration slot)
  const truckstop = await queryTruckstopRates(load);
  if (truckstop) {
    return { floorRate: truckstop.low, midRate: truckstop.avg, bestRate: truckstop.high, confidence: 0.80, sources: ['truckstop'], currency: 'USD' };
  }
  
  // Source 4: Manual rate cache (existing rate_cache table)
  const manual = await queryRateCache(load.originRegion, load.destRegion);
  if (manual) {
    return { floorRate: manual.rate * 0.9, midRate: manual.rate, bestRate: manual.rate * 1.1, confidence: 0.65, sources: ['rate_cache'], currency: 'CAD' };
  }
  
  // Source 5: AI estimation (replace Grok with Claude for consistency)
  const aiEstimate = await claudeRateEstimate(load);
  if (aiEstimate) {
    return { ...aiEstimate, confidence: 0.55, sources: ['claude_estimate'] };
  }
  
  // Source 6: Benchmark fallback (existing hardcoded table)
  const benchmark = getBenchmarkRate(distance.km, load.equipmentType);
  return { floorRate: benchmark * 0.85, midRate: benchmark, bestRate: benchmark * 1.15, confidence: 0.40, sources: ['benchmark'], currency: 'CAD' };
}
```

### Step 3: Cost Model

Adapted from the implementation guide's `calculateNegotiationParams()`:

```typescript
function calculateTotalCost(distanceMiles: number, originCountry: string, crossBorder: boolean): CostBreakdown {
  const costPerMile = originCountry === 'CA' ? 2.00 : 1.50;
  const deadheadMiles = distanceMiles * 0.15;
  const totalMiles = distanceMiles + deadheadMiles;
  
  const baseCost = totalMiles * costPerMile;
  const deadheadCost = deadheadMiles * costPerMile;
  const fuelSurcharge = distanceMiles * 0.25;
  const accessorials = 75;
  const adminOverhead = 35;
  const crossBorderFees = crossBorder ? 250 : 0;
  const estimatedFactoringFee = (baseCost + fuelSurcharge + accessorials) * 0.03; // 3% estimate
  
  return {
    baseCost: Math.round(baseCost * 100) / 100,
    deadheadCost: Math.round(deadheadCost * 100) / 100,
    fuelSurcharge: Math.round(fuelSurcharge * 100) / 100,
    accessorials,
    adminOverhead,
    crossBorderFees,
    factoringFee: Math.round(estimatedFactoringFee * 100) / 100,
    total: Math.round((baseCost + fuelSurcharge + accessorials + adminOverhead + crossBorderFees + estimatedFactoringFee) * 100) / 100,
  };
}
```

### Step 4–5: Margin Envelope and Negotiation Params

```typescript
function computeNegotiationParams(totalCost: number, rates: RateCascadeResult, currency: string) {
  const minMargin = currency === 'CAD' ? 270 : 200;
  const targetMargin = currency === 'CAD' ? 470 : 350;
  const stretchMargin = currency === 'CAD' ? 675 : 500;
  
  const minAcceptableRate = totalCost + minMargin;
  const targetRate = totalCost + targetMargin;
  const stretchRate = totalCost + stretchMargin;
  
  // Initial offer: target rate, capped at 102% of best market rate
  let initialOffer = targetRate;
  if (initialOffer > rates.bestRate * 1.02) {
    initialOffer = Math.min(rates.bestRate * 1.02, targetRate);
  }
  initialOffer = Math.max(initialOffer, minAcceptableRate); // Never open below minimum
  
  // Concession ladder
  const maxConcession = initialOffer - minAcceptableRate;
  const concessionStep1 = initialOffer - (maxConcession * 0.33);
  const concessionStep2 = initialOffer - (maxConcession * 0.67);
  const finalOffer = minAcceptableRate;
  
  return {
    initialOffer: round(initialOffer),
    concessionStep1: round(concessionStep1),
    concessionStep2: round(concessionStep2),
    finalOffer: round(finalOffer),
    walkAwayRate: round(minAcceptableRate),
    minMargin, targetMargin, stretchMargin,
    marginEnvelope: {
      floor: round(minAcceptableRate - totalCost),
      target: round(targetRate - totalCost),
      stretch: round(stretchRate - totalCost),
    }
  };
}
```

### Step 6: Shipper Profile

```typescript
async function profileShipper(phone: string | null): Promise<ShipperProfile> {
  if (!phone) return defaultShipperProfile();
  
  // Check shipper_preferences table
  const prefs = await db.query('SELECT * FROM shipper_preferences WHERE phone = $1', [phone]);
  
  // Check previous calls
  const calls = await db.query(`
    SELECT outcome, agreed_rate, persona FROM agent_calls
    WHERE phone_number_called = $1 ORDER BY created_at DESC LIMIT 10
  `, [phone]);
  
  // Check pipeline_loads for posting frequency
  const postings = await db.query(`
    SELECT COUNT(*) as count FROM pipeline_loads
    WHERE shipper_phone = $1 AND created_at > NOW() - INTERVAL '30 days'
  `, [phone]);
  
  return {
    preferredLanguage: prefs.rows[0]?.preferred_language || 'en',
    preferredCurrency: prefs.rows[0]?.preferred_currency || 'CAD',
    previousCallCount: calls.rows.length,
    previousOutcomes: calls.rows.map(c => c.outcome),
    postingFrequency: parseInt(postings.rows[0]?.count || '0'),
    bestPerformingPersona: prefs.rows[0]?.best_performing_persona || null,
    lastBookedRate: calls.rows.find(c => c.outcome === 'booked')?.agreed_rate || null,
    fatigueScore: prefs.rows[0]?.total_calls_received - prefs.rows[0]?.total_bookings || 0,
  };
}
```

### Step 7: Strategy Recommendation (Claude API)

```typescript
async function determineStrategy(
  load: QualifiedLoad,
  rates: RateCascadeResult,
  negotiation: NegotiationParams,
  shipperProfile: ShipperProfile
): Promise<{ approach: string; reasoning: string }> {
  
  // Simple rule-based strategy (no API call needed for most cases)
  const estimatedMargin = negotiation.initialOffer - rates.midRate > 0 
    ? negotiation.marginEnvelope.target 
    : negotiation.marginEnvelope.floor;
  
  if (estimatedMargin >= negotiation.stretchMargin && rates.confidence > 0.7) {
    return { approach: 'aggressive', reasoning: 'Strong margin opportunity with high-confidence rate data. Push for stretch rate.' };
  }
  
  if (estimatedMargin >= negotiation.targetMargin) {
    return { approach: 'standard', reasoning: 'Healthy margin at target rate. Standard negotiation approach.' };
  }
  
  if (estimatedMargin >= negotiation.minMargin) {
    return { approach: 'standard', reasoning: 'Margin is viable but tight. Be prepared to hold firm on rate.' };
  }
  
  return { approach: 'walk', reasoning: 'Margin below minimum threshold. Proceed with call but prepared to decline.' };
}
```

**Note:** The strategy determination is mostly rule-based. Claude API is reserved for the structured `load_intelligence` output assembly (Step 8 below) when richer context is needed — for example, analyzing whether a shipper's posting pattern suggests urgency or flexibility.

---

## 3. Output Schema

Agent 3 writes its results to `pipeline_loads` (summary fields) and returns the full `load_intelligence` object that Agent 5 will merge into the brief:

```typescript
interface LoadIntelligence {
  rates: RateCascadeResult;
  cost: CostBreakdown;
  negotiation: NegotiationParams;
  shipperProfile: ShipperProfile;
  strategy: { approach: string; reasoning: string };
  distance: { miles: number; km: number; durationHours: number };
}
```

---

## 4. Claude API Integration Pattern

When Claude API is needed (shipper profiling with complex context, strategy for edge cases):

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic(); // Uses ANTHROPIC_API_KEY env var

async function claudeRateEstimate(load: QualifiedLoad): Promise<RateCascadeResult | null> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: 'You are a freight rate analyst. Return ONLY valid JSON, no markdown.',
    messages: [{
      role: 'user',
      content: `Estimate the freight rate for this load:
        Lane: ${load.originCity}, ${load.originState} → ${load.destinationCity}, ${load.destinationState}
        Distance: ${load.distanceMiles} miles
        Equipment: ${load.equipmentType}
        Date: ${load.pickupDate}
        Country: ${load.originCountry}
        
        Return JSON: {"floorRate": number, "midRate": number, "bestRate": number, "currency": "CAD"|"USD"}`
    }]
  });
  
  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}
```

**Cost consideration:** Each Claude API call costs ~$0.003–$0.01. At 200 loads/day, that's $0.60–$2.00/day for research. Negligible compared to Retell call costs ($1,800/month).

---

## 5. Completion Gate

Agent 3 updates `pipeline_loads` when it finishes. It then checks if Agent 4 has also finished:

```typescript
// After Agent 3 writes its results:
await db.query(`
  UPDATE pipeline_loads SET
    research_completed_at = NOW(),
    market_rate_floor = $2,
    market_rate_mid = $3,
    market_rate_best = $4,
    recommended_strategy = $5
  WHERE id = $1
`, [pipelineLoadId, rates.floorRate, rates.midRate, rates.bestRate, strategy.approach]);

// Check if Agent 4 is also done
const check = await db.query(
  'SELECT carrier_match_count FROM pipeline_loads WHERE id = $1',
  [pipelineLoadId]
);

if (check.rows[0].carrier_match_count > 0) {
  // Both agents done — advance to 'matched' and enqueue to brief-queue
  await db.query("UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() WHERE id = $1", [pipelineLoadId]);
  await briefQueue.add('brief', buildBriefPayload(pipelineLoadId), { priority });
}
// If Agent 4 isn't done yet, do nothing — Agent 4 will trigger the gate when it finishes
```

---

## 6. Performance Targets

| Metric | Target |
|---|---|
| Research time per load (with API cache hits) | < 2 seconds |
| Research time per load (with API calls) | < 8 seconds |
| Rate cascade hit rate (non-benchmark) | > 60% |
| Claude API calls per load | 0–1 (most loads use rule-based strategy) |

---

*End of document. The researcher is the brain. Accurate rate intelligence = profitable calls. Bad rate intelligence = burned margin.*
