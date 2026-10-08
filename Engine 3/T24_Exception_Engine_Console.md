---
title: Exception Engine + Human Escalation Console
id: T-24
version: 1.1
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: [T-24 v1.0 — superseded same day after discovering the existing Exception Detection Engine during T-26's build]
depends_on: [T-14, T-17, T-18, T-19, T-20, T-23, E3-00]
referenced_by: [T-25, T-26]
---

# T-24 — EXCEPTION ENGINE + HUMAN ESCALATION CONSOLE

**Engine 3 · Phase 2 · Module 5 of 7**
**Parent:** E3-00 §7 (module table), original draft PRD Module 6 (Exception Engine)
**Precondition:** Phase 0 handoff gate passed. T-17, T-18, T-19, T-20, T-23 deployed.

---

## 1. Objective — and what already exists, scattered (revised — six sources, not five)

**Amendment note (2026-08-22):** this module's first draft named five scattered escalation mechanisms and proposed building a new console to unify them. Building T-26 (Document Automation) surfaced a sixth, and it isn't a minor one — it already has a real, working, production API and UI. This revision changes T-24's actual shape: instead of building a *new* console, T-24 becomes the classification layer that feeds the console that already exists.

"Escalation" at Myra today is six things:

1. `pipeline_loads.stage = 'escalated'` — the load stage machine's own escalation state, the "universal safety valve."
2. The Stuck Load Detector cron (T-14) — escalates a load after repeated retry failure.
3. The Dead Letter Sweep (T-14) — escalates a job after max attempts, sends a notification.
4. T-18's `escalations` table — populated in shadow mode, informational only, not yet consequential.
5. T-23's `v_lifecycle_late_loads` and T-20's `carrier_risk_signals` — both explicitly built to feed something downstream, neither with a downstream destination yet.
6. **The existing Exception Detection Engine and Exception Alert Center** — a working, in-production system: 8 automated rules (`unassigned_urgent`, `late_delivery_risk`, `missing_gps`, `detention_risk`, `carrier_capacity`, `rate_escalation`, `missing_docs`, `missing_checkcall`), auto-dedup, auto-resolve, a cron trigger (`/api/cron/exception-detect`), and three real routes: `GET /api/exceptions` (severity-counted list), `PATCH /api/exceptions/[id]` (acknowledge or resolve), `POST /api/exceptions/detect` (manual trigger). The UI is a slide-out Alert Center with severity counts and active/acknowledged/resolved status tabs.

Source 6 changes the right shape for this module. It isn't just another feed to poll — it already *is* almost exactly what T-24 set out to build: severity, status lifecycle, acknowledge/resolve, a real UI. Building a second one alongside it would recreate the fragmentation this module exists to fix, just with six places to check instead of five. **T-24's job is now: make the existing `exceptions` system the one true console, and get sources 1–5 flowing into it — not build a rival.**

Worth flagging in passing, for later reconciliation rather than rework now: rules `late_delivery_risk` and `missing_checkcall` already cover much of what T-23's `v_lifecycle_late_loads` was built to detect. That overlap should be reconciled when T-23 is revisited, rather than run as two separate late-detection mechanisms indefinitely.

---

## 2. Scope

**In scope:**

- `exception_classifier` — normalizes signals from sources 1–5 (§1) into the shape the **existing** `exceptions` table expects, so they surface in the Alert Center alongside the existing 8 rules
- Additive extension of the existing `exceptions` table/rule taxonomy to accommodate AI-pipeline-specific alert types (tenant-aware, since the existing 8 rules predate multi-tenancy)
- `exception_classification_rules` — versioned, tenant-scoped severity/SLA/suggested-action rules for the *new* sources, editable without a deploy (same pattern as T-18's envelopes, T-19's policies) — the existing 8 TMS rules keep their own logic untouched
- A bridge from T-18's `escalations` table (kept as-is, for its original purpose — see §4.1) into the real `exceptions` table for any row that should be human-visible
- Notification firing for new critical items, via the **existing** `/api/notifications` route

**Out of scope (explicitly deferred to T-24b):**

- Any automated action that reaches an external party — auto-calling a carrier about lateness, auto-messaging a shipper, auto-cancelling a load. Resolution stays human, via the existing Alert Center's existing acknowledge/resolve actions.
- Automated L1/L2 action-taking in the E3-00 §5.1 sense — T-24 v1 only classifies and surfaces; it doesn't act on the load's behalf
- Flipping T-18's own authority-evaluation shadow mode for voice/booking decisions — that is T-18b's gate, entirely separate from and unaffected by this module
- Replacing or modifying the Stuck Load Detector, Dead Letter Sweep, or the **existing 8-rule Exception Detection Engine** — T-24 adds new rule categories alongside them and reads their output; it doesn't touch their mechanics
- Reconciling T-23's `v_lifecycle_late_loads` with the existing `late_delivery_risk`/`missing_checkcall` rules (flagged in §1, deferred to a T-23 revisit)

---

## 3. Design decisions

### 3.1 Reuse the existing console; don't build a competing one

The temptation with an "Exception Engine" spec is to jump straight to E3-00's full vision — agents that detect, decide, and act with humans only handling the rare case. That's the target, but arriving there in one module means teaching a system to take real-world actions based on classification logic that has never been tested against real volume. T-24 v1 does the part that's unambiguously safe and immediately useful — and, now that source 6 is known, the safest and most useful version of that is *not* a new UI at all. The existing Alert Center already does severity, status lifecycle, and acknowledge/resolve correctly, in production. T-24's job is to make it see everything, not to replace it.

### 3.2 What stays separate: T-18's `escalations` vs. the real `exceptions` table

These serve different purposes and shouldn't collapse into one table. T-18's `escalations` is specifically the audit trail for **agent authority decisions** — tied to `authority_evaluations`, shadow-mode, gated on T-18b. The existing `exceptions` table is the **general operational alert system** — TMS-wide, already live, already has a UI. T-24 builds a bridge: a consequential `escalations` row (one that isn't part of T-18's still-shadow voice/booking judgments) gets promoted into a real `exceptions` row so a human actually sees it. The two tables keep their own identities and their own gates; only the bridge is new.

---

## 4. Data model

### 4.0 First: confirm the live `exceptions` schema before writing anything

The existing table's exact columns weren't available in the corpus consulted for this spec — only its behavior (severity, status active/acknowledged/resolved, dedup, auto-resolve) and its three routes. Same discipline as T-26 §4.1: Claude Code confirms the live schema before writing the migration in §4.2, rather than assuming the shape below is complete or exactly matches.

### 4.1 T-18's `escalations` table — unchanged, kept for its original purpose

No changes to T-18's table in this module. It remains the shadow-mode audit trail for agent authority decisions, gated on T-18b, exactly as T-18 specified. T-24 reads from it (for consequential, non-shadow rows only) but does not alter its schema or its gate.

### 4.2 Extending the existing `exceptions` table

```sql
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS pipeline_load_id INTEGER REFERENCES pipeline_loads(id);
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS source_module VARCHAR(30);
    -- 'tms_native' (the existing 8 rules) | 'authority_shadow' | 'carrier_risk' |
    -- 'payer_risk' | 'transaction_halt' | 'stage_escalated' | 'dead_letter' | 'stuck_load'
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS suggested_action TEXT;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMP;
```

Additive only. The 8 existing `alert_type`/rule values keep working exactly as they do today, `source_module = 'tms_native'` for all of them by default — this extension only adds room for the new categories to live in the same table, the same severity model, the same UI.

### 4.3 `exception_classification_rules` — for the new sources only

```sql
CREATE TABLE IF NOT EXISTS exception_classification_rules (
    id                   SERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL DEFAULT 1,
    source_module          VARCHAR(30) NOT NULL,
    condition                JSONB NOT NULL,    -- e.g. {"time_overdue_minutes": {">=": 240}}
    severity                  VARCHAR(20) NOT NULL,
    sla_minutes                 INTEGER NOT NULL,
    suggested_action              TEXT NOT NULL,
    is_active                       BOOLEAN DEFAULT true,
    version                          INTEGER NOT NULL DEFAULT 1,

    UNIQUE (tenant_id, source_module, version)
);
```

Governs severity/SLA for sources 1–5 only — the existing 8 TMS rules keep their own existing logic, untouched. Seed data, directly from T-00's own Module 6 example: a load 20 minutes late is routine; six hours late needs stakeholder contact. (Note the overlap flagged in §1 — this rule set should eventually be reconciled with the existing `late_delivery_risk`/`missing_checkcall` rules rather than run in parallel indefinitely.)

### 4.4 The bridge

```typescript
async function bridgeToExceptions(source: SourceSignal): Promise<void> {
  const rule = await matchClassificationRule(source);   // tenant + source_module + condition

  if (source.sourceModule === 'authority_shadow') {
    // T-18's shadow rows never reach here unless T-18b has already made them consequential —
    // this bridge does not itself decide to promote a shadow evaluation.
    return;
  }

  await db.query(`
    INSERT INTO exceptions (tenant_id, pipeline_load_id, alert_type, severity, title, description,
      source_module, suggested_action, sla_due_at, resolved, detected_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' minutes')::interval, false, NOW())
    ON CONFLICT DO NOTHING  -- same dedup discipline the existing engine already uses
  `, [source.tenantId, source.pipelineLoadId, source.exceptionType, rule.severity,
      buildTitle(source), buildDescription(source), source.sourceModule,
      rule.suggested_action, rule.sla_minutes]);

  if (rule.severity in ['critical', 'high']) {
    await fireNotification(source, rule);   // existing /api/notifications route, unmodified
  }
}
```

Pollers run against: T-23's `v_lifecycle_late_loads`, T-20's `carrier_risk_signals` where `reviewed = false`, T-25's payer-risk and transaction-halt outputs once T-25 is built, `pipeline_loads` where `stage = 'escalated'` and no corresponding `exceptions` row exists, and `agent_jobs` where `status = 'dead_letter'` and unclassified. Each poller is additive, read-only against its source, and writes only to `exceptions` via the bridge — same exception-safe discipline as every prior module's derivation layer.

---

## 5. The console — the existing one, unmodified

There is no new console in this module. The existing Alert Center (slide-out sheet, severity counts, active/acknowledged/resolved tabs) and its existing routes (`GET /api/exceptions`, `PATCH /api/exceptions/[id]`) already do exactly what T-24's first draft proposed building. Once the bridge in §4.4 is live, a late load, a carrier risk signal, or a stage-escalated load simply *appears* in the same Alert Center a dispatcher already has open, tagged with its `source_module` so it's clear where it came from.

```
Exception Alert Center (existing UI, unmodified)         [Filter: severity, status]
┌────────────────────────────────────────────────────────────────────┐
│ 🔴 CRITICAL   Load #1044   delivery_late  [source: lifecycle_late]   │
│    Suggested: Contact carrier and shipper — see resolution options   │
│                                              [Acknowledge] [Resolve]  │
├────────────────────────────────────────────────────────────────────┤
│ 🟡 MEDIUM     Carrier #882   [source: carrier_risk]                  │
│    Suggested: Review before next assignment                          │
│                                              [Acknowledge] [Resolve]  │
├────────────────────────────────────────────────────────────────────┤
│ 🟠 HIGH       Load #998   missing_checkcall  [source: tms_native]     │
│    (unchanged — one of the original 8 rules, running exactly as before) │
└────────────────────────────────────────────────────────────────────┘
```

Resolution (via the existing `PATCH /api/exceptions/[id]`) writes back through the existing mechanism; T-24 additionally writes a `exception.resolved` event into T-17's `events` table for every resolution regardless of source, so the permanent record covers both the 8 original rules and the new categories uniformly — this is the one place T-24 adds behavior to the existing route, and it's additive (a second write after the existing one succeeds, never blocking it).

---

## 6. Interfaces

**Existing, reused as-is — no changes:**

```
GET   /api/exceptions?...          (severity-counted list — already supports filtering)
PATCH /api/exceptions/[id]         (acknowledge or resolve — already works)
POST  /api/exceptions/detect       (manual trigger — already works)
```

**New, added by this module:**

```
GET   /api/exceptions/classification-rules?tenant_id=
POST  /api/exceptions/classification-rules      (new version, human actor required)
GET   /api/exceptions/sla-breaches              (SLA tracking for the new sources — the existing 8 rules don't currently carry an SLA concept)
```

---

## 7. Acceptance criteria

1. Live `exceptions` table schema confirmed before any migration is written (§4.0).
2. The bridge correctly normalizes all in-scope new source signals (lifecycle late, carrier risk, stage-escalated, dead-letter) into real `exceptions` rows — spot-checked against at least 10 known past incidents where Patrice remembers what actually happened.
3. The existing 8 TMS rules (`unassigned_urgent` through `missing_checkcall`) continue to function completely unchanged — verified by an explicit regression test, not just inspection. This is the single most important criterion in this revision: the amendment's entire point is to stop building a rival system, and breaking the real one while doing that would be the opposite of progress.
4. Existing routes (`GET /api/exceptions`, `PATCH /api/exceptions/[id]`, `POST /api/exceptions/detect`) work identically to today for both old and new alert types — no client-visible change except new rows appearing.
5. New resolution-event logging (§5) writes a T-17 `events` row after every resolution without ever blocking or altering the existing route's own response.
6. Code review confirms zero automated external actions exist anywhere in this module — no outbound call, message, or cancellation triggered by anything built here.
7. Stuck Load Detector, Dead Letter Sweep, and the existing Exception Detection cron are unmodified; T-24 only reads their output.
8. Notification firing goes through the existing `/api/notifications` route with no new notification channel built.
9. T-16 suite green.

---

## 8. Gate

**T-24 exit gate (unblocks T-25, which needs a real destination for risk signals that require human judgment; and closes the loop T-18 opened for these categories):**

- All 9 acceptance criteria pass, including criterion 3 (existing 8 rules provably unaffected) — this one doesn't get a partial pass.
- Patrice actually sees new-source exceptions arriving in the Alert Center they already use, for a trial period, before T-24 is considered "done" in practice — same bar as before, just against the real console instead of a hypothetical new one.

**T-24b (deferred):** action-taking. Each proposed automated action (e.g., "auto-send an SMS to the carrier at 30 minutes late") is scoped, shadow-tested against real classified exceptions, and turned on individually — not as a batch. This keeps the same discipline as T-17b through T-23b: no action goes live without first being proven against real data it didn't influence.

---

## 9. Portability notes

- Classification rules are plain Postgres rows, portable to any host.
- No new frontend surface is introduced by this module at all — the existing Alert Center's frontend stack is entirely untouched, which is a stronger portability position than adding a new tab would have been.

---

## 10. Claude Code build plan

1. **First:** locate the existing `exceptions` table, the Exception Detection Engine's rule implementation, and the Alert Center frontend component. Confirm the live schema (§4.0) before writing any migration.
2. Migration: additive columns on `exceptions` (§4.2), new `exception_classification_rules` table (§4.3).
3. Bridge function and pollers (§4.4) — read-only against their sources, write-only to `exceptions` via the bridge, respecting the existing dedup mechanism.
4. **Regression test first, before anything else is considered working:** confirm all 8 existing rules still fire identically post-migration (criterion 3). If this doesn't pass, stop — don't proceed to the new sources until it does.
5. Additive resolution-event logging on the existing `PATCH /api/exceptions/[id]` route (§5) — must not alter that route's existing response shape or behavior for existing callers.
6. New API endpoints (§6, new section only).
7. Spot-check bridge output against 10 real historical incidents (criterion 2) — requires Patrice's input on what actually happened, not just automated testing.
8. Run T-16 suite — confirm zero regressions, especially in the Stuck Load Detector, Dead Letter Sweep, and existing Exception Detection cron.

Do not let Claude Code build any new frontend page or component for this module — that was the mistake in the first draft, and the entire point of this amendment is not to repeat it. Do not let it add any resolution action beyond what the existing route already supports (acknowledge/resolve) — no outbound call, no message send, no auto-cancel.

---

*End of T-24.*
