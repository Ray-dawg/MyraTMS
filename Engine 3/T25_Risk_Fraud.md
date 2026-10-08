---
title: Risk & Fraud Scoring
id: T-25
version: 1.0
date: 2026-08-22
owner: Patrice Penda
status: draft
classification: Technical — Engineering Only
supersedes: []
depends_on: [T-17, T-18, T-19, T-20, T-24, E3-00]
referenced_by: [T-26, T-27]
---

# T-25 — RISK & FRAUD SCORING

**Engine 3 · Phase 2 · Module 6 of 7**
**Parent:** E3-00 §7 (module table), original draft PRD Module 7 (Risk & Fraud), Pilot 1's own kill criteria and risk register
**Precondition:** Phase 0 handoff gate passed. T-17, T-18, T-19, T-20, T-24 deployed.
**Stakes:** This is the only Phase 2 module built directly against Pilot 1's own **kill criteria** (K1: fraud resulting in cargo loss or misdirected payment; K2: any receivable becomes unrecoverable) rather than against an operational metric. Every design decision below defaults to the more conservative option.

---

## 1. Objective

Pilot 1's risk register already names the mitigations for carrier fraud and payer non-payment: NSC-verified legal name, insurance obtained directly from the insurer, a human approval gate before any rate confirmation, credit checks on every payer, a 25% concentration cap on open receivables, mid-transaction banking or contact changes halting the load outright. Some of this is already manual practice. Some of it — payer credit checking specifically — is explicitly still open; Pilot 1's own pre-launch checklist lists "Payer credit check process established" as unchecked.

T-25 formalizes what's practiced manually into a scored, auditable system, and builds what doesn't exist yet. It does **not** automate the fraud or credit *decision* — E3-00's own autonomy model already places fraud flags, banking changes, and credit exposure above tenant limit at L3, human approval required, and this spec holds that line exactly. The one exception, argued explicitly in §3.2, is automating the **halt** itself — which is a conservative default, not a decision.

---

## Reconciliation note (E2-03, 2026-08-25)

- **§4.1 ("Gate 2" carrier verification, previously deferred to T-25b):** M4 (E2-03 §8) is the live version of this, built now rather than deferred — update T-25 to point at E2-03 M4 as done, not still-outstanding.

---

## 2. Scope

**In scope:**

- Carrier risk scoring: consumes T-20's `carrier_risk_signals`, adds severity computation, routes high/critical signals to T-24's console (extending T-24's classifier with the signal types it doesn't yet score)
- **Payer credit checking — greenfield.** `payer_registry` (platform-level identity, mirroring T-20's `carrier_registry` pattern — a payer who doesn't pay Tenant A should show up flagged for Tenant B, same cross-tenant logic as carriers) and `payer_credit_assessments`
- **Concentration cap enforcement** — real-time computation of a payer's share of a tenant's open receivables against the tenant's configured cap (default 25%, per Pilot 1's own number, overridable per tenant like every other policy in this series)
- **Banking/contact-change detection** — diffs incoming carrier banking or contact details against what's on file for any load with an active (non-terminal) pipeline state, and records an automatic halt
- A defense-in-depth cross-check against T-19's double-brokering policy: did any load that T-19's `evaluatePolicy()` would have rejected actually get booked anyway
- Extending T-24's classifier with two new `source_signal` types: `payer_risk`, `transaction_halt`

**Out of scope (explicitly deferred to T-25b):**

- Actually wiring the halt into `dispatcher-worker.ts`'s live control flow so a halted load cannot be assigned or dispatched while the halt is active. T-25 builds detection and recording; making it a real block requires modifying a live-path file, which — even though halting is the conservative direction — still needs the same shadow/canary discipline as every other live-path change in this series. §3.2 argues this should be the *first* thing prioritized among all the pending `*b` cutovers, but doesn't exempt it from the process.
- Any automated fraud or credit *decision* (approve/decline). This stays human, permanently, not just until some future gate — E3-00 places it at L3 by design, not by temporary caution.
- Third-party credit bureau or NSC/FMCSA API integration (this spec defines the data model and scoring; connecting a live external verification source is a follow-on integration task, not a redesign)

---

## 3. Design decisions

### 3.1 Formalize what's practiced; build what's missing, honestly labeled as new

Carrier verification (NSC/insurance/legal name) and the banking-change halt are described in Pilot 1's risk register as things Patrice already does. T-25 formalizes those into software. Payer credit checking is different — it's greenfield, explicitly flagged as not yet built anywhere in the corpus. The spec keeps these visibly distinct in the acceptance criteria (§7) rather than treating "formalize" and "build from scratch" as the same kind of task with the same kind of risk.

### 3.2 Why automating a halt is different from automating an action

Every module in this series has held the same line: no automated action reaches an external party or changes a live outcome until it's been shadow-tested against real data. T-25 mostly holds that line too — but the banking-change halt is worth arguing about explicitly, because it's the one place in Phase 2 where automating something immediately is actually the more conservative choice, not the riskier one.

A halt doesn't complete a transaction — it prevents one from silently proceeding. The asymmetry matters: if the halt fires and there was no real problem, the cost is a delay and a human check. If the halt doesn't fire and there was a real problem, the cost is K1 or K2 — a kill criterion. That asymmetry is why this spec still builds the halt *detection and recording* now, and argues for T-25b (wiring it into the live dispatch flow) to be prioritized ahead of every other pending `*b` item — while still requiring it to go through the same process, not skip it, because "this change is probably safe" is exactly the reasoning this whole series has been built to not rely on.

---

## 4. Data model

### 4.1 `payer_registry` (platform-level, mirrors T-20's `carrier_registry`)

```sql
CREATE TABLE IF NOT EXISTS payer_registry (
    id                   SERIAL PRIMARY KEY,
    legal_name           VARCHAR(200) NOT NULL,
    known_aliases         TEXT[],
    tax_id_or_business_number VARCHAR(30),

    first_seen_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at         TIMESTAMP,
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 `payer_credit_assessments`

```sql
CREATE TABLE IF NOT EXISTS payer_credit_assessments (
    id                    SERIAL PRIMARY KEY,
    payer_registry_id     INTEGER NOT NULL REFERENCES payer_registry(id),

    credit_level             VARCHAR(20) NOT NULL,   -- 'unknown' | 'weak' | 'acceptable' | 'strong'
    assessment_source          VARCHAR(30) NOT NULL,   -- 'manual' | 'factor_declination_signal' | 'external_bureau'
    assessment_notes             TEXT,

    assessed_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessed_by                       VARCHAR(100) NOT NULL
);

CREATE INDEX idx_payer_credit_current ON payer_credit_assessments(payer_registry_id, assessed_at DESC);
```

A payer with no row here is `unknown` by definition — per Pilot 1's own rule, unknown credit is declined or flagged regardless of margin, not treated as neutral.

### 4.3 Concentration exposure (computed, not stored)

```sql
CREATE OR REPLACE VIEW v_payer_concentration_exposure AS
SELECT pl.tenant_id, pr.id AS payer_registry_id, pr.legal_name,
       SUM(pl.agreed_rate) AS open_exposure,
       SUM(pl.agreed_rate) / NULLIF(
           (SELECT SUM(agreed_rate) FROM pipeline_loads
            WHERE tenant_id = pl.tenant_id AND stage IN ('booked','dispatched','delivered')
              AND agreed_rate IS NOT NULL), 0
       ) AS concentration_pct
FROM pipeline_loads pl
JOIN payer_registry pr ON pr.id = /* resolved via shipper->payer_registry link */
WHERE pl.stage IN ('booked', 'dispatched', 'delivered')  -- not yet 'scored' = still open
GROUP BY pl.tenant_id, pr.id, pr.legal_name;
```

Computed live, not cached — concentration risk is exactly the kind of number that must never be stale.

### 4.4 `transaction_halts`

```sql
CREATE TABLE IF NOT EXISTS transaction_halts (
    id                    SERIAL PRIMARY KEY,
    pipeline_load_id      INTEGER NOT NULL REFERENCES pipeline_loads(id),

    halt_reason             VARCHAR(40) NOT NULL,
    -- 'banking_change_detected' | 'insurance_lapsed' | 'critical_carrier_risk' |
    -- 'concentration_cap_breach' | 'unknown_payer_credit'
    halt_detail                JSONB DEFAULT '{}',

    halted_at                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    halted_by                       VARCHAR(20) NOT NULL DEFAULT 'system_auto',

    resumed_at                        TIMESTAMP,
    resumed_by                           VARCHAR(100),
    resolution_note                        TEXT
);

CREATE INDEX idx_halts_active ON transaction_halts(pipeline_load_id) WHERE resumed_at IS NULL;
```

An active halt (`resumed_at IS NULL`) is what T-25b will eventually make `dispatcher-worker.ts` check before proceeding. In this spec, it's detected, recorded, and escalated — not yet enforced at the code level.

### 4.5 Banking-change detection

```typescript
async function checkBankingChange(carrierId: number, incomingDetails: BankingDetails): Promise<void> {
  const onFile = await getCarrierBankingOnFile(carrierId);
  const activeLoads = await getActivePipelineLoadsForCarrier(carrierId);  // non-terminal stages only

  if (onFile && activeLoads.length > 0 && !bankingDetailsMatch(onFile, incomingDetails)) {
    for (const load of activeLoads) {
      await recordHalt(load.id, 'banking_change_detected', { onFile, incoming: incomingDetails });
      await escalateToConsole(load.id, 'transaction_halt', severity: 'critical');  // T-24
    }
  }
}
```

---

## 5. Interfaces

```
GET   /api/risk/carrier/:carrierRegistryId
POST  /api/risk/payer/:payerRegistryId/assess       (human-entered, requires assessor identity)
GET   /api/risk/payer/:payerRegistryId/concentration?tenant_id=
GET   /api/risk/halts?status=active
POST  /api/risk/halts/:id/resume                     (human-only, requires actor + resolution note)
GET   /api/risk/double-broker-crosscheck?since=       (defense-in-depth report, §2)
```

---

## 6. Acceptance criteria

1. Carrier risk signals from T-20 get severity-scored and correctly appear in T-24's console via the classifier extension — verified against at least 5 real or seeded signals across different `signal_type` values.
2. Payer credit: a payer with no assessment on file is correctly treated as `unknown` and flagged; a test payer with a `weak` assessment is flagged; a test payer with `strong` credit and normal exposure is not flagged. This is explicitly tested as new functionality, not validated against any historical baseline (none exists).
3. Concentration math: given a tenant with known open exposure, `v_payer_concentration_exposure` computes the correct percentage against at least 5 hand-calculated test cases — 100% arithmetic accuracy required, same bar as T-19's policy evaluator, because this is deterministic math, not judgment.
4. Banking-change detection correctly fires a halt when incoming carrier banking details differ from what's on file for a carrier with an active load, and correctly does *not* fire when there's no active load or no actual change.
5. The double-broker cross-check report correctly identifies zero false positives against a known-clean sample of historically booked loads.
6. T-24's classifier is extended with `payer_risk` and `transaction_halt` source types without modifying its existing `lifecycle_late`, `carrier_risk`, `stage_escalated`, or `dead_letter` handling.
7. Zero changes to `dispatcher-worker.ts` or any other live-path file. T-16 suite green.

---

## 7. Gate

**T-25 exit gate (unblocks T-26, which needs risk state before finalizing documents; and T-27, which needs payer credit state before extending payment terms):**

- All 7 acceptance criteria pass.
- Patrice reviews the payer credit and concentration logic specifically, since it's new and has no historical baseline to validate against — this is the one place in T-25 where "does this match reality" can't be checked by comparison, only by judgment.

**T-25b (deferred, but flagged as the priority item among all pending `*b` cutovers given §3.2):** wiring the active-halt check into `dispatcher-worker.ts` so a halted load genuinely cannot proceed, not just gets flagged. Still requires the same shadow/canary treatment as every other live-path change — the argument in §3.2 is for sequencing priority, not for skipping the process.

---

## 8. Portability notes

- All new tables are plain Postgres. `payer_registry` is platform-level by design, same reasoning as T-20's `carrier_registry`.
- Concentration exposure is computed live from `pipeline_loads`, so it has no cache-invalidation problem to port — it's correct by construction on any host that can query the table.

---

## 9. Claude Code build plan

1. Migration: `payer_registry`, `payer_credit_assessments`, `transaction_halts` (§4.1, 4.2, 4.4).
2. `v_payer_concentration_exposure` view (§4.3), validated against hand-calculated cases.
3. Carrier risk severity scoring, extending T-20's signals — wire into T-24's classifier as an additional rule set, not a parallel system.
4. Payer credit assessment API and flagging logic (§5, criterion 2).
5. Banking-change detection function (§4.5), tested against active vs. inactive load scenarios.
6. Double-broker cross-check report (§2, criterion 5).
7. Extend T-24's classifier with `payer_risk` and `transaction_halt` source types — additive only.
8. Run T-16 suite — confirm zero regressions, especially in `dispatcher-worker.ts`, which stays untouched.

Do not let Claude Code wire the halt into `dispatcher-worker.ts`'s actual control flow in this session, even though it's the module where "just add the check, it's obviously safe" will be the most tempting shortcut in this entire spec series. Detection and recording only.

---

*End of T-25.*
