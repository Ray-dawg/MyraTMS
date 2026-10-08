---
title: Event & Data Layer
id: T-17
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-02, T-03, E3-00]
referenced_by: [T-18, T-19, T-20, T-21, T-22, T-23, T-24, T-25, T-26]
---

# T-17 — EVENT & DATA LAYER

**Engine 3 · Phase 1 · Module 1 of 3 (with T-18, T-19)**
**Parent:** E3-00 Master PRD
**Precondition:** None. Runs in parallel with the Engine 2 pilot.
**Hard constraint:** Zero changes to the live call path until the Phase 0 handoff gate (E3-00 §9) is passed.

---

## 1. Objective

Turn every event already happening inside Engine 2 into a structured, queryable, append-only record — without touching the code that runs Pilot 1. This is the bridge module. T-18 (Agent Runtime & Governance) and every Phase 2 module read from this layer; none of them can be built correctly without it.

Two things must both be true at the end of this spec:

1. A single `events` table contains a normalized record of every load-lifecycle transition, call, job, and consent action currently happening in Engine 2 — reconstructed from existing tables, not from new application code in the worker path.
2. The metrics named in T-00 §6 (stage conversion, cost per call, connect/answer rate, book rate, margin per booked load, time-in-stage) are computable from `events` alone, with a query, in under 2 seconds for 90 days of data.

---

## 2. Scope

**In scope:**

- New `events` table (append-only, tenant-aware from day one)
- A **derivation layer** that populates `events` from existing tables (`pipeline_loads`, `agent_jobs`, `agent_calls`, `consent_log`, `negotiation_briefs`, `scraper_runs`) — via PostgreSQL triggers, not application code
- A backfill script that reconstructs historical events from existing data
- A read API (`GET /events`, `GET /metrics/*`) for T-14's operator screen and future modules
- The event schema/taxonomy every future Engine 3 module (T-18 onward) will emit into

**Out of scope (explicitly deferred):**

- Any modification to `base-worker.ts`, `voice-worker.ts`, `retell-webhook.ts`, `compiler-worker.ts`, or any file in the live call path
- Real-time application-level event emission (T-17b, see §9 — deferred until after the Phase 0 gate)
- Agent governance / authority envelopes (T-18)
- Tenant policy enforcement (T-19)
- Any UI. T-14's dashboard consumes this API; this spec does not build the dashboard.

---

## 3. Design decision: derive, don't instrument

E3-00 principle 1 says Phase 1 must be isolated from the call path. The naive approach — add an `emitEvent()` call inside `base-worker.ts`'s `handleJob()` — touches the file every one of the 9 workers extends, including `voice-worker.ts`. That is a direct violation of E3-R1, no matter how careful the code review is, because it changes the artifact that is mid-validation in Pilot 1.

**T-17 instead derives events from data that Engine 2 already writes**, using PostgreSQL triggers on the existing tables. A trigger is a database object, not an application code change — it does not touch `base-worker.ts`, does not change job success/failure semantics, cannot affect retries, and cannot slow down or throw inside a worker's request path (writes happen in the same transaction as the row change Postgres already committed; on trigger failure, `events` writes are wrapped to never abort the parent transaction — see §5.3).

This is slightly less rich than direct instrumentation (no access to in-memory reasoning like "why did the agent choose persona X" beyond what's already persisted), but everything in T-00 §6's metric list is derivable from existing columns. Richer, real-time, application-level events become T-17b — a fast-follow, explicitly gated on Pilot 1 passing and a dedicated code review (§9).

---

## 4. Data model

### 4.1 `events` table

```sql
CREATE TABLE IF NOT EXISTS events (
    id                  BIGSERIAL PRIMARY KEY,

    -- Multi-tenancy (T-19 promotes this to a real FK; default 1 = Myra today)
    tenant_id           INTEGER      NOT NULL DEFAULT 1,

    -- What happened
    event_type          VARCHAR(60)  NOT NULL,   -- see §4.2 taxonomy
    entity_type         VARCHAR(30)  NOT NULL,   -- 'load' | 'call' | 'job' | 'consent' | 'carrier'
    entity_id           INTEGER      NOT NULL,   -- pipeline_loads.id / agent_calls.id / etc.

    -- Load linkage (nullable — not every event is load-scoped, e.g. scraper_runs)
    pipeline_load_id    INTEGER      REFERENCES pipeline_loads(id),

    -- Who/what caused it
    source               VARCHAR(40)  NOT NULL,   -- 'scanner' | 'qualifier' | 'researcher' |
                                                    -- 'ranker' | 'compiler' | 'voice' | 'dispatcher' |
                                                    -- 'feedback' | 'retell_webhook' | 'human' | 'system'
    actor_type           VARCHAR(20)  NOT NULL DEFAULT 'agent',  -- 'agent' | 'human' | 'system'

    -- The data
    payload              JSONB        NOT NULL DEFAULT '{}',
    stage_from            VARCHAR(30),
    stage_to              VARCHAR(30),

    -- Timing
    occurred_at           TIMESTAMP    NOT NULL,   -- when it actually happened (source row's own timestamp)
    recorded_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- when T-17 wrote it

    -- Derivation traceability
    derived_from_table    VARCHAR(40)  NOT NULL,   -- 'pipeline_loads' | 'agent_calls' | 'agent_jobs' | etc.
    derived_from_id        INTEGER      NOT NULL,   -- PK in that source table
    correlation_id          VARCHAR(100),             -- ties a load's full event chain together

    UNIQUE (derived_from_table, derived_from_id, event_type)  -- idempotent redelivery
);

CREATE INDEX idx_events_tenant_time ON events(tenant_id, occurred_at DESC);
CREATE INDEX idx_events_load ON events(pipeline_load_id, occurred_at);
CREATE INDEX idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX idx_events_entity ON events(entity_type, entity_id);
```

The `UNIQUE (derived_from_table, derived_from_id, event_type)` constraint is what makes trigger re-fires and backfill re-runs safe — `ON CONFLICT DO NOTHING` everywhere.

### 4.2 Event type taxonomy (v1)

| event_type | derived_from_table | Fires on |
|---|---|---|
| `load.scanned` | pipeline_loads | INSERT |
| `load.stage_changed` | pipeline_loads | UPDATE of `stage` |
| `load.qualified` / `load.disqualified` | pipeline_loads | stage → qualified/disqualified |
| `load.researched` | pipeline_loads | `research_completed_at` set |
| `load.matched` | pipeline_loads | stage → matched |
| `load.booked` | pipeline_loads | stage → booked |
| `load.dispatched` | pipeline_loads | stage → dispatched |
| `load.delivered` | pipeline_loads | stage → delivered |
| `load.scored` | pipeline_loads | stage → scored |
| `load.escalated` | pipeline_loads | stage → escalated |
| `call.initiated` | agent_calls | INSERT |
| `call.connected` | agent_calls | `call_connected_at` set |
| `call.ended` | agent_calls | `call_ended_at` set |
| `call.outcome_recorded` | agent_calls | `call_outcome` set |
| `job.completed` / `job.failed` | agent_jobs | `status` → completed/failed |
| `consent.logged` | consent_log | INSERT |
| `scraper.run_completed` | scraper_runs | `status` → success/partial/failed |

This list is extendable without a migration — new triggers can add new `event_type` values into the same table.

### 4.3 Metric views (built on `events`, not queried ad hoc)

```sql
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
                         AND payload->>'call_outcome' = 'booked') AS calls_booked
FROM events
WHERE occurred_at > NOW() - INTERVAL '30 days'
GROUP BY tenant_id;

CREATE OR REPLACE VIEW v_time_in_stage AS
SELECT pipeline_load_id, stage_to AS stage,
       occurred_at,
       LEAD(occurred_at) OVER (PARTITION BY pipeline_load_id ORDER BY occurred_at) - occurred_at AS time_in_stage
FROM events
WHERE event_type = 'load.stage_changed';
```

These three views answer every metric in T-00 §6 except cost-per-call, which needs Retell minute cost and Claude token cost — both already logged elsewhere (`agent_calls`, `claude-service.ts` usage). T-17 adds a `v_cost_per_call` view joining `agent_calls` cost columns once confirmed present; if not yet tracked, this is flagged back to Patrice rather than estimated.

---

## 5. Interfaces

### 5.1 Read API

```
GET  /api/events?tenant_id=&entity_type=&pipeline_load_id=&since=&until=&limit=
GET  /api/events/:id
GET  /api/metrics/funnel?tenant_id=&window=7d|30d|90d
GET  /api/metrics/stage-conversion?tenant_id=
GET  /api/metrics/time-in-stage?tenant_id=&stage=
GET  /api/metrics/cost-per-call?tenant_id=&window=
```

Read-only. No write endpoint in v1 — all writes happen via triggers or the backfill script, never via API, so there is no path for a bug in a future module to corrupt the append-only log.

### 5.2 Trigger functions

One trigger function per source table, e.g.:

```sql
CREATE OR REPLACE FUNCTION fn_events_from_pipeline_loads()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage) THEN
    INSERT INTO events (
        tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
        source, actor_type, payload, stage_from, stage_to,
        occurred_at, derived_from_table, derived_from_id, correlation_id
    ) VALUES (
        1, 'load.stage_changed', 'load', NEW.id, NEW.id,
        'system', 'system',
        jsonb_build_object('load_id', NEW.load_id, 'source', NEW.load_board_source),
        OLD.stage, NEW.stage,
        NEW.stage_updated_at, 'pipeline_loads', NEW.id,
        'load-' || NEW.id
    )
    ON CONFLICT (derived_from_table, derived_from_id, event_type) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_pipeline_loads
AFTER INSERT OR UPDATE ON pipeline_loads
FOR EACH ROW EXECUTE FUNCTION fn_events_from_pipeline_loads();
```

**Critical safety property:** trigger functions must never `RAISE EXCEPTION`. Wrap the insert in a `BEGIN ... EXCEPTION WHEN OTHERS THEN NULL; END;` block so a bug in the event derivation can never roll back or block the parent write to `pipeline_loads`, `agent_calls`, or `agent_jobs`. This is the mechanism that makes the "zero touch to the call path" guarantee real, not aspirational.

Repeat the pattern for `agent_calls`, `agent_jobs`, `consent_log`, `scraper_runs`.

### 5.3 Backfill script

`scripts/t17_backfill_events.ts` — one-time, idempotent (relies on the same `ON CONFLICT DO NOTHING`), reconstructs `events` from all historical rows in the five source tables. Runs outside the request path, batched (5,000 rows/batch), safe to re-run or interrupt.

---

## 6. Authority envelope

Not applicable in the T-18 sense — T-17 has no autonomous decision-making component; it is a passive derivation layer. The relevant constraint is a **write boundary**, not an authority envelope:

- Triggers may only `INSERT` into `events`. No trigger may `UPDATE` or `DELETE` any row in a source table.
- The read API is read-only; no mutation endpoints exist.
- `events` itself is `INSERT`-only at the application level — no `UPDATE`/`DELETE` grants for the app's DB role.

---

## 7. Portability notes

- Trigger functions are plain PL/pgSQL — portable to any Postgres-compatible host (Neon today, RDS/self-hosted later) with no code change.
- The read API is a standard Node/TypeScript service with env-only DB config — containerizable, no Vercel-specific dependencies beyond the existing pattern.
- `events` has no foreign key that would block moving it to a separate database later if event volume ever demands a dedicated store (e.g., ClickHouse) — `pipeline_load_id` is a soft reference by convention, enforced at the application layer if the table is split off.

---

## 8. Acceptance criteria

1. All five trigger functions deployed; a manual `UPDATE pipeline_loads SET stage = 'qualified' WHERE id = X` produces exactly one `load.stage_changed` row in `events` within the same transaction.
2. Backfill script run against current data produces a row count in `events` consistent with existing `pipeline_loads` stage-history volume (spot-checked against `agent_jobs` count as a cross-check).
3. `v_stage_conversion`, `v_call_funnel`, `v_time_in_stage` return correct results against a known Pilot 1 shadow-drain dataset (the 75-load shadow drain referenced in T-00 §3 is a good test fixture).
4. Zero rows changed, zero test failures, in the existing worker test suite (T-16) after trigger deployment — this is the proof the call path is untouched.
5. Read API responds to all six endpoints in §5.1 in under 500ms at current data volume.
6. A load documented to reach `escalated` and back to `calling` in `pipeline_loads` produces both transition events in `events`, in correct order, queryable by `pipeline_load_id`.

---

## 9. Gate

**T-17 exit gate (unblocks T-18, T-19, and all Phase 2 modules' design work):**

- All 6 acceptance criteria pass.
- Trigger deployment run once against a Neon branch/staging copy first, diffed against prod schema, before touching production.
- Patrice confirms the worker test suite (T-16) is green post-deployment.

**T-17b (deferred, not part of this spec's completion):** once the Phase 0 handoff gate (E3-00 §9) is passed and Pilot 1 is validated end-to-end, a follow-up spec can add direct application-level emission inside `base-worker.ts` for richer event detail (agent confidence, decision rationale, intermediate reasoning) that isn't captured in any existing column. That change gets its own code review, explicitly scoped, only after the call path is no longer mid-validation.

---

## 10. Claude Code build plan

Hand this spec to Claude Code as a single session. Suggested order:

1. Migration file: `events` table + indexes (§4.1).
2. Five trigger functions + triggers, each wrapped in exception-safe blocks (§5.2), deployed to a Neon branch first.
3. Three metric views (§4.3).
4. Backfill script (§5.3), run against the branch, row counts verified.
5. Read API (§5.1) — six endpoints, TypeScript, following the existing route patterns in the codebase.
6. Run T-16 worker test suite against the branch with triggers active — confirm zero regressions.
7. Only after 6 passes clean: apply migration to production, verify acceptance criteria 1–2 live, then run backfill against production.

Do not let Claude Code touch `base-worker.ts`, `voice-worker.ts`, `retell-webhook.ts`, or `compiler-worker.ts` in this session. If Claude Code proposes touching any of those files to "make the event emission cleaner," reject it — that's T-17b, not T-17.

---

*End of T-17.*
