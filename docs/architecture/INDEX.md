# Multi-Tenant Architecture — Document Index

> Lookup registry for the multi-tenant SaaS retrofit. One line per artifact.
> **Last update:** 2026-05-01 (Session 1 final wrap)

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

## Live tracking docs (updated daily/per-session)

- [RLS_ROLLOUT.md](./RLS_ROLLOUT.md) — per-batch RLS enable schedule for Phase M3; updated daily during rollout
- [SESSION_TIME_LOG.md](./SESSION_TIME_LOG.md) — actual vs budgeted time per session; updated at end of each session
- [STAGING_APPLY.md](./STAGING_APPLY.md) — staging branch creation + apply procedure; updated when migrations are added

## Session audits & summaries

- [TENANTING_AUDIT.md](./TENANTING_AUDIT.md) — full categorization of every Postgres table (A / A-DEF / A-JOIN / B / C / D); 8 questions resolved
- [STACK_DRIFT_REPORT.md](./STACK_DRIFT_REPORT.md) — divergences between mega-mission spec and actual codebase, with adaptations
- [SESSION_1_SUMMARY.md](./SESSION_1_SUMMARY.md) — Phase 0 wrap (architectural decisions)
- [SESSION_2_SUMMARY.md](./SESSION_2_SUMMARY.md) — Phase 1 wrap (database foundation; staging-apply pending Patrice authorization)

## Forthcoming (later sessions)

- `RLS_POLICY.md` — Phase 1.3 (full policy text + test approach; complements RLS_ROLLOUT)
- `API_REFACTOR_LOG.md` — Phase 2.4 (per-route refactor audit trail)
- `PRODUCTION_MIGRATION.md` — Phase 8.2 (uses `{{VERCEL_PROJECT_NAME}}` and `{{NEON_DATABASE_URL_PROD}}` placeholders until Patrice supplies them)
- `PRODUCTION_READINESS.md` — Phase 9.2
- `MULTI_TENANT_PLAYBOOK.md` — Phase 8.4
- `PRIVACY.md` — Phase 6.3 / 8.4 (cross-tenant aggregation anonymity guarantees)
- `PERFORMANCE_TUNING.md` — Phase 7.2

## Cadence summary

| Doc category | Update frequency | Owner |
|---|---|---|
| ADRs (001–004) | Rarely (only on supersession) | Patrice |
| Operational docs (PERMISSIONS_MATRIX, TENANT_CONFIG_SEMANTICS, SECURITY, BILLING_DEFERRED) | Quarterly OR on policy change | Patrice |
| Live tracking (RLS_ROLLOUT, SESSION_TIME_LOG) | Daily during M3 / End of every session | Whoever runs the session |
| Audit + drift (TENANTING_AUDIT, STACK_DRIFT_REPORT, SESSION_1_SUMMARY) | Frozen post-Session 1 unless schema changes | Historical reference |
