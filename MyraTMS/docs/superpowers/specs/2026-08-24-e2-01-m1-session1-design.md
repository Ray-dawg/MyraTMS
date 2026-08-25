# E2-01 M1 Session 1 — Reconciliation & Scope Design

**Date:** 2026-08-24
**Base spec:** `Engine 2/E2-01_Engine2_Expansion_PRD.md` (still authoritative for the full M1–M6 design — the classification decision table in §4.5, the data model in §4.10, the config/flags in §4.11, the test plan in §4.12, acceptance criteria in §4.13, rollout in §4.14, and the four-session build plan in §9). This document does not restate that content. It exists only to record two things the base PRD could not have known when it was written: what actually exists in the repo right now, and the two decisions needed to reconcile them.

## Why this document exists

The PRD's own §0 audit ("read before building anything") asks Claude Code to reconcile §0.2(c) — "is there a rebuilt gating layer in the repo that is not in the knowledge base?" — before Session 1. That check, plus a look at what else landed today (2026-08-24), turned up one non-conflict and one real conflict.

## Findings

### 1. §0.2(c) — no duplicate classifier exists (non-issue, confirmed)

`grep -rn "load_source_class|poster_registry|authority_lookups|classifyLoadSource"` across `lib/` and `app/` returns zero matches. M1 is genuinely new work.

Confirms the PRD's premise from an unexpected direction: T-19's own reconciliation design doc (`docs/superpowers/specs/2026-08-24-t19-tenant-policy-model-design.md`, decision 6), written earlier the same day, independently found the identical gap — "no shipper-direct/broker-posted enforcement exists anywhere in the live pipeline" — and explicitly deferred its `evaluatePolicy()` validation target to "the parallel compliance-gate work," i.e. this PRD. The two specs agree without having read each other.

### 2. `co_broker_agreements` — real conflict, resolved

T-19's migration `035-t19-tenant-policy-model.sql` (drafted today, **not yet applied** — Engine 3 tracker still reads "T-19 — Not started") already contains:

```sql
CREATE TABLE IF NOT EXISTS co_broker_agreements (
    id                      SERIAL PRIMARY KEY,
    tenant_id               BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    counterparty_name       VARCHAR(200) NOT NULL,
    counterparty_mc_number  VARCHAR(20),
    agreement_executed_at   DATE NOT NULL,
    agreement_document_url  TEXT,
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

E2-01 §4.10.4 specifies the same table with `tenant_id INTEGER NOT NULL DEFAULT 1`. Both use `CREATE TABLE IF NOT EXISTS`, so whichever migration runs first silently wins and the other's DDL becomes a no-op for the table shape. `DEFAULT 1` would also reintroduce the exact bug T-19's design doc spent its decision 2 fixing elsewhere: tenant `id=1` is `_system`, not Myra (`id=2`, slug `myra`, resolved via `fn_myra_tenant_id()`).

**Decision (confirmed with Patrice, 2026-08-24): M1's migration 040 adopts T-19's shape verbatim** — `tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, defaulted via `fn_myra_tenant_id()` where a default is needed, not a literal. M1 only adds its own `counterparty_name_normalized` column via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on top. Whichever of 035 or 040 lands first creates the table correctly; the other is a clean no-op.

### 3. FMCSA QCMobile webKey — not yet provisioned

PRD §8 flags webKey registration as an action item gating Session 1's acceptance criterion 2 (live lookup test against a known broker/carrier/private-fleet entity). **Decision (confirmed with Patrice, 2026-08-24): build now, test later.** `authority-lookup.ts` is built in full — provider chain, cache, audit-row writes, `FMCSA_QC_WEBKEY` read from env — but the live integration test stays unrun (not marked done) until a key is registered at `mobile.fmcsa.dot.gov` and dropped into `.env.local`. The synthetic classifier test suite (§4.12, 22+ cases) does not depend on this and ships complete.

## Scope of this pass

**M1 Session 1 only**, per PRD §9 Tasks 1–5 — foundation, zero live-path changes, ships behind `SHIPPER_DIRECT_GATE_ENABLED=false` regardless of code state:

1. Migration `040_shipper_direct_gate.sql` (per PRD §4.10, with the §2 correction above)
2. `lib/verification/authority-lookup.ts` (per PRD §4.3)
3. `lib/pipeline/load-source-classifier.ts` (per PRD §4.5) + 22+ synthetic fixtures (Appendix C)
4. Registry seed script — 205-shipper list + mines dossier + broker list → `poster_registry` (PRD §4.4, §4.12 step 5's registry-load half; Patrice's hand-labeled ~100–300 rows are Session 3, out of scope here)
5. `scripts/e2_backfill_load_source.ts` — shadow mode, idempotent, resumable (PRD §4.12 step 3)

**Defaults applied from PRD §8** (silence = default, per the PRD's own rule): D1 (for-hire carrier → review), D2 (no FMCSA record, no broker tokens → review), D3 (broker-token match with no record → auto-reject), D6 (seed registry from 205-shipper list at confidence 0.9). These are the four defaults that bake into the classifier's behavior and fixture set; D4/D5/D7 govern later sessions and aren't touched here.

**Explicitly not in this pass:** DAT scraper detail-panel expansion, Qualifier F0/F1 wiring, import attestation, review routing, M2 downstream assertions — PRD Sessions 2–4, gated on this session's review.

## Next step

Implementation plan via the writing-plans skill, scoped to the five items above.
