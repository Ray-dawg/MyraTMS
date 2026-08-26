# E2-03 M2 — Cascade State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `CarrierVoiceWorker`'s shadow-only "who I'd call first" computation into the real cascade state machine PRD §6.3 specifies — outcome-driven advance/retry/exhaust across the ranked carrier stack, server-side envelope enforcement already in place, per-carrier-phone lock actually held around a dial — proven by 12+ synthetic fixtures, still gated behind `CARRIER_CALLS_ENABLED` defaulting `false`.

**Architecture:** A new pure decision function (`decideCascadeAction`) takes an outcome + cascade position + retry count and returns what happens next (accept / advance / retry-same-at-+2h / exhausted) — no DB, no I/O, cheap to exhaustively unit-test. `carrier-voice-worker.ts`'s live-dial branch (currently a deliberate `throw`) is replaced with a real dial mirroring `voice-worker.ts`'s `dialRetell` pattern, gated by the existing per-carrier-phone lock. `retell-webhook.ts`'s carrier routing ladder is extended so every call-status a carrier call can come back with (not just `'completed'`) reaches cascade-aware handling, and on decline/unreachable it calls `decideCascadeAction` and re-enqueues `carrier-call-queue` (advance/retry) or escalates (exhausted) via the same Alert Center `exceptions` pattern M0 established. Cascade position/retry-count travel through the existing metadata pass-through (`RetellWebhookMetadata`) exactly like `briefId`/`retryCount` already do on the shipper side — no new migration.

**Tech Stack:** TypeScript, BullMQ (`carrier-call-queue`, already defined in `queues.ts`), ioredis locks (`lib/pipeline/carrier-locks.ts`, already built), Vitest, Neon (`lib/pipeline/db-adapter.ts`).

**Spec:** `Engine 2/E2-03_Engine2_SellSide_Expansion_PRD.md` §6.3 (cascade state machine), §6.5 (envelope, already implemented), §6.8 (test plan — 12+ fixtures), §6.9 (acceptance criteria), §13 Session 2 items 8–11.

## Global Constraints

- `CARRIER_CALLS_ENABLED` stays defaulting `false` in every env file touched — this plan builds the code path, it does not flip production behavior.
- Never touch `voice-worker.ts` or `processCallCompleted()`'s shipper-only columns — carrier calls write only `carrier_*` columns (established in the M1 session, migration 042).
- No new migration. Cascade state (position, retry count) is job-payload/webhook-metadata state, not persisted columns — `pipeline_loads.carrier_cascade_position` (migration 041) is reserved for "which position secured the booking," not in-progress cascade tracking.
- `carrier-call-queue` retry config stays `RETRY_NO_RETRY` (BullMQ-level retries off) — cascade retries are our own explicit re-enqueues with a payload, not BullMQ's attempt mechanism, exactly like the shipper side's `retryQueue.add(..., { delay })` pattern in `processNonConversation()`.
- Retell's `call_status` type in this codebase is `'completed' | 'failed' | 'no_answer' | 'busy' | 'voicemail'` (no literal `'disconnected'`) — PRD §6.3's "disconnected" maps to `call_status === 'failed'` for the carrier path (documented inline where mapped); `'busy'` is folded into the same retry-once bucket as voicemail/no_answer for the carrier cascade, consistent with how the shipper side's `processNonConversation()` already treats voicemail/no_answer/busy identically.

---

### Task 1: Pure cascade decision function

**Files:**
- Create: `lib/pipeline/carrier-cascade.ts`
- Test: `__tests__/pipeline/carrier-cascade.test.ts`

**Interfaces:**
- Produces: `decideCascadeAction(params: { outcome: CarrierCascadeOutcome; position: number; stackLength: number; voicemailRetryCount: number }): CascadeAction`, `CarrierCascadeOutcome = 'accept' | 'decline' | 'voicemail' | 'no_answer' | 'busy' | 'disconnected'`, `CascadeAction = { type: 'accept' } | { type: 'advance'; nextPosition: number } | { type: 'retry_same'; position: number; delayMs: number } | { type: 'exhausted' }`, `VOICEMAIL_RETRY_DELAY_MS` (exported constant, `2 * 60 * 60 * 1000`).

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/pipeline/carrier-cascade.test.ts
import { describe, it, expect } from 'vitest';
import { decideCascadeAction, VOICEMAIL_RETRY_DELAY_MS } from '@/lib/pipeline/carrier-cascade';

describe('decideCascadeAction (E2-03 M2 §6.3 pure state machine)', () => {
  it('accept at any position returns {type: accept}, no advance', () => {
    const r = decideCascadeAction({ outcome: 'accept', position: 2, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'accept' });
  });

  it('decline mid-stack advances to the next position', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 1, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'advance', nextPosition: 2 });
  });

  it('decline on the last position exhausts the cascade', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 4, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'exhausted' });
  });

  it('decline on a single-carrier stack (position 0 of 1) exhausts immediately', () => {
    const r = decideCascadeAction({ outcome: 'decline', position: 0, stackLength: 1, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'exhausted' });
  });

  it('voicemail on first attempt retries the same position at +2h', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 0, stackLength: 5, voicemailRetryCount: 0 });
    expect(r).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('voicemail after the retry has already been used advances instead of retrying again', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 0, stackLength: 5, voicemailRetryCount: 1 });
    expect(r).toEqual({ type: 'advance', nextPosition: 1 });
  });

  it('no_answer is treated identically to voicemail (retry once, per PRD §6.3)', () => {
    const first = decideCascadeAction({ outcome: 'no_answer', position: 2, stackLength: 5, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 2, delayMs: VOICEMAIL_RETRY_DELAY_MS });
    const second = decideCascadeAction({ outcome: 'no_answer', position: 2, stackLength: 5, voicemailRetryCount: 1 });
    expect(second).toEqual({ type: 'advance', nextPosition: 3 });
  });

  it('disconnected (mapped from call_status=failed) is treated identically to voicemail', () => {
    const first = decideCascadeAction({ outcome: 'disconnected', position: 0, stackLength: 3, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('busy is folded into the same retry-once bucket as voicemail/no_answer/disconnected', () => {
    const first = decideCascadeAction({ outcome: 'busy', position: 0, stackLength: 3, voicemailRetryCount: 0 });
    expect(first).toEqual({ type: 'retry_same', position: 0, delayMs: VOICEMAIL_RETRY_DELAY_MS });
  });

  it('an unreachable retry that lands on the last position exhausts rather than advancing out of bounds', () => {
    const r = decideCascadeAction({ outcome: 'voicemail', position: 4, stackLength: 5, voicemailRetryCount: 1 });
    expect(r).toEqual({ type: 'exhausted' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-cascade.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/carrier-cascade'`

- [ ] **Step 3: Implement**

```typescript
// lib/pipeline/carrier-cascade.ts
/**
 * E2-03 M2 §6.3 — pure cascade decision logic. Given a call outcome plus
 * where the cascade currently stands, decides what happens next. No DB, no
 * I/O — the webhook (which knows the stack + cascade position from Retell
 * metadata) and the worker's defensive out-of-bounds check both call this
 * as the single source of truth for cascade transitions, so the state
 * machine described in the PRD only exists in one place.
 */

export type CarrierCascadeOutcome =
  | 'accept'
  | 'decline'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'disconnected';

export type CascadeAction =
  | { type: 'accept' }
  | { type: 'advance'; nextPosition: number }
  | { type: 'retry_same'; position: number; delayMs: number }
  | { type: 'exhausted' };

export const VOICEMAIL_RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // +2h, per PRD §6.3

const UNREACHABLE_OUTCOMES = new Set<CarrierCascadeOutcome>([
  'voicemail',
  'no_answer',
  'busy',
  'disconnected',
]);

export function decideCascadeAction(params: {
  outcome: CarrierCascadeOutcome;
  position: number;
  stackLength: number;
  voicemailRetryCount: number;
}): CascadeAction {
  const { outcome, position, stackLength, voicemailRetryCount } = params;

  if (outcome === 'accept') {
    return { type: 'accept' };
  }

  if (UNREACHABLE_OUTCOMES.has(outcome) && voicemailRetryCount < 1) {
    return { type: 'retry_same', position, delayMs: VOICEMAIL_RETRY_DELAY_MS };
  }

  // Either a decline, or an unreachable outcome that already used its one
  // retry — both advance to the next position (or exhaust if there is none).
  const nextPosition = position + 1;
  if (nextPosition >= stackLength) {
    return { type: 'exhausted' };
  }
  return { type: 'advance', nextPosition };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-cascade.test.ts`
Expected: PASS (10/10)

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/carrier-cascade.ts __tests__/pipeline/carrier-cascade.test.ts
git commit -m "E2-03 M2: pure cascade decision function decideCascadeAction()"
```

---

### Task 2: Escalation helper (exhaustion → Alert Center)

**Files:**
- Modify: `lib/pipeline/carrier-cascade.ts` (add `escalateCascadeExhausted`)
- Test: `__tests__/pipeline/carrier-cascade.test.ts` (append)

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter` (Pattern B: `db.query<T>(text, params)`).
- Produces: `escalateCascadeExhausted(params: { pipelineLoadId: number; loadId: string; stack: string[]; originCity: string; originState: string; destinationCity: string; destinationState: string }): Promise<void>` — writes `pipeline_loads.stage='escalated'` + inserts one `exceptions` row (`type='carrier_cascade_exhausted'`), mirroring `dispatcher-worker.ts`'s `escalateCarrierConfirmation()` shape exactly (same 10-column INSERT).

- [ ] **Step 1: Write the failing test**

```typescript
// append to __tests__/pipeline/carrier-cascade.test.ts
import { db } from '@/lib/pipeline/db-adapter';
import { escalateCascadeExhausted } from '@/lib/pipeline/carrier-cascade';

describe('escalateCascadeExhausted (E2-03 M2 §6.3 exhaustion — Alert Center pattern)', () => {
  it('sets stage=escalated and inserts a visible exceptions row naming every carrier tried', async () => {
    const runId = Date.now();
    const loadId = `TEST-EXHAUST-${runId}`;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Exhaust Co', 'x@test.test', '+17055559999', 2400, 'CAD', 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [loadId],
    );
    const pipelineLoadId = ins.rows[0].id;
    const stack = [`car_a_${runId}`, `car_b_${runId}`, `car_c_${runId}`];

    try {
      await escalateCascadeExhausted({
        pipelineLoadId, loadId, stack,
        originCity: 'Toronto', originState: 'ON',
        destinationCity: 'Sudbury', destinationState: 'ON',
      });

      const loadRow = await db.query<{ stage: string }>(
        `SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
      );
      expect(loadRow.rows[0].stage).toBe('escalated');

      const exc = await db.query<{ type: string; detail: string; pipeline_load_id: number }>(
        `SELECT type, detail, pipeline_load_id FROM exceptions WHERE pipeline_load_id = $1`,
        [pipelineLoadId],
      );
      expect(exc.rows).toHaveLength(1);
      expect(exc.rows[0].type).toBe('carrier_cascade_exhausted');
      for (const carrierId of stack) {
        expect(exc.rows[0].detail).toContain(carrierId);
      }
    } finally {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-cascade.test.ts -t escalateCascadeExhausted`
Expected: FAIL — `escalateCascadeExhausted is not a function`

- [ ] **Step 3: Implement**

Append to `lib/pipeline/carrier-cascade.ts`:

```typescript
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

/**
 * Cascade exhaustion (all N ranked carriers declined or were unreachable
 * through their retry) escalates to a human — same Alert Center `exceptions`
 * pattern E2-03 M0's `escalateCarrierConfirmation()` established, so this
 * shows up in the same operator surface, not a new one.
 */
export async function escalateCascadeExhausted(params: {
  pipelineLoadId: number;
  loadId: string;
  stack: string[];
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
}): Promise<void> {
  const { pipelineLoadId, loadId, stack, originCity, originState, destinationCity, destinationState } = params;

  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [pipelineLoadId],
  );

  const title = `Carrier cascade exhausted: ${originCity}, ${originState} → ${destinationCity}, ${destinationState}`;
  const detail =
    `AI carrier calling exhausted the ranked stack (${stack.length} carrier${stack.length === 1 ? '' : 's'}: ` +
    `${stack.join(', ')}) — all declined or were unreachable through their voicemail retry. ` +
    `Secure a carrier for this load by phone.`;
  const suggestedAction = 'Secure a carrier by phone — the AI cascade tried every ranked carrier without success.';

  await db.query(
    `INSERT INTO exceptions (
       load_id, carrier_id, type, severity, title, detail,
       pipeline_load_id, source_module, suggested_action, sla_due_at
     ) VALUES (
       NULL, NULL, 'carrier_cascade_exhausted', 'high', $1, $2,
       $3, 'carrier_cascade_exhausted', $4, NOW() + INTERVAL '4 hours'
     )`,
    [title, detail, pipelineLoadId, suggestedAction],
  );

  logger.warn(
    `[CarrierCascade] Load ${pipelineLoadId} (${loadId}) escalated: cascade exhausted after ${stack.length} carriers`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-cascade.test.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/carrier-cascade.ts __tests__/pipeline/carrier-cascade.test.ts
git commit -m "E2-03 M2: escalateCascadeExhausted() — exhaustion writes a visible exceptions row"
```

---

### Task 3: Metadata plumbing for cascade state

**Files:**
- Modify: `lib/pipeline/retell-types.ts:64-83` (`RetellWebhookMetadata`), `lib/pipeline/retell-types.ts:244-259` (`CallMetadata`)

**Interfaces:**
- Produces: `RetellWebhookMetadata.cascadePosition?: number`, `.voicemailRetryCount?: number`, `.carrierId?: string`, `.stackLength?: number` (carrier-call-only fields, all optional so shipper calls — which never set them — are unaffected). `CallMetadata` gets the same four fields, all optional, populated by `extractCallMetadata()`.

- [ ] **Step 1: Extend `RetellWebhookMetadata`**

In `lib/pipeline/retell-types.ts`, inside the existing `RetellWebhookMetadata` interface (around line 64-83), add after `primaryCarrierPhone?: string;`:

```typescript
  // E2-03 M2 cascade state — set only on outbound_carrier calls; a shipper
  // call never sets these (voice-worker.ts's payload construction is
  // untouched by this plan).
  cascadePosition?: number;
  voicemailRetryCount?: number;
  carrierId?: string;
  stackLength?: number;
```

- [ ] **Step 2: Extend `CallMetadata`**

In the same file, inside `CallMetadata` (around line 244-259), add after `callType: 'outbound_shipper' | 'outbound_carrier';`:

```typescript
  cascadePosition?: number;
  voicemailRetryCount?: number;
  carrierId?: string;
  stackLength?: number;
```

- [ ] **Step 3: Wire `extractCallMetadata()` to surface the new fields**

In `lib/pipeline/retell-webhook.ts`, `extractCallMetadata()` (around line 789-811), add after the existing `callType:` line:

```typescript
    cascadePosition: (payload.metadata as any).cascadePosition,
    voicemailRetryCount: (payload.metadata as any).voicemailRetryCount,
    carrierId: (payload.metadata as any).carrierId,
    stackLength: (payload.metadata as any).stackLength,
```

- [ ] **Step 4: Typecheck**

Run: `cd MyraTMS && pnpm tsc --noEmit`
Expected: 0 new errors (pre-existing 2 test-file errors unrelated, per completion.md history, are fine).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/retell-types.ts lib/pipeline/retell-webhook.ts
git commit -m "E2-03 M2: thread cascade state (position/retryCount/carrierId/stackLength) through Retell metadata"
```

---

### Task 4: Webhook — cascade-aware carrier call routing

**Files:**
- Modify: `lib/pipeline/retell-webhook.ts:38-48` (queue init), `lib/pipeline/retell-webhook.ts:103-160` (routing ladder), `lib/pipeline/retell-webhook.ts:519-625` (`processCarrierCallCompleted` decline branch)
- Test: `__tests__/pipeline/retell-webhook-carrier-cascade.test.ts` (new)

**Interfaces:**
- Consumes: `decideCascadeAction`, `escalateCascadeExhausted` from `@/lib/pipeline/carrier-cascade` (Task 1/2); `CarrierCallCascadePayload` shape from `carrier-voice-worker.ts` (Task 5, but the payload shape — `pipelineLoadId, loadId, loadBoardSource, enqueuedAt, priority, cascadePosition?, voicemailRetryCount?` — is already fixed by `BaseJobPayload` + this task's additions, so this task can be built first).
- Produces: `processCarrierCallOutcome(payload, metadata): Promise<ProcessResult>` — the new handler for non-`'completed'` carrier call statuses; `enqueueCascadeStep(pipelineLoadId, loadId, loadBoardSource, action, stack, loadContext)` — private helper used by both the completed-decline path and the new handler.

- [ ] **Step 1: Add the carrier-call-queue init**

In `lib/pipeline/retell-webhook.ts`, after line 48 (`const retryQueue = new Queue('call-queue', { connection: redis });`):

```typescript
const carrierCallQueue = new Queue('carrier-call-queue', { connection: redis });
```

- [ ] **Step 2: Write the failing integration test**

```typescript
// __tests__/pipeline/retell-webhook-carrier-cascade.test.ts
/**
 * E2-03 M2 §6.8 — integration-level cascade fixtures. Each test posts a
 * synthetic Retell webhook payload (never a real HTTP call to Retell) and
 * asserts the resulting DB writes + carrier-call-queue enqueue. Complements
 * carrier-cascade.test.ts's pure unit tests with the actual wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { Queue } from 'bullmq';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { handleRetellWebhook } from '@/lib/pipeline/retell-webhook';
import crypto from 'crypto';

const RUN_ID = Date.now();
const WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || 'test-secret';

function signedRequest(body: object) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw + ts).digest('hex');
  return {
    text: async () => raw,
    headers: { 'x-retell-signature': `v=${ts},d=${digest}` },
  };
}

describe('carrier cascade — webhook integration (E2-03 M2 §6.8)', () => {
  let pipelineLoadId: number;
  const loadId = `TEST-WEBHOOK-CASCADE-${RUN_ID}`;
  const carriers = ['wc1', 'wc2', 'wc3'].map((s) => `${s}_${RUN_ID}`);
  const carrierCallQueue = new Queue('carrier-call-queue', { connection: redisConnection });
  const prevSecret = process.env.RETELL_WEBHOOK_SECRET;

  beforeEach(async () => {
    process.env.RETELL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, weight_lbs,
         distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
         posted_rate, posted_rate_currency, top_carrier_id, stage, agreed_rate, agreed_rate_currency, profit
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
         'Webhook Cascade Co', 'x@test.test', '+17055551234', 2400, 'CAD', $2, 'booked', 2200, 'CAD', 470
       ) RETURNING id`,
      [loadId, carriers[0]],
    );
    pipelineLoadId = ins.rows[0].id;
    for (let i = 0; i < carriers.length; i++) {
      await db.query(
        `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
           authority_status, insurance_status, insurance_expiry,
           liability_insurance, cargo_insurance, safety_rating,
           carrier_status, contact_phone, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
           750000, 100000, 'Not Rated', 'active', $5, NOW(), NOW())`,
        [carriers[i], LEGACY_DEFAULT_TENANT_ID, `Webhook Carrier ${i}`, `888${RUN_ID}${i}`, `+1555020${1000 + i}`],
      );
    }
  });

  afterEach(async () => {
    process.env.RETELL_WEBHOOK_SECRET = prevSecret;
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [carriers]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  function carrierPayload(overrides: Partial<any>) {
    return {
      call_id: `call_${RUN_ID}_${Math.random().toString(36).slice(2)}`,
      agent_id: 'agent_test',
      call_status: 'completed',
      from_number: '+15145551000',
      to_number: '+17055551234',
      duration_ms: 30000,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      transcript: '',
      recording_url: null,
      metadata: {
        pipelineLoadId,
        briefId: 1,
        persona: 'assertive',
        language: 'en',
        currency: 'CAD',
        callType: 'outbound_carrier',
        cascadePosition: 0,
        voicemailRetryCount: 0,
        carrierId: carriers[0],
        stackLength: carriers.length,
      },
      ...overrides,
    };
  }

  it('decline on carrier 1 of 3 re-enqueues carrier-call-queue at position 1', async () => {
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Sorry, we cannot cover that lane this week.' });
    const res = await handleRetellWebhook(signedRequest(payload));
    expect(res.status).toBe(200);

    const load = await db.query<{ carrier_call_outcome: string }>(
      `SELECT carrier_call_outcome FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('decline');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0)).toBeGreaterThan(
      (before.waiting ?? 0) + (before.delayed ?? 0),
    );
  }, 30_000);

  it('decline on the last carrier (position 2 of 3) exhausts and escalates, no re-enqueue', async () => {
    const payload = carrierPayload({
      transcript: 'No thanks.',
      metadata: {
        pipelineLoadId, briefId: 1, persona: 'assertive', language: 'en', currency: 'CAD',
        callType: 'outbound_carrier', cascadePosition: 2, voicemailRetryCount: 0,
        carrierId: carriers[2], stackLength: carriers.length,
      },
    });
    const before = await carrierCallQueue.getJobCounts();
    const res = await handleRetellWebhook(signedRequest(payload));
    expect(res.status).toBe(200);

    const load = await db.query<{ stage: string }>(
      `SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].stage).toBe('escalated');

    const exc = await db.query(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(exc.rows).toHaveLength(1);
    expect((exc.rows[0] as any).type).toBe('carrier_cascade_exhausted');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0));
  }, 30_000);

  it('voicemail on carrier 1 schedules a delayed retry at the same position, not an advance', async () => {
    const payload = carrierPayload({ call_status: 'voicemail', transcript: '' });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getDelayed();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.cascadePosition).toBe(0);
    expect(mine!.data.voicemailRetryCount).toBe(1);
  }, 30_000);

  it('no_answer after the retry is already used advances to the next position immediately (no delay)', async () => {
    const payload = carrierPayload({
      call_status: 'no_answer',
      metadata: {
        pipelineLoadId, briefId: 1, persona: 'assertive', language: 'en', currency: 'CAD',
        callType: 'outbound_carrier', cascadePosition: 0, voicemailRetryCount: 1,
        carrierId: carriers[0], stackLength: carriers.length,
      },
    });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getWaiting();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.cascadePosition).toBe(1);
    expect(mine!.data.voicemailRetryCount).toBe(0);
  }, 30_000);

  it('failed call_status (mapped to "disconnected") is retried once before advancing, same as voicemail', async () => {
    const payload = carrierPayload({ call_status: 'failed' });
    await handleRetellWebhook(signedRequest(payload));

    const jobs = await carrierCallQueue.getDelayed();
    const mine = jobs.find((j) => j.data.pipelineLoadId === pipelineLoadId);
    expect(mine).toBeDefined();
    expect(mine!.data.voicemailRetryCount).toBe(1);
  }, 30_000);

  it('accept within the envelope ceiling does not enqueue a cascade step (cascade ends)', async () => {
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Great, we agreed to $1800 for this load.' });
    await handleRetellWebhook(signedRequest(payload));

    const load = await db.query<{ carrier_call_outcome: string; carrier_agreed_rate: string }>(
      `SELECT carrier_call_outcome, carrier_agreed_rate FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('accept');
    expect(Number(load.rows[0].carrier_agreed_rate)).toBe(1800);

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0));
  }, 30_000);

  it('accept above the envelope ceiling is rewritten to escalated and does not enqueue a cascade step', async () => {
    // agreed_rate_currency CAD, agreed_rate 2200 → carrier ceiling well under
    // $2200; $2199 asked by the carrier exceeds any sane margin floor.
    const before = await carrierCallQueue.getJobCounts();
    const payload = carrierPayload({ transcript: 'Deal, we agreed to $2199 for the run.' });
    await handleRetellWebhook(signedRequest(payload));

    const load = await db.query<{ carrier_call_outcome: string }>(
      `SELECT carrier_call_outcome FROM pipeline_loads WHERE id = $1`, [pipelineLoadId],
    );
    expect(load.rows[0].carrier_call_outcome).toBe('escalated');

    const after = await carrierCallQueue.getJobCounts();
    expect((after.waiting ?? 0) + (after.delayed ?? 0)).toBe((before.waiting ?? 0) + (before.delayed ?? 0));
  }, 30_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/retell-webhook-carrier-cascade.test.ts`
Expected: FAIL — decline/voicemail/no_answer/failed cases either don't advance `carrier_call_outcome` correctly or don't enqueue (current code returns `carrier_status_unhandled` for anything but `'completed'`, and `'completed'`+decline never enqueues).

- [ ] **Step 4: Implement — routing ladder + decline branch + new handler**

Replace the carrier-routing block in `handleRetellWebhook` (lines ~121-142 of `lib/pipeline/retell-webhook.ts`):

```typescript
    if (metadata.callType === 'outbound_carrier') {
      // Every call_status a carrier call can come back with is cascade-aware
      // now (E2-03 M2 Session 2) — 'completed' still goes through the
      // envelope+transcript path, everything else (no_answer/voicemail/busy/
      // failed) goes through processCarrierCallOutcome(), which maps them to
      // decideCascadeAction() and either re-enqueues carrier-call-queue or
      // escalates on exhaustion. Nothing carrier-side falls through to the
      // shipper-only handlers below this branch.
      result =
        payload.call_status === 'completed'
          ? await processCarrierCallCompleted(payload, metadata)
          : await processCarrierCallOutcome(payload, metadata);
    } else if (payload.call_status === 'completed') {
```

Add a new function after `processCarrierCallCompleted` (after its closing brace, before the `processCallFailed` section, i.e. after line ~625):

```typescript
/**
 * Non-'completed' carrier call statuses (no_answer / voicemail / busy /
 * failed). Maps them onto decideCascadeAction()'s outcome vocabulary and
 * drives the cascade forward — this is the branch that didn't exist before
 * E2-03 M2 Session 2 (every such call previously fell through to
 * 'carrier_status_unhandled' and escalated immediately, per the whole-branch
 * review finding that shipped alongside M2 Foundation).
 */
export async function processCarrierCallOutcome(
  payload: RetellWebhookPayload,
  metadata: CallMetadata,
): Promise<ProcessResult> {
  const { pipelineLoadId } = metadata;

  const outcomeMap: Record<string, import('./carrier-cascade').CarrierCascadeOutcome> = {
    voicemail: 'voicemail',
    no_answer: 'no_answer',
    busy: 'busy',
    // No literal 'disconnected' call_status in this codebase's Retell
    // payload type — PRD §6.3's "disconnected" maps onto 'failed' (a call
    // that didn't complete), documented in the plan's Global Constraints.
    failed: 'disconnected',
  };
  const outcome = outcomeMap[payload.call_status];

  await db.query(
    `INSERT INTO agent_calls (
       pipeline_load_id, call_id, call_type, persona, language, currency,
       retell_call_id, retell_agent_id, phone_number_called,
       call_initiated_at, call_ended_at, duration_seconds,
       carrier_outcome, created_at
     ) VALUES (
       $1, $2, 'outbound_carrier', $3, $4, $5,
       $6, $7, $8,
       $9, NOW(), $10,
       $11, NOW()
     )`,
    [
      pipelineLoadId, payload.call_id, metadata.persona, metadata.language, metadata.currency,
      metadata.retellCallId, metadata.retellAgentId, metadata.toNumber,
      metadata.startTime, metadata.durationSeconds, outcome,
    ],
  );

  await db.query(
    `UPDATE pipeline_loads SET carrier_call_outcome = $2, updated_at = NOW() WHERE id = $1`,
    [pipelineLoadId, outcome],
  );

  return enqueueCascadeStep(payload, metadata, outcome);
}

/**
 * Shared by processCarrierCallCompleted()'s decline branch and
 * processCarrierCallOutcome() above. Reads cascade position/retry
 * count/stack length back out of the metadata the worker set when it
 * dialed, calls the pure decideCascadeAction(), and either re-enqueues
 * carrier-call-queue (advance/retry) or escalates (exhausted).
 */
async function enqueueCascadeStep(
  payload: RetellWebhookPayload,
  metadata: CallMetadata,
  outcome: import('./carrier-cascade').CarrierCascadeOutcome,
): Promise<ProcessResult> {
  const { decideCascadeAction, escalateCascadeExhausted } = await import('./carrier-cascade');
  const { pipelineLoadId, cascadePosition, voicemailRetryCount, stackLength } = metadata;

  if (cascadePosition === undefined || stackLength === undefined) {
    // Defensive — should never happen for a real carrier call, which the
    // worker always stamps with cascade metadata before dialing.
    return {
      success: false,
      pipelineLoadId,
      callId: payload.call_id,
      outcome,
      nextAction: 'escalate_human',
      error: 'Carrier call webhook missing cascade metadata (cascadePosition/stackLength)',
      timestamp: new Date(),
    };
  }

  const action = decideCascadeAction({
    outcome,
    position: cascadePosition,
    stackLength,
    voicemailRetryCount: voicemailRetryCount ?? 0,
  });

  if (action.type === 'accept') {
    // processCarrierCallCompleted() already handled the terminal write for
    // an accept before calling this helper — nothing left to enqueue.
    return {
      success: true, pipelineLoadId, callId: payload.call_id, outcome,
      nextAction: 'no_action', timestamp: new Date(),
    };
  }

  const loadRow = await db.query<{
    load_id: string; load_board_source: string;
    origin_city: string; origin_state: string; destination_city: string; destination_state: string;
  }>(
    `SELECT load_id, load_board_source, origin_city, origin_state, destination_city, destination_state
     FROM pipeline_loads WHERE id = $1`,
    [pipelineLoadId],
  );
  const load = loadRow.rows[0];

  if (action.type === 'exhausted') {
    const stackRow = await db.query<{ carrier_id: string }>(
      `SELECT carrier_id FROM match_results WHERE load_id = $1 ORDER BY match_score DESC LIMIT $2`,
      [load.load_id, stackLength],
    );
    await escalateCascadeExhausted({
      pipelineLoadId, loadId: load.load_id,
      stack: stackRow.rows.map((r) => r.carrier_id),
      originCity: load.origin_city, originState: load.origin_state,
      destinationCity: load.destination_city, destinationState: load.destination_state,
    });
    return {
      success: true, pipelineLoadId, callId: payload.call_id, outcome,
      nextAction: 'escalate_human',
      details: { cascadeExhausted: true },
      timestamp: new Date(),
    };
  }

  const nextPosition = action.type === 'advance' ? action.nextPosition : action.position;
  const nextRetryCount = action.type === 'retry_same' ? (voicemailRetryCount ?? 0) + 1 : 0;
  const jobOptions = action.type === 'retry_same' ? { delay: action.delayMs } : {};

  await carrierCallQueue.add(
    'cascade-step',
    {
      pipelineLoadId,
      loadId: load.load_id,
      loadBoardSource: load.load_board_source,
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      cascadePosition: nextPosition,
      voicemailRetryCount: nextRetryCount,
    },
    jobOptions,
  );

  return {
    success: true, pipelineLoadId, callId: payload.call_id, outcome,
    nextAction: action.type === 'retry_same' ? 'retry_later' : 'no_action',
    details: { cascadeAction: action.type, nextPosition, nextRetryCount },
    timestamp: new Date(),
  };
}
```

Now update `processCarrierCallCompleted()`'s decline branch (the `'accept' | 'decline' | 'voicemail' | 'no_answer' | 'disconnected' | 'escalated'` union already includes `'decline'` as a possibility from `parseCarrierTranscript`). Immediately before its `return { success: true, ... }` (around line 601 in the original), replace the return with:

```typescript
    if (finalOutcome === 'decline') {
      return enqueueCascadeStep(payload, metadata, 'decline');
    }

    return {
      success: true,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: finalOutcome,
      nextAction: finalOutcome === 'accept' ? 'send_confirmation' : finalOutcome === 'escalated' ? 'escalate_human' : 'no_action',
      details: { carrierOutcome: finalOutcome, carrierAgreedRate: finalOutcome === 'accept' ? parsed.agreedRate : null },
      timestamp: new Date(),
    };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/retell-webhook-carrier-cascade.test.ts`
Expected: PASS (7/7)

- [ ] **Step 6: Run the full pipeline + loadboards suite to check no regression**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/ __tests__/loadboards/`
Expected: same pass count as before this task plus the new files, modulo the two pre-existing environmental timeouts (`ranker.test.ts`, `researcher.test.ts`) already documented in `completion.md`.

- [ ] **Step 7: Commit**

```bash
git add lib/pipeline/retell-webhook.ts __tests__/pipeline/retell-webhook-carrier-cascade.test.ts
git commit -m "E2-03 M2: webhook drives the cascade — decline/voicemail/no_answer/failed advance or retry, exhaustion escalates"
```

---

### Task 5: Worker — real dial + per-carrier-phone lock call site

**Files:**
- Modify: `lib/workers/carrier-voice-worker.ts`
- Modify: `__tests__/pipeline/carrier-voice-worker.test.ts` (extend; the existing "live mode throws" test is replaced since the throw is now gone)

**Interfaces:**
- Consumes: `acquireCarrierPhoneLock`, `releaseCarrierPhoneLock` from `@/lib/pipeline/carrier-locks` (already imported, just unused — this task is exactly what gives them a call site); `RetellCreatePhoneCallPayload`-shaped fetch, mirroring `voice-worker.ts`'s `dialRetell`.
- Produces: `CarrierCallCascadePayload` gains `cascadePosition?: number` and `voicemailRetryCount?: number` (both default to `0` when absent — the first dial in a fresh cascade).

- [ ] **Step 1: Write the failing tests**

Replace the existing "live mode (carrierCallsEnabled: true) throws" test in `__tests__/pipeline/carrier-voice-worker.test.ts` (lines 157-171) with:

```typescript
  it('live mode dials the carrier at cascadePosition (default 0) via Retell, holding the per-carrier-phone lock', async () => {
    mockServer.removeAllListeners('request');
    let received: any = null;
    mockServer.on('request', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ call_id: 'call_test_live_1' }));
      });
    });

    const worker = new CarrierVoiceWorker(redisConnection, {
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5,
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.callId).toBe('call_test_live_1');
    expect(result.details?.carrierId).toBe(CARRIERS[0]);
    expect(received.metadata.callType).toBe('outbound_carrier');
    expect(received.metadata.cascadePosition).toBe(0);
    expect(received.metadata.voicemailRetryCount).toBe(0);
    expect(received.metadata.carrierId).toBe(CARRIERS[0]);
    expect(received.metadata.stackLength).toBe(CARRIERS.length);

    const agentCallRow = await db.query<{ carrier_outcome: string }>(
      `SELECT carrier_outcome FROM agent_calls WHERE pipeline_load_id = $1 AND call_id = $2`,
      [pipelineLoadId, 'call_test_live_1'],
    );
    expect(agentCallRow.rows[0].carrier_outcome).toBe('in_progress');

    // Lock should be released again now the dial attempt finished.
    const { acquireCarrierPhoneLock, releaseCarrierPhoneLock } = await import('@/lib/pipeline/carrier-locks');
    const token = await acquireCarrierPhoneLock(`+1555010${1000}`, 1000);
    expect(token).not.toBeNull();
    if (token) await releaseCarrierPhoneLock(`+1555010${1000}`, token);

    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1 AND call_id = $2`, [pipelineLoadId, 'call_test_live_1']);
  }, 30_000);

  it('live mode at a later cascadePosition dials that carrier, not the top of the stack', async () => {
    mockServer.removeAllListeners('request');
    let received: any = null;
    mockServer.on('request', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ call_id: 'call_test_live_2' }));
      });
    });

    const worker = new CarrierVoiceWorker(redisConnection, {
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5, cascadePosition: 2, voicemailRetryCount: 1,
    };

    const result = await worker.process(payload);
    expect(result.details?.carrierId).toBe(CARRIERS[2]);
    expect(received.metadata.cascadePosition).toBe(2);
    expect(received.metadata.voicemailRetryCount).toBe(1);

    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1 AND call_id = $2`, [pipelineLoadId, 'call_test_live_2']);
  }, 30_000);

  it('live mode at a cascadePosition past the stack length escalates immediately instead of dialing (defensive out-of-bounds)', async () => {
    mockServer.removeAllListeners('request');
    let requestReceived = false;
    mockServer.on('request', (req, res) => {
      requestReceived = true;
      res.writeHead(500).end();
    });

    const worker = new CarrierVoiceWorker(redisConnection, {
      retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
    });
    const payload: CarrierCallCascadePayload = {
      pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(), priority: 5, cascadePosition: 99, voicemailRetryCount: 0,
    };

    const result = await worker.process(payload);
    expect(requestReceived).toBe(false);
    expect(result.details?.cascadeExhausted).toBe(true);

    const load = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(load.rows[0].stage).toBe('escalated');
    // Restore for subsequent tests in this file that assume stage='booked'.
    await db.query(`UPDATE pipeline_loads SET stage = 'booked' WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = $1`, [pipelineLoadId]);
  }, 30_000);

  it('a held per-carrier-phone lock blocks a live dial to that carrier — blocked, not raced (PRD §6.9 acceptance criterion 5)', async () => {
    mockServer.removeAllListeners('request');
    let requestReceived = false;
    mockServer.on('request', (req, res) => {
      requestReceived = true;
      res.writeHead(500).end();
    });

    const { acquireCarrierPhoneLock, releaseCarrierPhoneLock } = await import('@/lib/pipeline/carrier-locks');
    const carrier0Phone = `+1555010${1000}`;
    const heldToken = await acquireCarrierPhoneLock(carrier0Phone, 5000);
    expect(heldToken).not.toBeNull();

    try {
      const worker = new CarrierVoiceWorker(redisConnection, {
        retellBaseUrl: mockUrl, carrierCallsEnabled: true, retellApiKey: 'test-key',
      });
      const payload: CarrierCallCascadePayload = {
        pipelineLoadId, loadId: TEST_LOAD_ID, loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(), priority: 5,
      };
      const result = await worker.process(payload);
      expect(requestReceived).toBe(false);
      expect(result.details?.skipped).toBe(true);
      expect(result.details?.reason).toBe('carrier_phone_locked');
    } finally {
      if (heldToken) await releaseCarrierPhoneLock(carrier0Phone, heldToken);
    }
  }, 30_000);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-voice-worker.test.ts`
Expected: FAIL — current `process()` throws unconditionally in live mode, so the first three new tests get a rejected promise instead of a result, and the phone-lock test never gets exercised because the throw fires first.

- [ ] **Step 3: Implement — replace the live-mode branch**

In `lib/workers/carrier-voice-worker.ts`, replace the whole live-mode block (from the `if (!this.carrierCallsEnabled) { ... }` shadow block's closing brace through the `throw new Error(...)` and the `finally` — i.e. everything from where the shadow-mode early-return ends to the end of `process()`'s try block) with:

```typescript
      const position = payload.cascadePosition ?? 0;
      const voicemailRetryCount = payload.voicemailRetryCount ?? 0;

      if (!this.carrierCallsEnabled) {
        logger.info(
          `[CarrierVoice] CARRIER_CALLS_ENABLED=false — shadow mode for load ${pipelineLoadId}. ` +
          `Stack: [${stack.join(', ')}]. Would call: ${stack[0]}`,
        );
        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: {
            shadowMode: true,
            cascadeStack: stack,
            wouldCallCarrierId: stack[0],
          },
        };
      }

      // Defensive out-of-bounds check: the webhook's decideCascadeAction()
      // never re-enqueues past the last position (it returns 'exhausted'
      // instead), so this should be unreachable in normal operation. It's
      // here so a bad re-enqueue fails visibly (escalates) rather than
      // dialing undefined or crashing on stack[position].
      if (position >= stack.length) {
        const { escalateCascadeExhausted } = await import('@/lib/pipeline/carrier-cascade');
        const loadRow = await db.query<{
          origin_city: string; origin_state: string; destination_city: string; destination_state: string;
        }>(
          `SELECT origin_city, origin_state, destination_city, destination_state FROM pipeline_loads WHERE id = $1`,
          [pipelineLoadId],
        );
        const l = loadRow.rows[0];
        await escalateCascadeExhausted({
          pipelineLoadId, loadId, stack,
          originCity: l?.origin_city ?? '', originState: l?.origin_state ?? '',
          destinationCity: l?.destination_city ?? '', destinationState: l?.destination_state ?? '',
        });
        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: { cascadeExhausted: true, position, stackLength: stack.length },
        };
      }

      const carrierId = stack[position];
      const carrierRow = await db.query<{ contact_phone: string | null }>(
        `SELECT contact_phone FROM carriers WHERE id = $1`,
        [carrierId],
      );
      const carrierPhone = carrierRow.rows[0]?.contact_phone ?? null;
      if (!carrierPhone) {
        logger.warn(`[CarrierVoice] Carrier ${carrierId} has no contact_phone — cannot dial`);
        return this.skipResult(pipelineLoadId, 'carrier_no_phone');
      }

      const phoneLockToken = await acquireCarrierPhoneLock(carrierPhone);
      if (!phoneLockToken) {
        logger.warn(
          `[CarrierVoice] Carrier ${carrierId} (${logger.maskPhone(carrierPhone)}) is already being dialed on another load's cascade — skipping`,
        );
        return this.skipResult(pipelineLoadId, 'carrier_phone_locked');
      }

      try {
        const callId = await this.dialRetell({
          to_number: carrierPhone,
          metadata: {
            pipelineLoadId,
            callType: 'outbound_carrier',
            cascadePosition: position,
            voicemailRetryCount,
            carrierId,
            stackLength: stack.length,
          },
        });

        await db.query(
          `INSERT INTO agent_calls (
             pipeline_load_id, call_id, call_type, retell_call_id, phone_number_called,
             call_initiated_at, carrier_outcome, created_at
           ) VALUES ($1, $2, 'outbound_carrier', $3, $4, NOW(), 'in_progress', NOW())`,
          [pipelineLoadId, callId, callId, carrierPhone],
        );

        logger.info(
          `[CarrierVoice] Carrier call initiated for load ${pipelineLoadId}, carrier ${carrierId} ` +
          `(position ${position}/${stack.length}). retell_call_id=${callId}`,
        );

        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: { callId, carrierId, position, stackLength: stack.length },
        };
      } finally {
        // TTL-based expiry (5 min, carrier-locks.ts default) is the real
        // release mechanism for the duration of the actual call — the
        // webhook resolving the outcome runs in a separate request/process
        // later and doesn't hold this function's lock token, so it can't
        // call releaseCarrierPhoneLock() explicitly. Releasing here too
        // (immediately after the dial *attempt* returns, not after the call
        // itself ends) only protects the synchronous dial-request window;
        // the TTL is what actually prevents a double-dial for the minutes
        // the real conversation is in progress.
        await releaseCarrierPhoneLock(carrierPhone, phoneLockToken);
      }
```

Add a `dialRetell` private method (mirroring `voice-worker.ts`'s, simplified to the fields this worker needs) right after `fetchCascadeStack`:

```typescript
  private async dialRetell(payload: {
    to_number: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const res = await fetch(`${this.retellBaseUrl}/v2/create-phone-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.retellApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unparseable>');
      throw new Error(`Retell create-phone-call ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { call_id?: string };
    if (!data.call_id) {
      throw new Error(`Retell response missing call_id: ${JSON.stringify(data)}`);
    }
    return data.call_id;
  }
```

Extend `CarrierCallCascadePayload`:

```typescript
export interface CarrierCallCascadePayload extends BaseJobPayload {
  cascadePosition?: number;
  voicemailRetryCount?: number;
}
```

Update the file-header JSDoc block's "SHADOW-ONLY IN THIS PLAN'S SCOPE" paragraph to reflect that live dialing now exists behind the flag (replace the sentence describing the throw with one describing the real dial + lock), and delete the now-stale inline comment above `nextStage: undefined` that says "This worker doesn't override updatePipelineLoad... nothing to persist yet" — replace with a note that the `agent_calls` insert now happens directly in `process()` (matching the pattern this comment already anticipates from `voice-worker.ts`, but here because `nextStage` intentionally stays `undefined` — carrier dial attempts never change `pipeline_loads.stage`, only exhaustion/webhook outcomes do).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd MyraTMS && pnpm vitest run __tests__/pipeline/carrier-voice-worker.test.ts`
Expected: PASS (all — the 7 pre-existing + 4 new = 11)

- [ ] **Step 5: Typecheck + full pipeline suite**

Run: `cd MyraTMS && pnpm tsc --noEmit && pnpm vitest run __tests__/pipeline/ __tests__/loadboards/`
Expected: tsc clean; same baseline pass count plus new tests, modulo the two pre-existing environmental timeouts.

- [ ] **Step 6: Commit**

```bash
git add lib/workers/carrier-voice-worker.ts __tests__/pipeline/carrier-voice-worker.test.ts
git commit -m "E2-03 M2: real cascade dial + per-carrier-phone lock call site, still CARRIER_CALLS_ENABLED-gated"
```

---

### Task 6: Queue doc accuracy + completion tracker

**Files:**
- Modify: `lib/pipeline/queues.ts:236-252` (`CARRIER_CALL_QUEUE_CONFIG`)
- Modify: `Engine 2/docs/superpowers/plans/completion.md` (append session entry, per the standing "keep this in sync, don't batch" convention)

- [ ] **Step 1: Update queue doc fields to match reality**

In `lib/pipeline/queues.ts`, `CARRIER_CALL_QUEUE_CONFIG` (lines 236-252):

```typescript
export const CARRIER_CALL_QUEUE_CONFIG: QueueConfig = {
  queueName: 'carrier-call-queue',
  description:
    'Dispatch One (E2-03 M2) via Retell AI — cascades outbound carrier calls through the ranked stack; shadow-gated by CARRIER_CALLS_ENABLED',
  concurrency: 5,
  retryConfig: RETRY_NO_RETRY,
  priority: true,
  delayable: true, // cascade-step re-enqueues use { delay } for the +2h voicemail retry (E2-03 M2 §6.3)
  defaultJobOptions: {
    attempts: RETRY_NO_RETRY.attempts,
    removeOnComplete: {
      age: 86400,
    },
    removeOnFail: {
      age: 604800,
    },
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `cd MyraTMS && pnpm tsc --noEmit`
Expected: 0 new errors.

- [ ] **Step 3: Append the completion.md session entry**

Append a new bullet under the existing 2026-08-25 M2 Foundation entry in `Engine 2/docs/superpowers/plans/completion.md`, following that file's established format (date — bold headline — prose paragraph covering what shipped, what was found/fixed, what's still open). Content: cascade state machine built (`decideCascadeAction` pure function + `escalateCascadeExhausted`), webhook routing extended to handle every carrier call_status (not just completed), decline path now drives the cascade instead of dead-ending, real dial + per-carrier-phone lock call site added to `carrier-voice-worker.ts` (still `CARRIER_CALLS_ENABLED`-gated, defaults false), N synthetic fixtures added (report the actual final count across all three test files once Steps 1-5 of Tasks 1-5 are done — must be ≥12 net-new beyond the 7 pre-existing shadow-mode tests). Note explicitly what's still open per the PRD: Session 3's M4 wiring (already done per prior session per the user's own recap — cross-check against completion.md before writing "not started"), Session 4's shadow drain + founder sign-off + first real carrier call (blocking on `CARRIER_CALLS_ENABLED` ever flipping true — still nobody's flipped it), Session 5's M5/M6 remainder.

- [ ] **Step 4: Commit**

```bash
git add lib/pipeline/queues.ts "Engine 2/docs/superpowers/plans/completion.md"
git commit -m "E2-03 M2: queue doc accuracy (delayable) + completion tracker entry for cascade state machine session"
```

---

## Self-Review Notes (already applied above, kept for the record)

- **Spec coverage:** §6.3 cascade table → Task 1 (pure decision) + Task 4 (webhook wiring) + Task 5 (worker dial). §6.5 envelope → already implemented pre-session, exercised by Task 4's Step 2 tests (accept-within/above-ceiling). §6.7 webhook branch → already implemented pre-session; Task 4 extends it. §6.8 test plan's 6 named cases → covered across Task 1 (accept, decline-advance, decline-exhaust, voicemail-retry) + Task 4 (decline re-enqueue/exhaust/envelope, integration-level) + Task 5 (concurrent-dial lock, live). §6.9 acceptance criteria 1 (12+ fixtures) → 10 (Task 1) + 1 (Task 2) + 7 (Task 4) + 4 new (Task 5) = 22 net-new, well past 12; criterion 5 (phone lock blocks) → Task 5's dedicated test.
- **Out of scope, confirmed intentionally:** §6.9 criteria 2-4 (shadow drain against ≥20 real booked loads, founder sign-off, one real validated call) are Session 4 per the PRD's own sequencing — this plan is Session 2 only. M4 (authority-lookup wiring) and M6 (independent kill switch) are reported by the user as already done in a prior session; this plan doesn't touch them and Task 6 Step 3 should cross-check completion.md rather than assume.
- **Placeholder scan:** no TBD/TODO markers; every step has literal code.
