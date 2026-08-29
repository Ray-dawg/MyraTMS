# T-23 Dispatch & Load Lifecycle Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the lifecycle-event layer, `carrier_acceptance_state`/`dispatch_routing_rules` tables, the late-load detection view, the acceptance-gap measurement report, and 5 read/routing API endpoints from T-23 §4–§6 — purely observational, zero changes to `dispatcher-worker.ts` or `lib/dispatch-gate.ts`'s live behavior.

**Architecture:** Extends T-17's existing `events` table via new triggers on `loads` and `location_pings` (not a new parallel table, per spec §2). `carrier_acceptance_state` and `dispatch_routing_rules` are new, additive tables built on T-19's `tenant_policies`/`fn_myra_tenant_id()` and T-20's `carrier_registry`. A backfill script seeds `carrier_acceptance_state` for loads dispatched before this migration existed; the acceptance-gap report script is the module's key deliverable — a real number, not a placeholder.

**Tech Stack:** PostgreSQL (Neon), TypeScript, Next.js API routes, `db.query<T>()` via `@/lib/pipeline/db-adapter`, Vitest.

**Spec:** `Engine 3/T23_Dispatch_Lifecycle_Monitor.md`

## Global Constraints

- **Zero changes to `lib/workers/dispatcher-worker.ts` or `lib/dispatch-gate.ts`** — acceptance criterion 5. Every event/state row in this plan comes from a trigger observing a write those files already make.
- **Migration numbering:** next free number is `053` (highest existing is `052-t22-objection-playbook.sql`).
- **Schema-reality correction #1 — the spec's central premise is narrower than stated.** T-23 §1 claims dispatch has *no* carrier-acceptance step at all. That was true when the spec was drafted (2026-08-22) but **migrations `049`/`051` (2026-08-26, E2-04 M6/F1) already added one**: `loads.carrier_signature_received_at` / `carrier_signature_method` (`'email_verified'` | `'manual_ops'`) / `carrier_signature_confirmed_by`, gating an AI-cascade load's move to `'Dispatched'` behind a signed rate-con (`lib/dispatch-gate.ts`'s `runAiCascadeDispatchGate()`). The real, still-open gap is narrower: (a) **manual (non-pipeline) assignments** via `/api/loads/[id]/assign` never run this gate at all and flip straight to `'Dispatched'` with zero confirmation tracking, and (b) an AI-cascade load whose signature SLA lapses. `carrier_acceptance_state` must report the real split, not assume 100% unconfirmed — that's what makes the measurement report in Task 6 meaningful instead of a foregone conclusion.
- **Schema-reality correction #2 — `events.entity_id`/`events.derived_from_id` are `INTEGER` (T-17), but `loads.id` is `TEXT`.** Every new trigger that derives from `loads` is scoped to pipeline-linked loads only (`WHEN NEW.pipeline_load_id IS NOT NULL`) and uses `NEW.pipeline_load_id` — the same integer identity T-17's own `pipeline_loads`-derived events already key on — for `entity_id`, `derived_from_id`, and the `pipeline_load_id` column alike, rather than widening the shared `events` table's column types. Manual (non-pipeline) loads produce no lifecycle events under this migration: an explicit scoping decision (T-10's Dispatcher, the module T-23 investigates, only ever touches pipeline-linked loads), not an oversight. `derived_from_id` therefore does **not** mean "the id of the row in `derived_from_table`" for these rows the way it does for T-17/T-20's triggers — it means "the `pipeline_loads.id` this load write is linked to." Documented once here and once in the migration file; don't re-derive it differently in a future module.
- **Schema-reality correction #3 — `load.delivered` needs zero new code.** T-17's existing `fn_events_from_pipeline_loads()`/`fn_stage_event_type()` already emits `load.delivered` the moment `advanceDeliveredLoads()` (`dispatcher-worker.ts:506`) flips `pipeline_loads.stage` to `'delivered'`. Task 1 does not add a trigger for it — the view in Task 1 just reads the event T-17 already writes.
- **Schema-reality correction #4 — `load.pickup_checked_in` derives from `loads.status` transitioning to `'In Transit'`**, not from `check_calls`. `check_calls.status` is dispatcher free text with no structured pickup/enroute/delivery distinction — using it would mean guessing a mapping the spec doesn't define, the same class of guess migration `044`'s header explicitly refused to make for the carrier acceptance-rate-delta trigger. `loads_status_check`'s own enum order (`Booked → Awaiting Signature → Dispatched → In Transit → Delivered`) already encodes "picked up and en route" at `'In Transit'` — an unambiguous, already-live signal.
- **`carrier_acceptance_state` has no `tenant_id` column.** Like `carrier_registry` (044) and `objection_playbook` (052), its only FKs (`pipeline_loads`, `carrier_registry`) are currently Myra-only; adding an unused column ahead of a real second tenant would be speculative.
- **This codebase has no "cancelled" load status.** `loads_status_check` is `Booked | Awaiting Signature | Dispatched | In Transit | Delivered | Invoiced | Closed` — no cancellation state exists anywhere in the schema. Task 6's report measures carrier substitution (a second `carrier_acceptance_state` row for the same `pipeline_load_id`) and late pickup, and says so plainly rather than fabricating a cancellation metric the schema can't support.
- Money/DB conventions: `db.query<T>(text, params)` via `@/lib/pipeline/db-adapter` (Neon `sql.query`, not the tagged-template form) — same as every Engine 2/3 module to date.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/053-t23-dispatch-lifecycle-monitor.sql` | `carrier_acceptance_state`, `dispatch_routing_rules`, `v_lifecycle_late_loads`, 2 new triggers (`loads`, `location_pings`) |
| `scripts/t23_backfill_carrier_acceptance_state.ts` | Seeds `carrier_acceptance_state` for loads dispatched before this migration existed |
| `scripts/t23_acceptance_gap_report.ts` | The measurement report (spec §5) — required deliverable |
| `lib/dispatch/routing.ts` | `resolveDispatchRouting(tenantId)`, `setDispatchRoutingOverride(...)` |
| `app/api/lifecycle/load/[pipelineLoadId]/route.ts` | `GET` full event timeline |
| `app/api/lifecycle/late/route.ts` | `GET ?tenant_id=` |
| `app/api/lifecycle/acceptance-gap-report/route.ts` | `GET ?since=` |
| `app/api/dispatch/routing/[tenantId]/route.ts` | `GET` / `POST` |

---

### Task 1: Migration — tables, triggers, view

**Files:**
- Create: `scripts/053-t23-dispatch-lifecycle-monitor.sql`
- Test: `__tests__/lifecycle/t23-triggers.test.ts`

**Interfaces:**
- Consumes: `fn_myra_tenant_id()` (035), `fn_insert_event()` (033/035), `carriers.carrier_registry_id` (044), `loads.{carrier_id,status,pod_url,rate_con_send_status,rate_con_sent_at,carrier_signature_received_at,carrier_signature_method,carrier_signature_confirmed_by,pipeline_load_id}` (001/010/043/049/051/pipeline_migrations), `location_pings.{load_id,lat,lng,speed_mph}` (010).
- Produces: `carrier_acceptance_state`, `dispatch_routing_rules`, `v_lifecycle_late_loads` — consumed by Tasks 2–5.

- [ ] **Step 1: Write the migration**

```sql
-- 053: T-23 Dispatch & Load Lifecycle Monitor
-- Engine 3 Phase 2, Module 4. See Engine 3/T23_Dispatch_Lifecycle_Monitor.md.
--
-- Schema-reality corrections vs. the base spec (same discipline as
-- 035/044/045/052 — see this plan's Global Constraints for the full
-- reasoning, not repeated here):
--   1. Carrier acceptance already has a real (if narrower-than-assumed)
--      confirmation signal for AI-cascade loads: loads.carrier_signature_
--      received_at/_method/_confirmed_by (049/051), gated by
--      lib/dispatch-gate.ts. carrier_acceptance_state reports the real
--      split instead of assuming 100% unconfirmed.
--   2. events.entity_id/derived_from_id are INTEGER; loads.id is TEXT. Every
--      trigger below deriving from `loads` is scoped to pipeline-linked
--      loads (WHEN NEW.pipeline_load_id IS NOT NULL) and uses
--      NEW.pipeline_load_id for entity_id/derived_from_id/pipeline_load_id
--      alike -- NOT loads.id. Manual (non-pipeline) loads produce no
--      lifecycle events under this migration.
--   3. load.delivered needs no new trigger -- T-17's existing
--      fn_events_from_pipeline_loads()/fn_stage_event_type() already emits
--      it when pipeline_loads.stage -> 'delivered'.
--   4. load.pickup_checked_in derives from loads.status -> 'In Transit',
--      not check_calls (no structured pickup/enroute distinction exists
--      there -- flagged, not guessed, same discipline as migration 044).
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS
-- throughout. Zero changes to dispatcher-worker.ts, dispatch-gate.ts, or
-- any existing table's write path.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_myra_tenant_id') THEN
        RAISE EXCEPTION 'fn_myra_tenant_id() not found — migration 035 (T-19) must be applied first';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'carriers' AND column_name = 'carrier_registry_id'
    ) THEN
        RAISE EXCEPTION 'carriers.carrier_registry_id not found — migration 044 (T-20) must be applied first';
    END IF;
END $$;

-- ============================================================
-- 1. carrier_acceptance_state — the missing state, made explicit
-- ============================================================
CREATE TABLE IF NOT EXISTS carrier_acceptance_state (
    id                    SERIAL PRIMARY KEY,
    pipeline_load_id      INTEGER NOT NULL REFERENCES pipeline_loads(id) ON DELETE CASCADE,
    carrier_registry_id   INTEGER REFERENCES carrier_registry(id) ON DELETE SET NULL,

    assigned_at           TIMESTAMP NOT NULL,
    confirmation_method   VARCHAR(30),   -- 'dispatch_one_negotiation' | 'manual_call' | 'rate_con_signed' | 'assumed_unconfirmed'
    confirmed_at          TIMESTAMP,     -- NULL = never confirmed
    confirmation_source   VARCHAR(40),

    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_acceptance_unconfirmed ON carrier_acceptance_state(pipeline_load_id) WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_acceptance_load ON carrier_acceptance_state(pipeline_load_id);

-- ============================================================
-- 2. dispatch_routing_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch_routing_rules (
    id             SERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mode           VARCHAR(20) NOT NULL CHECK (mode IN ('myra_managed', 'in_house_notify')),
    notify_contact VARCHAR(200),
    is_active      BOOLEAN DEFAULT true,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id)
);

INSERT INTO dispatch_routing_rules (tenant_id, mode)
SELECT fn_myra_tenant_id(), 'myra_managed'
WHERE NOT EXISTS (SELECT 1 FROM dispatch_routing_rules WHERE tenant_id = fn_myra_tenant_id());

-- ============================================================
-- 3. Trigger: lifecycle events + acceptance-state from `loads`
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_events_from_loads() RETURNS TRIGGER AS $$
DECLARE
    v_registry_id INTEGER;
BEGIN
    IF NEW.pipeline_load_id IS NULL THEN
        RETURN NEW; -- manual/non-pipeline load — out of scope, see migration header note 2
    END IF;

    -- load.carrier_assigned + carrier_acceptance_state seed row (one per
    -- assignment; a reassignment to a different carrier gets its own row —
    -- see the report script's "reassigned" metric).
    IF NEW.carrier_id IS DISTINCT FROM OLD.carrier_id AND NEW.carrier_id IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.carrier_assigned', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id, 'carrier_id', NEW.carrier_id),
            NULL, NULL, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );

        SELECT carrier_registry_id INTO v_registry_id FROM carriers WHERE id = NEW.carrier_id;
        INSERT INTO carrier_acceptance_state (pipeline_load_id, carrier_registry_id, assigned_at, confirmation_method, confirmed_at)
        VALUES (NEW.pipeline_load_id, v_registry_id, LOCALTIMESTAMP, 'assumed_unconfirmed', NULL);
    END IF;

    -- load.rate_confirmation_sent — AI-cascade path only (manual assignment
    -- never persists rate_con_send_status at all; see Global Constraints).
    IF NEW.rate_con_send_status IS DISTINCT FROM OLD.rate_con_send_status AND NEW.rate_con_send_status IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.rate_confirmation_sent', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'dispatch-gate', 'system',
            jsonb_build_object('load_id', NEW.id, 'send_status', NEW.rate_con_send_status),
            NULL, NULL, COALESCE(NEW.rate_con_sent_at, LOCALTIMESTAMP), 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.carrier_acceptance_confirmed — backfill from a real signature
    -- (the one carrier_acceptance_state row this pipeline load has that's
    -- still unconfirmed; a reassigned load's earlier, superseded row is
    -- deliberately left alone).
    IF NEW.carrier_signature_received_at IS DISTINCT FROM OLD.carrier_signature_received_at
       AND NEW.carrier_signature_received_at IS NOT NULL THEN
        UPDATE carrier_acceptance_state
           SET confirmed_at = NEW.carrier_signature_received_at,
               confirmation_method = CASE NEW.carrier_signature_method
                                       WHEN 'email_verified' THEN 'rate_con_signed'
                                       WHEN 'manual_ops' THEN 'manual_call'
                                       ELSE 'rate_con_signed' END,
               confirmation_source = NEW.carrier_signature_confirmed_by
         WHERE pipeline_load_id = NEW.pipeline_load_id AND confirmed_at IS NULL;

        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.carrier_acceptance_confirmed', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'dispatch-gate', 'system',
            jsonb_build_object('load_id', NEW.id, 'method', NEW.carrier_signature_method, 'confirmed_by', NEW.carrier_signature_confirmed_by),
            NULL, NULL, NEW.carrier_signature_received_at, 'carrier_acceptance_state', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.pickup_checked_in — see Global Constraints note 4.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'In Transit' THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.pickup_checked_in', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id),
            OLD.status, NEW.status, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    -- load.pod_captured
    IF NEW.pod_url IS DISTINCT FROM OLD.pod_url AND NEW.pod_url IS NOT NULL THEN
        PERFORM fn_insert_event(
            fn_myra_tenant_id()::integer, 'load.pod_captured', 'load', NEW.pipeline_load_id, NEW.pipeline_load_id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.id),
            NULL, NULL, LOCALTIMESTAMP, 'loads', NEW.pipeline_load_id, 'load-' || NEW.pipeline_load_id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_events_loads ON loads;
CREATE TRIGGER trg_lifecycle_events_loads
AFTER UPDATE ON loads
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_events_from_loads();

-- ============================================================
-- 4. Trigger: load.in_transit_ping from location_pings
-- ============================================================
CREATE OR REPLACE FUNCTION fn_lifecycle_event_from_location_ping() RETURNS TRIGGER AS $$
DECLARE
    v_pipeline_load_id INTEGER;
BEGIN
    SELECT pipeline_load_id INTO v_pipeline_load_id FROM loads WHERE id = NEW.load_id;
    IF v_pipeline_load_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM fn_insert_event(
        fn_myra_tenant_id()::integer, 'load.in_transit_ping', 'load', v_pipeline_load_id, v_pipeline_load_id,
        'gps', 'system',
        jsonb_build_object('lat', NEW.lat, 'lng', NEW.lng, 'speed_mph', NEW.speed_mph),
        NULL, NULL, LOCALTIMESTAMP, 'location_pings', v_pipeline_load_id, 'load-' || v_pipeline_load_id
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_event_location_ping ON location_pings;
CREATE TRIGGER trg_lifecycle_event_location_ping
AFTER INSERT ON location_pings
FOR EACH ROW EXECUTE FUNCTION fn_lifecycle_event_from_location_ping();

-- ============================================================
-- 5. v_lifecycle_late_loads — read-only, feeds T-24
-- ============================================================
-- Base-spec fix: pl.delivery_date is nullable (pipeline_loads has no
-- NOT NULL constraint on it); the base spec's GREATEST(pickup_date,
-- delivery_date) silently returns NULL for time_overdue on any pickup_late
-- row whose delivery_date hasn't been set yet. COALESCE'd here.
CREATE OR REPLACE VIEW v_lifecycle_late_loads AS
SELECT pl.id AS pipeline_load_id,
       fn_myra_tenant_id()::integer AS tenant_id,
       pl.pickup_date, pl.delivery_date, pl.stage,
       CASE
         WHEN pl.pickup_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id AND e.event_type = 'load.pickup_checked_in')
         THEN 'pickup_late'
         WHEN pl.delivery_date IS NOT NULL AND pl.delivery_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id AND e.event_type = 'load.delivered')
         THEN 'delivery_late'
         ELSE NULL
       END AS late_status,
       NOW() - GREATEST(pl.pickup_date, COALESCE(pl.delivery_date, pl.pickup_date)) AS time_overdue
FROM pipeline_loads pl
WHERE pl.stage = 'dispatched';
```

- [ ] **Step 2: Apply on a disposable Neon branch first**

Create branch `t23-verify` from production (via `mcp__Neon__create_branch`, same precedent as `t17-verify`/`t18-verify`/`t19-verify`/`t20-t21-verify`). Apply with `mcp__Neon__run_sql` (or `psql "$BRANCH_DATABASE_URL" -f scripts/053-t23-dispatch-lifecycle-monitor.sql`). Expected: no errors, both `RAISE EXCEPTION` guards pass silently (035/044 already applied to production and therefore to any branch cut from it).

- [ ] **Step 3: Write the failing integration test**

```typescript
// __tests__/lifecycle/t23-triggers.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const TEST_LOAD_ID = `TEST-T23-${Date.now()}`;
const TMS_LOAD_ID = `LD-T23-${Date.now()}`;
const TEST_CARRIER_ID = `CAR-T23-${Date.now()}`;

describe('T-23 lifecycle triggers (053)', () => {
  let pipelineLoadId: number;

  beforeAll(async () => {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, stage
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
                 NOW() + INTERVAL '2 days', NOW() + INTERVAL '3 days', 'Dry Van', 'dispatched')
       RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'T23 Test Carrier', fn_myra_tenant_id())`,
      [TEST_CARRIER_ID],
    );
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pipeline_load_id)
       VALUES ($1, 'Toronto', 'Sudbury', 'Booked', $2)`,
      [TMS_LOAD_ID, pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [TMS_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [TEST_CARRIER_ID]);
  });

  it('carrier_id set → load.carrier_assigned event + assumed_unconfirmed acceptance row', async () => {
    await db.query(`UPDATE loads SET carrier_id = $1 WHERE id = $2`, [TEST_CARRIER_ID, TMS_LOAD_ID]);

    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.carrier_assigned'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);

    const state = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].confirmation_method).toBe('assumed_unconfirmed');
    expect(state.rows[0].confirmed_at).toBeNull();
  });

  it('carrier_signature_received_at set → backfills confirmed_at + emits load.carrier_acceptance_confirmed', async () => {
    await db.query(
      `UPDATE loads SET carrier_signature_received_at = NOW(), carrier_signature_method = 'email_verified', carrier_signature_confirmed_by = 'imap-poller' WHERE id = $1`,
      [TMS_LOAD_ID],
    );

    const state = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows[0].confirmation_method).toBe('rate_con_signed');
    expect(state.rows[0].confirmed_at).not.toBeNull();

    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.carrier_acceptance_confirmed'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('status → In Transit emits load.pickup_checked_in exactly once', async () => {
    await db.query(`UPDATE loads SET status = 'In Transit' WHERE id = $1`, [TMS_LOAD_ID]);
    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.pickup_checked_in'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('pod_url set emits load.pod_captured', async () => {
    await db.query(`UPDATE loads SET pod_url = 'https://blob.example/pod.jpg' WHERE id = $1`, [TMS_LOAD_ID]);
    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.pod_captured'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('a manual (non-pipeline) load produces zero lifecycle events', async () => {
    const manualLoadId = `LD-MANUAL-${Date.now()}`;
    await db.query(
      `INSERT INTO loads (id, origin, destination, status) VALUES ($1, 'A', 'B', 'Booked')`,
      [manualLoadId],
    );
    await db.query(`UPDATE loads SET carrier_id = $1 WHERE id = $2`, [TEST_CARRIER_ID, manualLoadId]);
    const events = await db.query(
      `SELECT * FROM events WHERE derived_from_table = 'loads' AND payload->>'load_id' = $1`,
      [manualLoadId],
    );
    expect(events.rows.length).toBe(0);
    await db.query(`DELETE FROM loads WHERE id = $1`, [manualLoadId]);
  });

  it('v_lifecycle_late_loads flags a load past pickup_date with no check-in, and does not flag an on-time one', async () => {
    const lateLoad = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() - INTERVAL '2 hours', NOW() + INTERVAL '1 day', 'Dry Van', 'dispatched')
       RETURNING id`,
      [`TEST-T23-LATE-${Date.now()}`],
    );
    const lateId = lateLoad.rows[0].id;

    const onTimeLoad = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 'Dry Van', 'dispatched')
       RETURNING id`,
      [`TEST-T23-ONTIME-${Date.now()}`],
    );
    const onTimeId = onTimeLoad.rows[0].id;

    const view = await db.query<{ pipeline_load_id: number; late_status: string | null }>(
      `SELECT pipeline_load_id, late_status FROM v_lifecycle_late_loads WHERE pipeline_load_id IN ($1, $2)`,
      [lateId, onTimeId],
    );
    expect(view.rows.find((r) => r.pipeline_load_id === lateId)?.late_status).toBe('pickup_late');
    expect(view.rows.find((r) => r.pipeline_load_id === onTimeId)?.late_status).toBeNull();

    await db.query(`DELETE FROM pipeline_loads WHERE id IN ($1, $2)`, [lateId, onTimeId]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run __tests__/lifecycle/t23-triggers.test.ts`
Expected: FAIL — `relation "carrier_acceptance_state" does not exist` (or similar) until Step 2's branch has the migration applied and `DATABASE_URL` in the test run points at it.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run __tests__/lifecycle/t23-triggers.test.ts` (against the `t23-verify` branch)
Expected: PASS, all 6 cases.

- [ ] **Step 6: Commit**

```bash
git add scripts/053-t23-dispatch-lifecycle-monitor.sql __tests__/lifecycle/t23-triggers.test.ts
git commit -m "T-23: lifecycle event triggers, carrier_acceptance_state, dispatch_routing_rules, v_lifecycle_late_loads"
```

---

### Task 2: Backfill script for historical dispatched loads

**Files:**
- Create: `scripts/t23_backfill_carrier_acceptance_state.ts`
- Test: `__tests__/lifecycle/t23-backfill.test.ts`

**Interfaces:**
- Consumes: `pipeline_loads`, `loads` (joined via `pipeline_load_id`), `carriers.carrier_registry_id`.
- Produces: `carrier_acceptance_state` rows for every historically-dispatched pipeline load that predates the Task 1 trigger — read by Task 6's report.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/t23-backfill.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { backfillCarrierAcceptanceState } from '../../scripts/t23_backfill_carrier_acceptance_state';

describe('t23_backfill_carrier_acceptance_state', () => {
  let pipelineLoadId: number;
  const tmsLoadId = `LD-BACKFILL-${Date.now()}`;
  const carrierId = `CAR-BACKFILL-${Date.now()}`;

  beforeAll(async () => {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage, dispatched_at)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '9 days', 'Dry Van', 'delivered', NOW() - INTERVAL '10 days')
       RETURNING id`,
      [`TEST-BACKFILL-${Date.now()}`],
    );
    pipelineLoadId = ins.rows[0].id;
    await db.query(`INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'Backfill Carrier', fn_myra_tenant_id())`, [carrierId]);
    // Inserted directly with carrier_id already set — simulates a load
    // dispatched BEFORE the Task 1 trigger existed (no carrier_acceptance_state row).
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, carrier_id, pipeline_load_id) VALUES ($1, 'A', 'B', 'Delivered', $2, $3)`,
      [tmsLoadId, carrierId, pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [carrierId]);
  });

  it('inserts an assumed_unconfirmed row for a pre-existing dispatched load with no acceptance row yet', async () => {
    const result = await backfillCarrierAcceptanceState();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const row = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].confirmation_method).toBe('assumed_unconfirmed');
  });

  it('is idempotent — a second run inserts nothing new for the same load', async () => {
    const before = await db.query(`SELECT COUNT(*) FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await backfillCarrierAcceptanceState();
    const after = await db.query(`SELECT COUNT(*) FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/lifecycle/t23-backfill.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/t23_backfill_carrier_acceptance_state'`.

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/t23_backfill_carrier_acceptance_state.ts
//
// Seeds carrier_acceptance_state for pipeline loads dispatched before
// migration 053's trigger existed. Uses the identical assumed_unconfirmed /
// rate_con_signed / manual_call classification the trigger applies live
// (Task 1) so a backfilled row is indistinguishable from one the trigger
// would have written in real time.

import { db } from '../lib/pipeline/db-adapter';

interface BackfillCandidate {
  pipeline_load_id: number;
  carrier_registry_id: number | null;
  assigned_at: Date;
  carrier_signature_received_at: Date | null;
  carrier_signature_method: string | null;
  carrier_signature_confirmed_by: string | null;
}

export async function backfillCarrierAcceptanceState(): Promise<{ inserted: number; candidates: number }> {
  const { rows } = await db.query<BackfillCandidate>(`
    SELECT pl.id AS pipeline_load_id,
           c.carrier_registry_id,
           COALESCE(pl.dispatched_at, pl.stage_updated_at, pl.created_at) AS assigned_at,
           l.carrier_signature_received_at, l.carrier_signature_method, l.carrier_signature_confirmed_by
      FROM pipeline_loads pl
      JOIN loads l ON l.pipeline_load_id = pl.id
      LEFT JOIN carriers c ON c.id = l.carrier_id
     WHERE pl.stage IN ('dispatched', 'delivered')
       AND l.carrier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM carrier_acceptance_state cas WHERE cas.pipeline_load_id = pl.id)
  `);

  let inserted = 0;
  for (const row of rows) {
    const method = row.carrier_signature_received_at
      ? row.carrier_signature_method === 'manual_ops'
        ? 'manual_call'
        : 'rate_con_signed'
      : 'assumed_unconfirmed';

    await db.query(
      `INSERT INTO carrier_acceptance_state
         (pipeline_load_id, carrier_registry_id, assigned_at, confirmation_method, confirmed_at, confirmation_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.pipeline_load_id,
        row.carrier_registry_id,
        row.assigned_at,
        method,
        row.carrier_signature_received_at,
        row.carrier_signature_confirmed_by,
      ],
    );
    inserted += 1;
  }

  return { inserted, candidates: rows.length };
}

async function main(): Promise<void> {
  const result = await backfillCarrierAcceptanceState();
  console.log(`Backfilled ${result.inserted} of ${result.candidates} candidate carrier_acceptance_state rows.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[t23-backfill] failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/lifecycle/t23-backfill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/t23_backfill_carrier_acceptance_state.ts __tests__/lifecycle/t23-backfill.test.ts
git commit -m "T-23: carrier_acceptance_state backfill script for pre-trigger dispatched loads"
```

---

### Task 3: `resolveDispatchRouting()` / `setDispatchRoutingOverride()`

**Files:**
- Create: `lib/dispatch/routing.ts`
- Test: `lib/dispatch/__tests__/routing.test.ts`

**Interfaces:**
- Consumes: `dispatch_routing_rules` (Task 1), `tenant_policies.dispatch_agent_enabled` (035).
- Produces: `resolveDispatchRouting(tenantId): Promise<DispatchRoutingResolution>`, `setDispatchRoutingOverride(tenantId, mode, notifyContact): Promise<void>` — consumed by Task 4's API routes.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/dispatch/__tests__/routing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { resolveDispatchRouting, setDispatchRoutingOverride } from '@/lib/dispatch/routing';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('resolveDispatchRouting', () => {
  it('returns the active override when one exists', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ mode: 'in_house_notify', notify_contact: 'ops@carrier.test' }] });
    const result = await resolveDispatchRouting(2);
    expect(result).toEqual({ mode: 'in_house_notify', notifyContact: 'ops@carrier.test', source: 'override' });
  });

  it('falls back to tenant_policies.dispatch_agent_enabled=true → myra_managed when no override row exists', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ dispatch_agent_enabled: true }] });
    const result = await resolveDispatchRouting(2);
    expect(result).toEqual({ mode: 'myra_managed', notifyContact: null, source: 'tenant_policy_default' });
  });

  it('falls back to dispatch_agent_enabled=false → in_house_notify with no override row', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ dispatch_agent_enabled: false }] });
    const result = await resolveDispatchRouting(3);
    expect(result.mode).toBe('in_house_notify');
    expect(result.source).toBe('tenant_policy_default');
  });
});

describe('setDispatchRoutingOverride', () => {
  it('throws when mode=in_house_notify with no notifyContact', async () => {
    await expect(setDispatchRoutingOverride(3, 'in_house_notify', null)).rejects.toThrow(/notifyContact is required/);
  });

  it('upserts when valid', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    await setDispatchRoutingOverride(3, 'in_house_notify', 'dispatch@carrier.test');
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (tenant_id)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/dispatch/__tests__/routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/dispatch/routing.ts
//
// T-23 §4.3/§6 — tenant-scoped dispatch mode resolution. Reads
// dispatch_routing_rules as a per-tenant override; falls back to T-19's
// tenant_policies.dispatch_agent_enabled default when no override row
// exists. Resolves only — never acts (T-23b routes a real second tenant
// through in_house_notify; this module doesn't call anything).

import { db } from '@/lib/pipeline/db-adapter';

export type DispatchMode = 'myra_managed' | 'in_house_notify';

export interface DispatchRoutingResolution {
  mode: DispatchMode;
  notifyContact: string | null;
  source: 'override' | 'tenant_policy_default';
}

export async function resolveDispatchRouting(tenantId: number): Promise<DispatchRoutingResolution> {
  const overrideRes = await db.query<{ mode: DispatchMode; notify_contact: string | null }>(
    `SELECT mode, notify_contact FROM dispatch_routing_rules WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );
  if (overrideRes.rows.length > 0) {
    const row = overrideRes.rows[0];
    return { mode: row.mode, notifyContact: row.notify_contact, source: 'override' };
  }

  const policyRes = await db.query<{ dispatch_agent_enabled: boolean }>(
    `SELECT dispatch_agent_enabled FROM tenant_policies
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const enabled = policyRes.rows[0]?.dispatch_agent_enabled ?? false;
  return { mode: enabled ? 'myra_managed' : 'in_house_notify', notifyContact: null, source: 'tenant_policy_default' };
}

export async function setDispatchRoutingOverride(
  tenantId: number,
  mode: DispatchMode,
  notifyContact: string | null,
): Promise<void> {
  if (mode === 'in_house_notify' && !notifyContact) {
    throw new Error('notifyContact is required when mode=in_house_notify');
  }
  await db.query(
    `INSERT INTO dispatch_routing_rules (tenant_id, mode, notify_contact, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode, notify_contact = EXCLUDED.notify_contact, is_active = true`,
    [tenantId, mode, notifyContact],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/dispatch/__tests__/routing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch/routing.ts lib/dispatch/__tests__/routing.test.ts
git commit -m "T-23: dispatch routing resolution (myra_managed / in_house_notify)"
```

---

### Task 4: Dispatch routing API

**Files:**
- Create: `app/api/dispatch/routing/[tenantId]/route.ts`
- Test: `__tests__/lifecycle/dispatch-routing-api.test.ts`

**Interfaces:**
- Consumes: `resolveDispatchRouting`, `setDispatchRoutingOverride` (Task 3), `authorizeGovernanceRequest` (`@/lib/governance/api-helpers`, existing).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/dispatch-routing-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
}));
vi.mock('@/lib/dispatch/routing', () => ({
  resolveDispatchRouting: vi.fn(async () => ({ mode: 'myra_managed', notifyContact: null, source: 'tenant_policy_default' })),
  setDispatchRoutingOverride: vi.fn(async () => undefined),
}));

import { GET, POST } from '@/app/api/dispatch/routing/[tenantId]/route';
import { setDispatchRoutingOverride } from '@/lib/dispatch/routing';

describe('GET/POST /api/dispatch/routing/:tenantId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET resolves routing for the given tenant', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2');
    const res = await GET(req, { params: Promise.resolve({ tenantId: '2' }) });
    const body = await res.json();
    expect(body.mode).toBe('myra_managed');
  });

  it('POST sets an override with a valid body', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2', {
      method: 'POST',
      body: JSON.stringify({ mode: 'in_house_notify', notifyContact: 'dispatch@carrier.test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: '2' }) });
    expect(res.status).toBe(200);
    expect(setDispatchRoutingOverride).toHaveBeenCalledWith(2, 'in_house_notify', 'dispatch@carrier.test');
  });

  it('POST rejects an invalid mode', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2', {
      method: 'POST',
      body: JSON.stringify({ mode: 'bogus' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: '2' }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/lifecycle/dispatch-routing-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/dispatch/routing/[tenantId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { resolveDispatchRouting, setDispatchRoutingOverride, type DispatchMode } from '@/lib/dispatch/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseTenantId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { tenantId: raw } = await params;
  const tenantId = parseTenantId(raw);
  if (tenantId === null) return NextResponse.json({ error: 'Invalid tenantId' }, { status: 400 });

  try {
    const resolution = await resolveDispatchRouting(tenantId);
    return NextResponse.json(resolution);
  } catch (err) {
    logger.error('[dispatch/routing GET] failed', err);
    return NextResponse.json({ error: 'Failed to resolve dispatch routing' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { tenantId: raw } = await params;
  const tenantId = parseTenantId(raw);
  if (tenantId === null) return NextResponse.json({ error: 'Invalid tenantId' }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const mode: DispatchMode = body?.mode;
  if (!['myra_managed', 'in_house_notify'].includes(mode)) {
    return NextResponse.json({ error: "mode must be 'myra_managed' or 'in_house_notify'" }, { status: 400 });
  }

  try {
    await setDispatchRoutingOverride(tenantId, mode, body?.notifyContact ?? null);
    const resolution = await resolveDispatchRouting(tenantId);
    return NextResponse.json(resolution);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to set dispatch routing override';
    logger.error('[dispatch/routing POST] failed', err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/lifecycle/dispatch-routing-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/dispatch/routing/\[tenantId\]/route.ts __tests__/lifecycle/dispatch-routing-api.test.ts
git commit -m "T-23: dispatch routing API (GET resolve / POST override)"
```

---

### Task 5: Lifecycle read API — timeline, late loads, acceptance-gap report

**Files:**
- Create: `app/api/lifecycle/load/[pipelineLoadId]/route.ts`
- Create: `app/api/lifecycle/late/route.ts`
- Create: `app/api/lifecycle/acceptance-gap-report/route.ts`
- Test: `__tests__/lifecycle/lifecycle-api.test.ts`

**Interfaces:**
- Consumes: `events`, `v_lifecycle_late_loads` (Task 1), `resolveTenantId` (`@/lib/governance/api-helpers`, existing).
- Produces: the 3 remaining spec §6 endpoints (2 already built in Task 4).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/lifecycle-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getTimeline } from '@/app/api/lifecycle/load/[pipelineLoadId]/route';
import { GET as getLate } from '@/app/api/lifecycle/late/route';
import { GET as getGapReport } from '@/app/api/lifecycle/acceptance-gap-report/route';

describe('lifecycle read API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET /lifecycle/load/:id returns the ordered event timeline', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ event_type: 'load.carrier_assigned', occurred_at: '2026-08-01' }] });
    const req = new NextRequest('http://x/api/lifecycle/load/42');
    const res = await getTimeline(req, { params: Promise.resolve({ pipelineLoadId: '42' }) });
    const body = await res.json();
    expect(body.events.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('ORDER BY occurred_at');
  });

  it('GET /lifecycle/load/:id rejects a non-numeric id', async () => {
    const req = new NextRequest('http://x/api/lifecycle/load/abc');
    const res = await getTimeline(req, { params: Promise.resolve({ pipelineLoadId: 'abc' }) });
    expect(res.status).toBe(400);
  });

  it('GET /lifecycle/late returns only rows with a non-null late_status', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ pipeline_load_id: 1, late_status: 'pickup_late' }] });
    const req = new NextRequest('http://x/api/lifecycle/late');
    const res = await getLate(req);
    const body = await res.json();
    expect(body.lateLoads.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('late_status IS NOT NULL');
  });

  it('GET /lifecycle/acceptance-gap-report returns the aggregate shape', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ total: '10', confirmed: '3' }] })
      .mockResolvedValueOnce({ rows: [{ delivered: '5', reassigned: '1', pickup_late: '2', unconfirmed_total: '7' }] });
    const req = new NextRequest('http://x/api/lifecycle/acceptance-gap-report?since=30');
    const res = await getGapReport(req);
    const body = await res.json();
    expect(body.total).toBe(10);
    expect(body.confirmed).toBe(3);
    expect(body.unconfirmedBreakdown.delivered).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run __tests__/lifecycle/lifecycle-api.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

```typescript
// app/api/lifecycle/load/[pipelineLoadId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ pipelineLoadId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { pipelineLoadId: raw } = await params;
  const pipelineLoadId = Number(raw);
  if (!Number.isInteger(pipelineLoadId)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId' }, { status: 400 });
  }

  try {
    const { rows } = await db.query(
      `SELECT event_type, entity_type, source, actor_type, payload, stage_from, stage_to, occurred_at
         FROM events WHERE pipeline_load_id = $1 ORDER BY occurred_at ASC`,
      [pipelineLoadId],
    );
    return NextResponse.json({ pipelineLoadId, events: rows });
  } catch (err) {
    logger.error('[lifecycle/load GET] failed', err);
    return NextResponse.json({ error: 'Failed to load lifecycle timeline' }, { status: 500 });
  }
}
```

```typescript
// app/api/lifecycle/late/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT pipeline_load_id, pickup_date, delivery_date, stage, late_status, time_overdue
         FROM v_lifecycle_late_loads
        WHERE tenant_id = $1 AND late_status IS NOT NULL
        ORDER BY time_overdue DESC`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, lateLoads: rows });
  } catch (err) {
    logger.error('[lifecycle/late GET] failed', err);
    return NextResponse.json({ error: 'Failed to load late-load report' }, { status: 500 });
  }
}
```

```typescript
// app/api/lifecycle/acceptance-gap-report/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same query shape as scripts/t23_acceptance_gap_report.ts (Task 6) — kept
// in sync deliberately; this route is the live/on-demand view of the same
// measurement, not a separate metric.
export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const totalsRes = await db.query<{ total: string; confirmed: string }>(
      `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::text AS confirmed
         FROM carrier_acceptance_state
        WHERE assigned_at > NOW() - ($1 || ' days')::interval`,
      [sinceDays],
    );

    const breakdownRes = await db.query<{ delivered: string; reassigned: string; pickup_late: string; unconfirmed_total: string }>(
      `WITH unconfirmed AS (
         SELECT cas.pipeline_load_id, l.status,
                (SELECT COUNT(*) FROM carrier_acceptance_state c2 WHERE c2.pipeline_load_id = cas.pipeline_load_id) AS assignment_count,
                EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = cas.pipeline_load_id AND e.event_type = 'load.pickup_checked_in') AS picked_up,
                pl.pickup_date
           FROM carrier_acceptance_state cas
           JOIN pipeline_loads pl ON pl.id = cas.pipeline_load_id
           LEFT JOIN loads l ON l.pipeline_load_id = pl.id
          WHERE cas.confirmed_at IS NULL AND cas.assigned_at > NOW() - ($1 || ' days')::interval
       )
       SELECT
         COUNT(*) FILTER (WHERE status IN ('Delivered', 'Invoiced', 'Closed'))::text AS delivered,
         COUNT(*) FILTER (WHERE assignment_count > 1)::text AS reassigned,
         COUNT(*) FILTER (WHERE NOT picked_up AND pickup_date < NOW() - INTERVAL '30 minutes' AND status NOT IN ('Delivered', 'Invoiced', 'Closed'))::text AS pickup_late,
         COUNT(*)::text AS unconfirmed_total
       FROM unconfirmed`,
      [sinceDays],
    );

    const total = Number(totalsRes.rows[0]?.total ?? 0);
    const confirmed = Number(totalsRes.rows[0]?.confirmed ?? 0);
    const b = breakdownRes.rows[0];

    return NextResponse.json({
      sinceDays,
      total,
      confirmed,
      unconfirmed: total - confirmed,
      unconfirmedBreakdown: {
        delivered: Number(b?.delivered ?? 0),
        reassigned: Number(b?.reassigned ?? 0),
        pickupLate: Number(b?.pickup_late ?? 0),
        total: Number(b?.unconfirmed_total ?? 0),
      },
      note: 'This schema has no cancellation status on loads — cancellation is not a trackable dimension here.',
    });
  } catch (err) {
    logger.error('[lifecycle/acceptance-gap-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute acceptance-gap report' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run __tests__/lifecycle/lifecycle-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/lifecycle __tests__/lifecycle/lifecycle-api.test.ts
git commit -m "T-23: lifecycle read API (timeline, late loads, acceptance-gap report)"
```

---

### Task 6: Measurement report script — run it for real

**Files:**
- Create: `scripts/t23_acceptance_gap_report.ts`

**Interfaces:**
- Consumes: the identical query shape as Task 5's `acceptance-gap-report` route (kept in sync deliberately — see that route's comment).
- Produces: a console report. **This is the module's required deliverable (spec §5, §8) — running it and recording the real numbers is part of this task, not optional.**

- [ ] **Step 1: Write the script**

```typescript
// scripts/t23_acceptance_gap_report.ts
//
// T-23 §5 — the measurement report. Prints, does not just compute: this
// script's actual printed output (not a description of it) is the required
// deliverable this module hands to Patrice before T-23b's priority is
// decided (spec §8's exit gate).

import { db } from '../lib/pipeline/db-adapter';

async function main(): Promise<void> {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const sinceDays = sinceArg ? Number(sinceArg.split('=')[1]) : 90;

  const totalsRes = await db.query<{ total: string; confirmed: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::text AS confirmed
       FROM carrier_acceptance_state
      WHERE assigned_at > NOW() - ($1 || ' days')::interval`,
    [sinceDays],
  );

  const breakdownRes = await db.query<{ delivered: string; reassigned: string; pickup_late: string; unconfirmed_total: string }>(
    `WITH unconfirmed AS (
       SELECT cas.pipeline_load_id, l.status,
              (SELECT COUNT(*) FROM carrier_acceptance_state c2 WHERE c2.pipeline_load_id = cas.pipeline_load_id) AS assignment_count,
              EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = cas.pipeline_load_id AND e.event_type = 'load.pickup_checked_in') AS picked_up,
              pl.pickup_date
         FROM carrier_acceptance_state cas
         JOIN pipeline_loads pl ON pl.id = cas.pipeline_load_id
         LEFT JOIN loads l ON l.pipeline_load_id = pl.id
        WHERE cas.confirmed_at IS NULL AND cas.assigned_at > NOW() - ($1 || ' days')::interval
     )
     SELECT
       COUNT(*) FILTER (WHERE status IN ('Delivered', 'Invoiced', 'Closed'))::text AS delivered,
       COUNT(*) FILTER (WHERE assignment_count > 1)::text AS reassigned,
       COUNT(*) FILTER (WHERE NOT picked_up AND pickup_date < NOW() - INTERVAL '30 minutes' AND status NOT IN ('Delivered', 'Invoiced', 'Closed'))::text AS pickup_late,
       COUNT(*)::text AS unconfirmed_total
     FROM unconfirmed`,
    [sinceDays],
  );

  const total = Number(totalsRes.rows[0]?.total ?? 0);
  const confirmed = Number(totalsRes.rows[0]?.confirmed ?? 0);
  const unconfirmed = total - confirmed;
  const b = breakdownRes.rows[0];
  const delivered = Number(b?.delivered ?? 0);
  const reassigned = Number(b?.reassigned ?? 0);
  const pickupLate = Number(b?.pickup_late ?? 0);
  const pct = (n: number, d: number) => (d === 0 ? 'n/a (0 in window)' : `${((n / d) * 100).toFixed(1)}%`);

  console.log(`T-23 Acceptance Gap Report — last ${sinceDays} days`);
  console.log('='.repeat(60));
  console.log(`Total loads dispatched (carrier_acceptance_state rows): ${total}`);
  console.log(`  Real confirmation signal:  ${confirmed} (${pct(confirmed, total)})`);
  console.log(`  assumed_unconfirmed:       ${unconfirmed} (${pct(unconfirmed, total)})`);
  console.log('');
  console.log(`Of the ${unconfirmed} unconfirmed loads:`);
  console.log(`  Delivered successfully anyway: ${delivered} (${pct(delivered, unconfirmed)})`);
  console.log(`  Later reassigned to another carrier: ${reassigned} (${pct(reassigned, unconfirmed)})`);
  console.log(`  Pickup went late with no check-in: ${pickupLate} (${pct(pickupLate, unconfirmed)})`);
  console.log('');
  console.log('Note: this schema has no cancellation status on loads.status —');
  console.log('cancellation is not a measurable dimension here, not omitted by oversight.');
}

main().catch((err) => {
  console.error('[t23-acceptance-gap-report] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it for real against production (read-only query, safe to run directly)**

Run: `pnpm tsx --env-file=.env.local scripts/t23_acceptance_gap_report.ts --since=90`
Record the actual printed output verbatim in the completion tracker entry (Task 7) — this is the module's key deliverable per spec §5/§8. If the real number is unflattering (e.g. most loads show `assumed_unconfirmed`), report it exactly as printed — do not soften it.

- [ ] **Step 3: Commit**

```bash
git add scripts/t23_acceptance_gap_report.ts
git commit -m "T-23: acceptance-gap measurement report script"
```

---

### Task 7: Regression suite, late-load validation, completion tracker

**Files:**
- Modify: `Engine 3/docs/superpowers/plans/completion.md`

- [ ] **Step 1: Apply migration 053 to production**

Via `mcp__Neon__run_sql` against the real production branch, after Task 1–6 all pass on `t23-verify`. Verify each new object directly (table exists, view returns rows, trigger fired on a real historical load) — not just that the migration exited cleanly (same discipline as every prior Engine 3 module).

- [ ] **Step 2: Validate `v_lifecycle_late_loads` against ≥5 real historical late loads**

Query `v_lifecycle_late_loads` on production, cross-check at least 5 flagged rows manually against `agent_calls`/TMS records (acceptance criterion 4) and confirm on-time loads are never flagged. Record the specific `pipeline_load_id`s checked in the completion tracker entry.

- [ ] **Step 3: Run the full regression suite**

Run: `pnpm vitest run`
Expected: no new failures beyond the already-documented pre-existing set (`cost-calculator.test.ts`'s 5 pure-arithmetic mismatches, `ranker.test.ts`/`researcher.test.ts` timeouts, occasional full-suite DB-race flakes in `carrier-brief-compiler-worker.test.ts`) — confirm via `git diff`/`git log` that none of those files were touched by this plan, same as every prior module's regression note.

- [ ] **Step 4: Run `pnpm tsc --noEmit -p tsconfig.json`**

Expected: clean, project-wide.

- [ ] **Step 5: Update the completion tracker**

Add a T-23 section to `Engine 3/docs/superpowers/plans/completion.md` (Phase 2, after T-22) following the exact structure of the T-20/T-21/T-22 entries: spec link, status line, the 4 schema-reality corrections from this plan's Global Constraints, a task-by-task checklist with `(done YYYY-MM-DD)`, the real Task 6 report numbers verbatim, and an explicit acceptance-criteria pass/fail table (spec §7, all 6 criteria) — mark criteria PASS/OPEN honestly, same as T-20's criteria 4/5 and T-22's criteria 1/7.

- [ ] **Step 6: Commit**

```bash
git add Engine\ 3/docs/superpowers/plans/completion.md
git commit -m "T-23: completion tracker entry — Dispatch & Load Lifecycle Monitor built, acceptance-gap report delivered"
```

---

## Self-Review Notes (for the executor, not a step to repeat)

- **Spec coverage:** §4.1 (8 event types) — 7 built in Task 1, 1 (`load.delivered`) already satisfied by T-17, documented in Global Constraints #3. §4.2 (`carrier_acceptance_state`) — Task 1 + Task 2. §4.3 (`dispatch_routing_rules`) — Task 1 + Task 3 + Task 4. §4.4 (view) — Task 1. §5 (report) — Task 6. §6 (5 endpoints) — Task 4 (2) + Task 5 (3). §7 (acceptance criteria) — Task 7. §8 (gate) — Task 7 Step 5. §9 (portability) — no host-specific code introduced anywhere in this plan; satisfied by construction.
- **Explicitly deferred to T-23b per spec §8**, not built here: wiring a confirmation *requirement* into the live dispatch flow, and routing a real second tenant through `in_house_notify`.
