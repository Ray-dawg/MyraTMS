---
title: Engine 2 Expansion — Shipper-Direct Hard Gate & the E2→E3 Bridge
id: E2-01
version: 1.0
date: 2026-08-24
owner: Patrice Penda
status: draft
classification: Technical — Engineering + Founder
supersedes: []
depends_on: [T-00, T-04, T-04A, T-05, T-08, T-10, T-13, T-19, T-24, T-25, E3-00, Myra_Engine2_Pilot1_Definition]
referenced_by: [T-19, T-25]
note: |
  Single PRD for the live Engine 2 expansion. Module M1 (the hard gate) is the
  only P0 and ships first, behind a flag defaulting ON. Everything else is
  sequenced behind it. This document is handed to Claude Code one module at a
  time — never the whole thing in one session. §0 is a codebase audit and must
  be read before any build session; it corrects three assumptions the corpus
  currently carries.
---

# E2-01 — ENGINE 2 EXPANSION
## Shipper-Direct Hard Gate & the Engine 2 → Engine 3 Bridge

| Field | Value |
|---|---|
| Document | E2-01 (Engine 2 expansion master) |
| Version | 1.0 |
| Date | 2026-08-24 |
| Owner | Patrice Penda, Founder |
| Status | DRAFT — awaiting decisions in §8 |
| Parent | T-00 (Engine 2 system report), E3-00 (Engine 3 master PRD) |
| Build tool | Claude Code, one module per session |
| Live path | **Yes.** This is the first spec since T-16 that intentionally modifies the live call path. Every change is flagged, reviewed, and reversible. |

---

## 0. Codebase audit — read before building anything

Step 1 of the build order was "check for an existing FMCSA/SAFER/NSC authority-lookup integration; reuse if it exists." Result of a full-corpus grep and read:

### 0.1 What exists

| Asset | Where | Reusable for the gate? |
|---|---|---|
| `carriers.authority_status` column (`'Active' \| 'Verified'`) | Migration 001; used in Qualifier Filter 2 | **No.** It is a manually-set status on *our carrier network*, not a lookup. Nothing populates it from an external source. |
| `mcNumber` field on carrier objects | `myra_negotiation_brief_schema.ts:253` (comment: "FMCSA MC number (US) or NSC (CA)") | Field only. No lookup behind it. |
| DAT scraper `cellBroker` selector → `row.broker` | T-04A §8.1, §8.3 | **Partially.** Captures the poster's *company name* into `shipper_company`. Does **not** capture MC#, DOT#, or company type. `rowHTML` is captured in memory for re-parse but **not persisted**. |
| `co_broker_agreements` DDL | T-19 §4.4 | **Yes — DDL reused verbatim** (§4.10). Confirm the table is actually live in Neon; T-19 is `status: draft`. If absent, M1's migration creates it with identical shape (see §4.10 note on the `tenants` FK). |
| `exceptions` table + Alert Center UI | Live TMS; T-24 §4.2 extends it with `source_module`, `pipeline_load_id`, `suggested_action`, `sla_due_at` | **Yes.** Review routing goes through this, same pattern T-25 uses for `unknown_payer_credit`. |
| `escalated` stage | T-00 §2.3 — "universal safety valve, can re-enter" | **Yes.** Loads awaiting human source-review sit at `escalated`; no new stage needed. |
| Pilot 1 shipper lead list (205 Ontario shippers) + Ontario mines dossier | `Ontario_Carrier_Network_Directory_1.xlsx`, `Ontario_Mines_Intelligence_Report.docx`, C-02 | **Yes.** Seeds the poster registry (§4.4) so the ICP is accept-on-sight from day 1. |

**There is no FMCSA, SAFER, QCMobile, CVOR, or NSC lookup client anywhere in the codebase.** T-25 §2 explicitly defers "third-party credit bureau or NSC/FMCSA API integration" to a follow-on task. M1 builds that client (`lib/verification/authority-lookup.ts`) and T-25's Gate 2 carrier verification consumes it later — reuse runs in reverse from what the build order assumed.

### 0.2 Three things the corpus gets wrong

These are not nitpicks. Each one would send Claude Code down a wrong path.

**(a) T-19 assumes a shipper-direct filter that does not exist.**
T-19 §1, §6, §8, §10 and §11 all reference "the Qualifier's current hardcoded shipper-direct filter (T-05, 'Filter 3')" and expect `pipeline_loads.qualification_reason` to already contain values like `shipper_direct_required`. In the actual `qualifier-worker.ts` and in T-05 §2, **Filter 3 is lane coverage.** The six filters are freshness, equipment, lane, margin, DNC, fatigue. No filter reads poster identity. No `shipper_direct_required` value has ever been written. T-19's replay harness would find zero rows to compare against and its "100% agreement" acceptance criterion would pass vacuously. §7 of this document specifies the exact T-19 edits.

**(b) `qualification_reason` holds prose, not codes.**
T-05 §2 specified coded failures (`fail('pickup_too_soon', …)`). The shipped worker writes the human sentence instead: `'Pickup date is less than 4 hours away or in the past'`, `'No active carriers with flatbed equipment'`, etc. Anything downstream that pattern-matches on reason (T-19 harness, T-25 cross-check, funnel metrics) is matching on free text. M1 fixes this for all filters, not just the new one (§4.9).

**(c) Pilot 1 promises Kevin a classifier that is not in the code.**
`Myra_Engine2_Pilot1_Definition` §3.1: *"Engine 2 evaluates poster identity, contact domain, posting language, repeat-posting behaviour and lane patterns, then assigns a confidence score."* §4.1: *"Broker-posted loads are excluded from the pilot queue."* Risk register #3: *"Classifier filters to shipper-direct. Manual verification of posting source before acceptance."* Pre-launch checklist: *"Classifier validated; confidence scoring calibrated on a manual sample."* None of that exists in the project snapshot. If a rebuilt gating layer exists in the repo but was never pre-loaded here, **stop and reconcile before Session 1** — this PRD is written against what is in the knowledge base. Either way, M1 is the thing that makes §3.1 of the pilot document true.

### 0.3 Two domain facts that reshape the classification rule

The build order says: *"Carrier-only authority or no authority record → accept as shipper-direct."* Two facts break that as written:

1. **A Canadian domestic-only broker has no FMCSA record.** Canadian domestic brokerage requires no federal broker authority (the pilot document says so itself, §4.2 and §14). A Loadlink or DAT poster like "Maple Freight Solutions Inc." running Ontario–Quebec only will return *nothing* from FMCSA — and under the rule as written would be auto-accepted as shipper-direct. **"No record" is the exact signature of the entity we are trying to exclude.** It must never auto-accept.
2. **A for-hire carrier posting a load is re-tendering someone else's freight.** A carrier that picked up a shipper's load and can't cover it posts it to find a partner carrier. That load's shipper relationship belongs to the carrier, not Myra. It is not shipper-direct, and re-brokering it carries the same contractual exposure. The only carrier-authority poster that *is* shipper-direct is a **private fleet** — a manufacturer or mine that owns trucks (has CVOR/DOT as a private carrier) and is tendering its own freight. FMCSA distinguishes these (Operation Classification: *Auth. For Hire* vs *Private (Property)*).

The decision table in §4.5 keeps the spirit of the rule (authority type, not board source) and closes both holes. The economic argument for biasing hard toward reject: Pilot 1 §4 establishes that load supply exceeds pilot requirement by roughly two orders of magnitude. **A false reject costs one load out of thousands. A false accept is kill criterion K4.** Every ambiguous branch resolves toward reject-or-review, never accept.

---

## 1. Objective

Extend the live Engine 2 pipeline so that (a) no load can reach a voice call, a brief, or a dispatch unless its poster has been positively classified as a direct shipper or an executed co-broker counterparty, and (b) the pipeline picks up the handful of Engine 3 capabilities that are cheap to add now, make Pilot 1 safer or more legible to Kevin, and make the eventual T-19b/T-18b cutovers a swap rather than a rewrite.

One sentence:

> **Engine 2 books only freight it is entitled to book, proves it on every row, and reports the funnel it actually ran.**

---

## 2. Scope

### In scope

| Module | Name | Priority | Live path? |
|---|---|---|---|
| **M1** | Shipper-direct hard gate (authority-type classification, poster registry, geographic scope, manual attestation, review routing) | **P0** | Yes — Qualifier, Scanner, import route |
| M2 | Downstream policy assertions (Compiler + Dispatcher refuse unclassified loads) and brief fields | P0 (ships with M1) | Yes — Compiler, Dispatcher |
| M3 | Pilot gates in software: payer-credit hold before the call, carrier-verification hold before rate con | P1 | Yes — Compiler, Dispatcher |
| M4 | Call concurrency governor (daily budget, per-phone lock, error-rate brake) | P1 | Yes — Voice |
| M5 | Funnel + gate instrumentation on the operator screen | P1 | No |
| M6 | Pipeline hygiene: walk-load terminal state (R-6), expiry sweeper for stalled review loads | P2 | Yes — gate.ts, cron |

### Out of scope

- Multi-tenancy, `tenant_id` propagation, `evaluatePolicy()` wiring (T-19 / T-19b). M1 is single-tenant and reads policy from env. It is written so T-19b replaces the *source* of policy, not the logic (§4.11).
- Authority envelopes, budgets as envelope fields (T-18 / T-18b). M4's governor is a stopgap with the same shape.
- Shipper-side acquisition agent, contract freight intake (T-30), any new Retell agent.
- Cross-border loads. Explicitly rejected by M1's geographic filter; not "supported later" within this document.
- Automating the fraud/credit *decision*. M3 enforces the *hold*; the decision stays human (E3-00 L3).
- Any change to `matchCarriers()`, the rate cascade, persona sampling, or the feedback loops.

---

## 3. Module map and sequencing

```
Week 1                                  Week 2                     Week 3
├── M1 Session 1: schema + lookup +     ├── M3 pilot gates         ├── M6 hygiene
│   registry + classifier + tests       ├── M4 governor            └── T-19 reconciliation PR
├── M1 Session 2: capture + qualifier   └── M5 instrumentation
│   + import attestation
├── M1 Session 3: review routing +
│   backfill + calibration
└── M1/M2 Session 4: assertions +
    brief + flag ON + code review
```

Sequencing rule, same as T-00 §5: **M1 ships before anything else is touched.** M2 ships in the same deploy as M1 because a gate with no downstream assertion is a filter, not a gate. M3–M6 wait for M1's first week of live data.

---

## 4. M1 — Shipper-Direct Hard Gate

### 4.1 Design principle

*Classify the poster, not the posting.* Board source tells you where the load was seen. Authority type tells you who is entitled to tender it. The gate reads authority type from a registry (fast, local, compounding) and falls back to an external lookup (slow, rate-limited, cached). Unknown is not neutral. Failure is closed.

Three properties are non-negotiable:

1. **Positive classification or no call.** A load advances past `scanned` only with `load_source_class IN ('shipper_direct', 'co_brokered')`. Absence of a class is a reject, not a pass.
2. **Enforced at three points.** Qualifier decides. Compiler and Dispatcher *assert* (M2). Mirrors E3-00 §4.2 and E3-R2. A load injected mid-pipeline by any future route cannot bypass the gate.
3. **Every decision is a row.** Class, method, confidence, evidence snapshot, evaluated-at. Kevin can be shown the row for any load.

### 4.2 Poster identity capture at ingestion

Every ingest path must populate the poster identity block on `pipeline_loads` (columns in §4.10). What each path can capture:

| Path | Fields available | Change required |
|---|---|---|
| **DAT headless scraper** (T-04A, live) | Results row: company name (`cellBroker`). Load detail expansion: MC#, DOT#, DAT credit score, days-to-pay, company type badge where shown | Add detail-expansion step per row (click → read → close). New env-driven selectors `DAT_SEL_DETAIL_MC`, `DAT_SEL_DETAIL_DOT`, `DAT_SEL_DETAIL_COMPANY_TYPE`, `DAT_SEL_DETAIL_CREDIT`. Persist `poster_raw_html` (first 4 KB of detail panel) — the audit trail T-04A intended but never stored. Budget: detail expansion adds ~1–2 s/row; at 5-min polls over ~50 new rows this is fine. If DAT's UI exposes MC# in the results grid without expansion, use that and skip expansion. |
| **DAT / Truckstop / 123LB / Loadlink official APIs** (stubs) | Poster company + MC/DOT are standard payload fields on DAT and Truckstop; Loadlink exposes company profile | Map into the same columns in each adapter's `mapXLoad()`. Stubs stay stubs; the mapping is written now so cutover is a one-line `loadboard_sources` change (T-00 §5 Phase 2). |
| **CSV / JSON import** (`/api/pipeline/import`) | Whatever the operator provides | **No inference.** Required `shipper_direct_attestation` per §4.8. Optional `poster_mc_number`, `poster_dot_number` columns honoured if present. |

Normalisation at capture: MC# and DOT# stripped to digits (`MC-123456` → `123456`); company name → `normalize_company_name()` (lowercase, strip punctuation and legal suffixes `inc|ltd|ltée|corp|co|llc|limited`, collapse whitespace). Both the raw and normalized forms are stored.

### 4.3 Authority lookup client — `lib/verification/authority-lookup.ts`

A single module, no worker dependency, callable from Qualifier now and from T-25's carrier verification later.

```typescript
interface AuthorityLookupInput {
  mcNumber?: string;        // digits only
  dotNumber?: string;       // digits only
  companyName?: string;     // raw; client normalizes
  country: 'CA' | 'US';
}

type EntityClass =
  | 'broker'               // broker authority active (alone or dual with carrier)
  | 'carrier_for_hire'     // carrier authority, for-hire, no broker authority
  | 'carrier_private'      // carrier authority, private fleet (shipper with trucks)
  | 'shipper'              // registry-confirmed shipper, no operating authority
  | 'unknown';             // no record, ambiguous, or lookup failed

interface AuthorityLookupResult {
  entityClass: EntityClass;
  legalName: string | null;
  mcNumber: string | null;
  dotNumber: string | null;
  cvorNumber: string | null;
  provider: 'fmcsa_qcmobile' | 'fmcsa_safer' | 'on_cvor' | 'registry' | 'none';
  authority: {
    broker: 'active' | 'inactive' | 'none' | 'unknown';
    commonOrContract: 'active' | 'inactive' | 'none' | 'unknown';
    operationClassification: 'for_hire' | 'private' | 'unknown';
  };
  status: 'resolved' | 'not_found' | 'ambiguous' | 'error';
  latencyMs: number;
  rawSnapshot: unknown;     // stored to authority_lookups.response
}

export async function lookupAuthority(input: AuthorityLookupInput): Promise<AuthorityLookupResult>;
```

Provider chain, in order, first resolved wins:

1. **`authority_lookups` cache** — keyed on `mc:{n}` / `dot:{n}` / `name:{normalized}`; TTL 30 days for resolved rows, 24 h for `not_found`, 0 for `error`.
2. **FMCSA QCMobile API** (`mobile.fmcsa.dot.gov/qc/services/...`, free `webKey`, register before Session 1). By docket (MC) → by DOT → by name. Expected fields: `brokerAuthorityStatus`, `commonAuthorityStatus`, `contractAuthorityStatus`, `allowedToOperate`, `legalName`, `dbaName`, operation classification. **Confirm the live field names against one real response before writing the mapper** (T-24 §4.0 discipline). Rate limit: conservative 10 req/s, exponential backoff on 429/5xx, hard timeout 4 s.
3. **FMCSA SAFER company snapshot** (Playwright, reuse the T-04A browser pool) — fallback when QCMobile is down or lacks operation classification.
4. **Ontario MTO Carrier Safety Rating search** (Playwright) — name → CVOR#, fleet size, rating. Establishes "this Canadian entity operates trucks" but **cannot** distinguish private from for-hire and says nothing about brokerage. Used as corroboration, never as sole accept evidence.

Name search returns multiple matches → `status: 'ambiguous'` unless exactly one match shares the poster's province/state. Ambiguous is unknown.

Every call writes one `authority_lookups` row regardless of outcome.

### 4.4 Poster registry — `poster_registry`

Platform-level (no `tenant_id`), mirroring T-20 `carrier_registry` and T-25 `payer_registry`: a poster who is a broker for Tenant A is a broker for Tenant B.

Purpose: turn every human decision and every external lookup into a permanent fact, so the external-lookup and review branches shrink toward zero. Brokers repost daily; after week one the overwhelming majority of board rows resolve from the registry in a single indexed SQL hit.

Seed at migration time:

| Source | Rows | `entity_class` | `class_source` |
|---|---|---|---|
| Pilot 1 Ontario shipper lead list (205) | 205 | `shipper` | `seed_shipper_list` |
| Ontario mines dossier (operating mines with named operators) | ~40 | `shipper` | `seed_mines_dossier` |
| Distinct `pipeline_loads.shipper_company` from all scanner runs to date, hand-labelled by Patrice (§4.12) | ~100–300 | as labelled | `human_review` |
| Known-broker name list (Appendix B) | ~60 | `broker` | `seed_broker_list` |

Registry rows carry `confidence` (0–1). Seeds from the shipper list are 0.9, mines dossier 0.95, human review 1.0, FMCSA-resolved 0.95, heuristic 0.6.

### 4.5 Classification decision table

`classifyLoadSource(load, policy)` — pure function over `(poster identity, registry hit, lookup result, co-broker agreements, attestation)`. Returns `{ class, method, confidence, reasonCode, evidence }`.

| # | Condition (first match wins) | `load_source_class` | Verdict | `qualification_reason` (on reject/review) |
|---|---|---|---|---|
| 0 | Manual import, `shipper_direct_attestation = 'no'` | `broker_posted` | **REJECT** | `broker_posted_attested` |
| 1 | Manual import, `attestation = 'yes'` | `shipper_direct` | **ACCEPT** (method `manual_attestation`, conf 1.0) | — |
| 2 | Manual import, `attestation = 'unknown'` | `unresolved` | **REVIEW** | `poster_unresolved_review` |
| 3 | Registry hit, `entity_class = 'broker'`, **and** active `co_broker_agreements` row matching MC# (or normalized name if MC absent) | `co_brokered` | **ACCEPT** (method `co_broker_agreement`) | — |
| 4 | Registry hit, `entity_class = 'broker'`, no agreement | `broker_posted` | **REJECT** | `broker_posted_no_agreement` |
| 5 | Registry hit, `entity_class IN ('shipper', 'carrier_private')`, conf ≥ 0.8 | `shipper_direct` | **ACCEPT** (method `registry`) | — |
| 6 | Registry hit, `entity_class = 'carrier_for_hire'` | `carrier_reposted` | **REVIEW** | `poster_carrier_reposted_review` |
| 7 | No registry hit → lookup. `authority.broker = 'active'` (alone or dual) → check agreements → same as 3/4 | `co_brokered` / `broker_posted` | ACCEPT / **REJECT** | `broker_posted_no_agreement` |
| 8 | Lookup: carrier authority, `operationClassification = 'private'`, no broker authority | `shipper_direct` | **ACCEPT** (method `fmcsa_authority`, conf 0.9) | — |
| 9 | Lookup: carrier authority, `for_hire`, no broker authority | `carrier_reposted` | **REVIEW** | `poster_carrier_reposted_review` |
| 10 | Lookup: carrier authority, operation classification `unknown` | `unresolved` | **REVIEW** | `poster_unresolved_review` |
| 11 | Lookup `not_found` **and** normalized name matches strong-broker token list (Appendix B) | `broker_posted` | **REJECT** (method `heuristic`, conf 0.7) | `broker_posted_inferred` |
| 12 | Lookup `not_found`, no broker tokens, no registry hit | `unresolved` | **REVIEW** | `poster_unresolved_review` |
| 13 | Lookup `ambiguous` or `error` (timeout, 5xx, no webKey) | `unresolved` | **REVIEW** (never accept on infra failure) | `authority_lookup_failed_review` |
| 14 | No poster identity at all (no name, no MC, no DOT) | `unresolved` | **REJECT** — a board row with no poster is not a load we can act on | `poster_identity_missing` |

Deviation from the build order, flagged for decision (§8-D1, §8-D2): rows 6/9 route for-hire carriers to review rather than accept; rows 11–12 do **not** accept on "no record". Rationale in §0.3.

Review outcomes write back to the registry (§4.7), so each poster is reviewed at most once. Rows 3–6 then absorb them permanently.

### 4.6 Qualifier integration and filter order

`qualifier-worker.ts` filter chain becomes:

```
F0  Geographic scope        (config; <1 ms)      → out_of_geographic_scope
F1  Poster classification   (registry SQL ~3 ms; external lookup only on miss, ≤4 s)
                                                 → codes per §4.5
F2  Freshness               (existing)           → pickup_too_soon
F3  Equipment match         (existing)           → no_equipment_match
F4  Lane coverage           (existing)           → (no reject today; unchanged)
F5  Margin viability        (existing)           → margin_too_thin
F6  DNC                     (existing)           → dnc_listed
F7  Shipper fatigue         (existing stub)      → shipper_fatigue
```

Why F0 and F1 lead: they are the only two filters that answer "are we *allowed* to touch this load." Everything after answers "is it *worth* touching." Cost is controlled by the registry cache; the external lookup runs only on registry miss, which after week one is the minority path. Freshness is <1 ms and could sit first for cost reasons — but a stale load that is also broker-posted should be recorded as `broker_posted_no_agreement`, not `pickup_too_soon`, because the *registry write* on that load is the asset. Order is a correctness choice, not a performance one.

F0 geographic scope: reject unless `origin_country = destination_country` and both `IN GEOGRAPHIC_SCOPE_COUNTRIES` (default `CA`). Closes Pilot 1 §4.2, which the current Qualifier does not enforce.

On ACCEPT, the Qualifier writes the poster block (`load_source_class`, `_method`, `_confidence`, `_evaluated_at`, `poster_registry_id`) **in the same UPDATE** that advances to `qualified`. On REJECT, same fields plus `qualification_reason` code in the `disqualified` UPDATE. On REVIEW, §4.7.

Priority score: `+100` when `load_source_method IN ('registry','manual_attestation')` and registry confidence ≥ 0.9 — verified-shipper freight moves to the front of the queue. This is the ICP-first lever: the 205-shipper list is now a priority signal, not just a filter.

### 4.7 Review routing

REVIEW verdict:

1. `UPDATE pipeline_loads SET stage = 'escalated', qualification_reason = <code>, load_source_class = <class>, …`
2. Insert into `exceptions` via T-24's bridge shape with `source_module = 'load_source_review'`, `severity = 'medium'`, `sla_due_at = NOW() + 4h business hours`, `suggested_action` = one of: *"Confirm whether {poster} is a direct shipper or a broker. Registry will remember your answer."* / *"{poster} holds for-hire carrier authority and is posting freight — confirm this is their own private-fleet freight."* Payload includes the evidence snapshot so the operator can decide from the alert card without opening SAFER.
3. New route `POST /api/pipeline/loads/:id/resolve-source` — body `{ entity_class, applies_to_poster: boolean, note }`. Effects, in one transaction: upsert `poster_registry` (conf 1.0, `class_source = 'human_review'`, `verified_by = <user>`), update the load's poster block, set `stage = 'scanned'`, re-enqueue to `qualify-queue`. The Qualifier then resolves it deterministically from the registry — the human never bypasses the filter chain, they only inform it.
4. Expiry: the existing `pipeline-health` cron (5 min) moves any `escalated` load with `qualification_reason LIKE '%_review'` and `pickup_date < NOW() + 4h` to `expired` with `notes = 'review SLA missed'`. The exception auto-resolves. Nothing waits forever.

If T-24's `exceptions` extension columns are not yet live, M1's migration adds exactly those four columns with T-24's DDL (`IF NOT EXISTS`) — additive, identical shape, so T-24 finds them already there.

### 4.8 Manual import attestation

`/api/pipeline/import` (CSV/JSON):

- New required field `shipper_direct_attestation ∈ {'yes','no','unknown'}`. Accepted at file level (applies to every row) and overridden per row if the column is present. A file with neither → `400 attestation_required`. `'unknown'` is accepted by the API and routes to review; it is not a way to skip the question.
- Stored on each `pipeline_loads` row: `shipper_direct_attestation`, `attested_by` (JWT user id), `attested_at`.
- `created_by` for these rows changes from `'scanner-csv-v1'` to `'scanner-csv-v2'` so the pre/post-attestation populations are separable in metrics.
- UI: the import dialog gets a required radio group and, for `'yes'`, a one-line confirmation: *"I confirm these loads were tendered to Myra directly by the shipper or under an executed co-broker agreement."* The sentence is logged verbatim with the attestation — this is the written record Pilot 1 risk register #3 calls "manual verification of posting source."

### 4.9 Reason codes — the step-7 report

**What `qualification_reason` produces today:** prose sentences (§0.2b). Nothing in T-19's harness would match.

**What it produces after M1:** a code from this closed set, `VARCHAR(50)`, with the human sentence moved to a new `qualification_detail TEXT` column.

| Code | Filter | Terminal stage |
|---|---|---|
| `out_of_geographic_scope` | F0 | `disqualified` |
| `broker_posted_no_agreement` | F1 | `disqualified` |
| `broker_posted_inferred` | F1 | `disqualified` |
| `broker_posted_attested` | F1 | `disqualified` |
| `poster_identity_missing` | F1 | `disqualified` |
| `poster_unresolved_review` | F1 | `escalated` → (`scanned` on resolve \| `expired` on SLA) |
| `poster_carrier_reposted_review` | F1 | `escalated` → same |
| `authority_lookup_failed_review` | F1 | `escalated` → same |
| `pickup_too_soon` | F2 | `disqualified` |
| `no_equipment_match` | F3 | `disqualified` |
| `margin_too_thin` | F5 | `disqualified` |
| `dnc_listed` | F6 | `disqualified` |
| `shipper_fatigue` | F7 | `disqualified` |

Accept rows have `qualification_reason = NULL` and the class in `load_source_class`. **`shipper_direct_required` is retired before it was ever written.** T-19 edits in §7.

Backfill: existing prose rows are mapped to codes by prefix match in the migration (`'Pickup date is less'` → `pickup_too_soon`, etc.). Unmapped → `legacy_unmapped`, prose preserved in `qualification_detail`.

### 4.10 Data model

```sql
-- 040_shipper_direct_gate.sql  (additive; every statement idempotent)

-- 4.10.1 pipeline_loads: poster identity + classification block
ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS poster_company_raw          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS poster_company_normalized   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS poster_mc_number            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS poster_dot_number           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS poster_raw_html             TEXT,
  ADD COLUMN IF NOT EXISTS poster_registry_id          INTEGER,
  ADD COLUMN IF NOT EXISTS load_source_class           VARCHAR(20),
      -- 'shipper_direct' | 'co_brokered' | 'broker_posted' | 'carrier_reposted' | 'unresolved'
  ADD COLUMN IF NOT EXISTS load_source_method          VARCHAR(30),
      -- 'registry' | 'fmcsa_authority' | 'co_broker_agreement' | 'manual_attestation' | 'heuristic' | 'human_review'
  ADD COLUMN IF NOT EXISTS load_source_confidence      NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS load_source_evaluated_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS load_source_evidence        JSONB,
  ADD COLUMN IF NOT EXISTS shipper_direct_attestation  VARCHAR(10),   -- 'yes' | 'no' | 'unknown' | NULL (board-sourced)
  ADD COLUMN IF NOT EXISTS attested_by                 VARCHAR(100),
  ADD COLUMN IF NOT EXISTS attested_at                 TIMESTAMP,
  ADD COLUMN IF NOT EXISTS qualification_detail        TEXT;

-- qualification_reason becomes a code; width is fine at 200 but constrain semantically via CHECK after backfill
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_source_class ON pipeline_loads(load_source_class, stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_poster_mc    ON pipeline_loads(poster_mc_number) WHERE poster_mc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_loads_poster_norm  ON pipeline_loads(poster_company_normalized);

-- 4.10.2 poster_registry (platform-level)
CREATE TABLE IF NOT EXISTS poster_registry (
    id                    SERIAL PRIMARY KEY,
    legal_name            VARCHAR(200),
    normalized_name       VARCHAR(200) NOT NULL,
    mc_number             VARCHAR(20),
    dot_number            VARCHAR(20),
    cvor_number           VARCHAR(20),
    country               VARCHAR(2),
    province_state        VARCHAR(10),
    entity_class          VARCHAR(20) NOT NULL,
        -- 'broker' | 'carrier_for_hire' | 'carrier_private' | 'shipper' | 'unknown'
    class_source          VARCHAR(30) NOT NULL,
        -- 'seed_shipper_list' | 'seed_mines_dossier' | 'seed_broker_list' | 'fmcsa_authority' | 'heuristic' | 'human_review'
    confidence            NUMERIC(3,2) NOT NULL,
    authority_snapshot    JSONB,
    last_verified_at      TIMESTAMP,
    verified_by           VARCHAR(100),
    posting_count         INTEGER NOT NULL DEFAULT 0,
    first_seen_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes                 TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_registry_mc   ON poster_registry(mc_number)  WHERE mc_number  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_registry_dot  ON poster_registry(dot_number) WHERE dot_number IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_poster_registry_name ON poster_registry(normalized_name, country);

-- 4.10.3 authority_lookups (audit + cache)
CREATE TABLE IF NOT EXISTS authority_lookups (
    id              SERIAL PRIMARY KEY,
    lookup_key      VARCHAR(250) NOT NULL,    -- 'mc:123456' | 'dot:7890' | 'name:{normalized}|CA'
    provider        VARCHAR(30)  NOT NULL,
    status          VARCHAR(20)  NOT NULL,    -- 'resolved' | 'not_found' | 'ambiguous' | 'error'
    entity_class    VARCHAR(20),
    request         JSONB,
    response        JSONB,
    latency_ms      INTEGER,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_authority_lookups_key ON authority_lookups(lookup_key, created_at DESC);

-- 4.10.4 co_broker_agreements — T-19 §4.4 DDL, verbatim, so T-19 finds it in place
-- NOTE: T-19's DDL declares tenant_id REFERENCES tenants(id). If tenants does not
-- exist yet, create without the FK and let T-19's migration add it:
--   ALTER TABLE co_broker_agreements ADD CONSTRAINT fk_cba_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE TABLE IF NOT EXISTS co_broker_agreements (
    id                      SERIAL PRIMARY KEY,
    tenant_id               INTEGER NOT NULL DEFAULT 1,
    counterparty_name       VARCHAR(200) NOT NULL,
    counterparty_mc_number  VARCHAR(20),
    agreement_executed_at   DATE NOT NULL,
    agreement_document_url  TEXT,
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'terminated'
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- M1 addition (additive to T-19's shape): normalized name for MC-less Canadian counterparties
ALTER TABLE co_broker_agreements ADD COLUMN IF NOT EXISTS counterparty_name_normalized VARCHAR(200);

-- 4.10.5 exceptions — T-24 §4.2 columns, only if T-24 hasn't landed
ALTER TABLE exceptions
  ADD COLUMN IF NOT EXISTS pipeline_load_id  INTEGER REFERENCES pipeline_loads(id),
  ADD COLUMN IF NOT EXISTS source_module     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS suggested_action  TEXT,
  ADD COLUMN IF NOT EXISTS sla_due_at        TIMESTAMP;
```

`poster_registry_id` is intentionally not a hard FK — registry rows are merged and deduplicated over time and a load must keep pointing at *something*.

### 4.11 Configuration and flags

| Variable | Default | Effect |
|---|---|---|
| `SHIPPER_DIRECT_GATE_ENABLED` | `true` | **Default ON.** `false` = F0/F1 skipped, class written as `NULL`, M2 assertions log-only. Exists so the gate can be pulled in one env change without a deploy, not so it ships off. |
| `SHIPPER_DIRECT_GATE_MODE` | `enforce` | `shadow` = classify and write every column, but never reject or route to review on F1. Used for the historical backfill (§4.12) and for a maximum 24 h live observation if §8-D4 chooses it. |
| `GEOGRAPHIC_SCOPE_COUNTRIES` | `CA` | Comma list. F0. |
| `DOMESTIC_ONLY` | `true` | F0 requires origin and destination country to match. |
| `FMCSA_QC_WEBKEY` | — | Required. Missing key → every lookup is `error` → every registry-miss goes to review. Gate still closed, never open. |
| `AUTHORITY_LOOKUP_TIMEOUT_MS` | `4000` | Per provider. |
| `AUTHORITY_LOOKUP_CACHE_DAYS` | `30` | Resolved-row TTL. |
| `LOAD_SOURCE_REVIEW_SLA_HOURS` | `4` | Business hours, shipper timezone. |

`classifyLoadSource(load, policy)` takes a `policy` object with the same fields T-19's `PolicyEvaluationInput` needs (`loadSourcePolicy`, `geographicScope`, active agreements). In M1 the object is built from env. T-19b swaps in `tenant_policies` and deletes ~15 lines. That is the whole cutover.

### 4.12 Test plan

**Synthetic set (unit, required for merge):** one fixture per row of §4.5 (0–14), plus: dual-authority broker with agreement, expired agreement, agreement by normalized name without MC, lookup timeout, lookup 429 then success, name search with two matches in different provinces (→ ambiguous), name search with two matches one in poster's province (→ resolved), private-fleet with lapsed authority (→ still `carrier_private`; authority lapse is a T-25 concern, not a source-class concern). Minimum 22 cases. 100% pass; this is deterministic logic, same bar as T-19 §8.

**Historical sample (calibration, required before flag ON):**
1. `SELECT DISTINCT shipper_company, COUNT(*) FROM pipeline_loads WHERE shipper_company IS NOT NULL GROUP BY 1 ORDER BY 2 DESC` — every poster the scraper has ever seen, ordered by frequency.
2. Patrice labels each as `shipper` / `broker` / `carrier` / `don't know` in a sheet. Expected effort: the top 100 posters will cover the large majority of rows; budget 45 minutes.
3. Run `scripts/e2_backfill_load_source.ts` in `shadow` mode over every historical `pipeline_loads` row — writes the classification block, rejects nothing.
4. Compare machine class vs Patrice label. **Acceptance: zero labelled brokers classified `shipper_direct`; zero labelled brokers classified `co_brokered`.** False rejects and reviews are reported but not gating.
5. Load Patrice's labels into `poster_registry` (`class_source = 'human_review'`, conf 1.0).

**Live observation (optional, §8-D4):** 24 h of `shadow` on the live scanner, then read the distribution: % accept / reject / review, registry hit rate, external lookup p95. Then flip to `enforce`.

### 4.13 Acceptance criteria

1. Migration 040 applied to staging and production with zero behavioural change while `SHIPPER_DIRECT_GATE_ENABLED=false`. T-16 suite green.
2. `lookupAuthority()` resolves a known broker MC, a known for-hire carrier DOT, and a known private-fleet entity correctly against live FMCSA; all three write `authority_lookups` rows.
3. Synthetic set: 22+ cases, 100% pass.
4. Historical backfill: zero labelled-broker → accept. Report attached to the PR.
5. Registry seeded: 205 shipper-list rows + mines rows + Patrice's labels + broker list. `SELECT COUNT(*) FROM poster_registry` matches the seed manifest.
6. Every `pipeline_loads` row created after flag ON has non-null `load_source_class`, `_method`, `_evaluated_at`. Query for exceptions returns zero rows after 24 h.
7. A REVIEW load appears in the Alert Center within 5 s of qualification, with evidence visible; `resolve-source` returns it to `scanned` and it re-qualifies from the registry with `method = 'registry'`.
8. A CSV import without attestation returns 400. With `'no'` → `disqualified` / `broker_posted_attested`. With `'unknown'` → review.
9. `qualification_reason` contains only §4.9 codes for every row written after migration; `qualification_detail` holds the sentence.
10. Human code review of the PR by Patrice before merge (build order step 6). No Claude Code auto-merge.

### 4.14 Rollout

1. Merge behind `SHIPPER_DIRECT_GATE_ENABLED=false`. Deploy workers (Railway) and API (Vercel). Confirm no change.
2. Run the backfill in shadow. Calibrate. Seed registry.
3. Set `SHIPPER_DIRECT_GATE_ENABLED=true`, `MODE=enforce` on Railway workers first (Qualifier), then Vercel (import route, resolve-source route). Order matters: the assertion in M2 must not fire against loads that were qualified before the flag existed — M2 tolerates `load_source_class IS NULL` only for rows with `created_at < flag_enabled_at`, a timestamp written to `settings` at flip time.
4. Send Kevin the one-paragraph update: gate live, method, first-day distribution. He already knows the classifier issue existed; this closes it with a row-level audit trail he can be shown.

---

## 5. M2 — Downstream policy assertions and brief fields

Ships in the same deploy as M1. Small, and the reason M1 is a gate rather than a filter.

**Compiler** (`compiler-worker.ts`), before persona selection: `assertLoadSource(load)` — if `load_source_class NOT IN ('shipper_direct','co_brokered')` and the row post-dates the flag → `stage = 'escalated'`, `qualification_reason = 'source_assertion_failed_compiler'`, exception `severity = 'critical'`, no brief built. This should never fire; if it does, something injected a load mid-pipeline and Patrice needs to know that day.

**Dispatcher** (`dispatcher-worker.ts`), before `POST /api/loads`: same assertion → `escalated`, `'source_assertion_failed_dispatcher'`, critical.

**Brief fields** (`myra_negotiation_brief_schema.ts` + `compileRetellPayload`): add `load_source_class`, `poster_legal_name`, `co_broker_counterparty` (null unless `co_brokered`). Two uses:

- **Buy-side (Dispatch One, carrier negotiation):** carriers increasingly ask "is this your freight or are you double-brokering it?" The agent can now answer truthfully from a variable: *"This is direct shipper freight — {poster_legal_name} tenders to us."* or *"This is co-brokered under agreement with {counterparty}."* Add one line to `dispatch_one_v1.json`'s objection handling for the question. Truthful, specific, and a differentiator dispatchers notice.
- **Sell-side (shipper agent):** address the shipper by verified legal name. Cheap credibility.

---

## 6. M3 — M6 (P1/P2, one paragraph each; each gets its own build session and, if needed, its own short spec)

**M3 — Pilot gates in software.** Pilot 1 §3.2 promises Kevin two human gates: payer credit before accepting a load, carrier verification before rate con. Neither exists in code (`dispatcher-worker.ts` has no verification check; T-25 defers payer credit to Engine 3). Minimum viable version: `shippers.credit_status ∈ {unknown, declined, approved}` (default `unknown`) checked at Compiler — `unknown`/`declined` → `escalated`, `'payer_credit_hold'`, no buy-side call; and `carriers.verified_at` / `verified_by` checked at Dispatcher before `assign` — null → `escalated`, `'carrier_verification_hold'`. Both holds are resolved from the Alert Center. This is the E3-00 L3 boundary in ~150 lines and it makes the pilot document literally true. Depends on M1 (uses the same review routing).

**M4 — Call concurrency governor.** T-00 R-1: `MAX_CONCURRENT_CALLS=25` set ahead of validation, and the pilot's phase tree (40 → 60/wk → 80/wk → 100/wk) has no software enforcement. Add a `call_budget` config row: `max_calls_per_day`, `max_concurrent`, `max_per_phone_per_day` (default 1, per T-05 §7), `error_rate_brake_pct` (default 20%: if >20% of the last 20 calls ended `disconnected`/`escalated`, pause the call-queue and alert). Voice worker reads it at dial time alongside the existing DNC/hours rechecks. Adds a per-phone Redis lock so two calls never fire to the same number concurrently — the current worker counts active calls globally but not per counterparty. This is T-18's budget envelope in miniature; T-18b replaces the config row with `authority_envelopes.budget`.

**M5 — Funnel and gate instrumentation.** T-00 R-5 and §6: no per-stage conversion or unit economics on the operator screen. M1 adds the class dimension. One materialized view `v_pipeline_funnel_daily` (stage conversion, reason-code distribution, `load_source_class` mix, registry hit rate, lookup p95, review count and SLA breach count) and the six tiles from T-00 §6 on the existing Dispatch Briefing page. No new UI framework. This is the screen Kevin gets read-only access to under Pilot 1 §11 level 04.

**M6 — Pipeline hygiene.** (a) R-6: `gate.ts` routes degenerate rate-ladder loads (min > target after cost) to `disqualified` / `margin_too_thin` instead of leaving them at `matched`. (b) Expiry sweeper generalisation: any load at `scanned`/`qualified`/`matched`/`briefed` with `pickup_date < NOW() + 4h` → `expired`. (c) `qualifier-worker.ts` `TODO`s that are now live-path debt: the fan-out to research/match queues is still commented in the project snapshot — confirm the deployed version enqueues; if the snapshot is current, this is a P0 bug, not P2.

---

## 7. T-19 reconciliation — exact edits

To be applied to T-19 in the same PR as M1, or as a follow-up doc PR the same week. T-19 remains `draft`; these edits keep its shadow-validation discipline intact and point it at what exists.

| T-19 location | Current text | Replace with |
|---|---|---|
| §1 item 3 | "reproduces the Qualifier's current hardcoded shipper-direct filter (T-05, 'Filter 3') exactly" | "reproduces E2-01 M1's `classifyLoadSource()` verdicts exactly, as recorded in `pipeline_loads.load_source_class` and `qualification_reason`" |
| §5 `PolicyEvaluationInput.load.isDirect: boolean` | boolean "from existing classifier" | `loadSourceClass: 'shipper_direct' \| 'co_brokered' \| 'broker_posted' \| 'carrier_reposted' \| 'unresolved'` and `posterRegistryId: number \| null` — the classifier's output, not a re-derivation |
| §5 step 3 | "accept if isDirect, else check co_broker_agreements" | "`shipper_direct_or_coBroker`: accept if `loadSourceClass IN ('shipper_direct','co_brokered')`; reject otherwise. Agreement matching is M1's job and is already reflected in `co_brokered`." |
| §6 replay harness | "`qualification_reason` … values like `shipper_direct_required`" | "`qualification_reason IN ('broker_posted_no_agreement','broker_posted_inferred','broker_posted_attested','out_of_geographic_scope')` for rejects; `load_source_class` for accepts. `shipper_direct_required` was never emitted." |
| §8 criterion 5 | scenario list | add: `carrier_reposted` reject, `unresolved` reject (policy engine must never accept an unresolved class regardless of tenant policy `'any'` — `'any'` means any *resolved* source) |
| §8 criterion 6 | "100% agreement … T-05's actual historical values" | "100% agreement with E2-01 M1's recorded verdicts for every row with `load_source_evaluated_at IS NOT NULL`" |
| §10 T-19b | "one call inserted at Filter 3" | "replace the env-built `policy` argument to `classifyLoadSource()` with the active `tenant_policies` row (E2-01 §4.11). No change to filter order." |
| §11 last paragraph | "Do not let Claude Code modify `qualifier-worker.ts`'s Filter 3" | "Do not let Claude Code modify `classifyLoadSource()` or `qualifier-worker.ts` F0/F1 in this session" |

Also T-25 §2: the defense-in-depth cross-check ("did any load T-19 would have rejected get booked anyway") should read `load_source_class` directly — it is now a stored fact, not a re-evaluation.

---

## 8. Decisions required before Session 1

Each has a default. Silence = default applied.

| # | Decision | Default (my pick) | Alternative |
|---|---|---|---|
| **D1** | For-hire carrier posting a load (§4.5 rows 6, 9) | **Review**, registry remembers the answer | Accept as shipper-direct per original build order. I don't recommend it — see §0.3(2). |
| **D2** | Poster with no FMCSA record and no broker-signal tokens (§4.5 row 12) | **Review** | Accept. Not recommended — this is the Canadian domestic broker signature, §0.3(1). |
| **D3** | Strong broker-token names with no record (§4.5 row 11) | **Auto-reject** (`broker_posted_inferred`) | Review. Costs Patrice minutes per day on rows that are almost never shippers. Supply is not the constraint. |
| **D4** | 24 h live shadow before `enforce` | **Skip** — backfill on historical rows gives the distribution; ship enforce ON as the build order says | Run it. Costs one day. |
| **D5** | DAT detail-panel expansion for MC# capture | **Yes**, per row, ~1–2 s | Skip and rely on company-name → registry/name-search only. Weaker: MC is the deterministic key; names are fuzzy. |
| **D6** | Seed the registry from the 205-shipper list as `shipper` at conf 0.9 | **Yes** | Leave as review. Wastes the ICP asset. |
| **D7** | M3 pilot gates in week 2 | **Yes** — Kevin was promised them | Defer to T-25 in Engine 3. |

Confirm the reconciliation in §0.2(c): is there a rebuilt gating layer in the repo that is not in the knowledge base? If yes, upload it before Session 1 and this PRD gets a v1.1 delta rather than Claude Code building a duplicate.

Action item that gates Session 1 regardless: **register for an FMCSA QCMobile webKey** (free, same-day). Without it every registry-miss goes to review on day one.

---

## 9. Claude Code build plan — M1/M2 (four sessions)

One session per line group. Each session ends with the T-16 suite green and a PR, not a merge.

**Session 1 — foundation (no live-path change)**
1. Migration 040 (§4.10). Apply to staging. `EXPLAIN` the three new indexes against current row count.
2. `lib/verification/authority-lookup.ts` with provider chain, cache, audit rows. Integration test against live FMCSA for the three known entities in §4.13(2).
3. `lib/pipeline/load-source-classifier.ts`: `normalize_company_name()`, `classifyLoadSource()`, Appendix B token list as data. 22+ synthetic cases.
4. Seed script: shipper list, mines dossier, broker list → `poster_registry`.
5. `scripts/e2_backfill_load_source.ts` (shadow, idempotent, resumable).

**Session 2 — capture and qualification (live path, flag OFF)**
6. T-04A DAT adapter: detail expansion, new selectors, `poster_*` columns, `poster_raw_html`. Stub adapters: mapping only.
7. `/api/pipeline/import`: attestation contract (§4.8), 400 path, UI radio group + logged sentence.
8. `qualifier-worker.ts`: F0 + F1, reason codes for all filters, `qualification_detail`, priority bonus, single-UPDATE writes. Do not touch F2–F7 logic.
9. Reason-code backfill for historical prose rows.

**Session 3 — review loop and calibration**
10. Exception insert with `source_module = 'load_source_review'`; `resolve-source` route; pipeline-health cron expiry rule.
11. Run backfill. Produce the calibration report (§4.12 step 4). Patrice labels; load labels.
12. Fix anything the calibration surfaces in the classifier — with a new synthetic case for each fix.

**Session 4 — assertions, brief, ship**
13. M2: Compiler + Dispatcher assertions with the `flag_enabled_at` tolerance; brief fields; one Dispatch One objection line.
14. T-19 reconciliation edits (§7) as a doc commit.
15. Human code review. Merge. Deploy flag OFF → verify → flip ON per §4.14.
16. Kevin update.

Do not let Claude Code: modify F2–F7 logic; touch `voice-worker.ts` (that is M4); "simplify" the review branch into an accept because the queue looks empty; skip the calibration step because the synthetic set passed.

---

## 10. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| E2-R1 | Review queue floods Patrice in week one (Canadian posters with no FMCSA record) | Medium | Registry seed + D3 auto-reject on broker tokens + calibration labels before flag ON. Track review count/day on M5; if >20/day after day 3, tighten Appendix B. |
| E2-R2 | FMCSA QCMobile rate limit or outage | Medium | Cache, SAFER fallback, fail-closed to review. Never fail-open. |
| E2-R3 | DAT detail-panel expansion breaks on UI change | Medium | Same env-selector pattern as T-04A; scraper alerts on zero MC captures over one full poll cycle; classifier falls back to name path automatically. |
| E2-R4 | Gate rejects a real shipper repeatedly (false reject loop) | Low | Every reject writes the poster to the registry as `broker` only via lookup/human; heuristic rejects (`broker_posted_inferred`) are conf 0.7 and surface in M5 for weekly review. One `resolve-source` fixes it permanently. |
| E2-R5 | Load qualified before flag ON reaches Compiler with `NULL` class | Low | `flag_enabled_at` tolerance in M2; after 72 h, no such loads remain (expiry sweeper). |
| E2-R6 | A rebuilt classifier already exists in the repo and M1 duplicates it | Medium | §0.2(c) / §8 — reconcile before Session 1. |
| E2-R7 | Private-fleet classification depends on an FMCSA field that QCMobile may not expose | Medium | Row 10 routes `unknown` operation classification to review, never accept. SAFER snapshot fallback carries the field. |

---

## 11. Metrics (M5 surfaces these; M1 writes them)

| Metric | Target after week 1 | Why |
|---|---|---|
| % scanned loads with non-null `load_source_class` | 100% | Gate coverage |
| Registry hit rate on F1 | >70% | Compounding is working |
| Review loads/day | <10 | Solo-operator load |
| Review SLA breach rate | <10% | Loads aren't dying in the queue |
| Labelled-broker → accept | **0** | The only number that matters |
| External lookup p95 | <3 s | Qualifier throughput unaffected |
| Accept mix: `shipper_direct` vs `co_brokered` | reported | Tells Kevin what channel the freight came from |

---

## Appendix A — FMCSA field mapping (verify on first live response)

| Concept | QCMobile (expected) | SAFER snapshot |
|---|---|---|
| Broker authority | `brokerAuthorityStatus` (`A` active / `I` inactive / `N` none) | "Broker Authority" under Licensing & Insurance |
| Carrier authority | `commonAuthorityStatus`, `contractAuthorityStatus` | "Common / Contract Authority" |
| Private vs for-hire | operation classification field if present | "Operation Classification: Auth. For Hire / Private(Property) / …" |
| Legal / DBA | `legalName`, `dbaName` | "Legal Name", "DBA Name" |
| Identity | `dotNumber`, docket (`MC-`) | USDOT Number, MC/MX/FF Number(s) |

## Appendix B — Broker-signal tokens (initial; data, not code)

Strong (row 11 auto-reject): `logistics`, `logistique`, `brokerage`, `freight solutions`, `freight services`, `freight management`, `3pl`, `forwarding`, `forwarders`, `transport solutions`, `cargo solutions`, `supply chain solutions`, `load services`, `dispatch services`.

Weak (registry note only, never a verdict): `transport`, `trucking`, `express`, `carriers`, `lines`. These are ambiguous between for-hire carriers, private fleets, and brokers and must not drive a reject.

Known-broker seed list (~60 Ontario/Quebec brokerages Patrice already recognises from the boards) — Patrice supplies in the calibration sheet; loaded as `seed_broker_list`, conf 0.9.

## Appendix C — Synthetic test set index

One fixture per §4.5 row 0–14 plus the eight extra cases in §4.12. Fixtures live in `tests/fixtures/load-source/*.json`; each carries `expected: { class, verdict, reasonCode, method }`.

---

*End of E2-01. The gate is the first thing Kevin was promised that the code didn't yet do. Ship it, show him the row, then build the rest.*
