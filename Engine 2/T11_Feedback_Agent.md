# T-11: FEEDBACK AGENT — LEARNING LOOP SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

The Feedback Agent runs post-delivery. It compares predicted outcomes against actual outcomes and updates the intelligence that makes every upstream agent smarter. This is the compounding engine — after 500 loads, rate predictions improve, persona selection sharpens, and carrier scoring becomes more accurate. Without this agent, the system never learns.

---

## 1. Trigger Conditions

The Feedback Agent activates in two modes:

**Per-load (event-driven):** When a pipeline load reaches `delivered` stage, a job is enqueued to `feedback-queue` for that specific load.

**Nightly aggregation (cron):** A daily cron job at 2:00 AM ET aggregates all call data from the past 30 days and updates lane stats, persona metrics, and rate cascade correction factors.

---

## 2. Per-Load Feedback

For each delivered load:

```typescript
async function processLoadFeedback(pipelineLoadId: number) {
  // Fetch pipeline load + associated call + brief
  const pl = await db.query('SELECT * FROM pipeline_loads WHERE id = $1', [pipelineLoadId]);
  const call = await db.query('SELECT * FROM agent_calls WHERE pipeline_load_id = $1 AND outcome = $2', [pipelineLoadId, 'booked']);
  const brief = await db.query('SELECT brief FROM negotiation_briefs WHERE pipeline_load_id = $1', [pipelineLoadId]);
  const tmsLoad = await db.query('SELECT * FROM loads WHERE id = $1', [pl.rows[0].tms_load_id]);
  
  const load = pl.rows[0];
  const callData = call.rows[0];
  const briefData = brief.rows[0]?.brief;
  const actualLoad = tmsLoad.rows[0];
  
  // 1. Rate accuracy: predicted vs actual
  const predictedMid = load.market_rate_mid;
  const actualAgreed = load.agreed_rate;
  const rateAccuracy = predictedMid > 0 ? 1 - Math.abs(actualAgreed - predictedMid) / predictedMid : null;
  
  // 2. Cost accuracy: estimated vs actual carrier cost
  const estimatedCost = briefData?.rates?.totalCost;
  const actualCost = parseFloat(actualLoad?.carrier_cost || '0');
  const costAccuracy = estimatedCost > 0 ? 1 - Math.abs(actualCost - estimatedCost) / estimatedCost : null;
  
  // 3. Carrier performance
  const wasOnTime = actualLoad?.status === 'Delivered'; // Simplification — check delivery_date vs planned
  const carrierRating = actualLoad?.delivery_rating; // If shipper rated
  
  // 4. Profit accuracy
  const predictedProfit = load.profit;
  const actualProfit = parseFloat(actualLoad?.margin || '0');
  
  // Update pipeline_loads to 'scored'
  await db.query(`
    UPDATE pipeline_loads SET
      stage = 'scored',
      stage_updated_at = NOW()
    WHERE id = $1
  `, [pipelineLoadId]);
  
  // Update carrier performance in carriers table
  if (callData?.retell_call_id) {
    const carrierId = load.top_carrier_id;
    // Increment load count, update on-time rate
    await db.query(`
      UPDATE carriers SET
        total_loads = COALESCE(total_loads, 0) + 1,
        updated_at = NOW()
      WHERE id = $1
    `, [carrierId]);
  }
  
  // Update shipper preferences
  if (load.shipper_phone) {
    await db.query(`
      UPDATE shipper_preferences SET
        total_bookings = total_bookings + 1,
        avg_agreed_rate = (COALESCE(avg_agreed_rate, 0) * (total_bookings - 1) + $2) / total_bookings,
        updated_at = NOW()
      WHERE phone = $1
    `, [load.shipper_phone, actualAgreed]);
  }
  
  // Feed into quote feedback loop (existing in quoting engine)
  // Records actual rate vs estimated for rate source correction factors
  await db.query(`
    INSERT INTO quote_corrections (lane, source, estimated_rate, actual_rate, accuracy, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [
    `${load.origin_city}-${load.destination_city}`,
    briefData?.rates?.rateSources?.[0] || 'unknown',
    predictedMid,
    actualAgreed,
    rateAccuracy
  ]);
}
```

---

## 3. Nightly Aggregation Job

Runs at 2:00 AM ET via Vercel Cron.

### 3.1 Lane Stats Update

```sql
-- Aggregate last 30 days of booked calls by lane + persona + time
INSERT INTO lane_stats (
  lane, origin_city, origin_state, destination_city, destination_state, equipment_type,
  persona, day_of_week, hour_of_day,
  avg_posted_rate, avg_agreed_rate, avg_profit, rate_std_dev,
  min_agreed_rate, max_agreed_rate,
  total_calls, booked_count, booking_rate, avg_call_duration_sec,
  period_start, period_end, updated_at
)
SELECT
  CONCAT(pl.origin_city, ' → ', pl.destination_city) as lane,
  pl.origin_city, pl.origin_state, pl.destination_city, pl.destination_state,
  pl.equipment_type,
  ac.persona,
  EXTRACT(DOW FROM ac.call_initiated_at) as day_of_week,
  EXTRACT(HOUR FROM ac.call_initiated_at) as hour_of_day,
  AVG(pl.posted_rate) as avg_posted_rate,
  AVG(CASE WHEN ac.outcome = 'booked' THEN ac.agreed_rate END) as avg_agreed_rate,
  AVG(CASE WHEN ac.outcome = 'booked' THEN ac.profit END) as avg_profit,
  STDDEV(CASE WHEN ac.outcome = 'booked' THEN ac.agreed_rate END) as rate_std_dev,
  MIN(CASE WHEN ac.outcome = 'booked' THEN ac.agreed_rate END) as min_agreed_rate,
  MAX(CASE WHEN ac.outcome = 'booked' THEN ac.agreed_rate END) as max_agreed_rate,
  COUNT(*) as total_calls,
  COUNT(CASE WHEN ac.outcome = 'booked' THEN 1 END) as booked_count,
  COUNT(CASE WHEN ac.outcome = 'booked' THEN 1 END)::decimal / NULLIF(COUNT(*), 0) as booking_rate,
  AVG(ac.duration_seconds) as avg_call_duration,
  NOW() - INTERVAL '30 days' as period_start,
  NOW() as period_end,
  NOW()
FROM agent_calls ac
JOIN pipeline_loads pl ON ac.pipeline_load_id = pl.id
WHERE ac.call_initiated_at > NOW() - INTERVAL '30 days'
  AND ac.outcome IN ('booked', 'declined', 'counter_pending')
GROUP BY 1,2,3,4,5,6,7,8,9
ON CONFLICT (lane, persona, day_of_week, hour_of_day, equipment_type)
DO UPDATE SET
  avg_posted_rate = EXCLUDED.avg_posted_rate,
  avg_agreed_rate = EXCLUDED.avg_agreed_rate,
  avg_profit = EXCLUDED.avg_profit,
  rate_std_dev = EXCLUDED.rate_std_dev,
  min_agreed_rate = EXCLUDED.min_agreed_rate,
  max_agreed_rate = EXCLUDED.max_agreed_rate,
  total_calls = EXCLUDED.total_calls,
  booked_count = EXCLUDED.booked_count,
  booking_rate = EXCLUDED.booking_rate,
  avg_call_duration_sec = EXCLUDED.avg_call_duration_sec,
  period_start = EXCLUDED.period_start,
  period_end = EXCLUDED.period_end,
  updated_at = NOW();
```

### 3.2 Rate Adjustment Logic

```typescript
async function adjustRateTargets() {
  const lanes = await db.query(`
    SELECT lane, booking_rate, avg_profit, total_calls
    FROM lane_stats
    WHERE total_calls >= 10
    ORDER BY lane
  `);
  
  for (const lane of lanes.rows) {
    let adjustment = 0;
    
    if (lane.booking_rate < 0.20 && lane.total_calls >= 20) {
      // Booking too low — rates may be too aggressive, lower targets
      adjustment = -0.05;
    } else if (lane.booking_rate > 0.60 && lane.avg_profit < 250) {
      // Booking high but margins thin — raise rates
      adjustment = 0.03;
    } else if (lane.booking_rate > 0.50 && lane.avg_profit > 400) {
      // Strong performance — slight rate increase to capture more margin
      adjustment = 0.02;
    }
    
    if (adjustment !== 0) {
      await db.query(`
        UPDATE lane_stats SET rate_adjustment_factor = $2, updated_at = NOW()
        WHERE lane = $1
      `, [lane.lane, adjustment]);
    }
  }
}
```

### 3.3 Persona Performance Update (Thompson Sampling)

```typescript
async function updatePersonaStats() {
  const stats = await db.query(`
    SELECT
      ac.persona,
      COUNT(*) as total_calls,
      COUNT(CASE WHEN ac.outcome = 'booked' THEN 1 END) as total_bookings,
      AVG(CASE WHEN ac.outcome = 'booked' THEN ac.profit END) as avg_profit,
      SUM(CASE WHEN ac.outcome = 'booked' THEN ac.agreed_rate ELSE 0 END) as total_revenue
    FROM agent_calls ac
    WHERE ac.call_initiated_at > NOW() - INTERVAL '30 days'
    GROUP BY ac.persona
  `);
  
  for (const row of stats.rows) {
    const alpha = row.total_bookings + 1;
    const beta = (row.total_calls - row.total_bookings) + 1;
    const bookingRate = row.total_calls > 0 ? row.total_bookings / row.total_calls : 0;
    
    await db.query(`
      UPDATE personas SET
        total_calls = $2,
        total_bookings = $3,
        avg_profit = $4,
        total_revenue = $5,
        booking_rate = $6,
        alpha = $7,
        beta = $8,
        updated_at = NOW()
      WHERE persona_name = $1
    `, [row.persona, row.total_calls, row.total_bookings, row.avg_profit, row.total_revenue, bookingRate, alpha, beta]);
  }
}
```

### 3.4 Carrier Lane Refresh

Trigger the existing lane refresh endpoint to rebuild `carrier_lanes` with latest load data:

```typescript
await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/matching/refresh-lanes`, {
  method: 'POST',
  headers: { 'Cookie': `auth-token=${getServiceToken()}` },
});
```

---

## 4. Minimum Data Thresholds

| Insight Type | Min Data Required | When Meaningful |
|---|---|---|
| Lane-level rate adjustment | 10 calls on lane | ~Week 3–4 |
| Persona performance trends | 200 total calls | ~Month 2 |
| Day-of-week patterns | 50 calls per day-of-week | ~Month 2–3 |
| Hour-of-day patterns | 100 calls per time slot | ~Month 3–4 |
| Shipper-specific behavior | 3 calls to same shipper | Immediate |

Before thresholds are met, the system uses default settings (equal persona weights, benchmark rates, no lane adjustments).

---

## 5. Cron Configuration

```typescript
// Add to vercel.json crons (alongside existing cron jobs)
{
  "crons": [
    {
      "path": "/api/cron/feedback-aggregation",
      "schedule": "0 7 * * *"  // 2:00 AM ET = 07:00 UTC
    }
  ]
}
```

---

*End of document. The feedback loop is what makes this an AI company, not just a broker with a phone dialer. Without it, you're automating — with it, you're learning.*
