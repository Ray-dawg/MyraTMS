# T-03: ORCHESTRATION BACKBONE — ARCHITECTURE & SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

This document specifies the event-driven orchestration layer that replaces n8n as the pipeline backbone. It defines how loads flow through the 7-agent pipeline, how agents communicate, how concurrency is managed, and how failures are handled. This is the connective tissue that makes everything work together.

---

## 1. Architecture Decision

### Why Not n8n

n8n is a visual workflow tool optimized for linear automation. The Myra agent pipeline requires:
- Parallel execution (Agent 3 and Agent 4 run simultaneously)
- 200+ concurrent voice calls through Agent 6
- Real-time state transitions on the pipeline_loads table
- Testability (unit tests on each agent, integration tests on the pipeline)
- Version control (code in git, not visual node configs)
- Cost efficiency (no per-execution pricing at scale)

### The Stack

| Component | Technology | Purpose |
|---|---|---|
| **Job queue** | BullMQ on Upstash Redis | Manages job distribution, retries, concurrency limits, dead letter queues |
| **State store** | Neon PostgreSQL (pipeline_loads table) | Single source of truth for every load's current stage |
| **Agent workers** | TypeScript serverless functions (Vercel) | Each agent is an independent function that processes jobs from its queue |
| **Monitoring** | agent_jobs table + Vercel logs | Pipeline observability without querying Redis |
| **Exception handler** | Notification via email/Slack | Alerts for stuck loads, failed jobs, escalations |

### Why BullMQ

BullMQ is a Redis-backed job queue for Node.js/TypeScript. It provides exactly what the pipeline needs:
- Named queues (one per agent transition)
- Configurable concurrency per queue
- Automatic retries with exponential backoff
- Dead letter queues for permanently failed jobs
- Job priority (high-profit loads processed first)
- Job events (started, completed, failed) for monitoring
- Delayed jobs (for scheduled callbacks and follow-ups)

---

## 2. Pipeline Stage Machine

### Stage Flow Diagram

```
LOAD ENTERS
    │
    ▼
[scanned] ──── Agent 1 (Scanner) writes load
    │
    ▼
[qualified] ── Agent 2 (Qualifier) passes filter
    │           └── [disqualified] (dead end — load killed)
    ▼
[researched] ─ Agent 3 (Researcher) + Agent 4 (Ranker) run in PARALLEL
    │
    ▼
[matched] ──── Both Agent 3 and Agent 4 have completed
    │
    ▼
[briefed] ──── Agent 5 (Compiler) merges into negotiation brief
    │
    ▼
[calling] ──── Agent 6 (Voice) is on an active call
    │
    ├── [booked] ────── Call succeeded → Agent 7 (Dispatcher)
    ├── [declined] ───── Call completed, shipper said no
    ├── [escalated] ──── Agent couldn't resolve, human review needed
    ├── [callback] ────── Shipper requested callback (delayed job)
    │
    ▼
[dispatched] ── Agent 7 created load in TMS
    │
    ▼
[delivered] ─── Load delivered, POD captured
    │
    ▼
[scored] ────── Feedback Agent processed outcomes
```

### Stage Transitions Are Write-Once

Each stage transition updates `pipeline_loads.stage` and `pipeline_loads.stage_updated_at`. The previous stage is not stored in the row — it's implicit in the agent_jobs audit trail. This keeps the schema simple.

### Parallel Execution at the Research Stage

When a load enters `qualified`, TWO jobs are enqueued simultaneously:
1. `research-queue` → Agent 3 (Researcher)
2. `match-queue` → Agent 4 (Carrier Ranker)

Both write their results to the pipeline_loads row. A **completion gate** checks if both have finished:
- When Agent 3 completes: check if `carrier_match_count > 0` (Agent 4 done?)
- When Agent 4 completes: check if `research_completed_at IS NOT NULL` (Agent 3 done?)
- If both done: advance to `matched` and enqueue to `brief-queue`
- If only one done: do nothing, wait for the other

This avoids race conditions with a simple DB check rather than complex distributed locks.

---

## 3. Queue Definitions

### Queue Registry

| Queue Name | Source Agent | Target Agent | Concurrency | Retry | Priority |
|---|---|---|---|---|---|
| `qualify-queue` | Scanner (1) | Qualifier (2) | 50 | 3 attempts, 30s backoff | By posted_rate DESC |
| `research-queue` | Qualifier (2) | Researcher (3) | 20 | 3 attempts, 60s backoff | By priority_score DESC |
| `match-queue` | Qualifier (2) | Ranker (4) | 20 | 3 attempts, 30s backoff | By priority_score DESC |
| `brief-queue` | Completion gate | Compiler (5) | 20 | 2 attempts, 30s backoff | By priority_score DESC |
| `call-queue` | Compiler (5) | Voice Agent (6) | 100 | 1 attempt (no retry on calls) | By estimated_margin DESC |
| `dispatch-queue` | Voice Agent (6) | Dispatcher (7) | 10 | 3 attempts, 60s backoff | By profit DESC |
| `feedback-queue` | Dispatcher (7) | Feedback Agent | 5 | 3 attempts, 300s backoff | FIFO |
| `callback-queue` | Voice Agent (6) | Voice Agent (6) | 20 | 1 attempt | By scheduled time |
| `escalation-queue` | Any agent | Notification service | 5 | 3 attempts | By urgency |

### Concurrency Rationale

- **qualify-queue: 50** — Pure SQL/logic, very fast. High throughput.
- **research-queue: 20** — Each job makes a Claude API call (~2–5 seconds). 20 concurrent = ~240 research jobs/minute.
- **match-queue: 20** — Each job queries carrier database. Fast but involves DB reads.
- **call-queue: 100** — Retell supports dozens of concurrent calls. This is the throughput bottleneck for the whole pipeline. 100 concurrent = up to 100 simultaneous phone calls.
- **dispatch-queue: 10** — Lower concurrency because each dispatch involves multiple TMS writes. Serialization prevents conflicts.

---

## 4. Job Payload Schemas

Every job in every queue carries a typed JSON payload. These TypeScript interfaces define the contract between agents.

### Base Job Payload

```typescript
interface BaseJobPayload {
  pipelineLoadId: number;
  loadId: string;
  loadBoardSource: string;
  enqueuedAt: string; // ISO timestamp
  priority: number;
}
```

### Qualify Queue Payload

```typescript
interface QualifyJobPayload extends BaseJobPayload {
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  equipmentType: string;
  postedRate: number | null;
  postedRateCurrency: string;
  distanceMiles: number;
  pickupDate: string;
  shipperPhone: string | null;
}
```

### Research Queue Payload

```typescript
interface ResearchJobPayload extends BaseJobPayload {
  qualifiedLoad: {
    origin: { city: string; state: string; country: string };
    destination: { city: string; state: string; country: string };
    equipmentType: string;
    distanceMiles: number;
    distanceKm: number;
    postedRate: number | null;
    postedRateCurrency: string;
    pickupDate: string;
    deliveryDate: string | null;
    commodity: string | null;
    weightLbs: number | null;
  };
  priorityScore: number;
  estimatedMarginRange: { low: number; high: number };
}
```

### Match Queue Payload

```typescript
interface MatchJobPayload extends BaseJobPayload {
  qualifiedLoad: {
    origin: { city: string; state: string; country: string };
    destination: { city: string; state: string; country: string };
    equipmentType: string;
    distanceMiles: number;
    pickupDate: string;
    weightLbs: number | null;
  };
}
```

### Brief Queue Payload

```typescript
interface BriefJobPayload extends BaseJobPayload {
  researchResult: {
    marketRateFloor: number;
    marketRateMid: number;
    marketRateBest: number;
    totalCost: number;
    marginEnvelope: {
      floor: number;
      target: number;
      stretch: number;
    };
    recommendedStrategy: 'aggressive' | 'standard' | 'walk';
    shipperProfile: {
      postingFrequency: number;
      historicalRates: number[];
      preferredLanguage: string;
    };
  };
  carrierStack: Array<{
    carrierId: number;
    companyName: string;
    contactPhone: string;
    rate: number;
    matchScore: number;
    availabilityConfidence: 'high' | 'medium' | 'low';
    equipmentConfirmed: boolean;
  }>;
}
```

### Call Queue Payload

```typescript
interface CallJobPayload extends BaseJobPayload {
  briefId: number;
  brief: NegotiationBrief; // Full brief JSON — see T-08
  retellAgentId: string;
  phoneNumber: string;
  language: string;
}
```

### Dispatch Queue Payload

```typescript
interface DispatchJobPayload extends BaseJobPayload {
  agreedRate: number;
  agreedRateCurrency: string;
  profit: number;
  carrierId: number;
  carrierRate: number;
  shipperEmail: string;
  callId: string;
}
```

---

## 5. Agent Worker Pattern

Every agent follows the same structural pattern. This makes the codebase consistent and testable.

```typescript
// Pattern for every agent worker

import { Worker, Job } from 'bullmq';
import { redis } from '../lib/redis';
import { db } from '../lib/database';

const worker = new Worker(
  'QUEUE_NAME',
  async (job: Job<PayloadType>) => {
    const { pipelineLoadId } = job.data;
    
    try {
      // 1. Validate: load still exists and is in expected stage
      const load = await db.query(
        'SELECT * FROM pipeline_loads WHERE id = $1 AND stage = $2',
        [pipelineLoadId, 'EXPECTED_STAGE']
      );
      if (!load) return { skipped: true, reason: 'stage_mismatch' };
      
      // 2. Execute: agent-specific logic
      const result = await executeAgentLogic(job.data);
      
      // 3. Update: write results to pipeline_loads
      await db.query(
        'UPDATE pipeline_loads SET stage = $1, stage_updated_at = NOW(), ... WHERE id = $2',
        ['NEXT_STAGE', pipelineLoadId]
      );
      
      // 4. Enqueue: push to next queue
      await nextQueue.add('job-name', nextPayload, { priority: result.priority });
      
      // 5. Log: record in agent_jobs table
      await db.query(
        'UPDATE agent_jobs SET status = $1, completed_at = NOW(), result = $2 WHERE job_id = $3',
        ['completed', JSON.stringify(result), job.id]
      );
      
      return result;
      
    } catch (error) {
      // Log failure
      await db.query(
        'UPDATE agent_jobs SET status = $1, failed_at = NOW(), error_message = $2 WHERE job_id = $3',
        ['failed', error.message, job.id]
      );
      throw error; // BullMQ handles retry
    }
  },
  {
    connection: redis,
    concurrency: CONCURRENCY_LIMIT,
  }
);
```

---

## 6. Error Handling & Recovery

### Retry Strategy

| Error Type | Retry? | Max Attempts | Backoff | Action After Max |
|---|---|---|---|---|
| Network timeout (API call) | Yes | 3 | Exponential (30s, 60s, 120s) | Dead letter |
| Database connection error | Yes | 3 | Fixed 10s | Dead letter + alert |
| Claude API rate limit | Yes | 5 | Exponential (60s, 120s, 240s, 480s, 960s) | Dead letter |
| Retell API error | Yes | 2 | Fixed 30s | Escalate to human |
| Invalid data (parsing error) | No | 1 | N/A | Dead letter + alert |
| Business logic failure | No | 1 | N/A | Escalate to human |

### Dead Letter Handling

Jobs that exhaust all retries go to a dead letter queue (one per source queue). A nightly sweep checks all dead letter queues and:
1. Logs the failure in agent_jobs with status `dead_letter`
2. Updates pipeline_loads stage to `escalated` if load is still active
3. Sends notification (email/Slack) with job details and error

### Stuck Load Detection

A cron job runs every 15 minutes checking for loads stuck in a stage too long:

```sql
SELECT * FROM pipeline_loads
WHERE stage NOT IN ('scored', 'disqualified', 'expired', 'declined')
AND stage_updated_at < NOW() - INTERVAL '30 minutes'
ORDER BY stage_updated_at ASC;
```

Stuck loads get:
1. Re-enqueued to their current stage's queue (idempotent — agent checks stage before processing)
2. If stuck 3+ times: escalated to human review

### Load Expiry

Loads with `pickup_date` in the past that aren't booked get automatically expired:

```sql
UPDATE pipeline_loads
SET stage = 'expired', stage_updated_at = NOW()
WHERE stage NOT IN ('booked', 'dispatched', 'delivered', 'scored', 'expired')
AND pickup_date < NOW();
```

---

## 7. Manual Override Patterns

Patrice must be able to intervene at any point in the pipeline.

### Inject a Load Manually

Insert directly into `pipeline_loads` with stage `scanned`. The qualify-queue picks it up automatically.

Alternatively, insert with stage `qualified` (skip the filter) or `briefed` (skip research and go straight to calling) for loads Patrice has already analyzed.

### Skip a Stage

Update `pipeline_loads.stage` directly and enqueue to the target queue. The system is stage-driven — advancing the stage tells the next agent to pick it up.

### Force Escalation

Set `stage = 'escalated'` on any load. This pulls it out of the automated pipeline and into the human review queue.

### Pause the Pipeline

Set `is_active = false` on any persona to stop calls using that persona. Set all personas inactive to stop all outbound calls. The pipeline continues processing loads through research and briefing but holds at the call stage.

### Override a Rate

Before a call, update the negotiation_brief directly in the database. The voice agent reads the brief at call time — whatever's in the brief is what it uses.

---

## 8. Callback and Follow-Up Scheduling

When a call results in `callback_scheduled_at`, a delayed job is created:

```typescript
await callbackQueue.add(
  'callback',
  { pipelineLoadId, briefId, phoneNumber },
  { 
    delay: callbackTimestamp - Date.now(), // milliseconds until callback time
    priority: 1 // high priority — these are warm leads
  }
);
```

The callback-queue worker re-checks the load status before calling (it may have been booked by another agent or expired). If still active, it initiates a new Retell call with an updated brief that references the previous conversation.

---

## 9. Pipeline Metrics

### Real-Time (Query pipeline_loads)

```sql
-- Loads per stage right now
SELECT stage, COUNT(*) FROM pipeline_loads
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY stage;

-- Average time in each stage (bottleneck detection)
SELECT stage, AVG(EXTRACT(EPOCH FROM (stage_updated_at - lag_updated))) as avg_seconds
FROM (
    SELECT *, LAG(stage_updated_at) OVER (PARTITION BY id ORDER BY stage_updated_at) as lag_updated
    FROM pipeline_loads
) sub
GROUP BY stage;

-- Throughput: loads processed per hour
SELECT DATE_TRUNC('hour', stage_updated_at) as hour, COUNT(*)
FROM pipeline_loads WHERE stage = 'booked'
GROUP BY hour ORDER BY hour DESC LIMIT 24;
```

### Daily (Computed by Feedback Agent)

- Total loads scanned
- Qualification rate (% passing Agent 2)
- Research completion rate
- Call attempt rate
- Booking rate (booked / calls made)
- Average profit per booked load
- Escalation rate
- Average pipeline transit time (scanned → booked)

---

## 10. File Structure

```
/lib/
  /pipeline/
    queues.ts          — Queue definitions and connections
    stages.ts          — Stage enum and validation
    payloads.ts        — TypeScript interfaces for all job payloads
    gate.ts            — Completion gate logic (Agent 3+4 parallel merge)
    metrics.ts         — Pipeline metric queries
  /workers/
    scanner.worker.ts  — Agent 1
    qualifier.worker.ts — Agent 2
    researcher.worker.ts — Agent 3
    ranker.worker.ts   — Agent 4
    compiler.worker.ts — Agent 5
    voice.worker.ts    — Agent 6
    dispatcher.worker.ts — Agent 7
    feedback.worker.ts — Feedback Agent
    callback.worker.ts — Callback handler
  /cron/
    stuck-load-detector.ts
    load-expiry.ts
    dead-letter-sweep.ts
```

---

*End of document. The orchestration backbone is the spine. Build it first, test it with mock data, then wire agents one at a time.*
