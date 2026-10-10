# MyraTMS (core platform) — Next Step

> Written 2026-10-07 against `master` @ `41afeb6`. Paste this whole file as the opening message of a new conversation dedicated to the TMS platform (multi-tenant rollout, DApp, tracking page, landing site, platform hygiene). Re-verify facts before acting.

## Progress log

- **2026-10-07 (session 1 of this brief):** Step 1 done — tests refuse production (`lib/db/production-guard.ts`), `.env.local` → `dev-tests` branch, full run 849/864 then fixed/quarantined to green except `ranker`/`researcher` timing. Step 2 done — index audit green, leak suite (never previously run) now green, login route fixed. **Step 3 blocked**: see `docs/architecture/RLS_ROLLOUT.md` §0 — `neondb_owner` has BYPASSRLS (needs `myra_app` role + migration 061 + DATABASE_URL rotation) and 029's policies need migration 060. Neither applied to production; both need Patrice's go-ahead.

## Where it stands

- **Multi-tenant M1 + M2 in production since 2026-05-04** (migrations 027–031 applied; code promoted; `docs/architecture/PRODUCTION_MIGRATION_LOG.md` Entry 1). Verified 2026-10-07: RLS was OFF on every table. **Update 2026-10-08: M3 Day 1 done — RLS enabled on `tenant_audit_log`; Days 2–12 pending; Railway still on `neondb_owner`**, `pipeline_loads.tenant_id` does not exist (M5 / migration 030 not started), M4 not started.
- **Application code is the only tenant boundary.** A missed `withTenant()` leaks across tenants and nothing in the database catches it. Four Engine 3 routes shipped tenant-isolation IDORs that review caught; the next one might not be caught.
- **Test suite hazard.** `MyraTMS/.env.local`'s `DATABASE_URL` has pointed at production; most Engine 2/3 tests write rows. About 10 of ~850 tests fail on a rotating basis (`cost-calculator`, `carrier-brief-compiler-worker`, `ranker`, `researcher`, `t25-reconcile-payer`).
- **Deferred code follow-ups** (HANDOFF.md §4): daily Redis→`tenant_usage` aggregation cron, purge executor, zip export, `user_invites.role` widening, `useUsage()` hook, white-label domain UI, impersonation UI, owner-picker user search, component tests, pool tuning, Stripe billing (whole scope), warehouse build.
- **Known platform issues** (root `CLAUDE.md`): notifications dual source, non-atomic `PATCH /api/loads/[id]`, duplicate distance services, Edge-runtime JWT verifier that must track `lib/auth.ts` by hand.
- **Client apps.** DApp, One_pager (now also confirm mode), landing are deployed on Vercel. Their plans (`docs/plans/2026-02-28-dapp-*.md`, `docs/superpowers/plans/2026-03-19-myra-landing.md`) have no ticked checkboxes and no tracker; status is whatever is live.

## The next step: make the test suite safe, then start Phase M3 (RLS) batch 1

**Why this order.** RLS is the one change that turns "we hope every route scopes by tenant" into "the database refuses otherwise." It was designed, scheduled and staged in May and never started. But its pre-flight (cross-tenant leak audit, index audit, two-tenant staging soak) runs the test suite repeatedly, and today the suite can write to production. Fix that first.

1. **De-risk the suite (half a session).**
   - Create a persistent dev Neon branch from production; point `.env.local`'s `DATABASE_URL` there.
   - Add a guard in `vitest.config.ts` / `lib/pipeline/db-adapter.ts` setup that refuses to run when the connection string contains the production branch id `br-rough-forest-aif4a3vf` unless an explicit `ALLOW_PROD_TESTS=1` is set.
   - Fix or quarantine the five rotating failures so a green run means something.
2. **Pre-flight M3** (`docs/architecture/RLS_ROLLOUT.md`, `PERFORMANCE_NOTES.md` §7).
   - Seed two tenants on the staging branch; run `lib/test-utils/cross-tenant-leak.ts` — zero leaks is the green light.
   - Index audit: every `tenant_id` column used in a policy has an index.
   - Re-read `docs/architecture/API_REFACTOR_LOG.md` for any route added since May (all Engine 3 routes) and confirm each uses `withTenant()`/`asServiceAdmin()`.
3. **Enable batch 1** on production: `tenant_audit_log`, then `tenant_users`, then `tenant_subscriptions` — one per day per the schedule, watch `tenant_audit_log` for 4 hours after each. Update `RLS_ROLLOUT.md` after every flip. Engine 2 tables stay deferred to M5.
4. **Continue the schedule** (`shippers`, `invoices`, `carriers`, then `loads` after the 48-hour staging soak and perf benchmark).

**Stop before** the first production `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and confirm with Patrice; it is reversible but it is a production behavior change.

## After that, in rough priority

- Migration 030 (Engine 2 tenanting) — but only after Engine 2 has run stable in production for 24 hours; that is the Engine 2 stream's milestone, not this one's.
- HANDOFF §4 follow-ups 1 and 3 (usage aggregation cron, purge executor) — small, self-contained.
- Dedupe `lib/geo/distance-service.ts` vs `lib/quoting/geo/distance-service.ts`.
- Notifications dual source and `PATCH /api/loads/[id]` atomicity.
- Billing (Stripe) is a whole session on its own — `docs/architecture/BILLING_DEFERRED.md`.

## Working rules for this stream

Every tenant-scoped read/write goes through `withTenant()`; every cross-tenant escape through `asServiceAdmin(reason, …)`. Migrations are paired with rollbacks. `tenant_audit_log` is append-only. Never hardcode a tenant id. Update `RLS_ROLLOUT.md` on every flip and `PRODUCTION_MIGRATION_LOG.md` on every production apply.

## Suggested opening prompt

```
MyraTMS platform session. Read CLAUDE.md (root), docs/architecture/HANDOFF.md, docs/architecture/RLS_ROLLOUT.md,
and docs/next-steps/MYRATMS.md. Step 1: make the test suite unable to touch the production Neon branch by
accident, then get a clean green run. Report before starting the RLS pre-flight.
```
