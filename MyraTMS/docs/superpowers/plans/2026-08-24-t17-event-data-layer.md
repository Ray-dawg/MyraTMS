# T-17 Event & Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Recommended execution mode for this specific plan: Inline Execution.** Tasks 1–10 share a single Neon verification branch ID and connection string that must be threaded through nearly every task. Carrying that state across dispatched subagents is more error-prone than keeping it in one continuous session. If subagent-driven-development is used anyway, pass the branch ID and connection string explicitly in every task's dispatch prompt.

**Goal:** Build the T-17 Event & Data Layer — an append-only `events` table populated entirely by PostgreSQL triggers on tables Engine 2 already writes, plus a read-only API and a backfill script — verified end-to-end on a disposable Neon branch, without touching production or any file in the live call path.

**Architecture:** One migration (`033-event-data-layer.sql`) adds the `events` table, two shared PL/pgSQL helper functions (`fn_insert_event`, `fn_stage_event_type`), five exception-safe triggers on `pipeline_loads` / `agent_calls` / `agent_jobs` / `consent_log` / `scraper_runs`, and four metric views. A TypeScript backfill script reconstructs historical events using the same `fn_insert_event` choke point, so triggers and backfill can never drift apart. Six read-only Next.js API routes expose `events` and the views behind the same JWT-cookie + role-check pattern every other MyraTMS operator route uses.

**Tech Stack:** PostgreSQL (Neon serverless) via `@neondatabase/serverless`, Next.js 16 App Router route handlers, TypeScript, Vitest, Neon MCP tools for branch provisioning.

## Execution notes (added post-implementation, 2026-08-24)

All 11 tasks executed against Neon branch `t17-verify` (`br-cool-water-aiei1dwg`, project `lingering-bar-21372774`). The SQL embedded in Task 2 below is the **original plan**, not the final committed migration — three real bugs surfaced during Tasks 4/5/10 verification and were fixed directly in `scripts/033-event-data-layer.sql` (see its own header comments and the git history for `MyraTMS/scripts/033-event-data-layer.sql` for the authoritative, corrected SQL):

1. **Timestamp type mismatch:** `fn_insert_event`'s `p_occurred_at` is `TIMESTAMP`, but `COALESCE(some_column, CURRENT_TIMESTAMP)` resolves to `timestamptz` (CURRENT_TIMESTAMP/NOW() return `timestamptz`; the real columns are all plain `timestamp`). The mismatched overload call was silently swallowed by the required exception handlers, so every UPDATE-triggered event silently failed to insert. Fixed by using `LOCALTIMESTAMP` (returns `timestamp`) everywhere instead.
2. **Idempotency key too narrow:** the original `UNIQUE (derived_from_table, derived_from_id, event_type)` assumed each event type fires at most once per source row, but `load.stage_changed` fires once per transition — a load's second transition silently collided with its first via `ON CONFLICT ... DO NOTHING`. Fixed by adding `occurred_at` to the key.
3. **Missing cascade:** `events.pipeline_load_id` had no `ON DELETE` behavior, so every existing pipeline test's fixture cleanup (`DELETE FROM pipeline_loads WHERE id = ...`) started failing with an FK violation once a trigger had created events for that row. Confirmed `pipeline_loads` is never deleted in production code (only test/ops scripts), so `ON DELETE CASCADE` was added.

Acceptance criterion 4 (zero regressions in the existing worker suite) surfaced two more findings, both diagnosed as unrelated to T-17 rather than assumed clean: a queue-count mismatch in `qualifier.test.ts` was leftover BullMQ/Redis state from an earlier run that crashed mid-suite on bug #3 above (resolved on a fresh run); a 30s timeout in `ranker.test.ts` was proven — by reproducing the exact triggering UPDATE directly via SQL and getting an instant result — to be a pre-existing characteristic of the matching engine doing per-carrier DB round-trips against this branch's 207 real (production-forked) carrier rows, not a trigger issue.

## Global Constraints

- Zero changes to `base-worker.ts`, `voice-worker.ts`, `retell-webhook.ts`, or `compiler-worker.ts` (T-17 spec §2, §10; Engine 3 master PRD principle 1).
- Every trigger function must be exception-safe — it can never abort the write on its source table (T-17 spec §5.2).
- `events` writes only happen via triggers or the backfill script; the read API has no write endpoints (T-17 spec §6).
- All new migration SQL uses `IF NOT EXISTS` / `CREATE OR REPLACE` so the file is safe to re-run (matches every existing migration in `MyraTMS/scripts/`).
- This session applies the migration only to a disposable Neon branch, never to production. Production apply is a manual step for Patrice after reviewing the branch verification results (design doc decision 3).
- Auth on all new API routes: `getCurrentUser` + `requireRole(user, 'admin', 'ops')`, matching `app/api/loadboard-sources/route.ts` — not the bearer-token pattern used by `/api/pipeline/import`.
- Reference docs: `Engine 3/T17_Event_Data_Layer.md` (base spec, authoritative on schema/taxonomy/acceptance criteria) and `MyraTMS/docs/superpowers/specs/2026-08-24-t17-event-data-layer-design.md` (reconciliation + decisions).

---

### Task 1: Provision a Neon verification branch

**Files:** None — this task only records IDs/connection strings needed by every later task. Write them into a scratch note (e.g. a comment in your working notes) as you go; they are not committed to the repo.

**Interfaces:**
- Produces: `PROJECT_ID` (Neon project ID for MyraTMS's Neon project), `BRANCH_ID` (the new verification branch), `BRANCH_DATABASE_URL` (connection string for that branch). Every later task that touches a database uses `BRANCH_DATABASE_URL`, never the real `DATABASE_URL` from `.env.local`.

- [ ] **Step 1: Find the MyraTMS Neon project**

Call `mcp__Neon__list_projects` with no filters (or `search` matching "myra" if there are multiple projects in the account). Record the `id` field as `PROJECT_ID`.

- [ ] **Step 2: Create a disposable branch**

Call `mcp__Neon__create_branch` with `projectId: PROJECT_ID` and `branchName: "t17-verify"`. Record the returned branch `id` as `BRANCH_ID`.

- [ ] **Step 3: Get a connection string for the branch**

Call `mcp__Neon__get_connection_string` with `projectId: PROJECT_ID` and `branchId: BRANCH_ID`. Record the returned connection string as `BRANCH_DATABASE_URL`.

- [ ] **Step 4: Sanity-check the branch is a real copy of the schema**

Call `mcp__Neon__run_sql` with `projectId: PROJECT_ID`, `branchId: BRANCH_ID`, and:

```sql
SELECT COUNT(*) FROM pipeline_loads;
```

Expected: succeeds and returns a row count (proves the branch forked real data, not an empty schema). No commit — this task produces no files.

---

### Task 2: Write migration `033-event-data-layer.sql`

**Files:**
- Create: `MyraTMS/scripts/033-event-data-layer.sql`

**Interfaces:**
- Consumes: existing tables `pipeline_loads`, `agent_calls`, `agent_jobs`, `consent_log`, `scraper_runs` (schemas confirmed against live DB in the design doc's reconciliation table).
- Produces: table `events`, columns `agent_calls.retell_cost_cents` / `agent_calls.claude_cost_cents`, functions `fn_insert_event(...)` and `fn_stage_event_type(p_stage VARCHAR)`, 5 trigger functions + triggers, views `v_stage_conversion`, `v_call_funnel`, `v_time_in_stage`, `v_cost_per_call`. All of Task 3 onward depend on these exact names.

- [ ] **Step 1: Write the full migration file**

```sql
-- ============================================================================
-- 033 — T-17 EVENT & DATA LAYER
-- ============================================================================
-- Engine 3, Phase 1, Module 1 of 3. Spec: Engine 3/T17_Event_Data_Layer.md
-- Design notes: MyraTMS/docs/superpowers/specs/2026-08-24-t17-event-data-layer-design.md
--
-- Adds an append-only `events` table populated entirely by PostgreSQL
-- triggers on tables Engine 2 already writes (pipeline_loads, agent_calls,
-- agent_jobs, consent_log, scraper_runs). No application code in the live
-- call path is touched by this migration.
--
-- Idempotent: every statement uses IF NOT EXISTS / CREATE OR REPLACE, safe
-- to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- events — append-only, tenant-aware from day one.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id                  BIGSERIAL PRIMARY KEY,

    tenant_id           INTEGER      NOT NULL DEFAULT 1,

    event_type          VARCHAR(60)  NOT NULL,
    entity_type         VARCHAR(30)  NOT NULL,
    entity_id           INTEGER      NOT NULL,

    pipeline_load_id    INTEGER      REFERENCES pipeline_loads(id),

    source              VARCHAR(40)  NOT NULL,
    actor_type          VARCHAR(20)  NOT NULL DEFAULT 'agent',

    payload             JSONB        NOT NULL DEFAULT '{}',
    stage_from          VARCHAR(30),
    stage_to            VARCHAR(30),

    occurred_at         TIMESTAMP    NOT NULL,
    recorded_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    derived_from_table  VARCHAR(40)  NOT NULL,
    derived_from_id     INTEGER      NOT NULL,
    correlation_id      VARCHAR(100),

    UNIQUE (derived_from_table, derived_from_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_load ON events(pipeline_load_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Cost scaffolding on agent_calls (design doc decision 1 — nullable, no
-- backfill; a future module starts populating these, not this one).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS retell_cost_cents INTEGER;
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS claude_cost_cents INTEGER;

-- ────────────────────────────────────────────────────────────────────────────
-- fn_insert_event — single choke point for writing to `events`. Every
-- trigger and the backfill script call this instead of INSERTing directly,
-- so the exception-safety guarantee (T-17 §5.2 — a bug here can never abort
-- the write that triggered it) lives in exactly one place.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_insert_event(
    p_tenant_id          INTEGER,
    p_event_type         VARCHAR,
    p_entity_type        VARCHAR,
    p_entity_id          INTEGER,
    p_pipeline_load_id   INTEGER,
    p_source             VARCHAR,
    p_actor_type         VARCHAR,
    p_payload            JSONB,
    p_stage_from         VARCHAR,
    p_stage_to           VARCHAR,
    p_occurred_at        TIMESTAMP,
    p_derived_from_table VARCHAR,
    p_derived_from_id    INTEGER,
    p_correlation_id     VARCHAR
) RETURNS VOID AS $$
BEGIN
    INSERT INTO events (
        tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
        source, actor_type, payload, stage_from, stage_to,
        occurred_at, derived_from_table, derived_from_id, correlation_id
    ) VALUES (
        COALESCE(p_tenant_id, 1), p_event_type, p_entity_type, p_entity_id, p_pipeline_load_id,
        p_source, p_actor_type, COALESCE(p_payload, '{}'::jsonb), p_stage_from, p_stage_to,
        COALESCE(p_occurred_at, CURRENT_TIMESTAMP), p_derived_from_table, p_derived_from_id, p_correlation_id
    )
    ON CONFLICT (derived_from_table, derived_from_id, event_type) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
    -- Never let event derivation break the write that triggered it.
    NULL;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────────
-- fn_stage_event_type — single source of truth for the pipeline_loads.stage
-- -> typed event_type mapping (T-17 §4.2). Shared by the trigger and the
-- backfill script so they can never drift apart.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_stage_event_type(p_stage VARCHAR) RETURNS VARCHAR AS $$
BEGIN
    RETURN CASE p_stage
        WHEN 'qualified'    THEN 'load.qualified'
        WHEN 'disqualified' THEN 'load.disqualified'
        WHEN 'matched'      THEN 'load.matched'
        WHEN 'booked'       THEN 'load.booked'
        WHEN 'dispatched'   THEN 'load.dispatched'
        WHEN 'delivered'    THEN 'load.delivered'
        WHEN 'scored'       THEN 'load.scored'
        WHEN 'escalated'    THEN 'load.escalated'
        ELSE NULL
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 1: pipeline_loads -> load.scanned, load.stage_changed, typed stage
-- events, load.researched.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_pipeline_loads()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'load.scanned', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            NULL, NEW.stage,
            NEW.created_at, 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage THEN
        PERFORM fn_insert_event(
            1, 'load.stage_changed', 'load', NEW.id, NEW.id,
            'system', 'system',
            jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
            OLD.stage, NEW.stage,
            COALESCE(NEW.stage_updated_at, CURRENT_TIMESTAMP), 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );

        IF fn_stage_event_type(NEW.stage) IS NOT NULL THEN
            PERFORM fn_insert_event(
                1, fn_stage_event_type(NEW.stage), 'load', NEW.id, NEW.id,
                'system', 'system',
                jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
                OLD.stage, NEW.stage,
                COALESCE(NEW.stage_updated_at, CURRENT_TIMESTAMP), 'pipeline_loads', NEW.id, 'load-' || NEW.id
            );
        END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.research_completed_at IS DISTINCT FROM NEW.research_completed_at
       AND NEW.research_completed_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'load.researched', 'load', NEW.id, NEW.id,
            'researcher', 'agent',
            jsonb_build_object('market_rate_mid', NEW.market_rate_mid, 'recommended_strategy', NEW.recommended_strategy),
            NULL, NULL,
            NEW.research_completed_at, 'pipeline_loads', NEW.id, 'load-' || NEW.id
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_pipeline_loads ON pipeline_loads;
CREATE TRIGGER trg_events_pipeline_loads
AFTER INSERT OR UPDATE ON pipeline_loads
FOR EACH ROW EXECUTE FUNCTION fn_events_from_pipeline_loads();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 2: agent_calls -> call.initiated, call.connected, call.ended,
-- call.outcome_recorded. NOTE: live column is `outcome`, not `call_outcome`
-- as the base spec's example shows (see design doc reconciliation table).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_agent_calls()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'call.initiated', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'persona', NEW.persona, 'call_type', NEW.call_type),
            NULL, NULL,
            NEW.call_initiated_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.call_connected_at IS DISTINCT FROM NEW.call_connected_at
       AND NEW.call_connected_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.connected', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent', jsonb_build_object('call_id', NEW.call_id),
            NULL, NULL, NEW.call_connected_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.call_ended_at IS DISTINCT FROM NEW.call_ended_at
       AND NEW.call_ended_at IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.ended', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'duration_seconds', NEW.duration_seconds),
            NULL, NULL, NEW.call_ended_at, 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.outcome IS DISTINCT FROM NEW.outcome
       AND NEW.outcome IS NOT NULL THEN
        PERFORM fn_insert_event(
            1, 'call.outcome_recorded', 'call', NEW.id, NEW.pipeline_load_id,
            'voice', 'agent',
            jsonb_build_object('call_id', NEW.call_id, 'outcome', NEW.outcome, 'agreed_rate', NEW.agreed_rate),
            NULL, NULL,
            COALESCE(NEW.call_ended_at, CURRENT_TIMESTAMP), 'agent_calls', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_agent_calls ON agent_calls;
CREATE TRIGGER trg_events_agent_calls
AFTER INSERT OR UPDATE ON agent_calls
FOR EACH ROW EXECUTE FUNCTION fn_events_from_agent_calls();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 3: agent_jobs -> job.completed, job.failed.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_agent_jobs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('completed', 'failed') THEN
        PERFORM fn_insert_event(
            1, 'job.' || NEW.status, 'job', NEW.id, NEW.pipeline_load_id,
            NEW.queue_name, 'system',
            jsonb_build_object('job_id', NEW.job_id, 'attempts', NEW.attempts, 'error_message', NEW.error_message),
            NULL, NULL,
            COALESCE(NEW.completed_at, NEW.failed_at, CURRENT_TIMESTAMP), 'agent_jobs', NEW.id,
            CASE WHEN NEW.pipeline_load_id IS NOT NULL THEN 'load-' || NEW.pipeline_load_id ELSE NULL END
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_agent_jobs ON agent_jobs;
CREATE TRIGGER trg_events_agent_jobs
AFTER UPDATE ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION fn_events_from_agent_jobs();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 4: consent_log -> consent.logged. Payload stores only the last 4
-- phone digits, never the full number.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_consent_log()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_insert_event(
            1, 'consent.logged', 'consent', NEW.id, NULL,
            'compliance-service', 'system',
            jsonb_build_object(
                'phone_last4', RIGHT(NEW.phone, 4),
                'consent_type', NEW.consent_type,
                'consent_source', NEW.consent_source
            ),
            NULL, NULL,
            NEW.consent_date, 'consent_log', NEW.id, NULL
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_consent_log ON consent_log;
CREATE TRIGGER trg_events_consent_log
AFTER INSERT ON consent_log
FOR EACH ROW EXECUTE FUNCTION fn_events_from_consent_log();

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger 5: scraper_runs -> scraper.run_completed. Table lives in the
-- sibling scraper/ project's migration, same physical Neon DB.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_events_from_scraper_runs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status IN ('success', 'partial', 'failed') THEN
        PERFORM fn_insert_event(
            COALESCE(NEW.tenant_id, 1), 'scraper.run_completed', 'scraper_run', NEW.id, NULL,
            'scanner', 'system',
            jsonb_build_object(
                'source_board', NEW.source, 'status', NEW.status,
                'loads_found', NEW.loads_found, 'loads_inserted', NEW.loads_inserted,
                'error_message', NEW.error_message
            ),
            NULL, NULL,
            COALESCE(NEW.completed_at, CURRENT_TIMESTAMP), 'scraper_runs', NEW.id, NULL
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_scraper_runs ON scraper_runs;
CREATE TRIGGER trg_events_scraper_runs
AFTER UPDATE ON scraper_runs
FOR EACH ROW EXECUTE FUNCTION fn_events_from_scraper_runs();

-- ────────────────────────────────────────────────────────────────────────────
-- Metric views (T-17 §4.3). v_call_funnel keeps the spec's hardcoded 30-day
-- window (it's a convenience/BI view); the read API's ?window= parameter is
-- served by a direct parametrized query, not this view. v_time_in_stage adds
-- tenant_id (missing from the base spec's version) since the read API
-- contract needs it for filtering. v_cost_per_call is new — see design doc
-- decision 1.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_stage_conversion AS
SELECT tenant_id, stage_to AS stage,
       COUNT(*) AS entries,
       COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '7 days') AS entries_7d
FROM events
WHERE event_type = 'load.stage_changed'
GROUP BY tenant_id, stage_to;

CREATE OR REPLACE VIEW v_call_funnel AS
SELECT tenant_id,
       COUNT(*) FILTER (WHERE event_type = 'call.initiated') AS calls_initiated,
       COUNT(*) FILTER (WHERE event_type = 'call.connected') AS calls_connected,
       COUNT(*) FILTER (WHERE event_type = 'call.outcome_recorded'
                         AND payload->>'outcome' = 'booked') AS calls_booked
FROM events
WHERE occurred_at > NOW() - INTERVAL '30 days'
GROUP BY tenant_id;

CREATE OR REPLACE VIEW v_time_in_stage AS
SELECT tenant_id, pipeline_load_id, stage_to AS stage,
       occurred_at,
       LEAD(occurred_at) OVER (PARTITION BY pipeline_load_id ORDER BY occurred_at) - occurred_at AS time_in_stage
FROM events
WHERE event_type = 'load.stage_changed';

CREATE OR REPLACE VIEW v_cost_per_call AS
SELECT
    COALESCE(e.tenant_id, 1) AS tenant_id,
    COUNT(ac.id) AS calls_total,
    COUNT(ac.id) FILTER (WHERE ac.retell_cost_cents IS NOT NULL OR ac.claude_cost_cents IS NOT NULL) AS calls_with_cost_data,
    ROUND(
        AVG(COALESCE(ac.retell_cost_cents, 0) + COALESCE(ac.claude_cost_cents, 0))
            FILTER (WHERE ac.retell_cost_cents IS NOT NULL OR ac.claude_cost_cents IS NOT NULL)
        / 100.0, 2
    ) AS avg_cost_per_call_dollars
FROM agent_calls ac
LEFT JOIN events e
       ON e.derived_from_table = 'agent_calls'
      AND e.derived_from_id = ac.id
      AND e.event_type = 'call.initiated'
GROUP BY COALESCE(e.tenant_id, 1);

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
cd MyraTMS
git add scripts/033-event-data-layer.sql
git commit -m "T-17: add event data layer migration (events table, triggers, views)"
```

---

### Task 3: Apply the migration to the verification branch and confirm schema objects exist

**Files:** None (no new files; uses the migration from Task 2 and the branch from Task 1).

**Interfaces:**
- Consumes: `BRANCH_DATABASE_URL` (Task 1), `MyraTMS/scripts/033-event-data-layer.sql` (Task 2), the existing `MyraTMS/scripts/apply-pipeline-migration.ts` runner (accepts a filename argument, already supports arbitrary files in `scripts/`).

- [ ] **Step 1: Apply the migration to the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/apply-pipeline-migration.ts 033-event-data-layer.sql
```

Expected: `Migration applied successfully in <N>ms` — no errors.

- [ ] **Step 2: Verify every object exists**

Call `mcp__Neon__run_sql` with `projectId: PROJECT_ID`, `branchId: BRANCH_ID`, and:

```sql
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'events') AS events_table,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'agent_calls' AND column_name = 'retell_cost_cents') AS retell_cost_col,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'agent_calls' AND column_name = 'claude_cost_cents') AS claude_cost_col,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'fn_insert_event') AS fn_insert_event,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'fn_stage_event_type') AS fn_stage_event_type,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname LIKE 'trg_events_%') AS trigger_count,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_name IN
     ('v_stage_conversion', 'v_call_funnel', 'v_time_in_stage', 'v_cost_per_call')) AS view_count;
```

Expected: `events_table=1`, `retell_cost_col=1`, `claude_cost_col=1`, `fn_insert_event=1`, `fn_stage_event_type=1`, `trigger_count=5`, `view_count=4`.

- [ ] **Step 3: Re-run the migration to confirm idempotency**

Repeat Step 1 exactly. Expected: succeeds again with no errors (proves `CREATE OR REPLACE` / `IF NOT EXISTS` coverage is complete).

No commit — this task only verifies the branch state.

---

### Task 4: Verify trigger behavior (acceptance criteria 1 and 6)

**Files:**
- Create: `MyraTMS/__tests__/pipeline/events-triggers.test.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter` (existing), `events` table + 5 triggers (Task 2/3).
- Produces: nothing consumed by later tasks — this is a leaf verification.

- [ ] **Step 1: Write the test file**

```typescript
/**
 * T-17 trigger verification — acceptance criteria 1 and 6.
 *
 * Verifies the migration 033 triggers fire correctly and are exception-safe,
 * without touching any file in the live call path. Point DATABASE_URL at the
 * Neon verification branch before running this — never point it at
 * production.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const RUN_ID = `T17-TRIG-${Date.now()}`;
const loadIds: number[] = [];
const callIds: number[] = [];
const jobIds: string[] = [];
const consentIds: number[] = [];

async function insertTestLoad(suffix: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'scanned')
     RETURNING id`,
    [`${RUN_ID}-${suffix}`],
  );
  const id = r.rows[0].id;
  loadIds.push(id);
  return id;
}

describe('T-17 event triggers', () => {
  afterAll(async () => {
    if (callIds.length) await db.query(`DELETE FROM agent_calls WHERE id = ANY($1::int[])`, [callIds]);
    if (jobIds.length) {
      await db.query(
        `DELETE FROM events WHERE derived_from_table = 'agent_jobs'
           AND derived_from_id IN (SELECT id FROM agent_jobs WHERE job_id = ANY($1::text[]))`,
        [jobIds],
      );
      await db.query(`DELETE FROM agent_jobs WHERE job_id = ANY($1::text[])`, [jobIds]);
    }
    if (consentIds.length) {
      await db.query(
        `DELETE FROM events WHERE derived_from_table = 'consent_log' AND derived_from_id = ANY($1::int[])`,
        [consentIds],
      );
      await db.query(`DELETE FROM consent_log WHERE id = ANY($1::int[])`, [consentIds]);
    }
    if (loadIds.length) {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = ANY($1::int[])`, [loadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [loadIds]);
    }
  });

  it('acceptance criterion 1: a single stage UPDATE produces exactly one load.stage_changed row', async () => {
    const id = await insertTestLoad('AC1');
    await db.query(`UPDATE pipeline_loads SET stage = 'qualified', stage_updated_at = NOW() WHERE id = $1`, [id]);

    const r = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed'`,
      [id],
    );
    expect(r.rows.length).toBe(1);

    const typed = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.qualified'`,
      [id],
    );
    expect(typed.rows.length).toBe(1);
  });

  it('acceptance criterion 6: escalated then back to calling produces both transitions, in order, queryable by pipeline_load_id', async () => {
    const id = await insertTestLoad('AC6');
    await db.query(`UPDATE pipeline_loads SET stage = 'escalated', stage_updated_at = NOW() WHERE id = $1`, [id]);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'calling', stage_updated_at = NOW() + INTERVAL '1 minute' WHERE id = $1`,
      [id],
    );

    const r = await db.query<{ stage_from: string; stage_to: string; occurred_at: string }>(
      `SELECT stage_from, stage_to, occurred_at FROM events
        WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed'
        ORDER BY occurred_at ASC`,
      [id],
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].stage_to).toBe('escalated');
    expect(r.rows[1].stage_from).toBe('escalated');
    expect(r.rows[1].stage_to).toBe('calling');
  });

  it('agent_calls INSERT produces call.initiated; outcome UPDATE produces call.outcome_recorded', async () => {
    const loadId = await insertTestLoad('CALL');
    const r = await db.query<{ id: number }>(
      `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type)
       VALUES ($1, $2, 'negotiation') RETURNING id`,
      [loadId, `${RUN_ID}-CALL-1`],
    );
    const id = r.rows[0].id;
    callIds.push(id);

    await db.query(`UPDATE agent_calls SET outcome = 'booked', agreed_rate = 2400 WHERE id = $1`, [id]);

    const initiated = await db.query(
      `SELECT id FROM events WHERE derived_from_table = 'agent_calls' AND derived_from_id = $1 AND event_type = 'call.initiated'`,
      [id],
    );
    expect(initiated.rows.length).toBe(1);

    const outcome = await db.query<{ payload: { outcome: string } }>(
      `SELECT payload FROM events WHERE derived_from_table = 'agent_calls' AND derived_from_id = $1 AND event_type = 'call.outcome_recorded'`,
      [id],
    );
    expect(outcome.rows.length).toBe(1);
    expect(outcome.rows[0].payload.outcome).toBe('booked');
  });

  it('agent_jobs status UPDATE produces job.completed', async () => {
    const loadId = await insertTestLoad('JOB');
    const jobId = `${RUN_ID}-JOB-1`;
    await db.query(
      `INSERT INTO agent_jobs (job_id, queue_name, pipeline_load_id, status)
       VALUES ($1, 'qualify-queue', $2, 'processing')`,
      [jobId, loadId],
    );
    jobIds.push(jobId);

    await db.query(`UPDATE agent_jobs SET status = 'completed', completed_at = NOW() WHERE job_id = $1`, [jobId]);

    const r = await db.query<{ event_type: string }>(
      `SELECT e.event_type FROM events e
         JOIN agent_jobs j ON j.id = e.derived_from_id AND e.derived_from_table = 'agent_jobs'
        WHERE j.job_id = $1`,
      [jobId],
    );
    expect(r.rows.map((row) => row.event_type)).toContain('job.completed');
  });

  it('consent_log INSERT produces consent.logged with only the last 4 phone digits', async () => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO consent_log (phone, consent_type, consent_source)
       VALUES ('+14165551234', 'implied_load_post', 'manual_entry') RETURNING id`,
    );
    const id = r.rows[0].id;
    consentIds.push(id);

    const events = await db.query<{ payload: { phone_last4: string } }>(
      `SELECT payload FROM events WHERE derived_from_table = 'consent_log' AND derived_from_id = $1`,
      [id],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].payload.phone_last4).toBe('1234');
  });

  it('trigger exception-safety: an unmapped stage value still succeeds on the parent table with no typed event', async () => {
    const id = await insertTestLoad('SAFE');
    await expect(
      db.query(`UPDATE pipeline_loads SET stage = 'briefed', stage_updated_at = NOW() WHERE id = $1`, [id]),
    ).resolves.toBeDefined();

    const generic = await db.query(
      `SELECT id FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.stage_changed' AND stage_to = 'briefed'`,
      [id],
    );
    expect(generic.rows.length).toBe(1);

    const typed = await db.query(
      `SELECT id FROM events WHERE pipeline_load_id = $1 AND stage_to = 'briefed'
         AND event_type LIKE 'load.%' AND event_type != 'load.stage_changed'`,
      [id],
    );
    expect(typed.rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/events-triggers.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/pipeline/events-triggers.test.ts
git commit -m "T-17: add trigger verification tests (acceptance criteria 1, 6)"
```

---

### Task 5: Verify metric views (acceptance criterion 3)

**Files:**
- Create: `MyraTMS/__tests__/pipeline/events-views.test.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter`, views `v_stage_conversion`, `v_call_funnel`, `v_time_in_stage`, `v_cost_per_call` (Task 2/3), triggers from Task 4 (views read what triggers write).

- [ ] **Step 1: Write the test file**

```typescript
/**
 * T-17 metric view verification — acceptance criterion 3.
 *
 * The base spec suggests validating against the Pilot 1 75-load
 * shadow-drain dataset; that dataset isn't available in this environment,
 * so this test seeds a small synthetic fixture with known values and
 * asserts the views compute exactly what the fixture implies.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const RUN_ID = `T17-VIEW-${Date.now()}`;
const loadIds: number[] = [];
const callIds: number[] = [];

async function insertLoad(suffix: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'scanned')
     RETURNING id`,
    [`${RUN_ID}-${suffix}`],
  );
  const id = r.rows[0].id;
  loadIds.push(id);
  return id;
}

describe('T-17 metric views', () => {
  afterAll(async () => {
    if (callIds.length) await db.query(`DELETE FROM agent_calls WHERE id = ANY($1::int[])`, [callIds]);
    if (loadIds.length) {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = ANY($1::int[])`, [loadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [loadIds]);
    }
  });

  it('v_stage_conversion counts stage_changed events per stage', async () => {
    const idA = await insertLoad('SC-A');
    const idB = await insertLoad('SC-B');
    await db.query(`UPDATE pipeline_loads SET stage = 'qualified' WHERE id = ANY($1::int[])`, [[idA, idB]]);
    await db.query(`UPDATE pipeline_loads SET stage = 'matched' WHERE id = $1`, [idA]);

    const r = await db.query<{ stage: string; entries: string }>(
      `SELECT stage, entries::text FROM v_stage_conversion WHERE tenant_id = 1 AND stage IN ('qualified', 'matched')`,
    );
    const byStage = Object.fromEntries(r.rows.map((row) => [row.stage, Number(row.entries)]));
    expect(byStage.qualified).toBeGreaterThanOrEqual(2);
    expect(byStage.matched).toBeGreaterThanOrEqual(1);
  });

  it('v_call_funnel counts initiated/connected/booked within its 30-day window', async () => {
    const loadId = await insertLoad('CF');
    const insertedCalls: number[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await db.query<{ id: number }>(
        `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type, call_connected_at)
         VALUES ($1, $2, 'negotiation', NOW()) RETURNING id`,
        [loadId, `${RUN_ID}-CF-${i}`],
      );
      insertedCalls.push(r.rows[0].id);
    }
    callIds.push(...insertedCalls);
    await db.query(`UPDATE agent_calls SET outcome = 'booked' WHERE id = $1`, [insertedCalls[0]]);
    await db.query(`UPDATE agent_calls SET outcome = 'declined' WHERE id = $1`, [insertedCalls[1]]);

    const r = await db.query<{ calls_initiated: string; calls_connected: string; calls_booked: string }>(
      `SELECT calls_initiated::text, calls_connected::text, calls_booked::text FROM v_call_funnel WHERE tenant_id = 1`,
    );
    expect(Number(r.rows[0].calls_initiated)).toBeGreaterThanOrEqual(2);
    expect(Number(r.rows[0].calls_connected)).toBeGreaterThanOrEqual(2);
    expect(Number(r.rows[0].calls_booked)).toBeGreaterThanOrEqual(1);
  });

  it('v_time_in_stage computes the interval between consecutive stage_changed events', async () => {
    const loadId = await insertLoad('TIS');
    await db.query(`UPDATE pipeline_loads SET stage = 'qualified', stage_updated_at = NOW() WHERE id = $1`, [loadId]);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() + INTERVAL '10 minutes' WHERE id = $1`,
      [loadId],
    );

    const r = await db.query<{ stage: string; time_in_stage: string | null }>(
      `SELECT stage, time_in_stage FROM v_time_in_stage WHERE pipeline_load_id = $1 ORDER BY occurred_at ASC`,
      [loadId],
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].stage).toBe('qualified');
    expect(r.rows[0].time_in_stage).not.toBeNull();
    expect(r.rows[1].time_in_stage).toBeNull();
  });

  it('v_cost_per_call reports coverage even when cost columns are null', async () => {
    const loadId = await insertLoad('CPC');
    const r = await db.query<{ id: number }>(
      `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type) VALUES ($1, $2, 'negotiation') RETURNING id`,
      [loadId, `${RUN_ID}-CPC-1`],
    );
    callIds.push(r.rows[0].id);

    const view = await db.query<{ calls_total: string; calls_with_cost_data: string }>(
      `SELECT calls_total::text, calls_with_cost_data::text FROM v_cost_per_call WHERE tenant_id = 1`,
    );
    expect(Number(view.rows[0].calls_total)).toBeGreaterThanOrEqual(1);
    expect(Number(view.rows[0].calls_with_cost_data)).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run it against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/events-views.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/pipeline/events-views.test.ts
git commit -m "T-17: add metric view verification tests (acceptance criterion 3)"
```

---

### Task 6: Write and verify the backfill script (acceptance criterion 2)

**Files:**
- Create: `MyraTMS/scripts/t17_backfill_events.ts`
- Create: `MyraTMS/__tests__/pipeline/events-backfill.test.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter`, `fn_insert_event`, `fn_stage_event_type` (Task 2).
- Produces: exported `runBackfill(): Promise<void>` from `scripts/t17_backfill_events.ts`, importable by the test file and callable standalone via `pnpm tsx`.

- [ ] **Step 1: Write the backfill script**

```typescript
/**
 * T-17 backfill: reconstructs `events` rows for everything that happened
 * before the migration 033 triggers existed. Idempotent (relies on the same
 * ON CONFLICT DO NOTHING that fn_insert_event uses) — safe to re-run or
 * interrupt. Batches by primary-key range, 5,000 rows/batch, per T-17 §5.3.
 *
 * Known limitation: pipeline_loads only stores the CURRENT stage, not stage
 * history, so backfill can only emit one load.stage_changed / typed-stage
 * event per load (stage_from = NULL, stage_to = current stage). Every stage
 * transition from this point forward is captured in full by the triggers.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t17_backfill_events.ts
 */

import { db } from '../lib/pipeline/db-adapter';

const BATCH_SIZE = 5000;

interface BackfillStep {
  table: string;
  sql: string;
}

async function maxId(table: string): Promise<number> {
  const r = await db.query<{ max: number | null }>(`SELECT MAX(id) AS max FROM ${table}`);
  return r.rows[0]?.max ?? 0;
}

async function runBatched(table: string, sql: string): Promise<void> {
  const highWaterMark = await maxId(table);
  let cursor = 0;
  while (cursor < highWaterMark) {
    const upper = Math.min(cursor + BATCH_SIZE, highWaterMark);
    await db.query(sql, [cursor, upper]);
    console.log(`[t17-backfill] ${table}: processed id (${cursor}, ${upper}]`);
    cursor = upper;
  }
}

const PIPELINE_LOADS_STEPS: BackfillStep[] = [
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.scanned', 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, NULL, created_at, 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.stage_changed', 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, stage, COALESCE(stage_updated_at, created_at), 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, fn_stage_event_type(stage), 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, stage, COALESCE(stage_updated_at, created_at), 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE fn_stage_event_type(stage) IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.researched', 'load', id, id, 'researcher', 'agent',
            jsonb_build_object('market_rate_mid', market_rate_mid, 'recommended_strategy', recommended_strategy),
            NULL, NULL, research_completed_at, 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE research_completed_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
];

const AGENT_CALLS_STEPS: BackfillStep[] = [
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.initiated', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'persona', persona, 'call_type', call_type),
            NULL, NULL, call_initiated_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.connected', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id),
            NULL, NULL, call_connected_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE call_connected_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.ended', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'duration_seconds', duration_seconds),
            NULL, NULL, call_ended_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE call_ended_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.outcome_recorded', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'outcome', outcome, 'agreed_rate', agreed_rate),
            NULL, NULL, COALESCE(call_ended_at, call_initiated_at), 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE outcome IS NOT NULL AND id > $1 AND id <= $2`,
  },
];

const AGENT_JOBS_STEPS: BackfillStep[] = [
  {
    table: 'agent_jobs',
    sql: `SELECT fn_insert_event(
            1, 'job.' || status, 'job', id, pipeline_load_id, queue_name, 'system',
            jsonb_build_object('job_id', job_id, 'attempts', attempts, 'error_message', error_message),
            NULL, NULL, COALESCE(completed_at, failed_at, queued_at), 'agent_jobs', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_jobs WHERE status IN ('completed', 'failed') AND id > $1 AND id <= $2`,
  },
];

const CONSENT_LOG_STEPS: BackfillStep[] = [
  {
    table: 'consent_log',
    sql: `SELECT fn_insert_event(
            1, 'consent.logged', 'consent', id, NULL, 'compliance-service', 'system',
            jsonb_build_object('phone_last4', RIGHT(phone, 4), 'consent_type', consent_type, 'consent_source', consent_source),
            NULL, NULL, consent_date, 'consent_log', id, NULL
          ) FROM consent_log WHERE id > $1 AND id <= $2`,
  },
];

const SCRAPER_RUNS_STEPS: BackfillStep[] = [
  {
    table: 'scraper_runs',
    sql: `SELECT fn_insert_event(
            COALESCE(tenant_id, 1), 'scraper.run_completed', 'scraper_run', id, NULL, 'scanner', 'system',
            jsonb_build_object('source_board', source, 'status', status, 'loads_found', loads_found,
                                'loads_inserted', loads_inserted, 'error_message', error_message),
            NULL, NULL, COALESCE(completed_at, started_at), 'scraper_runs', id, NULL
          ) FROM scraper_runs WHERE status IN ('success', 'partial', 'failed') AND id > $1 AND id <= $2`,
  },
];

export async function runBackfill(): Promise<void> {
  const allSteps = [
    ...PIPELINE_LOADS_STEPS,
    ...AGENT_CALLS_STEPS,
    ...AGENT_JOBS_STEPS,
    ...CONSENT_LOG_STEPS,
    ...SCRAPER_RUNS_STEPS,
  ];

  for (const step of allSteps) {
    await runBatched(step.table, step.sql);
  }

  console.log('\n[t17-backfill] coverage by source table:');
  const coverage = await db.query<{ derived_from_table: string; count: string }>(
    `SELECT derived_from_table, COUNT(*)::text AS count FROM events GROUP BY derived_from_table ORDER BY derived_from_table`,
  );
  for (const row of coverage.rows) {
    console.log(`  ${row.derived_from_table}: ${row.count}`);
  }
}

const isMainModule = process.argv[1]?.endsWith('t17_backfill_events.ts') ?? false;
if (isMainModule) {
  runBackfill()
    .then(() => {
      console.log('[t17-backfill] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[t17-backfill] failed:', err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Run it against the branch directly once, to sanity-check output**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm tsx scripts/t17_backfill_events.ts
```

Expected: a coverage summary printed per source table, process exits 0.

- [ ] **Step 3: Write the idempotency test**

```typescript
/**
 * T-17 backfill verification — acceptance criterion 2 (row-count sanity,
 * idempotent re-run).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { runBackfill } from '../../scripts/t17_backfill_events';

const RUN_ID = `T17-BACKFILL-${Date.now()}`;
let loadId: number;

beforeAll(async () => {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage, research_completed_at
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'matched', NOW())
     RETURNING id`,
    [RUN_ID],
  );
  loadId = r.rows[0].id;
  // The INSERT above already fired the live trigger. Delete those rows so
  // this test exercises only the backfill script's own SQL path.
  await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [loadId]);
});

afterAll(async () => {
  await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [loadId]);
  await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [loadId]);
});

describe('T-17 backfill', () => {
  it('reconstructs events for a pre-existing row and is safe to re-run', async () => {
    await runBackfill();
    const first = await db.query<{ event_type: string }>(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 ORDER BY event_type`,
      [loadId],
    );
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.map((r) => r.event_type)).toContain('load.scanned');
    expect(first.rows.map((r) => r.event_type)).toContain('load.researched');

    await runBackfill();
    const second = await db.query(
      `SELECT event_type FROM events WHERE pipeline_load_id = $1 ORDER BY event_type`,
      [loadId],
    );
    expect(second.rows.length).toBe(first.rows.length);
  });
});
```

- [ ] **Step 4: Run the test against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/events-backfill.test.ts
```

Expected: test passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/t17_backfill_events.ts __tests__/pipeline/events-backfill.test.ts
git commit -m "T-17: add backfill script and idempotency test (acceptance criterion 2)"
```

---

### Task 7: Write shared types and API auth/query helpers

**Files:**
- Create: `MyraTMS/lib/pipeline/events-types.ts`
- Create: `MyraTMS/lib/pipeline/events-api-helpers.ts`

**Interfaces:**
- Consumes: `getCurrentUser`, `requireRole`, `JwtPayload` from `@/lib/auth` (existing); `apiError` from `@/lib/api-error` (existing).
- Produces: `EventRow` type; `authorizeEventsRequest(req): { user: JwtPayload } | { error: Response }`; `resolveTenantId(searchParams, user): number`; `clampLimit(raw, fallback?, max?): number`; `resolveWindowDays(raw): number`. Every route in Tasks 8–9 imports these.

- [ ] **Step 1: Write the shared row type**

```typescript
export interface EventRow {
  id: number;
  tenant_id: number;
  event_type: string;
  entity_type: string;
  entity_id: number;
  pipeline_load_id: number | null;
  source: string;
  actor_type: string;
  payload: Record<string, unknown>;
  stage_from: string | null;
  stage_to: string | null;
  occurred_at: string;
  recorded_at: string;
  derived_from_table: string;
  derived_from_id: number;
  correlation_id: string | null;
}
```

- [ ] **Step 2: Write the shared auth/query helpers**

```typescript
import type { NextRequest } from 'next/server';
import { getCurrentUser, requireRole, type JwtPayload } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

/**
 * Same auth pattern as every other operator-facing route (e.g.
 * app/api/loadboard-sources/route.ts) — JWT cookie + role check, not the
 * bearer-token pattern used by the machine-to-machine /api/pipeline/import.
 */
export function authorizeEventsRequest(req: NextRequest): { user: JwtPayload } | { error: Response } {
  const user = getCurrentUser(req);
  if (!user) return { error: apiError('Unauthorized', 401) };
  const denied = requireRole(user, 'admin', 'ops');
  if (denied) return { error: denied };
  return { user };
}

/** tenant_id defaults to the caller's own tenant; only super-admins may cross tenants via ?tenant_id=. */
export function resolveTenantId(searchParams: URLSearchParams, user: JwtPayload): number {
  const requested = searchParams.get('tenant_id');
  if (requested && user.isSuperAdmin) {
    const parsed = Number(requested);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return user.tenantId;
}

export function clampLimit(raw: string | null, fallback = 100, max = 500): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function resolveWindowDays(raw: string | null): number {
  if (raw === '7d') return 7;
  if (raw === '90d') return 90;
  return 30;
}
```

- [ ] **Step 3: Commit**

```bash
cd MyraTMS
git add lib/pipeline/events-types.ts lib/pipeline/events-api-helpers.ts
git commit -m "T-17: add shared types and auth helpers for the events read API"
```

---

### Task 8: Write `GET /api/events` and `GET /api/events/:id`

**Files:**
- Create: `MyraTMS/app/api/events/route.ts`
- Create: `MyraTMS/app/api/events/[id]/route.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/pipeline/db-adapter`, `logger` from `@/lib/logger`, `EventRow` + helpers from Task 7.

- [ ] **Step 1: Write the list route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId, clampLimit } from '@/lib/pipeline/events-api-helpers';
import type { EventRow } from '@/lib/pipeline/events-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const entityType = searchParams.get('entity_type');
  const pipelineLoadId = searchParams.get('pipeline_load_id');
  const since = searchParams.get('since');
  const until = searchParams.get('until');
  const limit = clampLimit(searchParams.get('limit'));

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (pipelineLoadId) {
    params.push(Number(pipelineLoadId));
    conditions.push(`pipeline_load_id = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    conditions.push(`occurred_at <= $${params.length}`);
  }
  params.push(limit);

  try {
    const r = await db.query<EventRow>(
      `SELECT id, tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
              source, actor_type, payload, stage_from, stage_to,
              occurred_at, recorded_at, derived_from_table, derived_from_id, correlation_id
         FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return NextResponse.json({ events: r.rows });
  } catch (err) {
    logger.error('[events GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load events' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the single-event route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';
import type { EventRow } from '@/lib/pipeline/events-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<EventRow>(
      `SELECT id, tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
              source, actor_type, payload, stage_from, stage_to,
              occurred_at, recorded_at, derived_from_table, derived_from_id, correlation_id
         FROM events WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ event: r.rows[0] });
  } catch (err) {
    logger.error('[events/:id GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load event' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd MyraTMS
git add app/api/events/route.ts "app/api/events/[id]/route.ts"
git commit -m "T-17: add GET /api/events and GET /api/events/:id"
```

---

### Task 9: Write the 4 metrics routes and the API test suite (acceptance criterion 5)

**Files:**
- Create: `MyraTMS/app/api/metrics/funnel/route.ts`
- Create: `MyraTMS/app/api/metrics/stage-conversion/route.ts`
- Create: `MyraTMS/app/api/metrics/time-in-stage/route.ts`
- Create: `MyraTMS/app/api/metrics/cost-per-call/route.ts`
- Create: `MyraTMS/__tests__/pipeline/events-api.test.ts`

**Interfaces:**
- Consumes: `db`, `logger`, helpers from Task 7, views from Task 2/3, route handlers from Task 8.

- [ ] **Step 1: Write the funnel route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId, resolveWindowDays } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface FunnelRow {
  calls_initiated: number;
  calls_connected: number;
  calls_booked: number;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const windowDays = resolveWindowDays(searchParams.get('window'));

  try {
    const r = await db.query<FunnelRow>(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'call.initiated') AS calls_initiated,
         COUNT(*) FILTER (WHERE event_type = 'call.connected') AS calls_connected,
         COUNT(*) FILTER (WHERE event_type = 'call.outcome_recorded' AND payload->>'outcome' = 'booked') AS calls_booked
       FROM events
       WHERE tenant_id = $1 AND occurred_at > NOW() - ($2 || ' days')::interval`,
      [tenantId, windowDays],
    );
    return NextResponse.json({ tenant_id: tenantId, window_days: windowDays, ...r.rows[0] });
  } catch (err) {
    logger.error('[metrics/funnel GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load funnel metrics' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the stage-conversion route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StageConversionRow {
  stage: string;
  entries: number;
  entries_7d: number;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<StageConversionRow>(
      `SELECT stage, entries, entries_7d FROM v_stage_conversion WHERE tenant_id = $1 ORDER BY stage`,
      [tenantId],
    );
    return NextResponse.json({ tenant_id: tenantId, stages: r.rows });
  } catch (err) {
    logger.error('[metrics/stage-conversion GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load stage conversion metrics' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Write the time-in-stage route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TimeInStageRow {
  pipeline_load_id: number;
  stage: string;
  occurred_at: string;
  time_in_stage: string | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const stage = searchParams.get('stage');

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (stage) {
    params.push(stage);
    conditions.push(`stage = $${params.length}`);
  }

  try {
    const r = await db.query<TimeInStageRow>(
      `SELECT pipeline_load_id, stage, occurred_at, time_in_stage
         FROM v_time_in_stage
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT 500`,
      params,
    );
    return NextResponse.json({ tenant_id: tenantId, rows: r.rows });
  } catch (err) {
    logger.error('[metrics/time-in-stage GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load time-in-stage metrics' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Write the cost-per-call route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CostPerCallRow {
  calls_total: number;
  calls_with_cost_data: number;
  avg_cost_per_call_dollars: number | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<CostPerCallRow>(
      `SELECT calls_total, calls_with_cost_data, avg_cost_per_call_dollars
         FROM v_cost_per_call WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = r.rows[0] ?? { calls_total: 0, calls_with_cost_data: 0, avg_cost_per_call_dollars: null };
    return NextResponse.json({
      tenant_id: tenantId,
      ...row,
      note:
        row.calls_with_cost_data === 0
          ? 'not_yet_tracked: cost columns exist but no worker populates them yet'
          : undefined,
    });
  } catch (err) {
    logger.error('[metrics/cost-per-call GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load cost-per-call metrics' }, { status: 500 });
  }
}
```

- [ ] **Step 5: Write the API test suite covering all 6 endpoints**

```typescript
/**
 * T-17 read API verification — auth boundary, response shape, and the
 * <500ms acceptance criterion (5) at current data volume.
 */

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { GET as eventsGet } from '@/app/api/events/route';
import { GET as eventByIdGet } from '@/app/api/events/[id]/route';
import { GET as funnelGet } from '@/app/api/metrics/funnel/route';
import { GET as stageConversionGet } from '@/app/api/metrics/stage-conversion/route';
import { GET as timeInStageGet } from '@/app/api/metrics/time-in-stage/route';
import { GET as costPerCallGet } from '@/app/api/metrics/cost-per-call/route';

function tokenFor(role: string): string {
  return createToken({
    userId: 'test-user',
    email: 'test@myra.dev',
    role,
    firstName: 'Test',
    lastName: 'User',
    tenantId: 1,
    tenantIds: [1],
  });
}

function requestWithCookie(path: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set('cookie', `auth-token=${token}`);
  return new NextRequest(`http://localhost${path}`, { headers });
}

describe('T-17 read API', () => {
  it('GET /api/events rejects unauthenticated requests with 401', async () => {
    const res = await eventsGet(requestWithCookie('/api/events'));
    expect(res.status).toBe(401);
  });

  it('GET /api/events rejects a role without access with 403', async () => {
    const res = await eventsGet(requestWithCookie('/api/events', tokenFor('driver')));
    expect(res.status).toBe(403);
  });

  it('GET /api/events returns 200 with an events array for an admin', async () => {
    const res = await eventsGet(requestWithCookie('/api/events?limit=5', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /api/events/:id returns 404 for a nonexistent event', async () => {
    const res = await eventByIdGet(requestWithCookie('/api/events/999999999', tokenFor('admin')), {
      params: Promise.resolve({ id: '999999999' }),
    });
    expect(res.status).toBe(404);
  });

  const metricEndpoints: Array<[string, (req: NextRequest) => Promise<Response>]> = [
    ['/api/metrics/funnel', funnelGet],
    ['/api/metrics/stage-conversion', stageConversionGet],
    ['/api/metrics/time-in-stage', timeInStageGet],
    ['/api/metrics/cost-per-call', costPerCallGet],
  ];

  it.each(metricEndpoints)(
    'GET %s responds under 500ms for an admin (acceptance criterion 5)',
    async (path, handler) => {
      const start = Date.now();
      const res = await handler(requestWithCookie(path, tokenFor('admin')));
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500);
    },
  );
});
```

- [ ] **Step 6: Run the full API test file against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/events-api.test.ts
```

Expected: all tests pass, including the 4 timing assertions.

- [ ] **Step 7: Commit**

```bash
git add app/api/metrics __tests__/pipeline/events-api.test.ts
git commit -m "T-17: add metrics API routes and full read-API test suite (acceptance criterion 5)"
```

---

### Task 10: Run the full existing pipeline test suite against the branch (acceptance criterion 4)

**Files:** None — this task only runs existing tests, it creates nothing.

**Interfaces:**
- Consumes: every existing file under `MyraTMS/__tests__/pipeline/` (unchanged by this plan).

- [ ] **Step 1: Run the entire existing pipeline suite against the branch**

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/
```

Expected: **zero regressions** — every test that passed before this migration (compiler, dispatcher, dispatcher-prospect-gate, feedback, qualifier, ranker, researcher, scanner-import, voice, webhook, plus the 4 new T-17 files) still passes. This is the concrete proof acceptance criterion 4 asks for: the live call path's own test suite is unaffected by triggers sitting on its tables.

- [ ] **Step 2: If anything regressed, stop and diagnose before proceeding**

A regression here means a trigger is doing something other than "insert a row into `events` and swallow errors" — re-check that every trigger function in Task 2 ends with `EXCEPTION WHEN OTHERS THEN RETURN NEW;` and that no trigger uses `RAISE EXCEPTION` anywhere. Do not proceed to Task 11 until this run is clean.

No commit — this task only verifies.

---

### Task 11: Final acceptance-criteria checklist and handoff

**Files:** None — this task confirms Tasks 1–10 collectively satisfy the base spec's gate (T-17 §8, §9) and prepares the handoff to Patrice. Do not delete the Neon branch — Patrice reviews it before deciding whether to apply the migration to production.

**Interfaces:** None — this is a verification/reporting task.

- [ ] **Step 1: Walk the base spec's 6 acceptance criteria explicitly**

| # | Criterion | Verified by |
|---|---|---|
| 1 | Manual stage UPDATE → exactly one `load.stage_changed` row | Task 4, test 1 |
| 2 | Backfill idempotent, row counts consistent with source data | Task 6, test 1 + coverage printout from Step 2 |
| 3 | 3 metric views return correct results | Task 5 (all 4 views — `v_cost_per_call` is new, not in the base spec, covered too) |
| 4 | Zero regressions in the existing T-16 worker test suite | Task 10 |
| 5 | Read API responds under 500ms at current data volume | Task 9, test suite |
| 6 | escalated → calling produces both transitions, correctly ordered, queryable by `pipeline_load_id` | Task 4, test 2 |

Confirm each row's referenced test actually passed in this run (don't rely on the earlier task's report — a later task could have altered shared fixtures). Re-run any that are in doubt:

```bash
cd MyraTMS
DATABASE_URL="<BRANCH_DATABASE_URL from Task 1>" pnpm vitest run __tests__/pipeline/
```

- [ ] **Step 2: Confirm the migration was diffed against prod schema, not blind-applied**

The reconciliation table in `MyraTMS/docs/superpowers/specs/2026-08-24-t17-event-data-layer-design.md` already documents every place the base spec's assumed schema differed from the live schema (`agent_calls.outcome` vs. `call_outcome`, `scraper_runs` living in the sibling project, no cost columns). No further diffing is needed — this satisfies T-17 §9's "diffed against prod schema" gate condition.

- [ ] **Step 3: Report status back to Patrice — do not apply to production**

Summarize for Patrice: branch ID and name (`t17-verify`), all 6 acceptance criteria status, the full regression run result, and the exact production apply command they'd run themselves:

```bash
cd MyraTMS
pnpm tsx scripts/apply-pipeline-migration.ts 033-event-data-layer.sql
DATABASE_URL="<production DATABASE_URL>" pnpm tsx scripts/t17_backfill_events.ts
```

Per the design doc's session-scope decision, do not run these two commands against production in this session — that is Patrice's call after reviewing the branch results.

No commit — this task is a status report, not a code change.
