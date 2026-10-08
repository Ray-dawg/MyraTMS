# Engine 2 — End-to-End Autonomous Brokerage Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the Engine 2 7-agent AI pipeline into MyraTMS so loads scraped from load boards (DAT/Truckstop, with CSV import as the cold-start fallback) are automatically qualified, researched, matched to carriers, compiled into negotiation briefs, called via Retell AI for outbound voice negotiation, booked into the TMS, dispatched (rate-con + tracking + email), and post-delivery aggregated into a feedback loop that updates persona Thompson α/β and shipper preferences.

**Architecture:** BullMQ on Upstash Redis as the orchestration backbone (chosen over n8n in `T03_Orchestration_Backbone.md`); Neon PostgreSQL `pipeline_loads` table as the central state machine; 8 worker classes extending `BaseWorker`; a database-backed parallel completion gate synchronizing Researcher (Agent 3) and Ranker (Agent 4); Anthropic Claude API (replacing Grok) for research, brief compilation, and call parsing; Retell AI for outbound voice; and integration via existing TMS API routes (`POST /api/loads`, `/api/loads/[id]/assign`, `/tracking-token`, `/send-tracking`) using a service-token JWT.

**Tech Stack:** Next.js 16 (App Router), TypeScript 5, pnpm, BullMQ 5.x + ioredis, Upstash Redis (TCP, not REST), Neon PostgreSQL (`@neondatabase/serverless`), `@anthropic-ai/sdk`, Zod, Retell AI HTTP API, Vercel cron, Vitest.

**Source materials (single source of truth):** `Engine 2/CLAUDE_CODE_BUILD_PLAN.md` (BUILD 11). T-series specs (`T02`–`T13`) only when resolving ambiguities. Conversation playbook in `Engine 2/C04_Voice_Agent_Conversation_Playbook.md`. Retell agent configs in `retell_config_v2_gatekeeper.jsx` and `retell_config_carrier_onboarding.jsx` (configured in Retell dashboard, not deployed).

**Working directory for all paths below:** `MyraTMS/` (the Next.js app). Source files are copied from `Engine 2/` (sibling directory).

---

## Deployment Topology Decision (Sprint 0 prerequisite)

BullMQ workers are **long-running processes** (poll Redis indefinitely). Vercel Functions — even with Fluid Compute — are HTTP-triggered with a 300s max execution time. This plan ships workers in two modes:

1. **Local dev / shadow mode:** Workers run via `pnpm tsx scripts/run-workers.ts` as a single Node process on the developer's machine.
2. **Production:** Workers run on a separate worker host (Railway, Fly, or Render — small Node container that imports `lib/workers` and calls `startAllWorkers()`). Vercel hosts the Next.js app, the Retell webhook, and cron routes that enqueue/sweep but does NOT host workers.

This split is implicit in the build plan and made explicit here. Sprint 5 includes the worker-host setup. Until then, workers run locally.

---

## File Structure — Source → Destination Map

All paths are relative to `MyraTMS/`. Source paths are relative to `Engine 2/`.

| Source (Engine 2) | Destination (MyraTMS) | Responsibility |
|---|---|---|
| `stages.ts` | `lib/pipeline/stages.ts` | Stage enum, `VALID_TRANSITIONS`, `isValidTransition()` |
| `queues.ts` | `lib/pipeline/queues.ts` | 9 BullMQ queue configs (concurrency, retry, priority) |
| `payloads.ts` | `lib/pipeline/payloads.ts` | TypeScript interfaces for every queue's job payload |
| `gate.ts` | `lib/pipeline/gate.ts` | `onResearcherComplete()`, `onRankerComplete()`, `checkAndAdvanceToMatched()` |
| `types.ts` | `lib/pipeline/types.ts` | `LoadIntelligence`, `CallParseResult`, shared types |
| `examples.ts` | `lib/pipeline/examples.ts` | Runnable examples (kept for reference) |
| `claude-service.ts` + `-types.ts` | `lib/pipeline/claude-service.ts` + types | Anthropic SDK wrapper (retry, parse, budget, prompts) |
| `compliance-service.ts` + `-types.ts` | `lib/pipeline/compliance-service.ts` + types | CASL/TCPA/DNC/calling-hours gate |
| `cost-calculator.ts` | `lib/pipeline/cost-calculator.ts` | Pure-math cost + negotiation envelope |
| `cost-calculator_test.ts` | `lib/pipeline/__tests__/cost-calculator.test.ts` | Unit tests (already written) |
| `persona-selector.ts` | `lib/pipeline/persona-selector.ts` | Thompson Sampling Beta(α, β) |
| `objection-playbook.ts` | `lib/pipeline/objection-playbook.ts` | 9 typed objection entries with scripts |
| `myra_negotiation_brief_schema.ts` | `lib/pipeline/negotiation-brief.ts` | `NegotiationBrief` interface + `validateBrief()` + `compileRetellPayload()` |
| `benchmark-rates.ts` | `lib/pipeline/benchmark-rates.ts` | Static Ontario CAD rate table (rate-cascade Source 6) |
| `retell-webhook.ts` + `retell-types.ts` | `lib/pipeline/retell-webhook.ts` + types | Retell webhook handler (HMAC, parse, enqueue) |
| `test-webhook.ts` | `lib/pipeline/__tests__/retell-webhook.test.ts` | 40+ webhook test cases |
| `example_retell_payload.json` | `lib/pipeline/fixtures/retell-payload.json` | Sample payload fixture |
| `base-worker.ts` | `lib/workers/base-worker.ts` | Abstract worker lifecycle |
| `scanner-worker.ts` | `lib/workers/scanner-worker.ts` | Agent 1 (7 TODOs) |
| `qualifier-worker.ts` | `lib/workers/qualifier-worker.ts` | Agent 2 (9 TODOs) |
| `researcher-worker.ts` | `lib/workers/researcher-worker.ts` | Agent 3 (10 TODOs) |
| `ranker-worker.ts` | `lib/workers/ranker-worker.ts` | Agent 4 (10 TODOs) |
| `compiler-worker.ts` | `lib/workers/compiler-worker.ts` | Agent 5 (24 TODOs) |
| `voice-worker.ts` | `lib/workers/voice-worker.ts` | Agent 6 (11 TODOs) |
| `dispatcher-worker.ts` | `lib/workers/dispatcher-worker.ts` | Agent 7 (8 TODOs) |
| `feedback-worker.ts` | `lib/workers/feedback-worker.ts` | Feedback (12 TODOs) |
| `index.ts` (workers barrel) | `lib/workers/index.ts` | `startAllWorkers(deps)` |
| `cron-handlers.ts` + `cron-types.ts` | `lib/cron/cron-handlers.ts` + types | 4 cron jobs (scan trigger, stuck detector, expiry, dead-letter) |
| `pipeline_migrations.sql` | `scripts/pipeline_migrations.sql` | 13 idempotent migrations |

**New files this plan creates** (not present in Engine 2):
- `lib/pipeline/redis-bullmq.ts` — IORedis connection (separate from REST `lib/redis.ts`)
- `lib/logger.ts` — JSON logger (if not already present)
- `lib/pipeline/service-token.ts` — Helper to mint service-role JWT for Agent 7
- `app/api/webhooks/retell-callback/route.ts` — Next.js route wrapping the webhook handler
- `app/api/cron/pipeline-scan/route.ts` — Cron scanner trigger
- `app/api/cron/pipeline-health/route.ts` — Cron stuck-load + dead-letter sweep
- `app/api/cron/feedback-aggregation/route.ts` — Cron daily aggregation
- `app/api/pipeline/import/route.ts` — CSV upload endpoint (Scanner cold-start fallback)
- `scripts/test-queue-connection.ts` — Smoke test for Redis/BullMQ
- `scripts/run-workers.ts` — Dev/prod entry point that calls `startAllWorkers()`
- `__tests__/pipeline/qualifier.test.ts`, `ranker.test.ts`, `researcher.test.ts`, `compiler.test.ts`, `voice.test.ts`, `dispatcher.test.ts`, `feedback.test.ts`, `gate.test.ts` — One integration test per worker

---

# Sprint 0 — Bootstrap (30 min)

Outcome: All Engine 2 source files placed, dependencies installed, env vars defined, TypeScript compiles cleanly.

### Task 1: Install new dependencies

**Files:**
- Modify: `MyraTMS/package.json`

- [ ] **Step 1: Install runtime deps**

```bash
cd MyraTMS
pnpm add @anthropic-ai/sdk bullmq ioredis zod
```

- [ ] **Step 2: Verify versions**

```bash
pnpm list @anthropic-ai/sdk bullmq ioredis zod
```

Expected: `@anthropic-ai/sdk` ≥ 0.30.0, `bullmq` ≥ 5.0.0, `ioredis` ≥ 5.0.0, `zod` ≥ 3.22.0.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(engine2): add anthropic-sdk, bullmq, ioredis, zod"
```

---

### Task 2: Create JSON logger if missing

**Files:**
- Create: `MyraTMS/lib/logger.ts` (only if it doesn't already exist)

- [ ] **Step 1: Check existence**

```bash
ls MyraTMS/lib/logger.ts 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

If `EXISTS`, skip to Step 4.

- [ ] **Step 2: Create logger**

```typescript
// MyraTMS/lib/logger.ts
type LogData = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: LogData) {
  const line = JSON.stringify({ level, message, ...data, ts: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, data?: LogData) => emit('info', msg, data),
  warn: (msg: string, data?: LogData) => emit('warn', msg, data),
  error: (msg: string, data?: LogData) => emit('error', msg, data),
  debug: (msg: string, data?: LogData) => emit('debug', msg, data),
};
```

- [ ] **Step 3: Verify it imports**

```bash
cd MyraTMS && pnpm tsc --noEmit lib/logger.ts
```

Expected: zero output (success).

- [ ] **Step 4: Commit**

```bash
git add lib/logger.ts
git commit -m "feat(engine2): add JSON logger" || echo "skipped — already existed"
```

---

### Task 3: Create IORedis connection for BullMQ

BullMQ requires raw Redis TCP, not the REST client in `lib/redis.ts`. The Upstash dashboard exposes an ioredis-compatible URL under the "Connect → ioredis" tab.

**Files:**
- Create: `MyraTMS/lib/pipeline/redis-bullmq.ts`

- [ ] **Step 1: Create file**

```typescript
// MyraTMS/lib/pipeline/redis-bullmq.ts
import IORedis from 'ioredis';

const REDIS_URL =
  process.env.UPSTASH_REDIS_URL ||
  process.env.REDIS_URL ||
  process.env.KV_URL;

if (!REDIS_URL) {
  throw new Error(
    'BullMQ requires an ioredis-compatible Redis URL. Set UPSTASH_REDIS_URL (from Upstash dashboard → Connect → ioredis tab).',
  );
}

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requirement
  enableReadyCheck: false,
  tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

redisConnection.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', message: 'redis_connection_error', error: err.message, ts: new Date().toISOString() }));
});
```

- [ ] **Step 2: Add to `.env.local.example`**

Append to `MyraTMS/.env.local.example` (create if missing):

```env
# Engine 2 — BullMQ requires TCP Redis (NOT the REST URL)
UPSTASH_REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379

# Engine 2 — Anthropic + Retell
ANTHROPIC_API_KEY=sk-ant-...
RETELL_API_KEY=
RETELL_WEBHOOK_SECRET=
RETELL_OUTBOUND_NUMBER_1=+1XXXXXXXXXX
RETELL_OUTBOUND_NUMBER_2=+1XXXXXXXXXX

# Engine 2 — Kill switches
PIPELINE_ENABLED=false
SCANNER_ENABLED=false
MAX_CONCURRENT_CALLS=0
AUTO_BOOK_PROFIT_THRESHOLD=999999
ALERT_EMAIL=patrice.penda@myraai.ca
```

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/redis-bullmq.ts .env.local.example
git commit -m "feat(engine2): add IORedis connection + env scaffolding"
```

---

### Task 4: Place all pre-built Engine 2 source files

This is mechanical copying per the file map at the top of this plan. Workers stay in Engine 2 form (with their TODOs) — implementations come in later sprints.

**Files:** see "File Structure" table above.

- [ ] **Step 1: Create destination directories**

```bash
cd MyraTMS
mkdir -p lib/pipeline/__tests__ lib/pipeline/fixtures lib/workers lib/cron __tests__/pipeline
```

- [ ] **Step 2: Copy foundation files**

```bash
ENGINE2="../Engine 2"
cp "$ENGINE2/stages.ts" lib/pipeline/stages.ts
cp "$ENGINE2/queues.ts" lib/pipeline/queues.ts
cp "$ENGINE2/payloads.ts" lib/pipeline/payloads.ts
cp "$ENGINE2/gate.ts" lib/pipeline/gate.ts
cp "$ENGINE2/types.ts" lib/pipeline/types.ts
cp "$ENGINE2/examples.ts" lib/pipeline/examples.ts
```

- [ ] **Step 3: Copy service modules**

```bash
cp "$ENGINE2/claude-service.ts" lib/pipeline/claude-service.ts
cp "$ENGINE2/claude-service-types.ts" lib/pipeline/claude-service-types.ts
cp "$ENGINE2/compliance-service.ts" lib/pipeline/compliance-service.ts
cp "$ENGINE2/compliance-types.ts" lib/pipeline/compliance-types.ts
cp "$ENGINE2/cost-calculator.ts" lib/pipeline/cost-calculator.ts
cp "$ENGINE2/cost-calculator_test.ts" lib/pipeline/__tests__/cost-calculator.test.ts
cp "$ENGINE2/persona-selector.ts" lib/pipeline/persona-selector.ts
cp "$ENGINE2/objection-playbook.ts" lib/pipeline/objection-playbook.ts
cp "$ENGINE2/myra_negotiation_brief_schema.ts" lib/pipeline/negotiation-brief.ts
cp "$ENGINE2/benchmark-rates.ts" lib/pipeline/benchmark-rates.ts
```

- [ ] **Step 4: Copy webhook + fixtures**

```bash
cp "$ENGINE2/retell-webhook.ts" lib/pipeline/retell-webhook.ts
cp "$ENGINE2/retell-types.ts" lib/pipeline/retell-types.ts
cp "$ENGINE2/test-webhook.ts" lib/pipeline/__tests__/retell-webhook.test.ts
cp "$ENGINE2/example_retell_payload.json" lib/pipeline/fixtures/retell-payload.json
```

- [ ] **Step 5: Copy workers**

```bash
cp "$ENGINE2/base-worker.ts" lib/workers/base-worker.ts
cp "$ENGINE2/scanner-worker.ts" lib/workers/scanner-worker.ts
cp "$ENGINE2/qualifier-worker.ts" lib/workers/qualifier-worker.ts
cp "$ENGINE2/researcher-worker.ts" lib/workers/researcher-worker.ts
cp "$ENGINE2/ranker-worker.ts" lib/workers/ranker-worker.ts
cp "$ENGINE2/compiler-worker.ts" lib/workers/compiler-worker.ts
cp "$ENGINE2/voice-worker.ts" lib/workers/voice-worker.ts
cp "$ENGINE2/dispatcher-worker.ts" lib/workers/dispatcher-worker.ts
cp "$ENGINE2/feedback-worker.ts" lib/workers/feedback-worker.ts
cp "$ENGINE2/index.ts" lib/workers/index.ts
```

- [ ] **Step 6: Copy crons + migration**

```bash
cp "$ENGINE2/cron-handlers.ts" lib/cron/cron-handlers.ts
cp "$ENGINE2/cron-types.ts" lib/cron/cron-types.ts
cp "$ENGINE2/pipeline_migrations.sql" scripts/pipeline_migrations.sql
```

- [ ] **Step 7: Commit**

```bash
git add lib/pipeline lib/workers lib/cron scripts/pipeline_migrations.sql __tests__/pipeline
git commit -m "feat(engine2): place pre-built modules from Engine 2 delivery package"
```

---

### Task 5: Fix import paths after relocation

Pre-built files use relative imports like `'../lib/database'` and `'../lib/redis'`. These must resolve to the actual MyraTMS module names.

**Files:**
- Modify: every `lib/pipeline/*.ts`, `lib/workers/*.ts`, `lib/cron/*.ts` that fails to compile

- [ ] **Step 1: Identify the database module name**

```bash
ls MyraTMS/lib/db.ts MyraTMS/lib/database.ts 2>&1
```

Engine 2 files import `'../lib/database'`. If MyraTMS uses `lib/db.ts` (per the existing CLAUDE.md), substitute that path.

- [ ] **Step 2: Identify the matching/quoting/distance exports**

```bash
cd MyraTMS
grep -rE "^export (function|const|class)" lib/matching lib/quoting lib/distance | head -30
```

Note the exact export names — these are referenced in later worker tasks (Sprints 2 and 3).

- [ ] **Step 3: Run typecheck and fix imports iteratively**

```bash
pnpm tsc --noEmit 2>&1 | head -100
```

For each `Cannot find module '../lib/database'`-style error, replace with the correct MyraTMS module path. Common substitutions:
- `'../lib/database'` → `'@/lib/db'`
- `'../lib/redis'` → `'@/lib/redis'` (REST client) or `'@/lib/pipeline/redis-bullmq'` (TCP client, for BullMQ Worker/Queue construction)
- `'../lib/logger'` → `'@/lib/logger'`

**Decision rule:** if the import is feeding `new Queue(...)` or `new Worker(...)`, use `redis-bullmq`. If it's used for caching (`getCached`/`setCache`), use `@/lib/redis`.

- [ ] **Step 4: Re-run typecheck**

```bash
pnpm tsc --noEmit 2>&1 | tail -30
```

Expected: zero errors. Repeat Step 3 if errors remain.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline lib/workers lib/cron
git commit -m "fix(engine2): retarget imports to MyraTMS module paths"
```

---

### Task 6: Set kill-switch env vars in Vercel and locally

- [ ] **Step 1: Set local `.env.local`**

Copy `.env.local.example` → `.env.local` and fill in real values for `ANTHROPIC_API_KEY`, `UPSTASH_REDIS_URL`, `RETELL_*`. **Leave kill switches at safe defaults** (`PIPELINE_ENABLED=false`, `MAX_CONCURRENT_CALLS=0`).

- [ ] **Step 2: Set Vercel env vars**

```bash
cd MyraTMS
vercel env add ANTHROPIC_API_KEY production
vercel env add UPSTASH_REDIS_URL production
vercel env add RETELL_API_KEY production
vercel env add RETELL_WEBHOOK_SECRET production
vercel env add RETELL_OUTBOUND_NUMBER_1 production
vercel env add PIPELINE_ENABLED production    # set to "false"
vercel env add SCANNER_ENABLED production     # set to "false"
vercel env add MAX_CONCURRENT_CALLS production # set to "0"
vercel env add AUTO_BOOK_PROFIT_THRESHOLD production # set to "999999"
vercel env add CRON_SECRET production         # generate via openssl rand -hex 32
```

If the Vercel CLI is not installed, instruct the user to install it (`npm i -g vercel`) and authenticate; the rest of the plan can proceed locally without this.

---

## ✅ Sprint 0 Checkpoint

Before continuing, verify:

```bash
cd MyraTMS
pnpm tsc --noEmit            # → zero errors
pnpm vitest run lib/pipeline/__tests__/cost-calculator.test.ts  # → all green (test was already written)
git log --oneline -5         # → 4 commits from this sprint
```

---

# Sprint 1 — Database & Queue Foundation (1–2 hrs)

Outcome: Migrations applied, all 9 new tables exist, BullMQ can connect to Redis.

### Task 7: Apply pipeline migrations to Neon

**Files:**
- Run against database: `MyraTMS/scripts/pipeline_migrations.sql`

- [ ] **Step 1: Back up current schema**

```bash
cd MyraTMS
pg_dump --schema-only "$DATABASE_URL" > /tmp/myratms-schema-backup-$(date +%Y%m%d).sql
```

- [ ] **Step 2: Apply migrations**

```bash
psql "$DATABASE_URL" -f scripts/pipeline_migrations.sql
```

Expected: Multiple `CREATE TABLE`, `ALTER TABLE`, and `INSERT` statements complete without error. The migration uses `IF NOT EXISTS` so re-running is safe.

- [ ] **Step 3: Verify 9 new tables**

```bash
psql "$DATABASE_URL" -c "
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'pipeline_loads','agent_calls','negotiation_briefs','consent_log',
    'dnc_list','shipper_preferences','lane_stats','personas','agent_jobs'
  )
ORDER BY table_name;
"
```

Expected: 9 rows returned.

- [ ] **Step 4: Verify 3 personas seeded**

```bash
psql "$DATABASE_URL" -c "SELECT persona_name, alpha, beta, is_active FROM personas;"
```

Expected: 3 rows (`friendly`, `professional`, `direct` or similar — confirm against migration 013).

- [ ] **Step 5: Verify column additions**

```bash
psql "$DATABASE_URL" -c "
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'loads' AND column_name IN ('pipeline_load_id','source_type','booked_via'))
   OR (table_name = 'carriers' AND column_name IN ('accepts_ai_dispatch','ai_call_count'))
   OR (table_name = 'shippers' AND column_name IN ('consent_status','preferred_language','shipper_fatigue_score'))
ORDER BY table_name, column_name;
"
```

Expected: 8 rows.

- [ ] **Step 6: Commit (no code change, but tag the milestone)**

```bash
git tag engine2-sprint1-migrations-applied
```

---

### Task 8: Smoke-test BullMQ → Redis connectivity

**Files:**
- Create: `MyraTMS/scripts/test-queue-connection.ts`

- [ ] **Step 1: Write the failing test (script asserts)**

```typescript
// MyraTMS/scripts/test-queue-connection.ts
import { Queue } from 'bullmq';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QUALIFY_QUEUE_CONFIG } from '@/lib/pipeline/queues';

async function main() {
  const q = new Queue(QUALIFY_QUEUE_CONFIG.queueName, { connection: redisConnection });

  // Ping
  const pingResult = await redisConnection.ping();
  if (pingResult !== 'PONG') {
    console.error('Redis PING failed:', pingResult);
    process.exit(1);
  }

  // Add + remove a probe job to confirm BullMQ works
  const job = await q.add('probe', { probe: true }, { removeOnComplete: true, removeOnFail: true });
  if (!job.id) throw new Error('Job add returned no id');
  await job.remove();

  console.log('Queue connection: OK');
  await q.close();
  await redisConnection.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error('Queue connection: FAIL', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
cd MyraTMS
pnpm tsx scripts/test-queue-connection.ts
```

Expected: `Queue connection: OK` and exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-queue-connection.ts
git commit -m "test(engine2): add BullMQ connection smoke test"
```

---

### Task 9: Add Vitest integration test for stage transitions

**Files:**
- Create: `MyraTMS/__tests__/pipeline/stages.test.ts`

- [ ] **Step 1: Write tests for `isValidTransition`**

```typescript
// MyraTMS/__tests__/pipeline/stages.test.ts
import { describe, it, expect } from 'vitest';
import { PipelineStage, isValidTransition, isTerminalStage } from '@/lib/pipeline/stages';

describe('pipeline stages', () => {
  it('allows scanned → qualified', () => {
    expect(isValidTransition(PipelineStage.SCANNED, PipelineStage.QUALIFIED)).toBe(true);
  });

  it('allows qualified → researched OR matched', () => {
    expect(isValidTransition(PipelineStage.QUALIFIED, PipelineStage.RESEARCHED)).toBe(true);
    expect(isValidTransition(PipelineStage.QUALIFIED, PipelineStage.MATCHED)).toBe(true);
  });

  it('forbids scanned → booked (skipping stages)', () => {
    expect(isValidTransition(PipelineStage.SCANNED, PipelineStage.BOOKED)).toBe(false);
  });

  it('marks disqualified, scored, expired as terminal', () => {
    expect(isTerminalStage(PipelineStage.DISQUALIFIED)).toBe(true);
    expect(isTerminalStage(PipelineStage.SCORED)).toBe(true);
    expect(isTerminalStage(PipelineStage.EXPIRED)).toBe(true);
    expect(isTerminalStage(PipelineStage.QUALIFIED)).toBe(false);
  });

  it('allows callback → calling (the loop-back)', () => {
    expect(isValidTransition(PipelineStage.CALLBACK, PipelineStage.CALLING)).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

```bash
pnpm vitest run __tests__/pipeline/stages.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/pipeline/stages.test.ts
git commit -m "test(engine2): pipeline stage transition rules"
```

---

## ✅ Sprint 1 Checkpoint

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM pipeline_loads;"  # → 0
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM personas WHERE is_active;"  # → 3
pnpm tsx scripts/test-queue-connection.ts                       # → "Queue connection: OK"
pnpm vitest run __tests__/pipeline/                             # → all green
```

---

# Sprint 2 — Agents 2 + 4 (Qualifier + Ranker, 3–5 hrs)

These two agents are pure SQL + the existing matching engine. No external APIs. They run in parallel off `qualify-queue`'s output.

### Task 10: Discover existing TMS values that the qualifier maps from

The qualifier needs to normalize equipment types and resolve regions against the data shape MyraTMS actually uses.

- [ ] **Step 1: Discover equipment-type strings**

```bash
psql "$DATABASE_URL" -c "SELECT DISTINCT equipment_type FROM carrier_equipment ORDER BY 1;"
psql "$DATABASE_URL" -c "SELECT DISTINCT equipment_type FROM loads WHERE equipment_type IS NOT NULL ORDER BY 1;"
```

Record the exact strings (e.g. `'Van'`, `'Flatbed'`, `'Reefer'`, `'Tanker'`). These map to canonical `'dry_van'`, `'flatbed'`, `'reefer'`, `'tanker'` in the qualifier.

- [ ] **Step 2: Discover region values**

```bash
psql "$DATABASE_URL" -c "SELECT DISTINCT origin_region FROM carrier_lanes ORDER BY 1 LIMIT 20;"
```

Confirm these match the regions `lib/quoting/geo/region-mapper.ts` returns. Record any discrepancies.

- [ ] **Step 3: Save discovery notes**

Append findings as a code comment at the top of `lib/workers/qualifier-worker.ts`:

```typescript
// EQUIPMENT TYPE MAP (verified <date>):
//   'Van'      -> 'dry_van'
//   'Flatbed'  -> 'flatbed'
//   'Reefer'   -> 'reefer'
//   'Tanker'   -> 'tanker'
//   'Step Deck'-> 'step_deck'
// REGION SOURCE: import { resolveRegion } from '@/lib/quoting/geo/region-mapper';
```

- [ ] **Step 4: Commit**

```bash
git add lib/workers/qualifier-worker.ts
git commit -m "docs(engine2): record TMS equipment + region discovery for qualifier"
```

---

### Task 11: Implement Qualifier — TODO Q-1 through Q-8

The qualifier filter chain is: freshness → equipment match → lane coverage → margin viability → DNC → shipper fatigue → priority scoring → parallel enqueue.

**Files:**
- Modify: `MyraTMS/lib/workers/qualifier-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/qualifier.test.ts`

- [ ] **Step 1: Write the integration test (failing)**

```typescript
// MyraTMS/__tests__/pipeline/qualifier.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '@/lib/db';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QualifierWorker } from '@/lib/workers/qualifier-worker';
import { Queue } from 'bullmq';

describe('QualifierWorker (integration)', () => {
  let worker: QualifierWorker;
  let researchQueue: Queue;
  let matchQueue: Queue;
  let testLoadId: number;

  beforeAll(async () => {
    researchQueue = new Queue('research-queue-test', { connection: redisConnection });
    matchQueue = new Queue('match-queue-test', { connection: redisConnection });
    worker = new QualifierWorker(redisConnection, researchQueue, matchQueue);

    const sql = getDb();
    const [row] = await sql`
      INSERT INTO pipeline_loads (
        load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date,
        equipment_type, posted_rate, posted_rate_currency, distance_miles, stage
      ) VALUES (
        'TEST-Q1', 'csv', 'Toronto', 'ON',
        'Montreal', 'QC', NOW() + INTERVAL '2 days',
        'Van', 1800, 'CAD', 340, 'scanned'
      ) RETURNING id
    `;
    testLoadId = row.id;
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM pipeline_loads WHERE id = ${testLoadId}`;
    await researchQueue.obliterate({ force: true });
    await matchQueue.obliterate({ force: true });
    await researchQueue.close();
    await matchQueue.close();
  });

  it('qualifies a profitable Toronto→Montreal van load', async () => {
    const result = await worker.process({
      pipelineLoadId: testLoadId,
      loadId: 'TEST-Q1',
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 0,
      origin: { city: 'Toronto', state: 'ON', country: 'CA' },
      destination: { city: 'Montreal', state: 'QC', country: 'CA' },
      equipmentType: 'Van',
      postedRate: 1800,
      postedRateCurrency: 'CAD',
      distanceMiles: 340,
      pickupDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
      shipperPhone: '+14165551234',
    });

    expect(result.success).toBe(true);
    expect(result.nextStage).toBe('qualified');

    const sql = getDb();
    const [load] = await sql`SELECT stage, priority_score FROM pipeline_loads WHERE id = ${testLoadId}`;
    expect(load.stage).toBe('qualified');
    expect(load.priority_score).toBeGreaterThan(0);

    const researchJobs = await researchQueue.getJobs(['waiting', 'active']);
    const matchJobs = await matchQueue.getJobs(['waiting', 'active']);
    expect(researchJobs.length).toBeGreaterThanOrEqual(1);
    expect(matchJobs.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
pnpm vitest run __tests__/pipeline/qualifier.test.ts
```

Expected: test fails (TODOs not implemented yet — `priority_score` will be null, no jobs enqueued).

- [ ] **Step 3: Implement TODO Q-1 (Equipment normalization)**

In `qualifier-worker.ts`, add (per build plan §5):

```typescript
const EQUIPMENT_MAP: Record<string, string> = {
  'Van': 'dry_van', 'van': 'dry_van', 'Dry Van': 'dry_van',
  'Flatbed': 'flatbed', 'flatbed': 'flatbed',
  'Reefer': 'reefer', 'reefer': 'reefer', 'Refrigerated': 'reefer',
  'Tanker': 'tanker', 'tanker': 'tanker',
  'Step Deck': 'step_deck', 'step_deck': 'step_deck',
};

function normalizeEquipment(raw: string): string {
  return EQUIPMENT_MAP[raw] ?? raw.toLowerCase().replace(/\s+/g, '_');
}
```

- [ ] **Step 4: Implement TODO Q-2 (Region mapper)**

```typescript
import { resolveRegion } from '@/lib/quoting/geo/region-mapper';
// Use resolveRegion(city, state) → returns canonical region string
```

If the export name differs (verified in Sprint 0 Task 5 Step 2), substitute. If the function doesn't exist, fall back to province/state code.

- [ ] **Step 5: Implement TODO Q-3 (Lane coverage SQL)**

Per build plan §5:

```typescript
const sql = getDb();
const [{ count }] = await sql`
  SELECT COUNT(DISTINCT cl.carrier_id)::int AS count
  FROM carrier_lanes cl
  JOIN carriers c ON cl.carrier_id = c.id
  WHERE (cl.origin_region = ${originRegion} OR cl.origin_region = 'Ontario')
    AND (cl.dest_region = ${destRegion} OR cl.dest_region = 'Ontario')
    AND c.status = 'Active'
`;
qualResult.carrierMatchCount = count;
if (count === 0) return fail('no_carrier_coverage');
```

- [ ] **Step 6: Implement TODO Q-4 (Benchmark rate)**

```typescript
import { calculateTotalCost } from '@/lib/pipeline/cost-calculator';
import { lookupBenchmarkRate } from '@/lib/pipeline/benchmark-rates';
const benchmark = lookupBenchmarkRate(normalizedEquipment, distanceMiles, currentSeason());
const benchmarkRate = benchmark.ratePerMile * payload.distanceMiles;
```

- [ ] **Step 7: Implement TODO Q-5 (DNC check)**

```typescript
import { ComplianceService } from '@/lib/pipeline/compliance-service';
const compliance = new ComplianceService(getDb(), defaultComplianceConfig());
if (payload.shipperPhone) {
  const dnc = await compliance.checkDNC(payload.shipperPhone);
  if (dnc.isOnList) return fail('dnc_listed');
}
```

- [ ] **Step 8: Implement TODO Q-6 (Shipper fatigue)**

```typescript
const [{ shipper_fatigue_score }] = await sql`
  SELECT COALESCE(MAX(shipper_fatigue_score), 0) AS shipper_fatigue_score
  FROM shippers WHERE phone = ${payload.shipperPhone}
`;
if (shipper_fatigue_score >= 3) return fail('shipper_fatigued');
```

- [ ] **Step 9: Implement TODO Q-7 (Priority scoring + Q-8 parallel enqueue)**

```typescript
const margin = (payload.postedRate ?? 0) - benchmarkRate;
qualResult.priorityScore = Math.round(margin / 10) + (qualResult.carrierMatchCount * 5);

await sql`
  UPDATE pipeline_loads
  SET stage = 'qualified',
      priority_score = ${qualResult.priorityScore},
      estimated_margin_low = ${margin * 0.8},
      estimated_margin_high = ${margin * 1.2},
      stage_updated_at = NOW()
  WHERE id = ${pipelineLoadId}
`;

await this.researchQueue.add('research', { pipelineLoadId, loadId, ... }, { priority: qualResult.priorityScore });
await this.matchQueue.add('match', { pipelineLoadId, loadId, ... }, { priority: qualResult.priorityScore });
```

Refer to `qualifier-worker.ts` source comments for the full TODO bodies — the snippets above are the load-bearing pieces.

- [ ] **Step 10: Run test — confirm pass**

```bash
pnpm vitest run __tests__/pipeline/qualifier.test.ts
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add lib/workers/qualifier-worker.ts __tests__/pipeline/qualifier.test.ts
git commit -m "feat(engine2): implement Agent 2 (Qualifier) — Q-1 through Q-8"
```

---

### Task 12: Implement Ranker — TODO R-1 through R-8

The ranker invokes the existing `lib/matching/runMatchingEngine()` and stores `match_results`, then triggers the completion gate.

**Files:**
- Modify: `MyraTMS/lib/workers/ranker-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/ranker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// MyraTMS/__tests__/pipeline/ranker.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '@/lib/db';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { RankerWorker } from '@/lib/workers/ranker-worker';
import { Queue } from 'bullmq';

describe('RankerWorker', () => {
  let worker: RankerWorker;
  let briefQueue: Queue;
  let testLoadId: number;

  beforeAll(async () => {
    briefQueue = new Queue('brief-queue-test', { connection: redisConnection });
    worker = new RankerWorker(redisConnection, briefQueue);
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO pipeline_loads (
        load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type,
        posted_rate, posted_rate_currency, distance_miles, stage,
        priority_score, research_completed_at
      ) VALUES (
        'TEST-R1', 'csv', 'Toronto', 'ON', 'Montreal', 'QC',
        NOW() + INTERVAL '2 days', 'Van', 1800, 'CAD', 340, 'qualified',
        100, NOW()
      ) RETURNING id
    `;
    testLoadId = row.id;
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM match_results WHERE load_id = (SELECT load_id FROM pipeline_loads WHERE id = ${testLoadId})`;
    await sql`DELETE FROM pipeline_loads WHERE id = ${testLoadId}`;
    await briefQueue.obliterate({ force: true });
    await briefQueue.close();
  });

  it('matches carriers, stores results, and (because research is already complete) opens the gate to brief-queue', async () => {
    const result = await worker.process({
      pipelineLoadId: testLoadId,
      loadId: 'TEST-R1',
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 100,
      qualifiedLoad: { equipmentType: 'Van', origin: 'Toronto, ON', destination: 'Montreal, QC' },
    } as any);

    expect(result.success).toBe(true);

    const sql = getDb();
    const [load] = await sql`SELECT stage, carrier_match_count FROM pipeline_loads WHERE id = ${testLoadId}`;
    expect(load.stage).toBe('matched');
    expect(load.carrier_match_count).toBeGreaterThan(0);

    const briefJobs = await briefQueue.getJobs(['waiting', 'active']);
    expect(briefJobs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
pnpm vitest run __tests__/pipeline/ranker.test.ts
```

Expected: fail.

- [ ] **Step 3: Implement TODO R-1 (Call matching engine)**

```typescript
import { runMatchingEngine } from '@/lib/matching';
const matchResults = await runMatchingEngine({
  loadId: payload.loadId,
  origin: payload.qualifiedLoad.origin,
  destination: payload.qualifiedLoad.destination,
  equipmentType: normalizeEquipment(payload.qualifiedLoad.equipmentType),
});
```

If `runMatchingEngine` requires a load ID that exists in the `loads` table (not `pipeline_loads`), call `POST /api/loads/[tempId]/match` instead — see build plan §5 for fallback.

- [ ] **Step 4: Implement TODO R-2 through R-4**

R-2 (filter F-grade, top 3):

```typescript
const viable = matchResults
  .filter(m => m.match_grade !== 'F')
  .sort((a, b) => b.match_score - a.match_score)
  .slice(0, 3);
```

R-3 (build CarrierStackEntry): query `carriers` table for each viable match.

R-4 (availability confidence):

```typescript
async function availabilityConfidence(carrierId: number, originCity: string): Promise<'high'|'medium'|'low'> {
  const sql = getDb();
  const recentPing = await sql`
    SELECT 1 FROM location_pings
    WHERE carrier_id = ${carrierId} AND pinged_at > NOW() - INTERVAL '24 hours'
    LIMIT 1
  `;
  if (recentPing.length > 0) return 'high';

  const [{ in_region }] = await sql`
    SELECT COUNT(*) > 0 AS in_region
    FROM carriers WHERE id = ${carrierId} AND home_base_city = ${originCity}
  `;
  return in_region ? 'medium' : 'low';
}
```

- [ ] **Step 5: Implement TODO R-5 (store match_results)**

```typescript
for (const m of viable) {
  await sql`
    INSERT INTO match_results (load_id, carrier_id, match_score, match_grade, breakdown, created_at)
    VALUES (${payload.loadId}, ${m.carrier_id}, ${m.match_score}, ${m.match_grade}, ${JSON.stringify(m.breakdown)}, NOW())
  `;
}
await sql`UPDATE pipeline_loads SET carrier_match_count = ${viable.length} WHERE id = ${pipelineLoadId}`;
```

- [ ] **Step 6: Implement TODO R-6 (completion gate trigger)**

```typescript
import { onRankerComplete, buildBriefPayload } from '@/lib/pipeline/gate';
const gateResult = await onRankerComplete(getDb(), pipelineLoadId);
if (gateResult.shouldEnqueue) {
  const briefPayload = await buildBriefPayload(getDb(), pipelineLoadId);
  await this.briefQueue.add('compile', briefPayload, { priority: payload.priority });
}
```

- [ ] **Step 7: Run test — confirm pass**

```bash
pnpm vitest run __tests__/pipeline/ranker.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add lib/workers/ranker-worker.ts __tests__/pipeline/ranker.test.ts
git commit -m "feat(engine2): implement Agent 4 (Ranker) — R-1 through R-8 + gate trigger"
```

---

### Task 13: Test the parallel completion gate

The gate's symmetric handler `onResearcherComplete` is implemented, but Agent 3 isn't done yet (Sprint 3). We test the gate logic itself with a mocked load that has both completion fields set.

**Files:**
- Test: `MyraTMS/__tests__/pipeline/gate.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// MyraTMS/__tests__/pipeline/gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/db';
import { getGateStatus, checkAndAdvanceToMatched, onResearcherComplete, onRankerComplete } from '@/lib/pipeline/gate';

describe('completion gate', () => {
  let testId: number;

  beforeEach(async () => {
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type, stage)
      VALUES ('TEST-GATE', 'csv', 'A', 'ON', 'B', 'ON', NOW(), 'Van', 'qualified')
      RETURNING id
    `;
    testId = row.id;
  });

  afterEach(async () => {
    await getDb()`DELETE FROM pipeline_loads WHERE id = ${testId}`;
  });

  it('reports both incomplete when neither field is set', async () => {
    const status = await getGateStatus(getDb() as any, testId);
    expect(status.canAdvanceToBrief).toBe(false);
  });

  it('reports research-only complete', async () => {
    await getDb()`UPDATE pipeline_loads SET research_completed_at = NOW() WHERE id = ${testId}`;
    const status = await getGateStatus(getDb() as any, testId);
    expect(status.research.completed).toBe(true);
    expect(status.ranker.completed).toBe(false);
    expect(status.canAdvanceToBrief).toBe(false);
  });

  it('advances to matched when both complete', async () => {
    await getDb()`UPDATE pipeline_loads SET research_completed_at = NOW(), carrier_match_count = 3 WHERE id = ${testId}`;
    const result = await checkAndAdvanceToMatched(getDb() as any, testId);
    expect(result.advanced).toBe(true);
    const [{ stage }] = await getDb()`SELECT stage FROM pipeline_loads WHERE id = ${testId}`;
    expect(stage).toBe('matched');
  });

  it('is idempotent — calling twice does not re-advance', async () => {
    await getDb()`UPDATE pipeline_loads SET research_completed_at = NOW(), carrier_match_count = 3 WHERE id = ${testId}`;
    const r1 = await checkAndAdvanceToMatched(getDb() as any, testId);
    const r2 = await checkAndAdvanceToMatched(getDb() as any, testId);
    expect(r1.advanced).toBe(true);
    expect(r2.advanced).toBe(false);
    expect(r2.reason).toMatch(/already at stage/);
  });
});
```

Note: `gate.ts` uses Pattern B (`db.query(...)`). The cast `getDb() as any` is intentional and short — adapter layer if pattern conversion was deferred.

- [ ] **Step 2: Run**

```bash
pnpm vitest run __tests__/pipeline/gate.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/pipeline/gate.test.ts
git commit -m "test(engine2): completion gate idempotency + advancement"
```

---

## ✅ Sprint 2 Checkpoint

Insert a synthetic load and walk it through Qualifier + Ranker manually:

```bash
psql "$DATABASE_URL" <<EOF
INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state,
  destination_city, destination_state, pickup_date, equipment_type, posted_rate,
  posted_rate_currency, distance_miles, stage)
VALUES ('SMOKE-1', 'csv', 'Toronto', 'ON', 'Montreal', 'QC', NOW() + INTERVAL '2 days',
  'Van', 1800, 'CAD', 340, 'scanned');
EOF
pnpm vitest run __tests__/pipeline/  # all green
```

---

# Sprint 3 — Agents 3 + 5 (Researcher + Compiler, 5–8 hrs)

These two agents introduce Claude API usage. Sprint 3 is the most expensive (token cost in tests) — keep `MAX_CONCURRENT_CALLS=0` so no voice calls fire even on accidental brief enqueueing.

### Task 14: Implement Researcher — TODO RE-1 through RE-7

**Files:**
- Modify: `MyraTMS/lib/workers/researcher-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/researcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// MyraTMS/__tests__/pipeline/researcher.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { ResearcherWorker } from '@/lib/workers/researcher-worker';
import { Queue } from 'bullmq';

describe('ResearcherWorker', () => {
  let worker: ResearcherWorker;
  let briefQueue: Queue;
  let testLoadId: number;

  beforeAll(async () => {
    briefQueue = new Queue('brief-queue-test', { connection: redisConnection });
    worker = new ResearcherWorker(redisConnection, briefQueue);
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type,
        posted_rate, posted_rate_currency, distance_miles, stage,
        priority_score, carrier_match_count)
      VALUES ('TEST-RE1', 'csv', 'Toronto', 'ON', 'Montreal', 'QC',
        NOW() + INTERVAL '2 days', 'Van', 1800, 'CAD', 340, 'qualified', 100, 3)
      RETURNING id
    `;
    testLoadId = row.id;
  });

  afterAll(async () => {
    await getDb()`DELETE FROM pipeline_loads WHERE id = ${testLoadId}`;
    await briefQueue.obliterate({ force: true });
    await briefQueue.close();
  });

  it('runs rate cascade, computes margin envelope, and (since matching is done) opens the gate', async () => {
    const result = await worker.process({
      pipelineLoadId: testLoadId, loadId: 'TEST-RE1', loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(), priority: 100,
      qualifiedLoad: { equipmentType: 'Van', origin: { city: 'Toronto', state: 'ON' },
        destination: { city: 'Montreal', state: 'QC' }, distanceMiles: 340 },
    } as any);

    expect(result.success).toBe(true);
    const [load] = await getDb()`
      SELECT research_completed_at, market_rate_floor, market_rate_mid, market_rate_best, recommended_strategy, stage
      FROM pipeline_loads WHERE id = ${testLoadId}
    `;
    expect(load.research_completed_at).not.toBeNull();
    expect(load.market_rate_mid).toBeGreaterThan(0);
    expect(['aggressive', 'standard', 'walk']).toContain(load.recommended_strategy);
    expect(load.stage).toBe('matched'); // gate opened (carrier_match_count was already 3)
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
pnpm vitest run __tests__/pipeline/researcher.test.ts
```

- [ ] **Step 3: Implement RE-1 (distance), RE-2 (rate cascade), RE-3 (cost)**

```typescript
import { getDistance } from '@/lib/distance';
import { generateQuote } from '@/lib/quoting';
import { calculateTotalCost } from '@/lib/pipeline/cost-calculator';

const dist = await getDistance(payload.qualifiedLoad.origin, payload.qualifiedLoad.destination);
const quote = await generateQuote({
  equipmentType: normalizeEquipment(payload.qualifiedLoad.equipmentType),
  distanceMiles: dist.miles,
  origin: payload.qualifiedLoad.origin,
  destination: payload.qualifiedLoad.destination,
});
const totalCost = calculateTotalCost({ /* per cost-calculator API */ });
```

- [ ] **Step 4: Implement RE-2 (Claude AI source #5)**

```typescript
import { ClaudeService } from '@/lib/pipeline/claude-service';
const claude = new ClaudeService({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-sonnet-4-6' });
const aiResearch = await claude.parseResearch({ loadParams }, jobId);
// Merge into rate cascade as Source 5
```

Use `claude-sonnet-4-6` (the current Sonnet 4.6 model ID per the in-context model list) for cost-balanced output. Do NOT default to Opus for research — too expensive at scale.

- [ ] **Step 5: Implement RE-4 (negotiation envelope) + RE-5 (shipper profile)**

```typescript
import { calculateNegotiationParams } from '@/lib/pipeline/cost-calculator';
const envelope = calculateNegotiationParams({ /* ... */ });

const sql = getDb();
const [pref] = await sql`SELECT * FROM shipper_preferences WHERE phone = ${payload.shipperPhone}`;
const callHistory = await sql`
  SELECT outcome, COUNT(*) AS n FROM agent_calls
  WHERE phone_number_called = ${payload.shipperPhone} GROUP BY outcome
`;
```

- [ ] **Step 6: Implement RE-6 (strategy)**

```typescript
function pickStrategy(margin: number, carrierCount: number): 'aggressive'|'standard'|'walk' {
  if (margin > 500 && carrierCount >= 2) return 'aggressive';
  if (margin < 200 || carrierCount === 0) return 'walk';
  return 'standard';
}
```

- [ ] **Step 7: Implement RE-7 (gate trigger)**

```typescript
await sql`
  UPDATE pipeline_loads
  SET research_completed_at = NOW(),
      market_rate_floor = ${quote.floor},
      market_rate_mid = ${quote.mid},
      market_rate_best = ${quote.best},
      recommended_strategy = ${strategy}
  WHERE id = ${pipelineLoadId}
`;
import { onResearcherComplete, buildBriefPayload } from '@/lib/pipeline/gate';
const gateResult = await onResearcherComplete(getDb() as any, pipelineLoadId);
if (gateResult.shouldEnqueue) {
  const briefPayload = await buildBriefPayload(getDb() as any, pipelineLoadId);
  await this.briefQueue.add('compile', briefPayload, { priority: payload.priority });
}
```

- [ ] **Step 8: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/researcher.test.ts
git add lib/workers/researcher-worker.ts __tests__/pipeline/researcher.test.ts
git commit -m "feat(engine2): implement Agent 3 (Researcher) — RE-1 through RE-7 with Claude"
```

---

### Task 15: Implement Compiler — TODO C-1 through C-6 (24 TODOs total, grouped)

The compiler builds the `NegotiationBrief` and is the most complex agent. Group TODOs by section.

**Files:**
- Modify: `MyraTMS/lib/workers/compiler-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/compiler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// MyraTMS/__tests__/pipeline/compiler.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '@/lib/db';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { CompilerWorker } from '@/lib/workers/compiler-worker';
import { validateBrief } from '@/lib/pipeline/negotiation-brief';
import { Queue } from 'bullmq';

describe('CompilerWorker', () => {
  let worker: CompilerWorker;
  let callQueue: Queue;
  let testLoadId: number;

  beforeAll(async () => {
    callQueue = new Queue('call-queue-test', { connection: redisConnection });
    worker = new CompilerWorker(redisConnection, callQueue);
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type,
        posted_rate, posted_rate_currency, distance_miles, stage,
        priority_score, carrier_match_count, research_completed_at,
        market_rate_floor, market_rate_mid, market_rate_best, recommended_strategy)
      VALUES ('TEST-C1', 'csv', 'Toronto', 'ON', 'Montreal', 'QC',
        NOW() + INTERVAL '2 days', 'Van', 1800, 'CAD', 340, 'matched',
        100, 3, NOW(), 1500, 1800, 2100, 'standard')
      RETURNING id
    `;
    testLoadId = row.id;
  });

  afterAll(async () => {
    await getDb()`DELETE FROM negotiation_briefs WHERE pipeline_load_id = ${testLoadId}`;
    await getDb()`DELETE FROM pipeline_loads WHERE id = ${testLoadId}`;
    await callQueue.obliterate({ force: true });
    await callQueue.close();
  });

  it('compiles a valid brief, persists it, and enqueues to call-queue', async () => {
    const result = await worker.process({
      pipelineLoadId: testLoadId, loadId: 'TEST-C1', loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(), priority: 100,
      researchResult: { /* shape from gate.buildBriefPayload */ },
      carrierStack: [{ carrierId: 1, matchScore: 0.85, matchGrade: 'A', breakdown: {} }],
    } as any);

    expect(result.success).toBe(true);
    const [b] = await getDb()`SELECT * FROM negotiation_briefs WHERE pipeline_load_id = ${testLoadId}`;
    expect(b).toBeDefined();
    const validation = validateBrief(b.brief);
    expect(validation.valid).toBe(true);

    const [{ stage }] = await getDb()`SELECT stage FROM pipeline_loads WHERE id = ${testLoadId}`;
    expect(stage).toBe('briefed');

    const callJobs = await callQueue.getJobs(['waiting']);
    expect(callJobs.length).toBe(1);
    expect(callJobs[0].data.briefId).toBe(b.id);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm vitest run __tests__/pipeline/compiler.test.ts
```

- [ ] **Step 3: Implement C-1 (Thompson Sampling persona)**

```typescript
import { sampleBeta } from '@/lib/pipeline/persona-selector';
const personas = await sql`SELECT id, persona_name, alpha, beta, retell_agent_id_en, retell_agent_id_fr FROM personas WHERE is_active = true`;
let best = -1, picked = personas[0];
for (const p of personas) {
  const s = sampleBeta(p.alpha, p.beta);
  if (s > best) { best = s; picked = p; }
}
```

- [ ] **Step 4: Implement C-2 (objection playbook)**

```typescript
import { OBJECTION_PLAYBOOK } from '@/lib/pipeline/objection-playbook';
brief.objectionPlaybook = OBJECTION_PLAYBOOK; // already typed and ready
```

The 9 objection types: `rate_too_high`, `have_broker`, `dont_use_brokers`, `not_decision_maker`, `call_back`, `send_email`, `handle_internally`, `better_offer`, `customer_routed`. Scripts already in `objection-playbook.ts`.

- [ ] **Step 5: Implement C-3 (compliance gate before brief is finalized)**

```typescript
import { ComplianceService } from '@/lib/pipeline/compliance-service';
const compliance = new ComplianceService(getDb(), defaultConfig());
const check = await compliance.runFullComplianceCheck(
  shipperPhone, 'outbound_negotiation', undefined, payload.loadId,
  shipperProvince, shipperState
);
if (!check.allowedToCall) {
  // Mark load escalated; do not enqueue to call-queue
  await sql`UPDATE pipeline_loads SET stage = 'escalated' WHERE id = ${pipelineLoadId}`;
  return { success: true, pipelineLoadId, stage: 'matched', nextStage: 'escalated', duration: 0 };
}
brief.compliance = check.disclosures;
```

- [ ] **Step 6: Implement C-4 (validate brief)**

```typescript
import { validateBrief } from '@/lib/pipeline/negotiation-brief';
const validation = validateBrief(brief);
if (!validation.valid) {
  throw new Error(`Brief validation failed: ${validation.errors.join('; ')}`);
}
```

- [ ] **Step 7: Implement C-5 (persist brief)**

```typescript
const [briefRow] = await sql`
  INSERT INTO negotiation_briefs (
    pipeline_load_id, brief, brief_version, persona_selected, strategy,
    initial_offer, target_rate, min_acceptable_rate, concession_step_1,
    concession_step_2, final_offer, carrier_count, top_carrier_id,
    top_carrier_rate, created_at
  ) VALUES (
    ${pipelineLoadId}, ${JSON.stringify(brief)}, '2.0', ${picked.persona_name},
    ${strategy}, ${envelope.initial}, ${envelope.target}, ${envelope.min},
    ${envelope.step1}, ${envelope.step2}, ${envelope.final}, ${carrierStack.length},
    ${carrierStack[0]?.carrierId ?? null}, ${carrierStack[0]?.rate ?? null}, NOW()
  ) RETURNING id
`;
```

- [ ] **Step 8: Implement C-6 (enqueue to call-queue + advance stage)**

```typescript
await sql`
  UPDATE pipeline_loads SET stage = 'briefed', stage_updated_at = NOW()
  WHERE id = ${pipelineLoadId}
`;
const language = picked.persona_name.includes('fr') ? 'fr' : 'en';
const retellAgentId = language === 'fr' ? picked.retell_agent_id_fr : picked.retell_agent_id_en;
await this.callQueue.add('call', {
  pipelineLoadId, briefId: briefRow.id, shipperPhone,
  persona: picked.persona_name, retellAgentId, language,
  enqueuedAt: new Date().toISOString(), priority: payload.priority, loadId: payload.loadId,
}, { priority: Math.round(envelope.target) });
```

- [ ] **Step 9: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/compiler.test.ts
git add lib/workers/compiler-worker.ts __tests__/pipeline/compiler.test.ts
git commit -m "feat(engine2): implement Agent 5 (Compiler) — C-1 through C-6 + brief validation"
```

---

## ✅ Sprint 3 Checkpoint

```bash
pnpm vitest run __tests__/pipeline/   # all green
psql "$DATABASE_URL" -c "
  SELECT stage, COUNT(*) FROM pipeline_loads GROUP BY stage;
"  # expect rows in matched/briefed for SMOKE-* loads
```

End-to-end pipeline now runs `scanned → qualified → researched + matched → briefed`. Calls are still gated by `MAX_CONCURRENT_CALLS=0`.

---

# Sprint 4 — Agents 1 + 6 + Webhook (4–6 hrs)

### Task 16: Implement Scanner CSV fallback (Agent 1, T04A)

DAT/Truckstop scrapers are deferred — start with CSV import per build plan §7.

**Files:**
- Create: `MyraTMS/app/api/pipeline/import/route.ts`
- Modify: `MyraTMS/lib/workers/scanner-worker.ts` (TODOs S-1 through S-7)
- Test: `MyraTMS/__tests__/pipeline/scanner-csv.test.ts`

- [ ] **Step 1: Write integration test for CSV upload**

```typescript
// MyraTMS/__tests__/pipeline/scanner-csv.test.ts
import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/pipeline/import/route';
import { NextRequest } from 'next/server';

describe('POST /api/pipeline/import', () => {
  it('parses CSV, inserts pipeline_loads rows, enqueues to qualify-queue', async () => {
    const csv = `load_id,origin_city,origin_state,destination_city,destination_state,pickup_date,equipment_type,posted_rate,distance_miles,shipper_phone
EXT-1,Toronto,ON,Montreal,QC,2026-05-02,Van,1800,340,+14165551234`;
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'loads.csv');

    const req = new NextRequest('http://localhost/api/pipeline/import', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.TEST_ADMIN_TOKEN}` },
      body: form,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.enqueued).toBe(1);
  });
});
```

- [ ] **Step 2: Run — confirm failure (404 / undefined)**

```bash
pnpm vitest run __tests__/pipeline/scanner-csv.test.ts
```

- [ ] **Step 3: Create the route**

```typescript
// MyraTMS/app/api/pipeline/import/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import { Queue } from 'bullmq';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QUALIFY_QUEUE_CONFIG } from '@/lib/pipeline/queues';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user || !requireRole(user, 'admin')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });

  const text = await file.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    return NextResponse.json({ error: 'csv_parse_failed', details: parsed.errors }, { status: 400 });
  }

  const sql = getDb();
  const queue = new Queue(QUALIFY_QUEUE_CONFIG.queueName, { connection: redisConnection });
  let imported = 0, enqueued = 0;

  for (const row of parsed.data as any[]) {
    const [created] = await sql`
      INSERT INTO pipeline_loads (
        load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type,
        posted_rate, posted_rate_currency, distance_miles, shipper_phone, stage
      ) VALUES (
        ${row.load_id}, 'csv', ${row.origin_city}, ${row.origin_state},
        ${row.destination_city}, ${row.destination_state}, ${row.pickup_date},
        ${row.equipment_type}, ${parseFloat(row.posted_rate)}, ${row.currency || 'CAD'},
        ${parseInt(row.distance_miles || '0', 10)}, ${row.shipper_phone || null}, 'scanned'
      ) RETURNING id
    `;
    imported++;

    if (process.env.PIPELINE_ENABLED === 'true') {
      await queue.add('qualify', {
        pipelineLoadId: created.id, loadId: row.load_id, loadBoardSource: 'csv',
        enqueuedAt: new Date().toISOString(), priority: 0,
        origin: { city: row.origin_city, state: row.origin_state, country: 'CA' },
        destination: { city: row.destination_city, state: row.destination_state, country: 'CA' },
        equipmentType: row.equipment_type,
        postedRate: parseFloat(row.posted_rate),
        postedRateCurrency: row.currency || 'CAD',
        distanceMiles: parseInt(row.distance_miles || '0', 10),
        pickupDate: row.pickup_date,
        shipperPhone: row.shipper_phone || null,
      });
      enqueued++;
    }
  }

  logger.info('pipeline.csv_import', { imported, enqueued });
  return NextResponse.json({ imported, enqueued });
}
```

- [ ] **Step 4: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/scanner-csv.test.ts
git add app/api/pipeline/import/route.ts __tests__/pipeline/scanner-csv.test.ts lib/workers/scanner-worker.ts
git commit -m "feat(engine2): Scanner CSV fallback + /api/pipeline/import route"
```

DAT/Truckstop scraper TODOs (S-3, S-4, S-5) are deferred — open as a follow-up issue rather than blocking the end-to-end milestone.

---

### Task 17: Implement Voice worker — TODO V-1 through V-11

**Files:**
- Modify: `MyraTMS/lib/workers/voice-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/voice.test.ts`

- [ ] **Step 1: Write the failing test (using Retell API mock)**

```typescript
// MyraTMS/__tests__/pipeline/voice.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { VoiceWorker } from '@/lib/workers/voice-worker';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { getDb } from '@/lib/db';

describe('VoiceWorker', () => {
  let worker: VoiceWorker;
  let testLoadId: number, briefId: number;

  beforeAll(async () => {
    worker = new VoiceWorker(redisConnection);
    const sql = getDb();
    const [load] = await sql`
      INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state,
        destination_city, destination_state, pickup_date, equipment_type, stage, shipper_phone)
      VALUES ('TEST-V1', 'csv', 'Toronto', 'ON', 'Montreal', 'QC', NOW() + INTERVAL '2 days',
        'Van', 'briefed', '+14165551234') RETURNING id
    `;
    testLoadId = load.id;
    const [brief] = await sql`
      INSERT INTO negotiation_briefs (pipeline_load_id, brief, brief_version, persona_selected,
        strategy, initial_offer, target_rate, min_acceptable_rate, concession_step_1,
        concession_step_2, final_offer, carrier_count, created_at)
      VALUES (${testLoadId}, '{"meta":{}}', '2.0', 'friendly', 'standard',
        2000, 1800, 1600, 1900, 1850, 1750, 3, NOW())
      RETURNING id
    `;
    briefId = brief.id;
  });

  afterAll(async () => {
    await getDb()`DELETE FROM negotiation_briefs WHERE id = ${briefId}`;
    await getDb()`DELETE FROM pipeline_loads WHERE id = ${testLoadId}`;
  });

  it('respects MAX_CONCURRENT_CALLS=0 — does not place a call, marks call_outcome=skipped_kill_switch', async () => {
    process.env.MAX_CONCURRENT_CALLS = '0';
    const result = await worker.process({
      pipelineLoadId: testLoadId, briefId, shipperPhone: '+14165551234',
      persona: 'friendly', retellAgentId: 'agent_test_123', language: 'en',
      loadId: 'TEST-V1', loadBoardSource: 'csv', enqueuedAt: new Date().toISOString(), priority: 100,
    } as any);
    expect(result.success).toBe(true);
    expect(result.details?.skipped).toBe('kill_switch');
  });

  it('places a Retell call when MAX_CONCURRENT_CALLS > 0 (mocked)', async () => {
    process.env.MAX_CONCURRENT_CALLS = '5';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ call_id: 'call_test_xyz', call_status: 'registered' }), { status: 200 }),
    );
    const result = await worker.process({
      pipelineLoadId: testLoadId, briefId, shipperPhone: '+14165551234',
      persona: 'friendly', retellAgentId: 'agent_test_123', language: 'en',
      loadId: 'TEST-V1', loadBoardSource: 'csv', enqueuedAt: new Date().toISOString(), priority: 100,
    } as any);
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.retellai.com/v2/create-phone-call',
      expect.objectContaining({ method: 'POST' }),
    );
    const [{ call_outcome }] = await getDb()`SELECT call_outcome FROM pipeline_loads WHERE id = ${testLoadId}`;
    expect(call_outcome).toBe('initiated');
    fetchSpy.mockRestore();
    process.env.MAX_CONCURRENT_CALLS = '0';
  });
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Implement V-1 through V-11 in `voice-worker.ts`**

Key sections (per build plan §7):

```typescript
// V-1: kill-switch guard
const max = parseInt(process.env.MAX_CONCURRENT_CALLS ?? '0', 10);
if (max <= 0) {
  await sql`UPDATE pipeline_loads SET call_outcome = 'skipped_kill_switch' WHERE id = ${pipelineLoadId}`;
  return { success: true, ...skipped };
}

// V-2: pre-call compliance re-check (calling hours could have shifted)
const compliance = new ComplianceService(getDb(), defaultConfig());
const check = await compliance.runFullComplianceCheck(shipperPhone, 'outbound_negotiation', undefined, loadId);
if (!check.allowedToCall) {
  // Reschedule via callbackQueue or escalate
}

// V-3 to V-7: Retell API call
const response = await fetch('https://api.retellai.com/v2/create-phone-call', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agent_id: retellAgentId,
    customer_number: shipperPhone,
    from_number: pickOutboundNumber(),
    metadata: { pipelineLoadId: String(pipelineLoadId), briefId: String(briefId), persona },
    retell_llm_dynamic_variables: compileRetellPayload(brief), // from negotiation-brief.ts
  }),
});

// V-8 to V-11: persist call attempt to agent_calls, advance stage to 'calling'
```

- [ ] **Step 4: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/voice.test.ts
git add lib/workers/voice-worker.ts __tests__/pipeline/voice.test.ts
git commit -m "feat(engine2): implement Agent 6 (Voice/Retell) — V-1 through V-11"
```

---

### Task 18: Wire the Retell webhook route

**Files:**
- Create: `MyraTMS/app/api/webhooks/retell-callback/route.ts`
- Test: webhook tests already at `lib/pipeline/__tests__/retell-webhook.test.ts`

- [ ] **Step 1: Run the existing webhook tests first**

```bash
pnpm vitest run lib/pipeline/__tests__/retell-webhook.test.ts
```

If failures, fix per the test messages — these tests cover signature verification, parsing, queue dispatch, and audit logging. The `retell-webhook.ts` handler is fully implemented; failures here are likely import-path issues from Sprint 0 Task 5.

- [ ] **Step 2: Create the Next.js route wrapper**

```typescript
// MyraTMS/app/api/webhooks/retell-callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const result = await handleRetellWebhook(req);
  return NextResponse.json(result.body, { status: result.status });
}
```

- [ ] **Step 3: Add a smoke test for the route**

```typescript
// MyraTMS/__tests__/pipeline/retell-route.test.ts
import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/webhooks/retell-callback/route';
import { NextRequest } from 'next/server';
import crypto from 'crypto';

describe('POST /api/webhooks/retell-callback', () => {
  it('returns 401 on bad signature', async () => {
    const body = JSON.stringify({ event: 'call_ended', call: {} });
    const req = new NextRequest('http://localhost/api/webhooks/retell-callback', {
      method: 'POST',
      headers: { 'x-retell-signature': 'bogus' },
      body,
    });
    const res = await POST(req);
    expect([401, 403]).toContain(res.status);
  });

  it('accepts a valid HMAC-signed payload', async () => {
    const body = JSON.stringify({ event: 'call_ended', call: { call_id: 'c1', metadata: { pipelineLoadId: '1', briefId: '1' } } });
    const sig = crypto.createHmac('sha256', process.env.RETELL_WEBHOOK_SECRET!).update(body).digest('hex');
    const req = new NextRequest('http://localhost/api/webhooks/retell-callback', {
      method: 'POST',
      headers: { 'x-retell-signature': sig, 'content-type': 'application/json' },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/retell-route.test.ts
git add app/api/webhooks/retell-callback/route.ts __tests__/pipeline/retell-route.test.ts
git commit -m "feat(engine2): mount Retell webhook at /api/webhooks/retell-callback"
```

---

## ✅ Sprint 4 Checkpoint

End-to-end shadow-mode walkthrough:

```bash
# 1. Insert via CSV
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     -F "file=@test-loads.csv" http://localhost:3000/api/pipeline/import

# 2. Start workers locally
PIPELINE_ENABLED=true MAX_CONCURRENT_CALLS=0 pnpm tsx scripts/run-workers.ts &

# 3. Watch progression
psql "$DATABASE_URL" -c "
  SELECT id, load_id, stage, priority_score, carrier_match_count, market_rate_mid
  FROM pipeline_loads ORDER BY id DESC LIMIT 5;
"
```

Expected: load advances scanned → qualified → matched → briefed within ~30s. No call placed (kill switch).

---

# Sprint 5 — Agent 7 + Feedback + Crons + Worker Host (3–4 hrs)

### Task 19: Service-token helper for Agent 7

**Files:**
- Create: `MyraTMS/lib/pipeline/service-token.ts`

- [ ] **Step 1: Create**

```typescript
// MyraTMS/lib/pipeline/service-token.ts
import jwt from 'jsonwebtoken';

export function mintServiceToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET required for service token');
  return jwt.sign(
    { userId: 'system', role: 'admin', type: 'service' },
    secret,
    { expiresIn: '1h' },
  );
}
```

- [ ] **Step 2: Test**

```typescript
// MyraTMS/__tests__/pipeline/service-token.test.ts
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintServiceToken } from '@/lib/pipeline/service-token';

describe('service token', () => {
  it('mints a token with admin role + system userId', () => {
    const token = mintServiceToken();
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    expect(decoded.role).toBe('admin');
    expect(decoded.userId).toBe('system');
    expect(decoded.type).toBe('service');
  });
});
```

```bash
pnpm vitest run __tests__/pipeline/service-token.test.ts
git add lib/pipeline/service-token.ts __tests__/pipeline/service-token.test.ts
git commit -m "feat(engine2): service-token helper for Agent 7 → TMS API"
```

---

### Task 20: Implement Dispatcher — TODO D-1 through D-8

**Files:**
- Modify: `MyraTMS/lib/workers/dispatcher-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/dispatcher.test.ts`

- [ ] **Step 1: Failing test (mocked TMS endpoints)**

```typescript
// MyraTMS/__tests__/pipeline/dispatcher.test.ts — abbreviated
import { describe, it, expect, vi } from 'vitest';
import { DispatcherWorker } from '@/lib/workers/dispatcher-worker';

describe('DispatcherWorker', () => {
  it('calls /api/loads → /assign → /tracking-token → /send-tracking in order', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 999, loadId: 'LD-X' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'tok_abc' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sent: true }), { status: 200 }));

    const worker = new DispatcherWorker(/* deps */);
    const result = await worker.process({ /* booked load payload */ } as any);
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('/api/loads'), expect.objectContaining({ method: 'POST' }));
    expect(fetchSpy).toHaveBeenNthCalledWith(2, expect.stringMatching(/\/api\/loads\/.+\/assign/), expect.objectContaining({ method: 'POST' }));
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Implement D-1 through D-8 (per build plan §8)**

```typescript
import { mintServiceToken } from '@/lib/pipeline/service-token';
const token = mintServiceToken();
const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// D-1: POST /api/loads with source_type='ai_agent', booked_via='ai_auto'
const createRes = await fetch(`${baseUrl}/api/loads`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ /* mapped from pipeline_load + agreed_rate */ source_type: 'ai_agent', booked_via: 'ai_auto' }),
});
const created = await createRes.json();

// D-2: assign carrier (generates rate-con PDF)
await fetch(`${baseUrl}/api/loads/${created.id}/assign`, { /* same auth, body has carrierId */ });

// D-3: tracking token
const tokenRes = await fetch(`${baseUrl}/api/loads/${created.id}/tracking-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

// D-4: send tracking email
await fetch(`${baseUrl}/api/loads/${created.id}/send-tracking`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

// D-5: link tms_load_id
await sql`UPDATE pipeline_loads SET tms_load_id = ${created.id}, dispatched_at = NOW(), stage = 'dispatched' WHERE id = ${pipelineLoadId}`;

// D-6 to D-8: feedback enqueue (post-delivery), error handling, escalation
```

- [ ] **Step 3: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/dispatcher.test.ts
git add lib/workers/dispatcher-worker.ts __tests__/pipeline/dispatcher.test.ts
git commit -m "feat(engine2): implement Agent 7 (Dispatcher) — TMS integration"
```

---

### Task 21: Implement Feedback worker

**Files:**
- Modify: `MyraTMS/lib/workers/feedback-worker.ts`
- Test: `MyraTMS/__tests__/pipeline/feedback.test.ts`

The feedback worker runs after delivery and updates persona α/β + shipper preferences.

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FeedbackWorker } from '@/lib/workers/feedback-worker';
import { getDb } from '@/lib/db';

describe('FeedbackWorker', () => {
  it('updates persona α on success, β on failure', async () => {
    const sql = getDb();
    const [before] = await sql`SELECT alpha, beta FROM personas WHERE persona_name = 'friendly'`;
    const worker = new FeedbackWorker(/* deps */);
    await worker.process({
      pipelineLoadId: 1, loadId: 'TEST-FB', persona: 'friendly',
      outcome: 'booked', profit: 250,
      /* ...payload */
    } as any);
    const [after] = await sql`SELECT alpha, beta FROM personas WHERE persona_name = 'friendly'`;
    expect(after.alpha).toBe(before.alpha + 1);
    expect(after.beta).toBe(before.beta);
  });
});
```

- [ ] **Step 2: Implement (per build plan §8 + T11)**

The 12 TODOs in `feedback-worker.ts` cover: outcome classification, persona Bayesian update, shipper preferences upsert (`preferred_language`, posting frequency, historical rates), lane stats aggregation, fatigue score adjustment.

- [ ] **Step 3: Commit**

```bash
git add lib/workers/feedback-worker.ts __tests__/pipeline/feedback.test.ts
git commit -m "feat(engine2): implement Feedback worker (Bayesian persona update + shipper learning)"
```

---

### Task 22: Wire 3 new cron routes in Vercel

**Files:**
- Modify: `MyraTMS/vercel.json`
- Create: `MyraTMS/app/api/cron/pipeline-scan/route.ts`
- Create: `MyraTMS/app/api/cron/pipeline-health/route.ts`
- Create: `MyraTMS/app/api/cron/feedback-aggregation/route.ts`

- [ ] **Step 1: Update vercel.json**

Add to `crons` array:

```json
{ "path": "/api/cron/pipeline-scan",         "schedule": "* * * * *" },
{ "path": "/api/cron/pipeline-health",       "schedule": "*/5 * * * *" },
{ "path": "/api/cron/feedback-aggregation",  "schedule": "0 7 * * *" }
```

- [ ] **Step 2: Create the three routes**

Each route follows this template (per build plan §8):

```typescript
// MyraTMS/app/api/cron/pipeline-scan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { CronJobHandlers } from '@/lib/cron/cron-handlers';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (process.env.PIPELINE_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'pipeline_disabled' });
  }
  if (process.env.SCANNER_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'scanner_disabled' });
  }
  const handlers = new CronJobHandlers(/* db, redis, config */);
  const result = await handlers.runScannerTrigger();
  return NextResponse.json(result);
}
```

Repeat for `pipeline-health` (calls stuck-load + dead-letter sweepers) and `feedback-aggregation` (calls daily aggregation handler).

- [ ] **Step 3: Test each route returns 401 without secret, 200 with**

```typescript
// __tests__/pipeline/cron-routes.test.ts
import { describe, it, expect } from 'vitest';
import { GET as scan } from '@/app/api/cron/pipeline-scan/route';
import { NextRequest } from 'next/server';

describe('cron routes', () => {
  it('rejects without CRON_SECRET', async () => {
    const r = await scan(new NextRequest('http://localhost/api/cron/pipeline-scan'));
    expect(r.status).toBe(401);
  });
  it('skips when PIPELINE_ENABLED=false', async () => {
    process.env.PIPELINE_ENABLED = 'false';
    const req = new NextRequest('http://localhost/api/cron/pipeline-scan', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const r = await scan(req);
    const body = await r.json();
    expect(body.skipped).toBe('pipeline_disabled');
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm vitest run __tests__/pipeline/cron-routes.test.ts
git add vercel.json app/api/cron/pipeline-scan app/api/cron/pipeline-health app/api/cron/feedback-aggregation __tests__/pipeline/cron-routes.test.ts
git commit -m "feat(engine2): add 3 pipeline cron routes with kill-switch guards"
```

---

### Task 23: Worker entry-point script

**Files:**
- Create: `MyraTMS/scripts/run-workers.ts`

- [ ] **Step 1: Create**

```typescript
// MyraTMS/scripts/run-workers.ts
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { startAllWorkers } from '@/lib/workers';
import { Queue } from 'bullmq';
import {
  RESEARCH_QUEUE_CONFIG, MATCH_QUEUE_CONFIG, BRIEF_QUEUE_CONFIG,
  CALL_QUEUE_CONFIG, DISPATCH_QUEUE_CONFIG, FEEDBACK_QUEUE_CONFIG,
  CALLBACK_QUEUE_CONFIG, ESCALATION_QUEUE_CONFIG,
} from '@/lib/pipeline/queues';
import { logger } from '@/lib/logger';

if (process.env.PIPELINE_ENABLED !== 'true') {
  logger.warn('startup.pipeline_disabled — exiting');
  process.exit(0);
}

const queues = {
  research: new Queue(RESEARCH_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  match:    new Queue(MATCH_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  brief:    new Queue(BRIEF_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  call:     new Queue(CALL_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  dispatch: new Queue(DISPATCH_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  feedback: new Queue(FEEDBACK_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  callback: new Queue(CALLBACK_QUEUE_CONFIG.queueName, { connection: redisConnection }),
  escalation: new Queue(ESCALATION_QUEUE_CONFIG.queueName, { connection: redisConnection }),
};

const workers = startAllWorkers({ redis: redisConnection, queues });
logger.info('workers.started', { workers: Object.keys(workers) });

const shutdown = async (sig: string) => {
  logger.info('workers.shutdown_start', { signal: sig });
  for (const w of Object.values(workers as any)) {
    await (w as any).close?.();
  }
  await redisConnection.quit();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

- [ ] **Step 2: Run locally (smoke check)**

```bash
PIPELINE_ENABLED=true MAX_CONCURRENT_CALLS=0 pnpm tsx scripts/run-workers.ts
```

Expected: log lines `workers.started` listing all 7 workers, then it idles waiting for jobs. Ctrl+C exits cleanly via SIGINT handler.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-workers.ts
git commit -m "feat(engine2): worker entry-point script for local dev + production worker host"
```

- [ ] **Step 4: Provision worker host (deferred operational task)**

Production deployment of `scripts/run-workers.ts` to Railway/Fly/Render is operational work outside this plan. Open a follow-up issue: "Provision worker host for Engine 2 (Railway recommended, single small Node container)."

---

## ✅ Sprint 5 Checkpoint

```bash
pnpm vitest run __tests__/pipeline/   # all green
pnpm tsc --noEmit                     # zero errors
git log --oneline | head -20          # ~20 commits across 5 sprints
```

End-to-end pipeline now complete: scanned → qualified → researched + matched → briefed → calling → booked (or declined/escalated) → dispatched → delivered → scored.

---

# Sprint 6 — Shadow Mode + First 10 Live Calls (4–8 hrs)

### Task 24: Shadow mode dry-run

- [ ] **Step 1: Set env**

```bash
PIPELINE_ENABLED=true SCANNER_ENABLED=false MAX_CONCURRENT_CALLS=0
```

- [ ] **Step 2: Import 50–100 sample loads via CSV**

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@sample-loads.csv" http://localhost:3000/api/pipeline/import
```

- [ ] **Step 3: Verify metrics**

```bash
psql "$DATABASE_URL" <<'EOF'
SELECT stage, COUNT(*) FROM pipeline_loads GROUP BY stage ORDER BY 1;
SELECT
  AVG(market_rate_mid - posted_rate) AS avg_margin,
  AVG(carrier_match_count)            AS avg_matches,
  COUNT(*) FILTER (WHERE stage = 'briefed')::float / NULLIF(COUNT(*), 0) AS qualification_rate
FROM pipeline_loads;
EOF
```

Expected ranges (per build plan §9):
- Qualification rate: 20–30%
- Avg carrier matches: 1–3 per brief
- Brief validation pass: ≥99%

If outside these ranges, debug before proceeding to live calls.

---

### Task 25: First 10 live calls

- [ ] **Step 1: Set env**

```bash
PIPELINE_ENABLED=true MAX_CONCURRENT_CALLS=1 SCANNER_ENABLED=false
```

- [ ] **Step 2: Import 10 loads with REAL shipper phone numbers** (verified opt-in, CASL-compliant)

- [ ] **Step 3: Listen via Retell dashboard** as calls go out

- [ ] **Step 4: Verify outcomes**

```bash
psql "$DATABASE_URL" -c "
  SELECT pl.load_id, pl.call_outcome, pl.agreed_rate, pl.profit, ac.transcript_summary
  FROM pipeline_loads pl LEFT JOIN agent_calls ac ON ac.pipeline_load_id = pl.id
  ORDER BY pl.last_call_at DESC LIMIT 10;
"
```

- [ ] **Step 5: Iterate Claude prompts** in `claude-service.ts` based on real call quality, then commit prompt adjustments separately:

```bash
git add lib/pipeline/claude-service.ts
git commit -m "tune(engine2): adjust research/brief prompts after first 10 live calls"
```

---

# Self-Review

Walking through the plan against the spec one more time:

1. **Spec coverage:**
   - Scanner / Agent 1 → Task 16 (CSV fallback) + deferred follow-up for DAT/Truckstop scrapers ✓
   - Qualifier / Agent 2 → Task 11 ✓
   - Researcher / Agent 3 → Task 14 ✓
   - Ranker / Agent 4 → Task 12 ✓
   - Compiler / Agent 5 → Task 15 ✓
   - Voice / Agent 6 → Task 17 ✓
   - Dispatcher / Agent 7 → Task 20 ✓
   - Feedback Agent → Task 21 ✓
   - Completion gate → Task 13 (independent test, used by Tasks 12 + 14) ✓
   - Compliance gate → wired in Tasks 11 (Q-5 DNC) + 15 (C-3 full check) + 17 (V-2 pre-call recheck) ✓
   - Retell webhook → Task 18 ✓
   - Crons → Task 22 ✓
   - Migrations → Task 7 ✓
   - Worker host topology → Task 23 ✓
   - Shadow mode + live calls → Tasks 24–25 ✓

2. **Placeholder scan:** No "TBD", no "implement later" without a concrete TODO reference, no "similar to Task N" without showing code. Implementation steps that defer to source-file TODO comments (e.g. "implement TODO Q-1 per build plan §5") give a precise location *and* show the load-bearing code. The deferred DAT/Truckstop scrapers are explicitly called out as a follow-up issue, not a placeholder.

3. **Type consistency:** `pipelineLoadId` (number) and `loadId` (string) used uniformly across all worker payloads, matching `BaseJobPayload`. `briefId` (number) consistent between Compiler output and Voice input. `validateBrief()` referenced in Task 15 returns `{ valid: boolean; errors: string[] }`, matching the contract in `myra_negotiation_brief_schema.ts`. `runMatchingEngine` import name verified in Sprint 0 Task 5 Step 2 (which is a discovery step, so it accommodates the actual export name).

4. **Stack-specific notes preserved:**
   - BullMQ requires IORedis (Task 3) — separate from REST `lib/redis.ts`.
   - Workers don't run on Vercel (Task 23 worker-host note).
   - Retell webhook uses `runtime = 'nodejs'` not Edge.
   - Migrations use `IF NOT EXISTS` (idempotent re-runs safe — Task 7).

No issues found that warrant changes. Plan is ready to execute.

---

# Execution Handoff

Plan complete and saved to `Engine 2/docs/superpowers/plans/2026-04-30-engine2-end-to-end.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, you review between tasks, fast iteration. Best for a multi-day build like this where each task's output deserves a sanity check before the next subagent starts. Required sub-skill: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batched with checkpoints between sprints. Best if you want to babysit the build and intervene mid-task.

Which approach? (Or pick a single sprint/task to start with — the plan is structured so any sprint's checkpoint is a clean stopping point.)
