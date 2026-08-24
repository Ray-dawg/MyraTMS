# T-17 Event & Data Layer — Implementation Design

**Date:** 2026-08-24
**Base spec:** `Engine 3/T17_Event_Data_Layer.md` (authoritative for schema, taxonomy, triggers, views, API shape, acceptance criteria, gate). This document only records the decisions needed to reconcile that spec with the real MyraTMS schema and to scope this build session — it does not restate anything the base spec already fixes.

## Why this document exists

The base spec was written before the final schema was available in places, and left two things open by design (auth pattern for the read API; how far a single Claude Code session should go toward production). This doc closes those gaps. Read it alongside the base spec, not instead of it.

## Schema reconciliation (base spec vs. live MyraTMS DB)

Checked against `MyraTMS/scripts/pipeline_migrations.sql`, `023`–`032`, and `scraper/migrations/001_scraper_tables.sql`:

| Base spec assumption | Reality | Resolution |
|---|---|---|
| `agent_calls.call_outcome` | Column is `agent_calls.outcome` | Trigger function and `v_call_funnel` use `outcome`, not `call_outcome` |
| `pipeline_loads.stage_updated_at`, `.research_completed_at`, `.carrier_match_count` | Present, exact names match | No change |
| `scraper_runs` table | Exists, but defined in the sibling `scraper/` project's migration, not MyraTMS's | Fine — same physical Neon DB. Trigger references it directly; no MyraTMS migration needs to create it |
| Cost columns for `v_cost_per_call` (§4.3 flags this as possibly untracked) | Confirmed: no cost column exists anywhere (`agent_calls`, `claude-service.ts`, or elsewhere) | See "Cost scaffolding" below — resolved with user, not left unhandled |
| Migration numbering | Next free number in `MyraTMS/scripts/` is `033` | File: `033-event-data-layer.sql`, hyphen style (matches `023`–`026`, `032`; underscore style is reserved for the multi-tenant migration series) |

## Decisions (resolved with Patrice, 2026-08-24)

### 1. Cost-per-call: add scaffolding now

The base spec says to flag missing cost tracking back to Patrice rather than estimate. Resolution: add nullable `agent_calls.retell_cost_cents` and `agent_calls.claude_cost_cents` (INTEGER) in the same migration. No backfill is attempted — historical calls stay `NULL`. `v_cost_per_call` is built against these columns now so a future module only needs to start populating them; it will return sparse/empty data until that happens. This is scaffolding, not a claim that cost is tracked yet — the read API response for `/api/metrics/cost-per-call` should make the coverage gap visible (e.g. a `calls_with_cost_data` count alongside the aggregate) rather than silently averaging over mostly-null rows.

### 2. Read API auth: JWT cookie + role, not bearer token

The base spec's `GET /api/events`, `GET /api/metrics/*` endpoints feed an internal operator screen (T-14). Every existing human-facing MyraTMS route uses `requireTenantContext(request)` (from `lib/auth.ts`) plus `requireRole(user, ...)`; the one bearer-token pattern in the codebase, `/api/pipeline/import`, is machine-to-machine CSV/JSON ingestion, not a fit for a screen a person loads. New routes use the same `requireTenantContext` + `requireRole` pattern as `app/api/loads/route.ts` and the rest of the authenticated surface. `tenant_id` defaults to the caller's own tenant from the resolved context; a super-admin (`ctx.isSuperAdmin`) may pass an explicit `?tenant_id=` query param to cross tenants, matching the existing admin-surface convention (`app/api/admin/**`).

### 3. Session scope: branch-verify, not production-apply

Per the base spec's own gate (§9): triggers must run against a Neon branch first, diffed against prod, before touching production, and Patrice must confirm the T-16 worker test suite is green post-deployment. This session:

- Writes all code artifacts (migration, backfill script, API routes, tests).
- Creates a real Neon branch via the Neon MCP tools.
- Applies the migration to that branch, runs the backfill against it, runs the T-16 worker suite against it.
- Verifies all 6 acceptance criteria on the branch.
- Does **not** apply anything to production. Patrice reviews the branch results and the migration file, then applies it themselves.

This keeps the "zero touch to the live call path" guarantee real for the one part of it a session could actually violate — an unreviewed production migration — while still producing a fully verified artifact.

## Explicitly unchanged from the base spec

Event taxonomy (§4.2), the five source tables triggers attach to, the `UNIQUE (derived_from_table, derived_from_id, event_type)` idempotency mechanism, the exception-safe trigger wrapping requirement (§5.2), the write-boundary rules (§6), the portability notes (§7), and all 6 acceptance criteria (§8) — the base spec is authoritative on all of these and they carry into the implementation plan unchanged.

**Files this session will not touch, per the base spec's explicit instruction:** `base-worker.ts`, `voice-worker.ts`, `retell-webhook.ts`, `compiler-worker.ts`.
