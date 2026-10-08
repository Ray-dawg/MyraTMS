# T-05: AGENT 2 — LOAD QUALIFIER SERVICE SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

Agent 2 (Qualifier) is the kill switch. It receives every scanned load and makes a fast, deterministic go/no-go decision: does this load have any chance of being profitable given our carrier network? If no — kill it immediately. If yes — pass it forward with a priority score. The goal is to eliminate 70–80% of loads in milliseconds before they touch any AI model, saving API costs and pipeline bandwidth.

**No AI is used in this agent.** Pure SQL queries and if/else logic. This is the fastest agent in the pipeline.

---

## 1. Existing Foundation (from T-01 Audit)

| Component | Status | Location | Notes |
|---|---|---|---|
| `carrier_equipment` table | EXISTS | Migration 005 | Columns: carrier_id, equipment_type, truck_count. UNIQUE on (carrier_id, equipment_type). |
| `carrier_lanes` table | EXISTS | Migration 005 | Columns: carrier_id, origin_region, dest_region, equipment_type, load_count, avg_carrier_rate, last_load_date, on_time_rate. |
| `carriers` table | EXISTS | Migration 001 | Has: status, authority_status, insurance_status, insurance_expiry, safety_rating, home_base_city, home_base_state. |
| Matching engine hard filters | WORKING | `lib/matching/` | Already filters: equipment type match, active authority, valid insurance, exclusion list. |
| Region mapper | WORKING | Quoting engine | 20 Ontario cities with radius circles, fallback to rural/province classifications. |
| Benchmark rate table | WORKING | Quoting engine | 5 distance bands × 4 equipment types with seasonal multipliers. |

### What Needs to Be Built

- The qualifier worker that reads from `qualify-queue`, applies filters, and writes results to `pipeline_loads`
- Priority scoring logic
- Margin estimation using benchmark rates (fast, no API calls)
- DNC and fatigue pre-check integration

---

## 2. Filter Chain

Filters execute in order. The first failure kills the load. Order is optimized for speed — cheapest checks first.

```typescript
interface QualificationResult {
  passed: boolean;
  reason: string;
  priorityScore: number;
  estimatedMarginLow: number;
  estimatedMarginHigh: number;
  carrierMatchCount: number;
}

async function qualifyLoad(load: QualifyJobPayload): Promise<QualificationResult> {
  
  // FILTER 1: Freshness check (< 1ms)
  // Kill loads with pickup date in the past or within 4 hours
  if (new Date(load.pickupDate) < new Date(Date.now() + 4 * 3600000)) {
    return fail('pickup_too_soon', 'Pickup date is less than 4 hours away or in the past');
  }
  
  // FILTER 2: Equipment match (1 SQL query, ~5ms)
  // Do we have ANY carrier with this equipment type?
  const equipMatch = await db.query(`
    SELECT COUNT(DISTINCT ce.carrier_id) as count
    FROM carrier_equipment ce
    JOIN carriers c ON ce.carrier_id = c.id
    WHERE ce.equipment_type = $1
      AND c.status = 'Active'
      AND c.authority_status IN ('Active', 'Verified')
      AND c.insurance_status = 'Valid'
  `, [normalizeEquipmentForTMS(load.equipmentType)]);
  
  if (parseInt(equipMatch.rows[0].count) === 0) {
    return fail('no_equipment_match', `No active carriers with ${load.equipmentType}`);
  }
  
  // FILTER 3: Lane coverage (1 SQL query, ~10ms)
  // Do we have any carrier that runs near this origin?
  // Uses the region mapper logic from the quoting engine
  const originRegion = resolveRegion(load.origin.city, load.origin.state);
  const destRegion = resolveRegion(load.destination.city, load.destination.state);
  
  const laneMatch = await db.query(`
    SELECT COUNT(DISTINCT cl.carrier_id) as count
    FROM carrier_lanes cl
    JOIN carriers c ON cl.carrier_id = c.id
    WHERE (cl.origin_region = $1 OR cl.origin_region = 'Ontario' OR cl.origin_region = $3)
      AND (cl.dest_region = $2 OR cl.dest_region = 'Ontario' OR cl.dest_region = $4)
      AND c.status = 'Active'
  `, [originRegion, destRegion, load.origin.state, load.destination.state]);
  
  const carrierMatchCount = parseInt(laneMatch.rows[0].count);
  // Don't require exact lane match — proximity is enough for qualification
  // The matching engine (Agent 4) will do precise scoring later
  
  // FILTER 4: Minimum rate viability (calculation, ~1ms)
  // Use benchmark rates to estimate if margin is possible
  const distanceMiles = load.distanceMiles || estimateDistance(load.origin, load.destination);
  const distanceKm = distanceMiles * 1.60934;
  const benchmarkRate = getBenchmarkRate(distanceKm, load.equipmentType);
  const estimatedCost = estimateCarrierCost(distanceMiles, load.origin.country);
  
  const postedRate = load.postedRate || benchmarkRate; // If no posted rate, use benchmark
  const estimatedMarginHigh = postedRate - estimatedCost;
  const estimatedMarginLow = estimatedMarginHigh * 0.7; // Conservative: 30% less
  
  const minMargin = load.origin.country === 'CA' ? 270 : 200; // CAD vs USD
  
  if (estimatedMarginHigh < minMargin * 0.5) {
    // Even in best case, margin is less than half the minimum — not viable
    return fail('margin_too_thin', `Best-case margin $${estimatedMarginHigh.toFixed(0)} < 50% of minimum $${minMargin}`);
  }
  
  // FILTER 5: DNC check (~2ms Redis or DB lookup)
  if (load.shipperPhone) {
    const isDNC = await db.query('SELECT 1 FROM dnc_list WHERE phone = $1', [load.shipperPhone]);
    if (isDNC.rows.length > 0) {
      return fail('dnc_listed', 'Shipper phone is on do-not-call list');
    }
  }
  
  // FILTER 6: Shipper fatigue check (~3ms)
  if (load.shipperPhone) {
    const fatigue = await checkShipperFatigue(load.shipperPhone);
    if (!fatigue.canContact) {
      return fail('shipper_fatigue', fatigue.reason);
    }
  }
  
  // ALL FILTERS PASSED — compute priority score
  const priorityScore = computePriorityScore({
    estimatedMargin: estimatedMarginHigh,
    carrierMatchCount,
    hasPostedRate: load.postedRate !== null,
    daysUntilPickup: daysBetween(new Date(), new Date(load.pickupDate)),
    isRepeatShipper: false, // TODO: check shipper_preferences
  });
  
  return {
    passed: true,
    reason: 'All filters passed',
    priorityScore,
    estimatedMarginLow,
    estimatedMarginHigh,
    carrierMatchCount,
  };
}
```

---

## 3. Priority Scoring

Priority score determines the order in which loads are processed downstream. Higher score = processed first. Range: 0–1000.

```typescript
function computePriorityScore(params: {
  estimatedMargin: number;
  carrierMatchCount: number;
  hasPostedRate: boolean;
  daysUntilPickup: number;
  isRepeatShipper: boolean;
}): number {
  let score = 0;
  
  // Margin potential (0-400 points)
  // $200 margin = 200 points, $500 = 400 points (capped)
  score += Math.min(Math.round(params.estimatedMargin * 0.8), 400);
  
  // Carrier coverage (0-200 points)
  // More matching carriers = higher confidence of booking
  score += Math.min(params.carrierMatchCount * 40, 200);
  
  // Posted rate certainty (0-150 points)
  // Loads with a posted rate are more predictable
  score += params.hasPostedRate ? 150 : 0;
  
  // Urgency (0-150 points)
  // Loads picking up sooner get prioritized (more likely to book)
  if (params.daysUntilPickup <= 1) score += 150;
  else if (params.daysUntilPickup <= 3) score += 100;
  else if (params.daysUntilPickup <= 7) score += 50;
  
  // Repeat shipper bonus (0-100 points)
  score += params.isRepeatShipper ? 100 : 0;
  
  return Math.min(score, 1000);
}
```

---

## 4. Benchmark Rate Lookup

Uses the existing hardcoded rate table from the quoting engine. No API calls needed.

```typescript
// Mirrors the existing benchmark in the quoting engine
const benchmarkRatesCAD: Record<string, Record<string, number>> = {
  // distance_band: { equipment_type: rate_per_km }
  '0-200':    { dry_van: 3.50, flatbed: 4.00, tanker: 4.50, reefer: 4.00 },
  '200-500':  { dry_van: 2.80, flatbed: 3.20, tanker: 3.60, reefer: 3.20 },
  '500-1000': { dry_van: 2.40, flatbed: 2.80, tanker: 3.20, reefer: 2.80 },
  '1000-2000':{ dry_van: 2.10, flatbed: 2.50, tanker: 2.80, reefer: 2.50 },
  '2000+':    { dry_van: 1.90, flatbed: 2.20, tanker: 2.50, reefer: 2.20 },
};

function getBenchmarkRate(distanceKm: number, equipment: string): number {
  const band = distanceKm <= 200 ? '0-200' : 
               distanceKm <= 500 ? '200-500' :
               distanceKm <= 1000 ? '500-1000' :
               distanceKm <= 2000 ? '1000-2000' : '2000+';
  const ratePerKm = benchmarkRatesCAD[band]?.[equipment] || 2.80;
  return ratePerKm * distanceKm;
}

function estimateCarrierCost(distanceMiles: number, country: string): number {
  const costPerMile = country === 'CA' ? 2.00 : 1.50; // CAD vs USD
  const totalMiles = distanceMiles * 1.15; // 15% deadhead factor
  return (totalMiles * costPerMile) + 62.50 + 75 + 35; // fuel + accessorials + admin
}
```

---

## 5. Worker Implementation

```typescript
// /lib/workers/qualifier.worker.ts

import { Worker, Job } from 'bullmq';
import { redis } from '../redis';
import { db } from '../database';

const qualifierWorker = new Worker(
  'qualify-queue',
  async (job: Job<QualifyJobPayload>) => {
    const { pipelineLoadId } = job.data;
    
    // Verify load is still in 'scanned' stage
    const load = await db.query(
      'SELECT * FROM pipeline_loads WHERE id = $1 AND stage = $2',
      [pipelineLoadId, 'scanned']
    );
    if (!load.rows[0]) return { skipped: true, reason: 'stage_mismatch' };
    
    // Run qualification
    const result = await qualifyLoad(job.data);
    
    if (result.passed) {
      // Update pipeline_loads to 'qualified'
      await db.query(`
        UPDATE pipeline_loads SET
          stage = 'qualified',
          stage_updated_at = NOW(),
          has_carrier_match = true,
          estimated_margin_low = $2,
          estimated_margin_high = $3,
          priority_score = $4,
          carrier_match_count = $5
        WHERE id = $1
      `, [pipelineLoadId, result.estimatedMarginLow, result.estimatedMarginHigh, result.priorityScore, result.carrierMatchCount]);
      
      // Enqueue to BOTH research-queue and match-queue (parallel execution)
      const researchPayload = buildResearchPayload(job.data, result);
      const matchPayload = buildMatchPayload(job.data);
      
      await researchQueue.add('research', researchPayload, { priority: result.priorityScore });
      await matchQueue.add('match', matchPayload, { priority: result.priorityScore });
      
    } else {
      // Update pipeline_loads to 'disqualified'
      await db.query(`
        UPDATE pipeline_loads SET
          stage = 'disqualified',
          stage_updated_at = NOW(),
          qualification_reason = $2
        WHERE id = $1
      `, [pipelineLoadId, result.reason]);
    }
    
    return result;
  },
  { connection: redis, concurrency: 50 }
);
```

---

## 6. Performance Targets

| Metric | Target |
|---|---|
| Qualification time per load | < 50ms |
| Throughput | 1,000 loads/minute |
| Pass rate (of scanned loads) | 20–30% (kill 70–80%) |
| False negative rate | < 5% (rarely kill a profitable load) |

---

## 7. Configuration

All thresholds should be configurable without code changes. Store in a `pipeline_config` JSON in the settings table or as environment variables:

```typescript
const config = {
  minHoursUntilPickup: 4,        // Don't pursue loads picking up in < 4 hours
  minMarginMultiplier: 0.5,      // Kill if best-case margin < 50% of minimum
  maxFatigueScore: 3,            // Don't call shippers with fatigue >= 3
  maxCallsPerDayPerPhone: 1,     // Max calls to same number per day
  maxCallsPerWeekPerPhone: 3,    // Max calls to same number per week
};
```

---

*End of document. The qualifier is the gatekeeper. It protects the pipeline from waste and protects shippers from annoyance.*
