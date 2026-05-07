# Multi-Tenant Architecture — Document Index

> Lookup registry for the multi-tenant SaaS retrofit. One line per artifact.
> **Last update:** 2026-05-07 (Session 8 final wrap — code-complete; production migration pending)

## Start here

- **[HANDOFF.md](./HANDOFF.md)** — Single-page entry point. Read first when picking the rollout back up.
- **[PRODUCTION_MIGRATION.md](./PRODUCTION_MIGRATION.md)** — Runbook for applying migrations 027–031 to production. **The next operational gate.**
- **[CODE_REVIEW_CHECKLIST.md](./CODE_REVIEW_CHECKLIST.md)** — Rules every PR must follow during the M3 → M4 soak.

## ADRs (decision records — change rarely)

- [ADR-001 — Tenant Isolation Strategy](./ADR-001-tenant-isolation.md) — shared schema + RLS, with documented escalation triggers to schema-per-tenant. **Approved.**
- [ADR-002 — Tenant Resolution Strategy](./ADR-002-tenant-resolution.md) — JWT > service header > tracking token > subdomain; conflicts reject 403. **Approved.**
- [ADR-003 — Feature Gating Strategy](./ADR-003-feature-gating.md) — server-authoritative tier features + numeric limits, JSONB overrides. **Approved.**
- [ADR-004 — Backwards-Compat & Migration Strategy](./ADR-004-migration-strategy.md) — five-phase expand-contract; Engine 2 deferred to M5. **Approved.**

## Operational docs (cross-cutting concerns — updated as policies evolve)

- [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md) — 6 roles × capability grid; `owner`/`admin`/`operator`/`service_admin` enforced in Phase 1; `driver`/`viewer` scaffolded
- [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) — `feature_overrides` vs `tenant_config` split rule; clone-on-create; default config keys
- [SECURITY.md](./SECURITY.md) — AES-GCM crypto, RLS defense-in-depth, service-admin escalation, audit log, key rotation, incident response
- [BILLING_DEFERRED.md](./BILLING_DEFERRED.md) — what's in scope (schema stubs + feature gating) and what's not (Stripe SDK, webhooks, dunning); starting point for the future billing session
- [PERFORMANCE_NOTES.md](./PERFORMANCE_NOTES.md) — perf delta of withTenant Pool/WebSocket vs HTTP-mode; load-test plan for Phase M3 pre-flight; index audit checklist
- [WAREHOUSE_INTEGRATION_POINTS.md](./WAREHOUSE_INTEGRATION_POINTS.md) — Neon logical replication touchpoints; raw_*/dbt model layering; cross-tenant aggregation safety

## Live tracking docs (updated daily/per-session)

- [RLS_ROLLOUT.md](./RLS_ROLLOUT.md) — per-batch RLS enable schedule for Phase M3; updated daily during rollout
- [SESSION_TIME_LOG.md](./SESSION_TIME_LOG.md) — actual vs budgeted time per session; closed at end of Session 8
- [STAGING_APPLY.md](./STAGING_APPLY.md) — staging branch creation + apply procedure; updated when migrations are added
- [API_REFACTOR_LOG.md](./API_REFACTOR_LOG.md) — per-route refactor audit trail; tracks every API endpoint's tenant-scoping treatment

## Session summaries (frozen — historical reference)

- [TENANTING_AUDIT.md](./TENANTING_AUDIT.md) — full categorization of every Postgres table (A / A-DEF / A-JOIN / B / C / D); 8 questions resolved
- [STACK_DRIFT_REPORT.md](./STACK_DRIFT_REPORT.md) — divergences between mega-mission spec and actual codebase, with adaptations across all 8 sessions (§10 covers Sessions 3–7 findings)
- [SESSION_1_SUMMARY.md](./SESSION_1_SUMMARY.md) — Phase 0 wrap (architectural decisions)
- [SESSION_2_SUMMARY.md](./SESSION_2_SUMMARY.md) — Phase 1 wrap (database foundation; migrations applied to staging)
- [SESSION_3_SUMMARY.md](./SESSION_3_SUMMARY.md) — Phase 2 wrap (middleware + auth + 71 API routes converted to withTenant)
- [SESSION_4_SUMMARY.md](./SESSION_4_SUMMARY.md) — Phase 3 wrap (admin onboarding API: tenant CRUD, config editor, JSON export, purge with 24h delay)
- [SESSION_5_SUMMARY.md](./SESSION_5_SUMMARY.md) — Phase 4 wrap (three-layer feature gating + Redis usage tracking)
- [SESSION_6_SUMMARY.md](./SESSION_6_SUMMARY.md) — Phase 5 wrap (tenant-aware UI shell, onboarding wizard, settings page)
- [SESSION_7_SUMMARY.md](./SESSION_7_SUMMARY.md) — Phase 6 + 7 wrap (warehouse integration doc, cross-tenant leak helper, browser smoke + admin loading-state fix)
- [SESSION_8_SUMMARY.md](./SESSION_8_SUMMARY.md) — Phase 8 + 9 wrap (production migration runbook, code-review checklist, handoff doc)

## Cadence summary

| Doc category | Update frequency | Owner |
|---|---|---|
| ADRs (001–004) | Rarely (only on supersession) | Patrice |
| Operational docs | Quarterly OR on policy change | Patrice |
| Live tracking (RLS_ROLLOUT, SESSION_TIME_LOG) | Daily during M3 / End of every session | Whoever runs the session |
| Code review checklist | When new tenant-isolation rules emerge | The next reviewer who finds a gap |
| Audit + drift (TENANTING_AUDIT, STACK_DRIFT_REPORT, SESSION_*_SUMMARY) | Frozen post-Session 8 unless schema changes | Historical reference |
| Production runbook | Updated at each production execution window | Operator |

## Quick reference: file → spec mapping

When you need to know which doc explains a code module:

| Code module | Spec doc |
|---|---|
| `lib/db/tenant-context.ts` | ADR-001 §How Option A is implemented; SECURITY §2 (RLS), §4 (service-admin) |
| `lib/auth.ts` (JWT shape, tenant-context helpers, requireSuperAdmin) | ADR-002 (resolution chain); ADR-004 §M2d (backfill) |
| `lib/crypto/tenant-secrets.ts` | SECURITY §1 (crypto policy) |
| `lib/tenants/defaults.ts` + `validators.ts` + `config-schema.ts` | TENANT_CONFIG_SEMANTICS (defaults, validation, encryption coverage) |
| `lib/features/{index,tiers,gate,loader}.ts` | ADR-003 (three-layer model) |
| `lib/usage/tracker.ts` | ADR-003 §Usage tracking |
| `lib/blob/tenant-paths.ts` | STACK_DRIFT_REPORT §3.1 (Vercel Blob over R2) |
| `lib/test-utils/cross-tenant-leak.ts` | RLS_ROLLOUT (pre-batch audit); SESSION_3_SUMMARY §4 |
| `app/api/admin/**` | SESSION_4_SUMMARY §1 (admin API) + SESSION_5_SUMMARY §1.3 (gates applied) |
| `components/tenant-context.tsx` | SESSION_6_SUMMARY §1.2 |
| `app/admin/**` (UI pages) | SESSION_6_SUMMARY §1.4 + SESSION_7_SUMMARY §2.4 (loading-state fix) |
| Migrations 027–031 | SESSION_2_SUMMARY §1 (027–029); SESSION_5_SUMMARY §1.2 (031); ADR-004 (migration strategy) |
