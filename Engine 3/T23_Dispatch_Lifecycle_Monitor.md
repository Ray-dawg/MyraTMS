---
title: Dispatch & Load Lifecycle Monitor
id: T-23
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-10, T-17, T-19, T-20, T-22, E3-00]
referenced_by: [T-24, T-25, T-26]
---

# T-23 — DISPATCH & LOAD LIFECYCLE MONITOR

**Engine 3 · Phase 2 · Module 4 of 7**
**Parent:** E3-00 §7 (module table), original draft PRD Module 5 (Autonomous Dispatch)
**Precondition:** Phase 0 handoff gate passed. T-17 (events), T-19 (tenant policy), T-20 (carrier score), T-22 (negotiation, buy-side integration discovery) deployed.

---

## 1. Objective — and a finding this spec surfaces before proposing anything

T-10's Dispatcher (Agent 7) is described as fully working: create load, assign carrier, generate tracking, notify shipper, schedule check-calls. Reading the actual worker code closely surfaces something worth stating plainly rather than folding quietly into a data model: **`assignCarrier()` calls `/api/loads/[id]/assign`, sends a rate confirmation PDF, and immediately marks the pipeline stage `dispatched` — there is no step that waits for or records the carrier actually confirming they'll run the load.** Assignment and acceptance are treated as the same event. They aren't. A rate confirmation being sent is not a carrier agreeing to move the freight.

This gap is exactly what T-22 flagged as Dispatch One's likely purpose — negotiating and securing real carrier agreement after a load is sold — but T-22's own investigation into where Dispatch One actually plugs into the orchestrator is still pending. T-23 does not assume that integration exists or works yet. It builds the **lifecycle monitor** that makes the gap visible and measurable for the first time, and gives T-23b a concrete, evidenced reason to close it rather than a guess.

T-23's second job is making dispatch **tenant-routable**, per the locked decision in E3-00 §4.2: a Carrier-type tenant's dispatch agent is opt-in, defaulting to routing booked loads to their own in-house dispatch instead of Myra's TMS-managed flow.

---

## Reconciliation note (E2-03, 2026-08-25)

- **§1, §4.2 (`carrier_acceptance_state`):** M5 ships a deliberately smaller interim slice (E2-03 §9) ahead of this full spec — the stuck-load cron stops excluding `dispatched` and a late-pickup/missing-check-call threshold is added, purely observational. T-23's full event taxonomy and `carrier_acceptance_state` table remain a later Engine 3 Phase 2 item, not superseded by M5, just not built yet.

---

## 2. Scope

**In scope:**

- Extend T-17's `events` taxonomy (not a new parallel table) with the full post-booking lifecycle: rate confirmation sent, carrier assigned, carrier acceptance confirmed/unconfirmed, pickup check-in, in-transit pings, delivery, POD captured
- `carrier_acceptance_state` — the new explicit state T-10's flow is missing, populated by observation first, not by changing the flow
- A backfill and **measurement report**: for historical dispatched loads, how many ever recorded a real acceptance confirmation vs. how many went straight from "assigned" to "delivered" with no confirmation event at all
- `dispatch_routing_rules` — tenant-scoped resolution of dispatch mode (`myra_managed` vs `in_house_notify`), read from T-19's `tenant_policies.dispatch_agent_enabled`
- Late-detection: a read-only view comparing appointment times to actual check-in/delivery timestamps, surfaced for T-24 to act on — T-23 detects, T-24 decides
- Read API

**Out of scope (explicitly deferred to T-23b):**

- Actually wiring Dispatch One (or any mechanism) into the dispatch flow to require confirmed acceptance before a load is considered dispatched — depends on T-22's integration discovery landing first
- Live routing of a real tenant to `in_house_notify` — no second tenant exists yet to route
- Automated action on a late load (T-24's Exception Engine owns response)
- Rate confirmation / BOL / POD document generation logic itself (T-26)

---

## 3. Design decision: observe the gap before closing it

The instinct once a real gap like this is found is to fix it immediately — add a webhook, block dispatch until confirmed. That would be a live-path change to a working revenue flow based on a hypothesis, not evidence. T-23 follows the same discipline as T-20 and T-21: **measure first.** The backfill report in §5 gives Patrice a real number — "X% of dispatched loads in the last N weeks have no recorded acceptance confirmation" — before anyone decides whether and how to close it. It may turn out phone-based confirmation already happens informally and just isn't logged; it may turn out this is a genuine live risk. The report is what tells the difference.

---

## 4. Data model

### 4.1 Extending T-17's event taxonomy

New `event_type` values, same `events` table, same trigger-based derivation pattern (T-17 §5.2, exception-safe):

| event_type | derived_from_table | Fires on |
|---|---|---|
| `load.rate_confirmation_sent` | loads | rate con PDF generation / send event |
| `load.carrier_assigned` | loads | `carrier_id` set via `/assign` |
| `load.carrier_acceptance_confirmed` | carrier_acceptance_state | `confirmed_at` set |
| `load.pickup_checked_in` | loads / check_calls | pickup check-in recorded |
| `load.in_transit_ping` | location_pings | GPS ping during active transit |
| `load.delivered` | loads | status → 'Delivered' |
| `load.pod_captured` | (POD route/table) | POD upload confirmed |
| `load.late_detected` | derived (view, not trigger) | appointment time passed without check-in |

No new table for this — it's additive rows in the schema T-17 already built, which is the point of having built a general-purpose event layer instead of a load-specific one.

### 4.2 `carrier_acceptance_state` — the missing state, made explicit

```sql
CREATE TABLE IF NOT EXISTS carrier_acceptance_state (
    id                    SERIAL PRIMARY KEY,
    pipeline_load_id      INTEGER NOT NULL REFERENCES pipeline_loads(id),
    carrier_registry_id   INTEGER REFERENCES carrier_registry(id),   -- from T-20

    assigned_at             TIMESTAMP NOT NULL,
    confirmation_method       VARCHAR(30),   -- 'dispatch_one_negotiation' | 'manual_call' |
                                              -- 'rate_con_signed' | 'assumed_unconfirmed'
    confirmed_at              TIMESTAMP,     -- NULL = never confirmed, the gap this table exists to show
    confirmation_source          VARCHAR(40),   -- 'agent_calls' row ref, 'manual', etc.

    created_at                    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_acceptance_unconfirmed ON carrier_acceptance_state(pipeline_load_id) WHERE confirmed_at IS NULL;
```

Populated two ways: (1) a trigger on `loads`/`match_results` writes a row with `confirmation_method = 'assumed_unconfirmed'` and `confirmed_at = NULL` the moment `/assign` fires — capturing today's actual behavior honestly, not flatteringly; (2) if any real confirmation signal already exists somewhere (a carrier reply, a manual note, a Dispatch One call outcome once T-22 locates it), a separate trigger backfills `confirmed_at` and the real `confirmation_method`.

### 4.3 `dispatch_routing_rules`

```sql
CREATE TABLE IF NOT EXISTS dispatch_routing_rules (
    id             SERIAL PRIMARY KEY,
    tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
    mode           VARCHAR(20) NOT NULL,   -- 'myra_managed' | 'in_house_notify'
    notify_contact  VARCHAR(200),           -- email or webhook URL, required if in_house_notify
    is_active         BOOLEAN DEFAULT true,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (tenant_id)
);

-- Myra (tenant 1) seeded exactly as today's behavior
INSERT INTO dispatch_routing_rules (tenant_id, mode)
VALUES (1, 'myra_managed')
ON CONFLICT (tenant_id) DO NOTHING;
```

Resolution logic reads `tenant_policies.dispatch_agent_enabled` (T-19) as the default and lets `dispatch_routing_rules` override per-tenant, same versioned-override pattern as T-18's envelopes and T-19's policies.

### 4.4 Late-detection view

```sql
CREATE OR REPLACE VIEW v_lifecycle_late_loads AS
SELECT pl.id AS pipeline_load_id, pl.tenant_id, pl.pickup_date, pl.delivery_date,
       pl.stage,
       CASE
         WHEN pl.stage = 'dispatched' AND pl.pickup_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id
                              AND e.event_type = 'load.pickup_checked_in')
         THEN 'pickup_late'
         WHEN pl.stage = 'dispatched' AND pl.delivery_date < NOW() - INTERVAL '30 minutes'
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = pl.id
                              AND e.event_type = 'load.delivered')
         THEN 'delivery_late'
         ELSE NULL
       END AS late_status,
       NOW() - GREATEST(pl.pickup_date, pl.delivery_date) AS time_overdue
FROM pipeline_loads pl
WHERE pl.stage IN ('dispatched');
```

Read-only. Feeds T-24's severity classification (T-00's own example — 20 minutes late is routine, six hours late needs stakeholder contact — lives in T-24, not here).

---

## 5. The measurement report

`scripts/t23_acceptance_gap_report.ts` — runs against all historical `dispatched`+ loads, reports:

- Total loads dispatched in the measurement window
- % with any real acceptance confirmation signal found (vs. `assumed_unconfirmed`)
- Of the unconfirmed set, % that nonetheless delivered successfully (suggesting the gap is often benign) vs. % that had a carrier substitution, cancellation, or late pickup (suggesting the gap is where problems actually originate)

This report is a required deliverable, not optional — it's the evidence base for whether and how urgently T-23b needs to happen.

---

## 6. Interfaces

```
GET  /api/lifecycle/load/:pipelineLoadId          (full event timeline)
GET  /api/lifecycle/late?tenant_id=
GET  /api/lifecycle/acceptance-gap-report?since=
GET  /api/dispatch/routing/:tenantId               (resolves mode, does not act)
POST /api/dispatch/routing/:tenantId                (admin sets override)
```

---

## 7. Acceptance criteria

1. All 8 new event types (§4.1) populated via exception-safe triggers, same pattern as T-17 — zero changes to `loads`, `check_calls`, or any existing table's write path.
2. `carrier_acceptance_state` backfilled for all historical dispatched loads; the measurement report (§5) produced and delivered to Patrice as a real finding, not a placeholder.
3. `dispatch_routing_rules` resolves correctly for Myra (myra_managed, unchanged) and for a test fixture Carrier-type tenant (in_house_notify, notification payload correctly shaped) — no live second tenant required to test this.
4. `v_lifecycle_late_loads` validated against at least 5 known historical late loads (cross-checked manually against `agent_calls`/TMS records) — correctly flags them, doesn't flag on-time loads.
5. Zero changes to `dispatcher-worker.ts`'s actual live behavior. T-16 suite green.
6. All five API endpoints functional.

---

## 8. Gate

**T-23 exit gate (unblocks T-24, which consumes `v_lifecycle_late_loads` and lifecycle events; and T-26, which consumes rate-con/POD state):**

- All 6 acceptance criteria pass.
- Patrice reviews the acceptance-gap report (§5) and makes an informed call on T-23b's priority — this spec doesn't presume the answer.

**T-23b (deferred):**
- Closing the acceptance gap live — requiring a real confirmation signal before a load is considered `dispatched`, likely via the Dispatch One integration T-22 is locating. Explicitly sequenced *after* T-22's discovery task, not in parallel with it — building a new confirmation requirement before knowing what confirmation mechanism already exists risks duplicating or conflicting with it.
- Routing a real second tenant through `in_house_notify` — waits for an actual second tenant (T2 in E3-00's rollout order).

---

## 9. Portability notes

- All new logic (triggers, view, resolution function) is plain Postgres/TypeScript, no host coupling.
- `dispatch_routing_rules`'s `in_house_notify` mode is deliberately generic (email or webhook) so it doesn't assume any particular external tenant's tooling.

---

## 10. Claude Code build plan

1. Migration: new event-type triggers extending T-17's pattern (§4.1), `carrier_acceptance_state`, `dispatch_routing_rules` (§4.2–4.3).
2. `v_lifecycle_late_loads` view (§4.4), validated against known historical late loads.
3. Backfill script populating `carrier_acceptance_state` for historical dispatched loads.
4. Measurement report script (§5) — run it, produce actual numbers, don't stop at building the query.
5. Tenant routing resolution function + API (§6), tested against Myra and a fixture tenant.
6. Run T-16 suite — confirm zero regressions in `dispatcher-worker.ts`.
7. Deliver the acceptance-gap report to Patrice as this module's key output, alongside the code.

Do not let Claude Code modify `dispatcher-worker.ts`'s actual assignment/dispatch behavior in this session, and do not let the acceptance-gap finding get soft-pedaled in the report — if the number is bad, say so plainly; that's the entire point of building this before deciding what to do about it.

---

*End of T-23.*
