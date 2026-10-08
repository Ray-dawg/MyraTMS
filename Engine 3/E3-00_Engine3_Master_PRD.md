# E3-00 — MYRA ENGINE 3
## Autonomous Brokerage Operating System — Master Product Requirements Document

| Field | Value |
|---|---|
| Document | E3-00 (Master) |
| Version | 1.0 |
| Date | 2026-08-22 |
| Owner | Patrice Penda, Founder |
| Status | APPROVED FOR CHILD-SPEC DRAFTING |
| Predecessor | Engine 2 — Autonomous Load Acquisition & Booking (T-00 through T-16) |
| Children | T-17 through T-30 (see §12) |
| Build tool | Claude Code, one child spec per session |

---

## 1. One-sentence definition

> **Engine 2 autonomously executes profitable freight transactions. Engine 3 autonomously operates the brokerage around those transactions, for any tenant, under explicit human authority boundaries.**

Engine 2 does not disappear. It becomes the Freight Acquisition & Booking service inside Engine 3.

---

## 2. Why this document exists

Engine 2 answers: *"Can Myra autonomously book profitable freight?"*
Engine 3 answers: *"Can Myra autonomously operate a brokerage — and can it do so for other companies?"*

This master PRD fixes the vision, the tenant model, the autonomy boundaries, the phase gates, and the metric system. It is deliberately not a build spec. Each module has its own child spec (T-17+) with acceptance criteria and a gate. Claude Code is handed one child spec at a time, never this document alone.

---

## 3. Non-negotiable principles

1. **Pilot 1 is the only hard dependency.** Engine 3 work runs in parallel with the Engine 2 pilot. Nothing in Engine 3 touches the live call path, the Retell agents, or the `pipeline_loads` stage machine's write path until Pilot 1 is green (§9).
2. **Extend, never rewrite.** Engine 3 is built on the existing Vercel / Railway / Neon / Upstash / BullMQ stack. Engine 2's workers are wrapped as callable services, not duplicated.
3. **Portable by construction.** Every agent and service has a clean interface, no host-specific coupling, and a documented deployment contract. The same code must run on Railway today and on owned hardware or another cloud later without a rewrite.
4. **Orchestrate finance, never own it.** No native ledger, no native AR/AP. eCapital, Stripe, Persona, and an accounting SaaS are integrated through adapters.
5. **Every agent acts inside an authority envelope.** Permissions, budget, confidence threshold, escalation rules, audit trail. No agent "decides"; it decides within bounds.
6. **Policy belongs to the tenant, not the platform.** Double-brokering rules, dispatch routing, margin floors, and calling behaviour are tenant-type defaults overridable per tenant. The platform enforces the envelope; the tenant sets the rules.
7. **Instrumented from day one.** Every event is a structured record. The data asset is a product, not a byproduct.
8. **Lean, defensible numbers.** Metrics are measured, never modelled, when presented externally.

---

## 4. Tenant model

### 4.1 Tenant rollout

| Order | Tenant | Purpose |
|---|---|---|
| T1 | Myra Logistics brokerage | Proves the OS on our own freight. Reference implementation. |
| T2 | External trucking companies and brokerages | First licensed SaaS revenue. Validates multi-tenancy and white-label. |
| T3 | Penda & Co acquired operating companies | Deploys the OS across the roll-up. Brokerages or carriers. |

### 4.2 Tenant types and default policy

| Tenant type | Load source policy | Dispatch agent | Negotiation direction | Typical user |
|---|---|---|---|---|
| **Broker** | Shipper-direct only, or broker-posted with a co-broker agreement on file | On by default | Sell-side (shipper) + buy-side (carrier) | Non-asset brokerage |
| **Dispatcher** | Broker-posted and shipper-direct both permitted | On by default | Buy-side on behalf of owner-operators | Dispatch service |
| **Carrier** | Any load | **Opt-in.** Default routes booked loads to in-house dispatch | Sell-side only (secure the load) | Asset trucking company |
| **Acquired Opco** | Inherits Broker or Carrier defaults by entity type | Per acquisition | Per entity type | Penda & Co portfolio |

Policy is an object, versioned, attached to the tenant, enforced at Qualifier, Brief Compiler, and Dispatcher. Changing a policy never requires a deploy.

### 4.3 Freight sources by phase

| Phase | Source |
|---|---|
| 1–3 | Load boards only (DAT, Truckstop, 123Loadboard, Loadlink) via existing Scanner paths |
| 4 | Contract Freight Intake (T-30): an email-intake agent that receives a tenant's direct shipper tenders, parses them, and injects them into that tenant's pipeline at `scanned` |
| 4+ | Direct shipper outreach agent (roadmap appendix) |

---

## 5. Autonomy model

### 5.1 Three levels

| Level | Behaviour | Examples |
|---|---|---|
| **L1 — Fully autonomous** | Agent acts. Event logged. | Routine carrier calls, qualification, dispatch notifications, invoice generation, reminders, late <30 min |
| **L2 — Autonomous with audit** | Agent acts. Audit event raised to console. Human may reverse. | Pricing exceptions inside tolerance, unusual negotiation path, moderate credit exposure, late 30 min–4 h |
| **L3 — Human approval** | Agent prepares. Human decides. | Fraud flag, claims, legal, banking changes, exposure above tenant limit, strategic customers, late >4 h with recovery failure |

### 5.2 Transition over time

```
Engine 2:   AI → Human → Action
Engine 3:   AI → Action → Human observes → intervenes on exception
Target:     AI → Action → Audit
```

### 5.3 Authority envelope (every agent)

```
Identity · Permissions · Tools · Budget · Policies · Memory
Confidence threshold · Escalation rules · Audit trail
```

Defined in T-18. No agent ships without one.

---

## 6. Architecture

```
                          MYRA ENGINE 3
                               │
                        CONTROL PLANE (T-29)
                   tenants · RBAC · billing · white-label
                               │
                       AGENT ORCHESTRATOR (T-18)
                               │
      ┌────────────────────────┼────────────────────────┐
      │                        │                        │
  COMMERCIAL               OPERATIONS                FINANCE
      │                        │                        │
  Pricing (T-21)           Load Intelligence (E2)    Finance
  Account/Customer (T-28)  Carrier Intel (T-20)      Orchestration
                           Negotiation (T-22)        (T-27)
                           Dispatch (T-23)
                           Exception (T-24)
                           Risk/Fraud (T-25)
                           Documents (T-26)
      │                        │                        │
      └────────────────────────┼────────────────────────┘
                               │
                        AGENT RUNTIME (T-18)
                               │
              ┌────────────────┼────────────────┐
              │                │                │
           MEMORY            TOOLS            DATA (T-17)
        carrier · customer   Retell · email   Neon · event bus
        agent · tenant       load boards      data lake
                             Stripe · eCapital
                               │
                        HUMAN ESCALATION CONSOLE (T-24)
```

### 6.1 Engine 2 as services

Engine 2 workers are exposed as internal service interfaces. Engine 3 orchestrates; it does not re-implement.

```
POST /loads/discover      (Scanner)
POST /loads/qualify       (Qualifier, policy-aware)
POST /loads/price         (Researcher → Pricing Engine T-21)
POST /carriers/rank       (Ranker → Carrier Intelligence T-20)
POST /negotiations/start  (Brief Compiler + Voice → Negotiation Service T-22)
POST /loads/book
POST /loads/dispatch      (Dispatcher, tenant-routable)
POST /outcomes/feed       (Feedback)
```

### 6.2 Portability contract

Each service ships with: a typed interface, an env-only config surface, a health endpoint, a queue contract (BullMQ now; abstracted behind a queue adapter), and a container definition. No service may import host-specific SDKs outside an adapter layer.

---

## 7. Module summary

| Module | Child | Phase | Purpose |
|---|---|---|---|
| Event & Data Layer | T-17 | 1 | Every event becomes a structured record. The bridge. |
| Agent Runtime & Governance | T-18 | 1 | Authority envelopes, budgets, audit, orchestration |
| Tenant & Policy Model | T-19 | 1 | Tenant types, RBAC, policy objects, migration 030 promotion |
| Carrier Intelligence | T-20 | 2 | Persistent carrier profiles, Myra Carrier Score |
| Pricing Engine | T-21 | 2 | Researcher extracted to a centralised, learning pricing service |
| Negotiation Service | T-22 | 2 | One service, two directions (Engine 2 sell-side, Dispatch One buy-side) |
| Dispatch & Lifecycle Monitor | T-23 | 2 | Booking → POD, tenant-routable, in-house dispatch handoff |
| Exception Engine + Console | T-24 | 2 | Classify → severity → authority → act → verify → close |
| Risk & Fraud | T-25 | 2 | Carrier, payer, load, transaction, banking, document risk |
| Document Automation | T-26 | 2 | Rate confirmation, BOL, POD collection and verification |
| Finance Orchestration | T-27 | 3 | Adapters for eCapital, Stripe, Persona, accounting SaaS; exposure governor |
| Customer OS & Onboarding | T-28 | 4 | Customer profiles, self-serve onboarding |
| Control Plane & White-label | T-29 | 5–6 | Multi-tenancy, RBAC, billing, metering, branding |
| Contract Freight Intake | T-30 | 4 | Email-tender intake agent per tenant |
| Autonomous Sales, Internal Agents | Appendix | — | Roadmap only. Not built. |

---

## 8. Phase plan

| Phase | Name | Modules | Entry gate | Exit gate |
|---|---|---|---|---|
| 0 | Stabilize Engine 2 | Pilot 1 | — | Pilot 1 green (§9) |
| 1 | Instrument | T-17, T-18, T-19 | None. Starts now, in parallel with Pilot 1, isolated from the call path | Every Engine 2 event emitted to the event layer; one agent running under a governance envelope; Myra tenant row exists and all loads carry `tenant_id` |
| 2 | Operationalize | T-20 to T-26 | Pilot 1 green AND Phase 1 exit | 100 consecutive loads through `booked → dispatched → delivered → scored` with ≥80% zero-touch |
| 3 | Financialize | T-27 | Phase 2 exit | Invoice → payment → carrier pay → reconciliation automated on 50 loads; exposure governor live |
| 4 | Commercialize | T-28, T-30 | Phase 3 exit | One external tenant onboarded self-serve and moving freight |
| 5 | Platformize | T-29 (core) | Phase 4 exit, counsel review of consent theory complete | Three tenants live with data isolation verified |
| 6 | White-label | T-29 (branding) | Phase 5 exit | One tenant running under its own brand |

Phases are gated by evidence, not dates.

---

## 9. The Engine 2 → Engine 3 handoff gate

Phase 2 does not start until all of the following are true:

1. **Pilot 1 complete.** The full three-month pilot as defined in `Myra_Engine2_Pilot1_Definition`, with its conversion, booking, dispatch, margin, fraud, and data-quality gates reported.
2. **Real loads scored.** More than one load has completed `calling → booked → dispatched → delivered → scored` against a real, paying counterparty. Friendly or controlled tests do not count.
3. **Outcome path validated.** Retell webhook verifier and ordering confirmed on real calls; `agent_calls` and pipeline linkage correct.
4. **Unit economics measured.** Cost per call, connect rate, book rate on connected calls, and actual gross margin per booked load are on the operator screen.
5. **Concurrency ramp documented.** Green-light criteria for each step of the 4-gate tree (10 → 25 → 50 → 200/day) written and signed off.
6. **Ingest hardened.** At least one official load-board API client off stubs (DAT first).

Phase 1 (T-17, T-18, T-19) is explicitly exempt from this gate and runs in parallel.

---

## 10. Metrics and the enterprise-value map

### 10.1 North star

> **Gross profit per human ops hour.**

Denominator = hours logged in the Escalation Console (T-24), not headcount. This works for a solo operator today and for a 40-person tenant later, and it is the number that proves the automation thesis.

### 10.2 Primary autonomy metric

> **Zero-touch rate:** % of loads reaching `scored` with no human action between `scanned` and `scored`. Target 95%.

Secondary: % of operational events auto-resolved (L1 + L2 without reversal). Target 95%.

### 10.3 Metric → valuation map

Every KPI exists to move a multiple. This table is the enterprise-value story.

| Metric | What it proves | Multiple it moves |
|---|---|---|
| Zero-touch rate | Software does the work | SaaS (10–15x) vs brokerage (3–4x) |
| Gross profit / human ops hour | Operating leverage | SaaS |
| Platform ARR (onboarding + subscription + usage) | Recurring software revenue | SaaS |
| % revenue recurring | Mix shift away from brokerage | SaaS |
| Quick Pay volume and take rate | Fintech layer | Fintech (float + take) |
| Myra Carrier Score coverage (carriers profiled, outcomes per carrier) | Proprietary data asset | Data |
| Negotiation records with outcome | Training and pricing moat | Data |
| Tenants live, NRR | Platform adoption | SaaS |
| Cost per booked load, AI cost per load | Unit economics | All |
| Autonomous booking rate, escalation rate | Investor-facing proof of mechanism | All |

### 10.4 Operational metrics

Booking conversion · dispatch success · on-time % · exception rate · DSO · AR recovery · fraud loss · working-capital utilization · agent utilization.

All metrics are computed from the event layer (T-17). None are entered manually.

---

## 11. Revenue model (Engine 3 as SaaS)

| Component | Mechanism | Tenant type |
|---|---|---|
| Onboarding fee | One-time, covers setup, policy configuration, integrations | All |
| Platform subscription | Monthly, tiered by tenant type and seat band | All |
| Usage | Per load processed through the pipeline, per call minute, per document | All |
| Fintech take | Quick Pay fee on carrier fast-pay; factoring referral margin | Broker, Acquired |
| Data (later) | Benchmark rate and carrier-score access | External |

Pricing architecture is a C-series deliverable (C-10), not this document.

---

## 12. Child specification index

| ID | Title | Phase | Status |
|---|---|---|---|
| T-17 | Event & Data Layer | 1 | NEXT |
| T-18 | Agent Runtime & Governance | 1 | QUEUED |
| T-19 | Tenant & Policy Model | 1 | QUEUED |
| T-20 | Carrier Intelligence & Myra Carrier Score | 2 | QUEUED |
| T-21 | Pricing Engine | 2 | QUEUED |
| T-22 | Negotiation Service (bidirectional) | 2 | QUEUED |
| T-23 | Dispatch & Load Lifecycle Monitor | 2 | QUEUED |
| T-24 | Exception Engine + Human Escalation Console | 2 | QUEUED |
| T-25 | Risk & Fraud Scoring | 2 | QUEUED |
| T-26 | Document Automation | 2 | QUEUED |
| T-27 | Finance Orchestration | 3 | QUEUED |
| T-28 | Customer OS & Onboarding | 4 | QUEUED |
| T-29 | Enterprise Control Plane & White-label | 5–6 | QUEUED |
| T-30 | Contract Freight Intake (email tender agent) | 4 | QUEUED |
| APPX-A | Autonomous Sales | Roadmap | NOT BUILT |
| APPX-B | Internal Myra Agents (CEO / Eng / Finance / CS) | Roadmap | NOT BUILT |

Each child spec follows the same template: Objective · Scope / Out of scope · Interfaces · Data model · Authority envelope · Acceptance criteria · Gate · Portability notes · Claude Code build plan.

---

## 13. What we do not build

* Our own LLM, voice stack, or GPU cluster
* A native ledger, AR/AP, or accounting system
* A native CRM
* Kubernetes or a microservice sprawl ahead of need
* Autonomous sales or internal executive agents before Phase 4 exit
* White-label branding before three tenants are live
* Self-improvement loops before real outcome data exists (carried from T-00 R-2)

---

## 14. Risk register (Engine 3 specific)

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| E3-R1 | Engine 3 work bleeds into the live call path during Pilot 1 | High | Phase 1 modules are read-only consumers of Engine 2 events. Separate deploy targets. Code review gate on any PR touching `voice-worker`, `retell-webhook`, `compiler-worker`. |
| E3-R2 | Tenant policy bypass leads to double-brokering on a Broker tenant | High | Policy enforced at three points (Qualifier, Compiler, Dispatcher). Policy object is versioned and audited. |
| E3-R3 | Consent theory (T-00 R-4) becomes a platform liability when licensed | Medium-High | Logged for defense now. Counsel review is a hard gate before Phase 5. Tenants sign consent-responsibility terms. |
| E3-R4 | Portability claim unverified | Medium | Each child spec includes a portability test: service runs in a clean container with env-only config. |
| E3-R5 | Metric inflation pressure for enterprise-value story | Medium | All external metrics computed from the event layer. No manual entry. Assumptions labelled. |
| E3-R6 | Solo founder + parallel agent fleets build divergent code | Medium | One child spec per build session. Master PRD is the single source of truth. Frontmatter standard applies. |
| E3-R7 | Financial adapters (eCapital, Stripe) change terms or APIs | Low-Medium | Adapter layer isolates providers. No provider lock-in in the data model. |

---

## 15. Build order for Claude Code

```
NOW (parallel with Pilot 1):
  T-17 → T-18 → T-19

AFTER handoff gate (§9):
  T-20 + T-21 (parallel)
  T-22
  T-23 → T-24 → T-25 → T-26

THEN:
  T-27
  T-28 + T-30
  T-29
```

First session: T-17. It is the bridge. Nothing downstream works without it.

---

*End of E3-00.*
