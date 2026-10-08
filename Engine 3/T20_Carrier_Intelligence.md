---
title: Carrier Intelligence & Myra Carrier Score
id: T-20
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-02, T-07, T-17, T-18, T-19, E3-00]
referenced_by: [T-21, T-22, T-23, T-25]
---

# T-20 — CARRIER INTELLIGENCE & MYRA CARRIER SCORE

**Engine 3 · Phase 2 · Module 1 of 7 (T-20 through T-26)**
**Parent:** E3-00 Master PRD §9 (Module 3, original draft), §7 (module table)
**Precondition:** Phase 0 handoff gate passed (E3-00 §9) — Pilot 1 is green, Engine 2 is live and ramping. T-17, T-18, T-19 deployed.
**Constraint (different in kind from Phase 1):** Engine 2 is now a live revenue system processing real, ramping call volume. The risk is no longer "disturbing an unvalidated experiment" — it's "disturbing a working production system." The mitigation is the same discipline that got Phase 1 built safely: additive schema, derive don't instrument, validate before cutover.

---

## 1. Objective

Build the persistent, cross-tenant carrier intelligence layer E3-00 calls "a core proprietary dataset" — without touching the existing 5-criteria matching engine (T-07), which is fully built, already fast (<500ms/load), and currently live inside Pilot 1's critical path.

Two different things are being conflated in the original draft PRD's Module 3, and T-20 separates them cleanly:

- **T-07's match score** is *load-specific*: given this load, which of these carriers fits best (lane, proximity, rate, reliability, relationship)? It stays exactly as it is.
- **The Myra Carrier Score** is *carrier-specific and persistent*: independent of any one load, how much should Myra trust this carrier overall — across every tenant that has ever dealt with them? That doesn't exist today and is what T-20 builds.

The commercial reason this matters: a carrier that defrauds Tenant A's brokerage should show up flagged the moment Tenant B tries to book them. That cross-tenant memory is the actual data moat referenced in E3-00 §10.3 — it doesn't exist if carrier history stays siloed per tenant the way the current single-tenant `carriers` table implicitly assumes.

---

## 2. Scope

**In scope:**

- `carrier_registry` — the platform-level canonical carrier identity (one row per real-world carrier, MC/DOT-keyed), independent of any tenant
- Reconciliation of the existing tenant-scoped `carriers` table against the new registry (additive FK, fuzzy-match by MC/DOT number)
- `carrier_outcome_events` — structured, derived outcome history (offered, accepted, declined, cancelled, completed, late, claim, fraud-signal) sourced via triggers, not worker code changes
- `carrier_risk_signals` — raw signals for the T-25 Risk & Fraud module to later act on (T-20 captures; T-25 decides and escalates)
- `myra_carrier_scores` — the computed, versioned, cross-tenant score
- A **shadow ranking comparison**: what would the carrier stack look like if the Myra Carrier Score were blended in as a 6th criterion, logged and compared against T-07's actual live selections, without changing what T-07 returns
- Read API

**Out of scope (explicitly deferred to T-20b):**

- Modifying T-07's matching engine to actually use the Myra Carrier Score
- Automated fraud response or carrier suspension (T-25 owns response; T-20 only captures signal)
- Cross-tenant data-sharing consent UI (T-29)

---

## 3. Design decision: derive, don't replace — same discipline, different reason

T-17 and T-18 used triggers because the call path was mid-validation and could not be touched at all. That constraint has technically lifted — Pilot 1 is green by the time T-20 is built. But `ranker-worker.ts` and the matching engine underneath it are now carrying real booking volume on the 4-gate concurrency ramp (T-00's 10 → 25 → 50 → 200/day tree). Breaking it now costs real revenue, not just a validation cycle.

So T-20 keeps the same technique for the same underlying reason: **prove the new thing against real behavior before it's allowed to influence real behavior.**

- `carrier_outcome_events` is populated by triggers on `match_results`, `loads` (delivery/completion status), and `carriers` (existing `ai_acceptance_rate`, `ai_call_count` columns) — not by editing `ranker-worker.ts`.
- The shadow ranking comparison runs as an independent scheduled job, reading what T-07 already decided and independently computing what it would have decided with the score blended in. It never writes back to `match_results` or influences `carrier_stack`.
- Cutover to T-20b happens only once there's enough real outcome volume for the score to mean something — this is the same principle already applied to persona Thompson Sampling (T-00 R-2: don't build self-improvement loops before real outcome data exists). A carrier score computed from 10 loads is noise, not intelligence.

---

## 4. Data model

### 4.1 `carrier_registry` — platform-level identity

```sql
CREATE TABLE IF NOT EXISTS carrier_registry (
    id                   SERIAL PRIMARY KEY,
    mc_number            VARCHAR(20) UNIQUE,
    dot_number           VARCHAR(20),
    legal_name           VARCHAR(200) NOT NULL,

    authority_status     VARCHAR(20),          -- from FMCSA/existing verification flow
    insurance_status     VARCHAR(20),
    insurance_verified_at TIMESTAMP,

    first_seen_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at       TIMESTAMP,

    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_carrier_registry_mc ON carrier_registry(mc_number);
CREATE INDEX idx_carrier_registry_dot ON carrier_registry(dot_number);
```

This is deliberately thin. It is not a replacement for the existing `carriers` table's operational data (contact info, equipment, home base, payment preference) — those stay tenant-scoped, because a carrier's preferred contact method or negotiated rate with Tenant A is not necessarily how they operate with Tenant B. Only *identity* and *platform-observed trust signal* live here.

### 4.2 Reconciliation — additive link, no structural change to `carriers`

```sql
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS carrier_registry_id INTEGER REFERENCES carrier_registry(id);
CREATE INDEX IF NOT EXISTS idx_carriers_registry ON carriers(carrier_registry_id);
```

`scripts/t20_reconcile_carrier_registry.ts` — matches existing `carriers` rows to `carrier_registry` by MC number (exact) first, DOT number second, and creates a new registry row for any carrier with no match. **This script depends on `carriers` actually having a populated MC-number column.** If it doesn't (verify against the live schema before building), that is flagged back to Patrice as a data-quality prerequisite, not silently worked around with a weaker match key like company name.

### 4.3 `carrier_outcome_events`

```sql
CREATE TABLE IF NOT EXISTS carrier_outcome_events (
    id                    BIGSERIAL PRIMARY KEY,
    carrier_registry_id   INTEGER NOT NULL REFERENCES carrier_registry(id),
    tenant_id             INTEGER NOT NULL DEFAULT 1,
    pipeline_load_id      INTEGER REFERENCES pipeline_loads(id),

    event_type            VARCHAR(30) NOT NULL,
    -- 'offered' | 'accepted' | 'declined' | 'cancelled_by_carrier' |
    -- 'completed_on_time' | 'completed_late' | 'claim_filed' | 'fraud_signal'

    occurred_at             TIMESTAMP NOT NULL,
    derived_from_table       VARCHAR(40) NOT NULL,
    derived_from_id           INTEGER NOT NULL,
    payload                    JSONB DEFAULT '{}',

    UNIQUE (derived_from_table, derived_from_id, event_type)
);

CREATE INDEX idx_carrier_outcomes_carrier ON carrier_outcome_events(carrier_registry_id, occurred_at DESC);
```

Populated the same way as T-17's `events` table: trigger functions on `match_results` (offered/accepted/declined via `was_selected`/`was_accepted`), on `loads` (completion/lateness from delivery timestamps vs. appointment), and on `carriers` (existing `ai_acceptance_rate` deltas). Same exception-safe trigger pattern as T-17 §5.2 — a bug here cannot block a write to a live table.

### 4.4 `carrier_risk_signals`

```sql
CREATE TABLE IF NOT EXISTS carrier_risk_signals (
    id                    SERIAL PRIMARY KEY,
    carrier_registry_id   INTEGER NOT NULL REFERENCES carrier_registry(id),

    signal_type            VARCHAR(40) NOT NULL,
    -- 'banking_change_mid_transaction' | 'insurance_lapsed' | 'authority_reassigned' |
    -- 'name_mismatch' | 'excessive_cancellation_rate' | 'multiple_mc_same_contact'

    severity                VARCHAR(20) NOT NULL DEFAULT 'medium',
    detected_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detail                     JSONB DEFAULT '{}',

    reviewed                   BOOLEAN NOT NULL DEFAULT false  -- T-25 owns triage; T-20 only flags
);
```

T-20 populates this from patterns already visible in existing data (e.g., a mid-transaction banking change is explicitly called out as a killer risk in Pilot 1's risk register — the classifier that catches it today should also write here). T-20 does **not** decide what to do about a signal — that's T-25's job. This table is the shared substrate.

### 4.5 `myra_carrier_scores` — the score itself

```sql
CREATE TABLE IF NOT EXISTS myra_carrier_scores (
    id                     SERIAL PRIMARY KEY,
    carrier_registry_id    INTEGER NOT NULL REFERENCES carrier_registry(id),

    score                    NUMERIC(5,2) NOT NULL,   -- 0-100
    formula_version           VARCHAR(10) NOT NULL,

    -- Component breakdown, for explainability
    on_time_pct                NUMERIC(5,2),
    acceptance_rate             NUMERIC(5,2),
    cancellation_rate            NUMERIC(5,2),
    claims_count                  INTEGER DEFAULT 0,
    open_risk_signals              INTEGER DEFAULT 0,
    total_loads_observed             INTEGER DEFAULT 0,

    computed_at                       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_carrier_scores_current ON myra_carrier_scores(carrier_registry_id, computed_at DESC);
```

**Score formula v1** (documented, not hardcoded silently — expected to be re-tuned once real Phase 2 volume exists, same as persona weights):

```
score = 100
  - (cancellation_rate × 40)
  - (1 - on_time_pct) × 25
  - (1 - acceptance_rate) × 15
  - (claims_count × 10, capped at 30)
  - (open_risk_signals × 15, capped at 40)
```

Floor 0, ceiling 100. A carrier with fewer than 5 observed loads (`total_loads_observed < 5`) gets `score = NULL` — insufficient data, not a bad score. This distinction matters: a new carrier should never look worse than a bad one just because it's new.

---

## 5. The shadow ranking comparison

```typescript
async function shadowCompareRanking(pipelineLoadId: number) {
  // 1. Read T-07's actual carrier_stack result from match_results for this load
  // 2. Re-score each candidate carrier by blending Myra Carrier Score in as a 6th
  //    criterion at a proposed weight (e.g. 15%, redistributed from the other five)
  // 3. Compute what the top-3 order WOULD have been
  // 4. Log both orderings side by side — never write to match_results
}
```

Run as a scheduled job against every load that reaches `matched`, reading from T-17's `events` (`load.matched`). Output: a report showing how often the blended ranking would have changed the top pick, and whether the loads where it would have changed correlate with better or worse actual outcomes (from `carrier_outcome_events`). This report — not intuition — is what justifies T-20b's weight and cutover decision.

---

## 6. Interfaces

```
GET  /api/carriers/registry/:id
GET  /api/carriers/registry/:id/score
GET  /api/carriers/registry/:id/outcomes
GET  /api/carriers/registry/:id/risk-signals
GET  /api/carriers/score-report?tenant_id=&min_loads=
GET  /api/carriers/shadow-ranking-report?since=
```

---

## 7. Acceptance criteria

1. `carrier_registry` populated via reconciliation script; match rate against existing `carriers` reported (target ≥95% by MC number; anything lower is a data-quality finding, not a script bug, and gets reported as such).
2. All four new tables deployed additively; zero columns removed or renamed on `carriers`, `match_results`, `loads`.
3. Trigger functions populate `carrier_outcome_events` correctly against a known set of historical `match_results` rows (cross-checked count).
4. `myra_carrier_scores` computed for every carrier with ≥5 observed loads; NULL correctly for carriers below that threshold.
5. Shadow ranking comparison run against at least 50 `matched` loads (real Phase 2 volume); report produced showing top-pick change rate.
6. Zero changes to `ranker-worker.ts`, the matching engine, or `match_results` write path. T-16 suite green, plus a live smoke test confirming carrier matching still returns results within the existing <500ms target.
7. All six API endpoints functional.

---

## 8. Gate

**T-20 exit gate (unblocks T-21, T-22, and feeds T-25):**

- All 7 acceptance criteria pass.
- Patrice reviews the shadow ranking report and the reconciliation match-rate report.
- Confirmed zero behavioral change to live carrier matching.

**T-20b (deferred):** blending the Myra Carrier Score into T-07's live ranking (as a 6th weighted criterion, or as a hard filter below a score floor) and wiring `carrier_risk_signals` into an automatic hold. Gated on: (a) shadow report showing the blend improves or is neutral to actual outcomes, not just plausible in theory, and (b) a minimum outcome-volume threshold Patrice sets after seeing the report in criterion 5 — not a fixed number chosen in advance.

---

## 9. Portability notes

- All new tables are plain Postgres. `carrier_registry` has no tenant coupling by design — it's the one table in Engine 3 explicitly meant to be platform-global, which is the point.
- Trigger functions follow T-17's exception-safe pattern exactly, so they're portable to any Postgres host with zero changes.
- Score formula lives in a single named function (`computeCarrierScore(version)`), versioned so historical scores remain interpretable even after the formula changes.

---

## 10. Claude Code build plan

1. Migration: `carrier_registry`, `carrier_outcome_events`, `carrier_risk_signals`, `myra_carrier_scores`, plus the additive `carriers.carrier_registry_id` column.
2. **Before writing the reconciliation script:** verify the live `carriers` table actually has a populated MC-number column. If not, stop and report back — do not substitute a weaker match key.
3. Reconciliation script (§4.2), run against a staging copy first, match-rate reported.
4. Trigger functions for `carrier_outcome_events` (§4.3), exception-safe, same pattern as T-17.
5. `computeCarrierScore()` function (§4.5) with the v1 formula, run as a scheduled job.
6. Shadow ranking comparison (§5), run against ≥50 real `matched` loads.
7. API endpoints (§6).
8. Run T-16 suite + a live smoke test of carrier matching latency — confirm zero regression.

Do not let Claude Code modify `ranker-worker.ts`, the matching engine, or the weights in T-07 in this session. If it proposes "just adding the score as a bonus multiplier since it's right there," reject it — that's T-20b, and it needs the shadow report first.

---

*End of T-20.*
