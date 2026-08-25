# E2-03 M0 — Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Engine 2 from silently auto-assigning carriers who were never contacted — replace the Dispatcher's unconditional auto-assign with a human-workable escalation, close a duplicate-load-row bug on retry, stop a zero-rate fallback from masquerading as a real 100%-margin number, and finish a half-done cleanup of a dead config variable.

**Architecture:** One migration (already drafted, this plan applies + verifies it) adds the schema `dispatcher-worker.ts` needs. All behavior changes land in `dispatcher-worker.ts`'s `process()` method, gated behind a new `CARRIER_AUTO_ASSIGN_ENABLED` flag that defaults `false`. A new escalation path reuses the exact table (`exceptions`) and UI (Alert Center) the existing prospect-gate escalation already renders through — no new UI code. The `AUTO_BOOK_PROFIT_THRESHOLD` cleanup is a documentation/tooling-only fix across 4 files, zero behavior change.

**Tech Stack:** TypeScript, `@neondatabase/serverless` via `lib/pipeline/db-adapter.ts` (Pattern B — `db.query(text, params)`), Vitest against live Neon (this codebase's tests don't mock the database — see `__tests__/pipeline/dispatcher.test.ts` for the established convention: a local `http.Server` mocks the 4 TMS routes, real DB rows are seeded/cleaned per test).

**Spec:**
- `Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md` §5 (M0 design + acceptance criteria), §6.6 (schema)
- `MyraTMS/docs/superpowers/specs/2026-08-25-e2-03-m0-design.md` — the three reconciliation findings this plan applies (migration's E2-01 dependency fix, the Alert Center context resolution, the AUTO_BOOK_PROFIT_THRESHOLD half-done cleanup) and exactly what M0 changes in `dispatcher-worker.ts`

## Global Constraints

- **`CARRIER_AUTO_ASSIGN_ENABLED` defaults to `false`.** This is the one flag in the whole E2-01/E2-03 arc that defaults OFF — the current always-on auto-assign is the dangerous state, the guarded one is safe. Read via constructor option first, env var second: `opts.carrierAutoAssignEnabled ?? process.env.CARRIER_AUTO_ASSIGN_ENABLED === 'true'` — this exact pattern (constructor opt overrides env) already exists for `tmsApiUrl` in this file; match it so tests can control the flag directly without touching `process.env`.
- **No new UI or API-route work.** The escalation exception must render correctly through the *existing* `components/alert-center.tsx` (reads `exc.title`, `exc.detail`, `exc.severity`, `exc.carrier_name` via the existing `app/api/exceptions/route.ts` GET, which `LEFT JOIN`s `carriers c ON e.carrier_id = c.id`). Set `carrier_id` on the exception row so that join resolves; put everything else (load details) into `title`/`detail` text.
- **`exceptions` INSERT: omit `id` and `tenant_id`.** Both have working defaults (`id` auto-generates, `tenant_id` defaults to `2`, confirmed live) — match the established insert shape used everywhere else in this codebase (`lib/exceptions/detector.ts`): `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, ...) VALUES (...)`, never specifying `id`/`tenant_id`/`status`.
- **Migrations are additive and idempotent.** Every `ALTER TABLE ... ADD COLUMN` uses `IF NOT EXISTS`; the one `ADD CONSTRAINT` is guarded via a `pg_constraint` existence check inside `DO $$ ... END $$` (Postgres has no native `ADD CONSTRAINT IF NOT EXISTS`) — this is already how `scripts/041-sellside-expansion-schema.sql` is written; don't touch its `CREATE TABLE`-equivalent blocks, only re-run/verify it.
- **Zero live-path files outside `dispatcher-worker.ts` change behavior in this plan**, except the AUTO_BOOK_PROFIT_THRESHOLD reference updates (Task 5), which are comment/log-string changes only — no logic changes.
- **DB access:** Pattern B only (`import { db } from '@/lib/pipeline/db-adapter'`, then `db.query<T>(text, params)`) — matches every existing line in `dispatcher-worker.ts`.
- **Tests hit live Neon**, matching `__tests__/pipeline/dispatcher.test.ts` and `dispatcher-prospect-gate.test.ts`'s convention: seed fixture rows with a timestamp-suffixed identifier in `beforeAll`, clean up in `afterAll`, mock only the outbound TMS HTTP calls via a local `http.Server`.
- **No new npm dependencies.**

---

### Task 1: Apply and verify migration 041

**Files:**
- Verify (already committed, no changes needed unless verification fails): `scripts/041-sellside-expansion-schema.sql`
- Verify (already committed): `scripts/verify-041-sellside-expansion-migration.ts`

**Interfaces:**
- Produces (for Task 2, 3, 4): `agent_calls.chk_agent_calls_call_type` CHECK constraint; `pipeline_loads` columns `carrier_agreed_rate`, `carrier_agreed_currency`, `carrier_call_outcome`, `carrier_id_secured`, `carrier_cascade_position`, `carrier_profit`; `loads.carrier_cost_estimated BOOLEAN DEFAULT false`; `carriers.verified_at`/`verified_by`/`verification_snapshot`; `exceptions.pipeline_load_id`/`source_module`/`suggested_action`/`sla_due_at` (order-independent of E2-01's own `040` migration, which has not yet merged to this branch's base).

- [ ] **Step 1: Apply the migration to the database referenced by `DATABASE_URL`**

Run: `cd MyraTMS && pnpm tsx --env-file=.env.local scripts/apply-pipeline-migration.ts 041-sellside-expansion-schema.sql`
Expected: `Migration applied successfully in <N>ms`

- [ ] **Step 2: Run the verification script**

Run: `pnpm tsx --env-file=.env.local scripts/verify-041-sellside-expansion-migration.ts`
Expected: `✅ Migration 041 verified.` and exit code 0 — all 5 checks (call_type constraint, pipeline_loads columns, loads column, carriers columns, exceptions columns) report zero MISSING lines.

- [ ] **Step 3: Confirm no regression on the existing pipeline suite**

Run: `pnpm vitest run __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts`
Expected: both pass exactly as before (this migration is purely additive — new columns, no column changes, no constraint that existing data would violate).

- [ ] **Step 4: Commit**

If Step 1/2 required no file edits (the migration was already correct), there's nothing new to commit — note in your report that the migration was pre-verified-clean. If Step 2 surfaced a gap you had to fix in the SQL or verify script, commit that fix:

```bash
git add scripts/041-sellside-expansion-schema.sql scripts/verify-041-sellside-expansion-migration.ts
git commit -m "E2-03 M0: apply + verify migration 041"
```

---

### Task 2: `CARRIER_AUTO_ASSIGN_ENABLED` gate + carrier-confirmation escalation

**Files:**
- Modify: `lib/workers/dispatcher-worker.ts`
- Modify: `__tests__/pipeline/dispatcher.test.ts` (must keep testing the auto-assign path — needs the new flag explicitly enabled, or it now hits the new escalation branch by default and every existing assertion fails)
- Test: `__tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts` (new)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces (for Task 3, Task 4): `DispatcherWorker`'s constructor gains a 3rd `opts` field `carrierAutoAssignEnabled?: boolean`; a new private field `this.carrierAutoAssignEnabled: boolean`. `process()` gains a new early-return branch between the existing prospect-gate check and `fetchCarrierRate()` — Task 3 and Task 4 both edit code that now lives *inside* that gated branch (i.e., only reachable when `carrierAutoAssignEnabled === true`).

- [ ] **Step 1: Write the failing tests**

First, fix the existing test so it keeps testing the auto-assign path (it will otherwise hit the new default-off escalation branch and every assertion about the 4 TMS routes will fail):

In `__tests__/pipeline/dispatcher.test.ts`, change:

```typescript
    const worker = new DispatcherWorker(redisConnection, {
      tmsApiUrl: mockUrl,
    });
```

to:

```typescript
    const worker = new DispatcherWorker(redisConnection, {
      tmsApiUrl: mockUrl,
      carrierAutoAssignEnabled: true,
    });
```

That's the only change to that file. Now write the new test file:

```typescript
// __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts
/**
 * E2-03 M0: when CARRIER_AUTO_ASSIGN_ENABLED is false (the default), the
 * Dispatcher must not call any TMS route or auto-assign a carrier who was
 * never actually contacted. It must instead escalate: pipeline_loads.stage
 * flips to 'escalated' and an exceptions row appears with enough context
 * for a human to secure the carrier by phone from the Alert Center alone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-CARRHOLD-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';

describe('DispatcherWorker — carrier confirmation gate (E2-03 M0)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let requestCount = 0;
  let pipelineLoadId: number;

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      requestCount += 1;
      res.writeHead(500).end('mock TMS should not have been called');
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id,
         stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID, REAL_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('escalates instead of dispatching when carrierAutoAssignEnabled is false (explicit)', async () => {
    const worker = new DispatcherWorker(redisConnection, {
      tmsApiUrl: mockUrl,
      carrierAutoAssignEnabled: false,
    });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_carrier_hold',
    };

    const result = await worker.process(payload);

    // No TMS API calls were made — the gate caught it before any side effect.
    expect(requestCount).toBe(0);

    expect(result.success).toBe(true);
    expect(result.stage).toBe('escalated');
    expect(result.details?.escalated).toBe(true);
    expect(result.details?.reason).toBe('carrier_auto_assign_disabled');
    expect(result.details?.carrierId).toBe(REAL_CARRIER_ID);

    const after = await db.query<{ stage: string; tms_load_id: string | null }>(
      `SELECT stage, tms_load_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('escalated');
    expect(after.rows[0].tms_load_id).toBeNull();

    // No loads row was created.
    const loadsRow = await db.query(`SELECT id FROM loads WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(loadsRow.rows.length).toBe(0);

    // Exception row carries the evidence a human needs, renderable via the
    // existing Alert Center (title/detail/severity/carrier_id, no new UI).
    const exc = await db.query<{
      title: string; detail: string; severity: string; carrier_id: string; load_id: string | null;
      pipeline_load_id: number; source_module: string; suggested_action: string;
    }>(
      `SELECT title, detail, severity, carrier_id, load_id, pipeline_load_id, source_module, suggested_action
       FROM exceptions WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(exc.rows.length).toBe(1);
    const row = exc.rows[0];
    expect(row.carrier_id).toBe(REAL_CARRIER_ID);
    expect(row.load_id).toBeNull(); // no TMS load exists yet at escalation time
    expect(row.severity).toBe('high');
    expect(row.source_module).toBe('carrier_confirmation_required');
    expect(row.suggested_action).toMatch(/AI carrier calling is not yet live/);
    expect(row.title).toMatch(/Toronto, ON/);
    expect(row.title).toMatch(/Sudbury, ON/);
    expect(row.detail).toMatch(new RegExp(REAL_CARRIER_ID));
    expect(row.detail).toMatch(/Dry Van/);
  }, 30_000);

  it('escalates by default when carrierAutoAssignEnabled is not passed at all', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl });
    // Re-seed: the previous test already escalated this load; reset stage to 'booked' to re-test.
    await db.query(`UPDATE pipeline_loads SET stage = 'booked' WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    requestCount = 0;

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_default_off',
    };

    const result = await worker.process(payload);
    expect(requestCount).toBe(0);
    expect(result.stage).toBe('escalated');
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts`
Expected: FAIL — `carrierAutoAssignEnabled` is not a recognized constructor option (TS error or the field is silently ignored and the worker proceeds to actually call the mock TMS server, which returns 500, causing the test to fail with an unhandled fetch error rather than the expected assertions).

Also run: `pnpm vitest run __tests__/pipeline/dispatcher.test.ts` — expected to already be passing again once the `carrierAutoAssignEnabled: true` edit lands, since the constructor doesn't reject unknown options yet; this confirms your Step 1 edit was applied correctly. If it fails, re-check the edit.

- [ ] **Step 3: Implement — modify `lib/workers/dispatcher-worker.ts`**

Change the constructor signature and add the field. Find:

```typescript
  constructor(redis: Redis, opts: { tmsApiUrl?: string; serviceTokenTtl?: string } = {}) {
    const config: WorkerConfig = {
      queueName: 'dispatch-queue',
      expectedStage: 'booked',
      // nextStage handled inside updatePipelineLoad — we also need to write
      // tms_load_id alongside the stage transition.
      nextStage: undefined,
      concurrency: 10,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      },
      redis,
    };
    super(config);

    this.tmsApiUrl =
      opts.tmsApiUrl ?? process.env.TMS_API_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    this.serviceTokenTtl = opts.serviceTokenTtl ?? '5m';
  }
```

Replace with:

```typescript
  constructor(
    redis: Redis,
    opts: { tmsApiUrl?: string; serviceTokenTtl?: string; carrierAutoAssignEnabled?: boolean } = {},
  ) {
    const config: WorkerConfig = {
      queueName: 'dispatch-queue',
      expectedStage: 'booked',
      // nextStage handled inside updatePipelineLoad — we also need to write
      // tms_load_id alongside the stage transition.
      nextStage: undefined,
      concurrency: 10,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      },
      redis,
    };
    super(config);

    this.tmsApiUrl =
      opts.tmsApiUrl ?? process.env.TMS_API_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    this.serviceTokenTtl = opts.serviceTokenTtl ?? '5m';
    // E2-03 M0: default OFF — the always-on auto-assign is the dangerous
    // state (fabricates a carrier commitment that was never obtained), not
    // the guarded one. Flip only after M2's real carrier-calling cascade is
    // live and validated end to end.
    this.carrierAutoAssignEnabled = opts.carrierAutoAssignEnabled ?? process.env.CARRIER_AUTO_ASSIGN_ENABLED === 'true';
  }
```

Add the field declaration next to the existing two. Find:

```typescript
export class DispatcherWorker extends BaseWorker<DispatchJobPayload> {
  private tmsApiUrl: string;
  private serviceTokenTtl: string;
```

Replace with:

```typescript
export class DispatcherWorker extends BaseWorker<DispatchJobPayload> {
  private tmsApiUrl: string;
  private serviceTokenTtl: string;
  private carrierAutoAssignEnabled: boolean;
```

Now add the gate itself inside `process()`. Find:

```typescript
    const carrierStatus = await this.fetchCarrierStatus(load.top_carrier_id);
    if (carrierStatus !== 'active') {
      await this.escalateProspect(pipelineLoadId, load.top_carrier_id, carrierStatus, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'top_carrier_not_active',
          carrierId: load.top_carrier_id,
          carrierStatus,
        },
      };
    }

    const carrierRate = await this.fetchCarrierRate(load.load_id, load.top_carrier_id);
```

Replace with:

```typescript
    const carrierStatus = await this.fetchCarrierStatus(load.top_carrier_id);
    if (carrierStatus !== 'active') {
      await this.escalateProspect(pipelineLoadId, load.top_carrier_id, carrierStatus, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'top_carrier_not_active',
          carrierId: load.top_carrier_id,
          carrierStatus,
        },
      };
    }

    // E2-03 M0: no real carrier has agreed to run this load yet — Dispatch
    // One (E2-03 M2) is the module that will actually call carriers. Until
    // it's live, assigning here would tell the shipper a carrier is moving
    // their freight when no carrier has agreed to anything.
    if (!this.carrierAutoAssignEnabled) {
      await this.escalateCarrierConfirmation(pipelineLoadId, load, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'carrier_auto_assign_disabled',
          carrierId: load.top_carrier_id,
        },
      };
    }

    const carrierRate = await this.fetchCarrierRate(load.load_id, load.top_carrier_id);
```

Add the new `escalateCarrierConfirmation` method. Find the existing `escalateProspect` method:

```typescript
  private async escalateProspect(
    pipelineLoadId: number,
    carrierId: string,
    carrierStatus: string | null,
    callId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId],
    );
    logger.warn(
      `[Dispatcher] Load ${pipelineLoadId} escalated: top carrier ${carrierId} has carrier_status='${carrierStatus ?? 'unknown'}' (must be 'active' to dispatch); call=${callId}`,
    );
  }
```

Add immediately after it:

```typescript

  private async escalateCarrierConfirmation(
    pipelineLoadId: number,
    load: PipelineLoadRow,
    callId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId],
    );

    const title = `Carrier confirmation needed: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const pickup = load.pickup_date ? this.toIsoDate(load.pickup_date) : 'unknown';
    const detail =
      `AI carrier calling is not yet live. Secure carrier ${load.top_carrier_id} for this load by phone. ` +
      `Pickup ${pickup}, equipment ${load.equipment_type}` +
      (load.weight_lbs ? `, ${load.weight_lbs} lbs` : '') +
      (load.shipper_company ? `. Shipper: ${load.shipper_company}` : '') +
      `.`;
    const suggestedAction = 'Secure a carrier for this load by phone. AI carrier calling is not yet live.';

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, $1, 'carrier_confirmation_required', 'high', $2, $3,
         $4, 'carrier_confirmation_required', $5, NOW() + INTERVAL '4 hours'
       )`,
      [load.top_carrier_id, title, detail, pipelineLoadId, suggestedAction],
    );

    logger.warn(
      `[Dispatcher] Load ${pipelineLoadId} escalated: CARRIER_AUTO_ASSIGN_ENABLED=false, carrier ${load.top_carrier_id} not yet confirmed; call=${callId}`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts`
Expected: all PASS (2 + 1 + 1 = 4 tests total across the 3 files).

- [ ] **Step 5: Commit**

```bash
git add lib/workers/dispatcher-worker.ts __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts
git commit -m "E2-03 M0: CARRIER_AUTO_ASSIGN_ENABLED gate — escalate instead of auto-assign, default off"
```

---

### Task 3: Idempotency guard on `createTMSLoad()`

**Files:**
- Modify: `lib/workers/dispatcher-worker.ts`
- Test: `__tests__/pipeline/dispatcher-idempotency.test.ts` (new)

**Interfaces:**
- Consumes: `this.carrierAutoAssignEnabled` (Task 2) — this task's test must construct `DispatcherWorker` with `carrierAutoAssignEnabled: true` or it never reaches the code this task changes.
- Produces (for Task 4): `PipelineLoadRow` interface gains `tms_load_id: string | null`; `fetchPipelineLoad()`'s SELECT includes it. Task 4's changes land inside the same `process()` region, after this task's `tmsLoad` resolution.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/pipeline/dispatcher-idempotency.test.ts
/**
 * E2-02 §4 item 2 / E2-03 §5.4.1: dispatcher-worker.ts's process() had no
 * checkpoint before creating the TMS load row. A dispatch-queue retry after
 * a downstream failure (e.g. assignCarrier() throws) re-ran from the top and
 * created a second `loads` row for the same pipeline_loads entry. This test
 * simulates that retry directly: seed a pipeline_load whose tms_load_id is
 * already set (as if createTMSLoad() succeeded on a prior attempt) and
 * confirm process() reuses it instead of creating a second loads row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-IDEMP-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';
const PRE_EXISTING_TMS_LOAD_ID = `LD-PREEXIST-${Date.now().toString(36).toUpperCase()}`;

interface CapturedRequest { method: string; url: string }

describe('DispatcherWorker — idempotency on retry (E2-02 §4 item 2)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  const captured: CapturedRequest[] = [];
  let pipelineLoadId: number;

  beforeAll(async () => {
    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      captured.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.method === 'POST' && req.url === '/api/loads') {
        res.writeHead(500).end('should never be called on a retry — tms_load_id already set');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // Pre-existing loads row, as if Step 1 (createTMSLoad) already succeeded
    // on a prior attempt before a downstream step failed.
    await db.query(
      `INSERT INTO loads (id, origin, destination, source, status, revenue, created_at)
       VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', 'Booked', 2200, NOW())`,
      [PRE_EXISTING_TMS_LOAD_ID],
    );

    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id,
         stage, agreed_rate, agreed_rate_currency, profit, tms_load_id
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470, $3
       ) RETURNING id`,
      [TEST_LOAD_ID, REAL_CARRIER_ID, PRE_EXISTING_TMS_LOAD_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at)
       VALUES ($1, $2, $3, 0.78, 'B', $4, true, 'auto', NOW())`,
      [`MR-IDP-${Date.now()}`, TEST_LOAD_ID, REAL_CARRIER_ID, JSON.stringify({ rate: { carrier_avg_rate: 1850 } })],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [PRE_EXISTING_TMS_LOAD_ID]);
  });

  it('reuses the existing tms_load_id instead of creating a second loads row', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: true });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_idempotency',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.tmsLoadId).toBe(PRE_EXISTING_TMS_LOAD_ID);

    // POST /api/loads was never called.
    expect(captured.some((c) => c.method === 'POST' && c.url === '/api/loads')).toBe(false);
    // But the rest of the chain still ran, against the pre-existing id.
    expect(captured.some((c) => c.url === `/api/loads/${PRE_EXISTING_TMS_LOAD_ID}/assign`)).toBe(true);

    // Still exactly one loads row for this id (no duplicate created).
    const rows = await db.query(`SELECT id FROM loads WHERE id = $1`, [PRE_EXISTING_TMS_LOAD_ID]);
    expect(rows.rows.length).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-idempotency.test.ts`
Expected: FAIL — the current `process()` always calls `createTMSLoad()`, which POSTs to `/api/loads`; the mock returns 500 for that path, so the worker throws.

- [ ] **Step 3: Implement — modify `lib/workers/dispatcher-worker.ts`**

Add `tms_load_id` to the row interface. Find:

```typescript
interface PipelineLoadRow {
  id: number;
  load_id: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  pickup_date: Date | null;
  delivery_date: Date | null;
  equipment_type: string;
  commodity: string | null;
  weight_lbs: number | null;
  shipper_company: string | null;
  shipper_email: string | null;
  shipper_phone: string | null;
  top_carrier_id: string | null;
}
```

Replace with:

```typescript
interface PipelineLoadRow {
  id: number;
  load_id: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  pickup_date: Date | null;
  delivery_date: Date | null;
  equipment_type: string;
  commodity: string | null;
  weight_lbs: number | null;
  shipper_company: string | null;
  shipper_email: string | null;
  shipper_phone: string | null;
  top_carrier_id: string | null;
  tms_load_id: string | null;
}
```

Update the SELECT. Find:

```typescript
  private async fetchPipelineLoad(id: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, origin_city, origin_state, destination_city, destination_state,
              pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
              shipper_company, shipper_email, shipper_phone, top_carrier_id
       FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }
```

Replace with:

```typescript
  private async fetchPipelineLoad(id: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, origin_city, origin_state, destination_city, destination_state,
              pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
              shipper_company, shipper_email, shipper_phone, top_carrier_id, tms_load_id
       FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }
```

Add the idempotency check. Find:

```typescript
    const cookie = `auth-token=${signServiceToken(this.serviceTokenTtl)}`;

    // Step 1: create the TMS load row.
    const tmsLoad = await this.createTMSLoad(load, agreedRate, payload.agreedRateCurrency, cookie);
```

Replace with:

```typescript
    const cookie = `auth-token=${signServiceToken(this.serviceTokenTtl)}`;

    // Step 1: create the TMS load row — or reuse one from a prior attempt.
    // E2-02 §4 item 2: a dispatch-queue retry after a downstream failure
    // (e.g. assignCarrier throws) used to re-run from the top and create a
    // second loads row for the same pipeline_loads entry. tms_load_id is
    // the natural idempotency key — once set, it's never re-created.
    const tmsLoad = load.tms_load_id
      ? { id: load.tms_load_id }
      : await this.createTMSLoad(load, agreedRate, payload.agreedRateCurrency, cookie);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-idempotency.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full dispatcher test surface to confirm no regression**

Run: `pnpm vitest run __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts __tests__/pipeline/dispatcher-idempotency.test.ts`
Expected: all PASS (1 + 1 + 2 + 1 = 5 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/workers/dispatcher-worker.ts __tests__/pipeline/dispatcher-idempotency.test.ts
git commit -m "E2-03 M0: idempotency guard on createTMSLoad() — no duplicate loads row on dispatch-queue retry"
```

---

### Task 4: `carrier_cost_estimated` honesty flag

**Files:**
- Modify: `lib/workers/dispatcher-worker.ts`
- Test: `__tests__/pipeline/dispatcher-cost-estimated-flag.test.ts` (new)

**Interfaces:**
- Consumes: `this.carrierAutoAssignEnabled` (Task 2, must be `true` in this task's test); the `tmsLoad` resolution from Task 3 (this task's changes sit just after it, in the same `process()` region).
- Produces: `fetchCarrierRate()`'s return type changes from `Promise<number>` to `Promise<CarrierRateResult>` (`{ rate: number; estimated: boolean }`) — nothing later in this plan consumes it further, but note the shape for anyone extending the Dispatcher later (M2's cascade worker will need its own equivalent, not this one — see PRD §6.5, carrier-side envelope is separate).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts
/**
 * E2-02 §4 item 3: when a carrier has no rate history, fetchCarrierRate()
 * fell back to 0, producing margin = revenue, a 100% margin indistinguishable
 * from a genuine zero-cost load. This doesn't fix the underlying "no real
 * carrier rate" problem (M2 does that) - it stops the number from lying
 * about its own confidence: loads.carrier_cost_estimated must be true
 * whenever the fallback fired, false when a real carrier_avg_rate was used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { DispatcherWorker, type DispatchJobPayload } from '@/lib/workers/dispatcher-worker';

const TEST_LOAD_ID = `TEST-COSTEST-${Date.now()}`;
const REAL_CARRIER_ID = 'car_001';
const FAKE_TMS_LOAD_ID = `LD-COSTEST-${Date.now().toString(36).toUpperCase()}`;

describe('DispatcherWorker — carrier_cost_estimated honesty flag (E2-02 §4 item 3)', () => {
  let mockServer: http.Server;
  let mockUrl: string;
  let pipelineLoadId: number;

  beforeAll(async () => {
    const env0 = process.env.JWT_SECRET;
    process.env.JWT_SECRET = env0 ?? 'test-secret-' + Date.now();

    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/loads') {
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: FAKE_TMS_LOAD_ID }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token: 't', trackingUrl: 'https://x.test' }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    if (!addr || typeof addr === 'string') throw new Error('mock bind failed');
    mockUrl = `http://127.0.0.1:${addr.port}`;

    // No match_results row for this carrier — fetchCarrierRate() has
    // nothing to read and must fall back.
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km,
         shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id,
         stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
         250, 402,
         'Northern Mine Supply Co', 'jm@nmsco.test', '+17055551861',
         2400, 'CAD', $2,
         'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [TEST_LOAD_ID, REAL_CARRIER_ID],
    );
    pipelineLoadId = ins.rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await db.query(`DELETE FROM loads WHERE id = $1`, [FAKE_TMS_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('sets carrier_cost_estimated=true when carrier rate falls back to 0 (no match_results row)', async () => {
    const worker = new DispatcherWorker(redisConnection, { tmsApiUrl: mockUrl, carrierAutoAssignEnabled: true });

    const payload: DispatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      agreedRate: 2200,
      agreedRateCurrency: 'CAD',
      profit: 470,
      callId: 'mock_call_cost_estimated',
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.carrierRate).toBe(0);

    const row = await db.query<{ carrier_cost_estimated: boolean }>(
      `SELECT carrier_cost_estimated FROM loads WHERE id = $1`,
      [FAKE_TMS_LOAD_ID],
    );
    expect(row.rows[0].carrier_cost_estimated).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts`
Expected: FAIL — `loads.carrier_cost_estimated` is `false` (the column's default), because nothing writes `true` to it yet.

- [ ] **Step 3: Implement — modify `lib/workers/dispatcher-worker.ts`**

Add the result type. Find:

```typescript
interface CreatedLoad {
  id: string;
}
```

Replace with:

```typescript
interface CreatedLoad {
  id: string;
}

interface CarrierRateResult {
  rate: number;
  estimated: boolean;
}
```

Change `fetchCarrierRate()`'s return shape. Find:

```typescript
  private async fetchCarrierRate(loadId: string, carrierId: string): Promise<number> {
    const r = await db.query<{ breakdown: any }>(
      `SELECT breakdown FROM match_results
       WHERE load_id = $1 AND carrier_id = $2
       ORDER BY match_score DESC LIMIT 1`,
      [loadId, carrierId],
    );
    const carrierAvg = r.rows[0]?.breakdown?.rate?.carrier_avg_rate;
    return typeof carrierAvg === 'number' && carrierAvg > 0 ? carrierAvg : 0;
  }
```

Replace with:

```typescript
  private async fetchCarrierRate(loadId: string, carrierId: string): Promise<CarrierRateResult> {
    const r = await db.query<{ breakdown: any }>(
      `SELECT breakdown FROM match_results
       WHERE load_id = $1 AND carrier_id = $2
       ORDER BY match_score DESC LIMIT 1`,
      [loadId, carrierId],
    );
    const carrierAvg = r.rows[0]?.breakdown?.rate?.carrier_avg_rate;
    if (typeof carrierAvg === 'number' && carrierAvg > 0) {
      return { rate: carrierAvg, estimated: false };
    }
    // E2-02 §4 item 3: no real rate history for this carrier. Returning 0
    // silently made margin = revenue (100% margin), indistinguishable from a
    // genuine zero-cost load. `estimated: true` is the honesty flag — it
    // doesn't fix the underlying "no real carrier rate" problem (M2 does
    // that by actually negotiating one), it stops the number from lying
    // about its own confidence in the interim.
    return { rate: 0, estimated: true };
  }
```

Update `process()` to use the new shape and thread it into the loads UPDATE. Find:

```typescript
    const carrierRate = await this.fetchCarrierRate(load.load_id, load.top_carrier_id);

    const cookie = `auth-token=${signServiceToken(this.serviceTokenTtl)}`;

    // Step 1: create the TMS load row — or reuse one from a prior attempt.
    // E2-02 §4 item 2: a dispatch-queue retry after a downstream failure
    // (e.g. assignCarrier throws) used to re-run from the top and create a
    // second loads row for the same pipeline_loads entry. tms_load_id is
    // the natural idempotency key — once set, it's never re-created.
    const tmsLoad = load.tms_load_id
      ? { id: load.tms_load_id }
      : await this.createTMSLoad(load, agreedRate, payload.agreedRateCurrency, cookie);

    // Step 2: patch the pipeline-linkage columns the route doesn't handle.
    await db.query(
      `UPDATE loads
       SET pipeline_load_id = $2,
           source_type = 'ai_agent',
           booked_via = 'ai_auto',
           updated_at = NOW()
       WHERE id = $1`,
      [tmsLoad.id, pipelineLoadId],
    );

    // Step 3: assign the carrier (also flips loads.status to 'Dispatched').
    await this.assignCarrier(tmsLoad.id, load.top_carrier_id, carrierRate, cookie);
```

Replace with:

```typescript
    const carrierRateResult = await this.fetchCarrierRate(load.load_id, load.top_carrier_id);

    const cookie = `auth-token=${signServiceToken(this.serviceTokenTtl)}`;

    // Step 1: create the TMS load row — or reuse one from a prior attempt.
    // E2-02 §4 item 2: a dispatch-queue retry after a downstream failure
    // (e.g. assignCarrier throws) used to re-run from the top and create a
    // second loads row for the same pipeline_loads entry. tms_load_id is
    // the natural idempotency key — once set, it's never re-created.
    const tmsLoad = load.tms_load_id
      ? { id: load.tms_load_id }
      : await this.createTMSLoad(load, agreedRate, payload.agreedRateCurrency, cookie);

    // Step 2: patch the pipeline-linkage columns the route doesn't handle.
    await db.query(
      `UPDATE loads
       SET pipeline_load_id = $2,
           source_type = 'ai_agent',
           booked_via = 'ai_auto',
           carrier_cost_estimated = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [tmsLoad.id, pipelineLoadId, carrierRateResult.estimated],
    );

    // Step 3: assign the carrier (also flips loads.status to 'Dispatched').
    await this.assignCarrier(tmsLoad.id, load.top_carrier_id, carrierRateResult.rate, cookie);
```

Finally, update the two remaining references to the old `carrierRate` variable name in the same function. Find:

```typescript
    logger.info(
      `[Dispatcher] Load ${pipelineLoadId} dispatched. tms_load_id=${tmsLoad.id}, carrier=${load.top_carrier_id}, agreed=$${agreedRate}, profit=$${profit}, call=${callId}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        tmsLoadId: tmsLoad.id,
        carrierId: load.top_carrier_id,
        carrierRate,
        agreedRate,
        profit,
      },
    };
```

Replace with:

```typescript
    logger.info(
      `[Dispatcher] Load ${pipelineLoadId} dispatched. tms_load_id=${tmsLoad.id}, carrier=${load.top_carrier_id}, agreed=$${agreedRate}, profit=$${profit}, call=${callId}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        tmsLoadId: tmsLoad.id,
        carrierId: load.top_carrier_id,
        carrierRate: carrierRateResult.rate,
        agreedRate,
        profit,
      },
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full dispatcher test surface to confirm no regression**

Run: `pnpm vitest run __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts __tests__/pipeline/dispatcher-idempotency.test.ts __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts`
Expected: all PASS (1 + 1 + 2 + 1 + 1 = 6 tests). In particular, `dispatcher.test.ts`'s existing assertion `expect(result.details?.carrierRate).toBe(1850)` must still pass — that load has a real `match_results` row, so `estimated` is `false` and `rate` is unchanged at `1850`.

- [ ] **Step 6: Commit**

```bash
git add lib/workers/dispatcher-worker.ts __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts
git commit -m "E2-03 M0: carrier_cost_estimated honesty flag — zero-rate fallback no longer masquerades as real margin"
```

---

### Task 5: `AUTO_BOOK_PROFIT_THRESHOLD` reference cleanup

**Files:**
- Modify: `scripts/run-workers.ts`
- Modify: `scripts/sprint6-shadow/01-preflight.ts`
- Modify: `scripts/sprint6-shadow/05-live-call-preflight.ts`
- Modify: `scripts/sprint6-shadow/README.md`

**Interfaces:** None — this task is entirely self-contained text/log-string edits with zero behavior change. `AUTO_BOOK_PROFIT_THRESHOLD` was already inert (T-18/T-19 confirmed and documented this — `.env.example:72`); this task finishes making the *operational* surface honest about that, matching what the config surface already says.

- [ ] **Step 1: Read the current state of each reference**

Run: `grep -n "AUTO_BOOK_PROFIT_THRESHOLD" scripts/run-workers.ts scripts/sprint6-shadow/01-preflight.ts scripts/sprint6-shadow/05-live-call-preflight.ts scripts/sprint6-shadow/README.md`

You'll see 6 matches across the 4 files. This step has no code to write — just confirm the grep output matches what Step 2 expects to change before editing.

- [ ] **Step 2: Edit `scripts/run-workers.ts`**

Find (around line 92, inside a kill-switch status-log object):

```typescript
    AUTO_BOOK_PROFIT_THRESHOLD: process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999',
```

Replace with:

```typescript
    // AUTO_BOOK_PROFIT_THRESHOLD retired (T-18/T-19) — never read by any
    // decision path. The real margin-floor mechanism is
    // lib/tenants/margin-floor.ts getMarginFloor(), backed by T-18's
    // authority_envelopes. Kept here only as a startup-log breadcrumb in
    // case an old .env still sets it, so an operator sees it's inert.
    AUTO_BOOK_PROFIT_THRESHOLD: `${process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '(unset)'} (inert — see getMarginFloor())`,
```

- [ ] **Step 3: Edit `scripts/sprint6-shadow/01-preflight.ts`**

Find (around line 53):

```typescript
  AUTO_BOOK_PROFIT_THRESHOLD: 'shadow_safe',
```

Replace with:

```typescript
  // Retired (T-18/T-19) — see getMarginFloor() in lib/tenants/margin-floor.ts.
  // Left in this map as a no-op so this preflight doesn't need restructuring;
  // the check below no longer gates on it.
  AUTO_BOOK_PROFIT_THRESHOLD: 'shadow_safe',
```

Find (around line 73):

```typescript
      if (name === 'AUTO_BOOK_PROFIT_THRESHOLD' && parseInt(v, 10) < 1000) {
```

Replace with:

```typescript
      // Retired (T-18/T-19): AUTO_BOOK_PROFIT_THRESHOLD is never read by any
      // decision path. This check is now a soft warning, not a gate — the
      // real margin floor lives in lib/tenants/margin-floor.ts.
      if (name === 'AUTO_BOOK_PROFIT_THRESHOLD' && parseInt(v, 10) < 1000) {
```

(This second change is a comment-only addition immediately above the existing line — the condition and its behavior are unchanged, since this variable's value was already never consulted by any real decision path; only the intent needs to be honest, not the check's mechanics.)

- [ ] **Step 4: Edit `scripts/sprint6-shadow/05-live-call-preflight.ts`**

Find (around lines 77-81):

```typescript
  const autobook = parseInt(process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999', 10);
  if (autobook < 1000) {
    record('env.AUTO_BOOK_PROFIT_THRESHOLD', 'FAIL', `must be high (e.g. 999999) for first 10 calls — got ${autobook}`);
  } else {
    record('env.AUTO_BOOK_PROFIT_THRESHOLD', 'PASS', `${autobook} (auto-book disabled)`);
  }
```

Replace with:

```typescript
  // AUTO_BOOK_PROFIT_THRESHOLD retired (T-18/T-19) — never read by any
  // decision path; the real margin-floor/auto-book gate is T-18's
  // authority_envelopes, read via lib/tenants/margin-floor.ts
  // getMarginFloor(). This check is now informational only — it no longer
  // blocks the live-call gate (record() below always reports PASS/INFO,
  // never FAIL, for this variable) — but is left in place so an operator
  // relying on old muscle memory sees that the variable is inert rather
  // than silently vanishing from the preflight output.
  const autobook = parseInt(process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999', 10);
  record('env.AUTO_BOOK_PROFIT_THRESHOLD', 'INFO', `${autobook} — retired (T-18/T-19), not read by any decision path; see getMarginFloor()`);
```

Check the `record()` function's signature in this same file before making this edit — confirm it accepts `'INFO'` as a valid status alongside `'PASS'`/`'FAIL'`/`'WARN'` (grep for `function record` or `type.*Status` in this file). If `'INFO'` is not a recognized status literal, use `'PASS'` instead and keep the message text — the goal is removing the false gating behavior, not introducing a new status enum value if one doesn't already exist.

- [ ] **Step 5: Edit `scripts/sprint6-shadow/README.md`**

Find (around line 44):

```
AUTO_BOOK_PROFIT_THRESHOLD=999999   # belt and suspenders — auto-book disabled
```

Replace with:

```
# AUTO_BOOK_PROFIT_THRESHOLD retired (T-18/T-19) — no longer read by any
# decision path. The real auto-book/margin-floor gate is T-18's
# authority_envelopes (see lib/tenants/margin-floor.ts). Setting this
# variable has no effect; left documented here only so it doesn't look
# like a missing step if you're following an older run of this file.
```

Find (around line 136):

```
AUTO_BOOK_PROFIT_THRESHOLD=999999  # still off — review every booking manually
```

Replace with:

```
# AUTO_BOOK_PROFIT_THRESHOLD retired (T-18/T-19) — see the note above.
```

- [ ] **Step 6: Verify only accurate references remain**

Run: `grep -rn "AUTO_BOOK_PROFIT_THRESHOLD" scripts/run-workers.ts scripts/sprint6-shadow/`
Expected: every remaining match is inside a comment explaining the variable is retired/inert, or a log/record line whose message text says so — no line implies the variable still gates a real decision.

- [ ] **Step 7: Run the affected scripts' type-check**

Run: `pnpm tsc --noEmit`
Expected: 0 new errors. (If Step 4's `'INFO'` status literal doesn't exist on this file's status type, this is where it will surface — go back and fix per Step 4's fallback instruction.)

- [ ] **Step 8: Commit**

```bash
git add scripts/run-workers.ts scripts/sprint6-shadow/01-preflight.ts scripts/sprint6-shadow/05-live-call-preflight.ts scripts/sprint6-shadow/README.md
git commit -m "E2-03 M0: finish AUTO_BOOK_PROFIT_THRESHOLD cleanup — 4 operational references now say it's retired (T-18/T-19)"
```

---

### Task 6: Surface `carrier_cost_estimated` on the load detail view

**Files:**
- Modify: `components/load-quick-view.tsx`

**Interfaces:** Consumes `loads.carrier_cost_estimated` (Task 1's migration; already returned by `app/api/loads/[id]/route.ts`'s existing `SELECT * FROM loads WHERE id = $1` — no API route change needed). No new interfaces produced.

PRD acceptance criterion 4 requires the flag to be "visible on the load detail view," not just stored — Task 4 only wrote the column. This task is the other half.

- [ ] **Step 1: Map the new field**

Find (around line 194-212):

```typescript
  const load = {
    id: rawLoad.id as string,
    origin: rawLoad.origin as string,
    destination: rawLoad.destination as string,
    shipper: (rawLoad.shipper_name || "") as string,
    carrier: (rawLoad.carrier_name || "") as string,
    source: rawLoad.source as string,
    status: rawLoad.status as string,
    revenue: Number(rawLoad.revenue) || 0,
    carrierCost: Number(rawLoad.carrier_cost) || 0,
    margin: Number(rawLoad.margin) || 0,
    marginPercent: Number(rawLoad.margin_percent) || 0,
    pickupDate: (rawLoad.pickup_date || "") as string,
    deliveryDate: (rawLoad.delivery_date || "") as string,
    assignedRep: (rawLoad.assigned_rep || "") as string,
    equipment: (rawLoad.equipment || "") as string,
    weight: (rawLoad.weight || "") as string,
    riskFlag: rawLoad.risk_flag as boolean || false,
  }
```

Replace with:

```typescript
  const load = {
    id: rawLoad.id as string,
    origin: rawLoad.origin as string,
    destination: rawLoad.destination as string,
    shipper: (rawLoad.shipper_name || "") as string,
    carrier: (rawLoad.carrier_name || "") as string,
    source: rawLoad.source as string,
    status: rawLoad.status as string,
    revenue: Number(rawLoad.revenue) || 0,
    carrierCost: Number(rawLoad.carrier_cost) || 0,
    carrierCostEstimated: Boolean(rawLoad.carrier_cost_estimated) || false,
    margin: Number(rawLoad.margin) || 0,
    marginPercent: Number(rawLoad.margin_percent) || 0,
    pickupDate: (rawLoad.pickup_date || "") as string,
    deliveryDate: (rawLoad.delivery_date || "") as string,
    assignedRep: (rawLoad.assigned_rep || "") as string,
    equipment: (rawLoad.equipment || "") as string,
    weight: (rawLoad.weight || "") as string,
    riskFlag: rawLoad.risk_flag as boolean || false,
  }
```

- [ ] **Step 2: Add the visible flag next to Carrier Pay**

Find (around line 430-433):

```typescript
            <div className="text-center p-3 rounded-md bg-secondary/30">
              <p className="text-[10px] text-muted-foreground">Carrier Pay</p>
              <p className="text-lg font-semibold text-muted-foreground font-mono mt-0.5">{formatCurrency(load.carrierCost)}</p>
            </div>
```

Replace with:

```typescript
            <div className="text-center p-3 rounded-md bg-secondary/30">
              <p className="text-[10px] text-muted-foreground">
                Carrier Pay
                {load.carrierCostEstimated && (
                  <span className="ml-1 text-warning" title="No real carrier rate history — this is a fallback estimate, not a negotiated number. Margin below is not reliable until a real rate is captured.">
                    (est.)
                  </span>
                )}
              </p>
              <p className="text-lg font-semibold text-muted-foreground font-mono mt-0.5">{formatCurrency(load.carrierCost)}</p>
            </div>
```

Check this file's existing Tailwind theme tokens before using `text-warning` — grep for `text-warning` or `bg-warning` elsewhere in `components/` to confirm that token exists in this codebase's theme (`app/globals.css`). If it doesn't exist, use `text-amber-600 dark:text-amber-400` instead (a literal color, not a theme token) — either is fine, the point is a visually distinct, non-error color that draws the eye without alarming.

- [ ] **Step 3: Manual verification (no automated test for this component — check existing test coverage first)**

Run: `grep -rn "load-quick-view" __tests__/ 2>/dev/null`

If this returns any test files, read one to see its convention and add a case asserting the "(est.)" marker renders when `carrier_cost_estimated: true` is in the mock load data, and does not render when `false`/absent. If it returns nothing (no existing tests for this component — likely, since it's a `"use client"` presentational component with no test infra in this codebase's pattern so far), skip to Step 4; don't introduce a new component-testing setup (React Testing Library, etc.) for one field — that's disproportionate to this task and outside this plan's scope.

Run: `pnpm tsc --noEmit`
Expected: 0 new errors.

- [ ] **Step 4: Commit**

```bash
git add components/load-quick-view.tsx
git commit -m "E2-03 M0: surface carrier_cost_estimated on the load detail view (PRD acceptance criterion 4)"
```

---

## Final check — full M0 regression pass

- [ ] **Step 1: Run the complete new + existing dispatcher test surface**

Run: `pnpm vitest run __tests__/pipeline/dispatcher.test.ts __tests__/pipeline/dispatcher-prospect-gate.test.ts __tests__/pipeline/dispatcher-carrier-confirmation-gate.test.ts __tests__/pipeline/dispatcher-idempotency.test.ts __tests__/pipeline/dispatcher-cost-estimated-flag.test.ts`
Expected: all pass (6 tests total).

- [ ] **Step 2: Run the full pipeline suite to confirm zero regressions elsewhere**

Run: `pnpm vitest run __tests__/pipeline/ __tests__/loadboards/`
Expected: same pass count as before this plan, plus the 5 new tests from Tasks 2-4. (`ranker.test.ts`/`researcher.test.ts` timing out against live infra is a pre-existing, documented condition unrelated to this plan — not a regression.)

- [ ] **Step 3: `tsc` clean**

Run: `pnpm tsc --noEmit`
Expected: 0 new errors introduced by this plan's files.

- [ ] **Step 4: Manual staging check against a synthetic booked load (PRD acceptance criterion 1)**

This is the PRD's own acceptance criterion 1 ("Confirmed against a synthetic booked load in staging") — the automated tests above already cover this exact scenario (Task 2's test IS a synthetic booked load hitting the Dispatcher's active-carrier branch), so this step is satisfied by Step 1 passing. Note in your final report that criterion 1 is covered by test, not a separate manual click-through.

- [ ] **Step 5: Update the Engine 2 completion tracker**

Add a Change Log entry to `Engine 2/docs/superpowers/plans/completion.md` (or, if that file's structure doesn't yet have an E2-03 section, add one) summarizing: migration 041 applied + verified with the E2-01-dependency fix, M0's escalation gate shipped behind `CARRIER_AUTO_ASSIGN_ENABLED=false` (default off), idempotency guard closed, carrier_cost_estimated honesty flag shipped, AUTO_BOOK_PROFIT_THRESHOLD cleanup finished across all 4 remaining operational references. Note explicitly that M1 (schema) landed as part of this same pass since the PRD's own §6.6 note says it can, and that M2-M6 have not started.
