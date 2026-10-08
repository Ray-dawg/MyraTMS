# T-10: AGENT 7 — DISPATCHER SERVICE SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Reconciliation note (E2-03, 2026-08-25)

- **§4 (`assignWithFallback()`):** Implemented as M2's cascade worker (E2-03 §6.3), not inside `dispatcher-worker.ts` itself — the Dispatcher now consumes a *secured* carrier from the cascade rather than performing fallback logic in-line.
- **§3 (`AUTO_BOOK_PROFIT_THRESHOLD` decision tree):** Retired — see T-18's governance envelope (`policies.auto_book_profit_threshold_cad`) and E2-03 §5.4.3's cleanup.

---

## Purpose

Agent 7 (Dispatcher) handles everything after a load is booked. It creates the load in MyraTMS, generates the rate confirmation PDF, assigns the carrier, notifies all parties, schedules check-calls, and activates GPS tracking. This agent bridges Engine 2 (AI pipeline) with Engine 1 (TMS operations).

**T-01 confirms:** The full dispatch lifecycle already works end-to-end in MyraTMS. Agent 7's job is to chain existing API calls together automatically instead of requiring manual clicks.

---

## 1. Existing Foundation (from T-01 Audit)

Every step Agent 7 needs already exists as a working API route:

| Step | Existing Route | Status | Notes |
|---|---|---|---|
| Create load | `POST /api/loads` | WORKING | Auto-generates ID, calculates margin%, fires workflow engine |
| Assign carrier | `POST /api/loads/[id]/assign` | WORKING | Auto-generates rate con PDF, optional auto-email |
| Generate tracking token | `POST /api/loads/[id]/tracking-token` | WORKING | 64-char hex, 30-day expiry |
| Send tracking link | `POST /api/loads/[id]/send-tracking` | WORKING | Email to shipper (requires SMTP) |
| Create invoice | `POST /api/loads/[id]/invoice` | WORKING | Auto from load revenue |
| Log events | Load events timeline | WORKING | Chronological event history per load |
| Notifications | `POST /api/notifications` | WORKING | In-app + SSE |
| Workflow triggers | Workflow engine | WORKING | Fires on load status change |

**Agent 7 does NOT need new API routes.** It calls existing routes in sequence.

---

## 2. Dispatch Sequence

When a booked load arrives in the `dispatch-queue`:

```
Step 1: CREATE LOAD        → POST /api/loads (with pipeline_load_id linkage)
Step 2: ASSIGN CARRIER      → POST /api/loads/[id]/assign (top carrier from brief)
Step 3: GENERATE TRACKING   → POST /api/loads/[id]/tracking-token
Step 4: NOTIFY SHIPPER      → POST /api/loads/[id]/send-tracking
Step 5: SCHEDULE CHECK-CALLS → Insert check-call schedule into TMS
Step 6: UPDATE PIPELINE     → Set pipeline_loads.stage = 'dispatched'
Step 7: LOG COMPLETION      → Update agent_jobs, fire notification
```

### Worker Implementation

```typescript
const dispatcherWorker = new Worker(
  'dispatch-queue',
  async (job: Job<DispatchJobPayload>) => {
    const { pipelineLoadId, agreedRate, agreedRateCurrency, profit, carrierId, carrierRate, shipperEmail, callId } = job.data;
    
    // Fetch the full pipeline load and brief
    const pipelineLoad = await db.query('SELECT * FROM pipeline_loads WHERE id = $1', [pipelineLoadId]);
    const pl = pipelineLoad.rows[0];
    
    // Step 1: Create load in TMS
    const loadResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/loads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `auth-token=${getServiceToken()}` },
      body: JSON.stringify({
        origin: `${pl.origin_city}, ${pl.origin_state}`,
        destination: `${pl.destination_city}, ${pl.destination_state}`,
        revenue: agreedRate,
        carrier_cost: carrierRate,
        equipment: pl.equipment_type,
        commodity: pl.commodity,
        weight: pl.weight_lbs?.toString() || '',
        pickup_date: pl.pickup_date,
        delivery_date: pl.delivery_date,
        source: 'Load Board',
        status: 'Booked',
        // Link back to pipeline
        pipeline_load_id: pipelineLoadId,
        source_type: 'ai_agent',
        booked_via: 'ai_auto',
      }),
    });
    const tmsLoad = await loadResponse.json();
    const tmsLoadId = tmsLoad.id;
    
    // Step 2: Assign carrier
    await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/loads/${tmsLoadId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `auth-token=${getServiceToken()}` },
      body: JSON.stringify({
        carrier_id: carrierId,
        carrier_cost: carrierRate,
        auto_send_ratecon: true, // Send rate con PDF to carrier via email
      }),
    });
    
    // Step 3: Generate tracking token
    await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/loads/${tmsLoadId}/tracking-token`, {
      method: 'POST',
      headers: { 'Cookie': `auth-token=${getServiceToken()}` },
    });
    
    // Step 4: Send tracking link to shipper
    if (shipperEmail) {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/loads/${tmsLoadId}/send-tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': `auth-token=${getServiceToken()}` },
        body: JSON.stringify({ email: shipperEmail }),
      });
    }
    
    // Step 5: Update pipeline_loads
    await db.query(`
      UPDATE pipeline_loads SET
        stage = 'dispatched',
        stage_updated_at = NOW(),
        tms_load_id = $2,
        dispatched_at = NOW()
      WHERE id = $1
    `, [pipelineLoadId, tmsLoadId]);
    
    // Step 6: Log success
    return { success: true, tmsLoadId, carrier: carrierId, rate: agreedRate, profit };
  },
  { connection: redis, concurrency: 10 }
);
```

---

## 3. Auto-Book Decision Tree

Not every booked load should be auto-dispatched. The threshold increases over time as confidence grows.

| Phase | Auto-Book Threshold | Human Review |
|---|---|---|
| Month 1 (pilot) | ALL loads require human review | Patrice reviews every booking |
| Month 2 | Profit ≥ $300 auto-books | $200–$300 flagged for review |
| Month 3 | Profit ≥ $250 auto-books | $200–$250 flagged for review |
| Month 4+ | Profit ≥ $200 auto-books | Below $200 rejected by Agent 6 |

The threshold is configured in the `pipeline_config` (environment variable or settings table):

```typescript
const AUTO_BOOK_THRESHOLD = parseInt(process.env.AUTO_BOOK_PROFIT_THRESHOLD || '999999');
// Month 1: set to 999999 (effectively: review everything)
// Month 2: set to 300
// Month 3: set to 250
// Month 4+: set to 200
```

---

## 4. Error Handling and Rollback

If any step in the dispatch sequence fails:

| Step Failed | Recovery |
|---|---|
| Load creation | Log error, retry job. No cleanup needed. |
| Carrier assignment | Load exists but unassigned. Retry assignment. If carrier unavailable, try next carrier in stack. |
| Tracking token | Non-critical. Log warning, continue. Generate later. |
| Shipper notification | Non-critical. Log warning, continue. Send manually later. |
| Pipeline update | Critical. If DB write fails, job retries. Dead letter after 3 attempts. |

```typescript
// If carrier assignment fails, try next carrier in stack
async function assignWithFallback(tmsLoadId: string, carrierStack: CarrierStack, carrierRate: number) {
  for (const carrier of carrierStack) {
    try {
      await assignCarrier(tmsLoadId, carrier.carrierId, carrierRate);
      return carrier;
    } catch (error) {
      console.error(`Carrier ${carrier.carrierId} assignment failed:`, error);
      continue; // Try next carrier
    }
  }
  throw new Error('All carriers in stack failed assignment');
}
```

---

## 5. Service Token

Agent 7 calls TMS API routes that require authentication. Use a service account JWT:

```typescript
function getServiceToken(): string {
  // Generate a JWT for the 'system' user with 'admin' role
  // This token is used only by pipeline workers for internal API calls
  return jwt.sign(
    { userId: 'system', role: 'admin', type: 'service' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}
```

---

## 6. Post-Dispatch Monitoring

After dispatch, the load enters the standard TMS operational flow:
- Check-calls every 4 hours (existing exception detection cron)
- GPS tracking via driver app (existing DApp infrastructure)
- POD capture on delivery (existing POD route)
- Auto-invoice on POD (existing workflow trigger)

When the load is delivered and POD captured, the pipeline advances:

```typescript
// Trigger via existing workflow engine (load status → 'Delivered')
// Or via a cron that checks for delivered pipeline loads:
await db.query(`
  UPDATE pipeline_loads SET
    stage = 'delivered',
    stage_updated_at = NOW(),
    delivered_at = NOW()
  WHERE tms_load_id IN (
    SELECT id FROM loads WHERE status = 'Delivered'
  )
  AND stage = 'dispatched'
`);
```

---

*End of document. The dispatcher is the handoff from AI to operations. If this works, the shipper never knows an AI booked their load.*
