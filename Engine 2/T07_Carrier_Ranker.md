# T-07: AGENT 4 — CARRIER RANKER SERVICE SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

Agent 4 (Carrier Ranker) takes a qualified load and returns a ranked stack of the top 3 carriers who can move it. This agent wraps the existing 5-criteria matching engine as a standalone pipeline service. It runs in parallel with Agent 3 (Researcher) — both are triggered when a load enters the `qualified` stage.

**This agent is ~85% built.** The matching engine exists and works. The gap is extracting it from a TMS API route into a pipeline worker and adding the completion gate check.

---

## 1. Existing Foundation (from T-01 Audit)

| Component | Status | Location | Notes |
|---|---|---|---|
| Matching engine | FULLY WORKING | `lib/matching/` | 5-criteria scoring, grades A–F |
| `/api/loads/[id]/match` | WORKING | Loads routes | Runs matching algo, stores results in `match_results` |
| `/api/loads/bulk-match` | WORKING | Loads routes | Matches up to 50 loads in parallel |
| `match_results` table | EXISTS | Migration 005 | Stores: load_id, carrier_id, match_score, match_grade, breakdown (JSONB), was_selected, was_accepted |
| `carrier_equipment` table | EXISTS | Migration 005 | Equipment type + truck count per carrier |
| `carrier_lanes` table | EXISTS | Migration 005 | Lane familiarity: origin/dest regions, load count, avg rate, on-time rate |
| Lane refresh route | WORKING | `/api/matching/refresh-lanes` | Rebuilds carrier_lanes from 365 days of load history |
| Hard filters | WORKING | Matching engine | Equipment type, active authority, valid insurance, exclusion list |

### The 5-Criteria Scoring Engine (Already Built)

| Criteria | Weight | Data Source | Method |
|---|---|---|---|
| **Lane familiarity** | 30% | `carrier_lanes` table | Historical loads on same lane (180-day window), reverse/nearby lane bonuses |
| **Proximity** | 25% | `location_pings` table + `carriers.home_base` | Nearest driver GPS within 24h, falls back to carrier home base. GPS confidence levels. |
| **Rate** | 20% | `carrier_lanes.avg_carrier_rate` + load target | Carrier average rate vs. target rate. 90-day lane average, fallback to all-loads average. |
| **Reliability** | 15% | `carriers` table performance fields | On-time %, communication rating, load count (NEW/PROVEN/VETERAN labels) |
| **Relationship** | 10% | Load history | Days since last load + frequency (90-day). Recency decay curve. |

### Grading Scale (Already Built)

| Grade | Score Range | Meaning |
|---|---|---|
| A | 0.85–1.00 | Excellent match — high confidence |
| B | 0.70–0.84 | Good match — reliable choice |
| C | 0.55–0.69 | Acceptable match — workable |
| D | 0.40–0.54 | Marginal match — use with caution |
| F | 0.00–0.39 | Poor match — likely decline |

---

## 2. What Needs to Be Built

The matching engine is a library function called by API routes. To use it in the pipeline, we need:

1. **A pipeline worker** that reads from `match-queue` and calls the matching engine
2. **Writes to `pipeline_loads`** instead of (or in addition to) `match_results`
3. **The `carrier_stack` output format** that Agent 5 expects
4. **Completion gate check** — after writing results, check if Agent 3 is also done

### NOT Needed

- No changes to the matching algorithm itself
- No new scoring criteria
- No new database tables (uses existing `match_results`, `carrier_lanes`, `carrier_equipment`)

---

## 3. The carrier_stack Output

Agent 4 returns a ranked array of the top 3 carriers. This is the format Agent 5 (Brief Compiler) expects:

```typescript
interface CarrierStackEntry {
  carrierId: string;              // TMS carrier ID (e.g., "CAR-1234")
  companyName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  
  // Match scoring
  matchScore: number;             // 0.00–1.00 from matching engine
  matchGrade: string;             // 'A' | 'B' | 'C' | 'D' | 'F'
  breakdown: {
    laneFamiliarity: number;      // 0–1
    proximity: number;            // 0–1
    rate: number;                 // 0–1
    reliability: number;          // 0–1
    relationship: number;         // 0–1
  };
  
  // Rate
  expectedRate: number;           // What this carrier typically charges for this lane
  rateCurrency: string;           // 'CAD' | 'USD'
  
  // Reliability data
  onTimePercentage: number | null;
  communicationRating: number | null;  // 1–5 stars
  totalLoadsWithMyra: number;
  veteranStatus: string;          // 'NEW' | 'PROVEN' | 'VETERAN'
  
  // Availability
  availabilityConfidence: 'high' | 'medium' | 'low';
  equipmentConfirmed: boolean;
  homeBaseCity: string;
  homeBaseState: string;
  estimatedDeadheadMiles: number | null;
  
  // Preferences
  paymentPreference: string;      // 'quick_pay' | 'net_15' | 'net_30'
  preferredContactMethod: string; // 'phone' | 'email' | 'text'
}

type CarrierStack = CarrierStackEntry[];  // Max 3 entries, ordered by matchScore DESC
```

---

## 4. Worker Implementation

```typescript
// /lib/workers/ranker.worker.ts

import { Worker, Job } from 'bullmq';
import { runMatchingEngine } from '@/lib/matching';
import { redis } from '../redis';
import { db } from '../database';

const rankerWorker = new Worker(
  'match-queue',
  async (job: Job<MatchJobPayload>) => {
    const { pipelineLoadId, qualifiedLoad } = job.data;
    
    // Verify load is still in 'qualified' stage (hasn't been killed or expired)
    const load = await db.query(
      'SELECT * FROM pipeline_loads WHERE id = $1 AND stage = $2',
      [pipelineLoadId, 'qualified']
    );
    if (!load.rows[0]) return { skipped: true, reason: 'stage_mismatch' };
    
    // Run the existing matching engine
    // The engine needs a load object in TMS format — adapt the pipeline load
    const tmsLoadFormat = adaptToTMSLoad(qualifiedLoad);
    const matchResults = await runMatchingEngine(tmsLoadFormat);
    
    // Take top 3 results
    const topMatches = matchResults
      .filter(m => m.matchGrade !== 'F')  // Exclude F-grade matches
      .slice(0, 3);
    
    if (topMatches.length === 0) {
      // No viable carriers — this load can't be covered
      await db.query(`
        UPDATE pipeline_loads SET
          carrier_match_count = 0,
          stage = 'disqualified',
          stage_updated_at = NOW(),
          qualification_reason = 'No carriers matched above F grade'
        WHERE id = $1
      `, [pipelineLoadId]);
      return { matched: false, reason: 'no_viable_carriers' };
    }
    
    // Build the carrier stack
    const carrierStack: CarrierStack = await Promise.all(
      topMatches.map(async (match) => {
        const carrier = await db.query('SELECT * FROM carriers WHERE id = $1', [match.carrierId]);
        const c = carrier.rows[0];
        return {
          carrierId: c.id,
          companyName: c.company_name,
          contactName: c.contact_name,
          contactPhone: c.contact_phone,
          contactEmail: c.contact_email,
          matchScore: match.matchScore,
          matchGrade: match.matchGrade,
          breakdown: match.breakdown, // JSONB from match_results
          expectedRate: match.expectedRate || null,
          rateCurrency: 'CAD',
          onTimePercentage: c.on_time_rate ? parseFloat(c.on_time_rate) * 100 : null,
          communicationRating: c.communication_rating ? parseFloat(c.communication_rating) : null,
          totalLoadsWithMyra: c.total_loads || 0,
          veteranStatus: c.total_loads >= 20 ? 'VETERAN' : c.total_loads >= 5 ? 'PROVEN' : 'NEW',
          availabilityConfidence: determineAvailability(c, qualifiedLoad),
          equipmentConfirmed: true, // Hard filter already passed
          homeBaseCity: c.home_base_city || '',
          homeBaseState: c.home_base_state || '',
          estimatedDeadheadMiles: match.proximityMiles || null,
          paymentPreference: c.payment_terms || 'net_30',
          preferredContactMethod: c.preferred_contact_method || 'phone',
        };
      })
    );
    
    // Write results to pipeline_loads
    await db.query(`
      UPDATE pipeline_loads SET
        carrier_match_count = $2,
        top_carrier_id = $3
      WHERE id = $1
    `, [pipelineLoadId, carrierStack.length, parseInt(carrierStack[0].carrierId.replace('CAR-', ''))]);
    
    // Store match results in match_results table (existing pattern)
    for (const match of topMatches) {
      await db.query(`
        INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [generateId('MR'), pipelineLoadId.toString(), match.carrierId, match.matchScore, match.matchGrade, JSON.stringify(match.breakdown)]);
    }
    
    // COMPLETION GATE: Check if Agent 3 (Researcher) is also done
    const check = await db.query(
      'SELECT research_completed_at FROM pipeline_loads WHERE id = $1',
      [pipelineLoadId]
    );
    
    if (check.rows[0].research_completed_at) {
      // Both agents done — advance to 'matched'
      await db.query(
        "UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() WHERE id = $1",
        [pipelineLoadId]
      );
      
      // Enqueue to brief-queue with carrier stack attached
      await briefQueue.add('brief', {
        pipelineLoadId,
        carrierStack, // Attached directly to the job payload
      }, { priority: load.rows[0].priority_score });
    }
    // If Agent 3 isn't done yet — do nothing. Agent 3 will trigger the gate when it completes.
    
    return { matched: true, carrierCount: carrierStack.length, topGrade: carrierStack[0].matchGrade };
  },
  { connection: redis, concurrency: 20 }
);
```

---

## 5. Availability Confidence Logic

```typescript
function determineAvailability(carrier: any, load: QualifiedLoad): 'high' | 'medium' | 'low' {
  // High: carrier has GPS ping within 24h near origin AND has confirmed equipment
  // Medium: carrier has home base in the region OR has run this lane in last 30 days
  // Low: carrier matches on equipment only, no proximity or recency data
  
  const hasRecentPing = carrier.last_ping_at && 
    new Date(carrier.last_ping_at) > new Date(Date.now() - 24 * 3600000);
  
  const hasRecentLaneActivity = carrier.last_load_date &&
    new Date(carrier.last_load_date) > new Date(Date.now() - 30 * 24 * 3600000);
  
  const isLocalToOrigin = carrier.home_base_state === load.qualifiedLoad.origin.state;
  
  if (hasRecentPing) return 'high';
  if (hasRecentLaneActivity || isLocalToOrigin) return 'medium';
  return 'low';
}
```

---

## 6. Performance Targets

| Metric | Target |
|---|---|
| Matching time per load | < 500ms (existing engine is fast) |
| Carrier stack size | 1–3 (minimum 1 to pass) |
| Top match grade | B or above for 70%+ of loads |
| Bulk throughput | 50 loads in < 10 seconds |

---

## 7. Lane Data Freshness

The matching engine's lane familiarity scoring depends on the `carrier_lanes` table, which is rebuilt by `/api/matching/refresh-lanes`. This refresh should run:

- Daily at 2 AM (existing cron pattern)
- After every 50 completed loads (trigger from feedback agent)
- Manually when Patrice adds a new batch of carriers

The refresh rebuilds from 365 days of load history, grouped by region and equipment type.

---

## 8. Edge Cases

| Scenario | Handling |
|---|---|
| Only 1 carrier matches | Proceed — single carrier is enough. Brief notes "limited carrier options." |
| No carrier matches above D grade | Proceed with D grade but flag as "carrier_risk" in the brief. |
| No carrier matches at all | Disqualify the load. Update stage to `disqualified` with reason. |
| Top carrier has no phone number | Skip to next carrier in stack. If none have phones, disqualify. |
| Carrier's insurance expired since last check | Hard filter catches this. Trigger FMCSA re-verification cron. |

---

*End of document. The ranker finds the truck. Without a truck, there's no deal.*
