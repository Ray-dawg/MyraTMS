# STACK_DRIFT_REPORT.md

> **Session:** 1 — Phase 0 / Task 0.6
> **Date:** 2026-05-01
> **Purpose:** Document every place where the original mega-mission's tech-stack assumptions diverge from the actual MyraTMS codebase. Per Patrice's Answer 3: follow the actual code, adapt the plan to it.

Each row: **Original assumption** (what the mega-prompt said) → **Actual reality** (what's in the repo) → **Implication** (what changes for the plan) → **Recommended adaptation** (how I'll proceed in Sessions 2–8).

## §1 — Framework / runtime

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 1.1 | Next.js 14 (App Router) | Next.js 16.0.10 (MyraTMS), 16.1.6 (DApp/One_pager), ^16.2.0 (myra-landing) | `cookies()`/`headers()` are async in 16; `params` Promise; middleware Edge runtime API has shifted; `NextResponse.json` typing changed | All ADR-002 middleware code samples target Next.js 16 idioms. Phase 2.1 deliverable will use async `cookies()`. |
| 1.2 | "73 API routes" | 90 `route.ts` files under `MyraTMS/app/api/` (31 top-level groups) | Phase 2.4 ("refactor every API route") underbudgeted by ~23%. Estimate scales from "~3 hours" to "~4 hours". | Updated Session 3 estimate to 4h (was 3–4h, now firm 4h). Itemized refactor list goes into `API_REFACTOR_LOG.md` in Session 3. |
| 1.3 | React 18 implied (Next 14 default) | React 19.2.x | `useActionState` available, server actions stable, `use()` hook for promises. Doesn't change ADRs but changes Phase 5 UI patterns. | No Phase 0 impact; flagged for Session 6 (UI). |

## §2 — Auth

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 2.1 | NextAuth (or "similar") | Custom JWT in `MyraTMS/lib/auth.ts` (`jsonwebtoken` + `bcryptjs`) with httpOnly cookie `auth-token` (24h). Edge-runtime middleware re-implements HMAC-SHA256 verification via `crypto.subtle` because `jsonwebtoken` cannot run in Edge. | Phase 2.3 ("auth + session integration") cannot use NextAuth callbacks/adapters. Must extend the existing `JwtPayload` interface and re-sign the Edge verifier. | ADR-002 specifies extending `JwtPayload` with `tenantId: number` and `tenantIds: number[]` (for multi-tenant users). Phase 2.3 updates `createToken()`, `verifyToken()`, `verifyJwtEdge()` in lockstep. No new auth lib. |
| 2.2 | "JWT-embedded `tenant_id` claim" | Today's JWT has no tenant claim — it has `userId, email, role, firstName, lastName, carrierId?` | Adding `tenantId` invalidates all existing tokens at deploy time (claim shape changes → users re-login). | Two-step: (a) Phase 2.3 deploys code that ACCEPTS tokens with or without `tenantId`, defaulting missing to tenant 1; (b) two weeks later (after token rotation), require `tenantId`. Same pattern as ADR-004 backwards-compat. |
| 2.3 | "Require tenant selection at login if user belongs to multiple tenants" | The driver login flow (`/api/auth/driver-login`) takes carrier_code + PIN. There's no concept of tenant choice. | DApp must learn its tenant context — either from subdomain (`drivers.acme.myraos.ca`) or from the carrier_code → carrier → tenant lookup chain. | ADR-002 §Driver login: carrier_code resolves to the carrier's `tenant_id`, JWT issued for that tenant. No subdomain dependency for DApp at MVP. |

## §3 — Storage

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 3.1 | Cloudflare R2 for tenant exports + branding | `@vercel/blob ^0.27.0` is the only blob storage. No R2/S3 client in MyraTMS deps. | Adding R2 means a new SDK, new env vars, a new auth model, and a deploy-time risk. Vercel Blob already supports public + private modes (per the session-start hook), 7-day signed URLs, and unlimited storage on Pro plans. | Phase 3.4 (tenant export) and Phase 5.3 (whitelabel branding) target Vercel Blob. Path convention: `tenants/{tenantId}/exports/{exportId}.zip` and `tenants/{tenantId}/branding/{logo|favicon}.{ext}`. R2 deferred indefinitely. |
| 3.2 | "Cloudflare R2 with 7-day signed URL" | Vercel Blob signed URLs supported via `@vercel/blob` `getDownloadUrl()` with TTL | Same UX, different SDK call. | Phase 3.4 uses `@vercel/blob`. |

## §4 — Payment / billing

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 4.1 | "Stripe + Persona for fintech (Quick Pay v0)" | No `stripe` or `@stripe/stripe-js` in MyraTMS deps. Quick Pay is greenfield. | Phase 4.5 ("billing integration") is build-from-scratch, not refactor. | **APPROVED 2026-05-01:** Stripe billing deferred entirely to a dedicated standalone session per Patrice Q8. Phase 4 retains only 4.1–4.4 (feature gating + usage tracking, ~2h). Schema stubs (`billing_provider`, `external_subscription_id`, `external_customer_id` NULLABLE) are added in Phase 1 to support future wiring. Full deferral scope and starting point in [BILLING_DEFERRED.md](./BILLING_DEFERRED.md). |
| 4.2 | "Persona for KYC" | No Persona integration | Same as 4.1 | Out of scope for Phases 1–4. Picked up in the same future session as Stripe billing. |

## §5 — Workers / queues

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 5.1 | "BullMQ workers (scanner, qualifier, …) live in this repo" | BullMQ is a MyraTMS dep (`bullmq ^5.76.4`). Worker source files live in `Engine 2/` (delivery package) and are copied into `MyraTMS/lib/workers/` per `Engine 2/CLAUDE.md`. The Railway scraper (T-04A) is a sibling deploy that hits the same Postgres. | Phase 2.5 ("worker refactor") splits across two deployment units — MyraTMS (Vercel) and the Railway scraper. Coordination required for env var rollout. | Per Rule A: Phase 2.5 is **deferred to Phase 6.5**. Phases 2–4 only refactor non-worker code paths. Phase 6.5 adds `tenantId` to all queue payloads and updates worker bootstrap. |
| 5.2 | "Engine 2 v1 in production" | Engine 2 v1 is integrated into the schema (migrations 023–026 are pipeline corrections) but per Patrice (Answer 4), Engine 2 v1 has not yet run end-to-end in production for the required 24h. | Phase 6.5 gating depends on a future event we don't control. | ADR-004 Phase 4 ("remove single-tenant code paths") cannot complete until Phase 6.5 is done. Documented as a hard dependency. |

## §6 — Data warehouse

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 6.1 | "Postgres logical replication slot, raw zone tables, dbt models" | None of these exist. No `dbt_project.yml`, no warehouse infra. | Phase 6 as written is build-from-scratch (~weeks of work, not 2h). | Per Patrice's Answer 5: Phase 6 is **REPLACED** by a 30-minute documentation task that lists future warehouse integration points and confirms Neon logical replication is enabled. Full warehouse build is a separate dedicated session. ADR-001 §Future migration to schema-per-tenant references this. |

## §7 — Production deployment

| # | Original assumption | Actual reality | Implication | Recommended adaptation |
|---|---|---|---|---|
| 7.1 | "MyraTMS not yet deployed to Vercel as standalone" (per the existing CLAUDE.md when this audit started) | Per Patrice's Answer 6: MyraTMS IS deployed and running in production today on Vercel. | The existing CLAUDE.md note is stale. Phase 8 production migration plan is real, not aspirational. | Update repo `CLAUDE.md` in Session 8 (Phase 9 documentation pass) to reflect actual prod URL/project name. Phase 8 plan uses Vercel deployment-revert + Neon PIT restore as rollback path. |
| 7.2 | "Cron jobs configured in `MyraTMS/vercel.json`" | Confirmed: 4 crons in `vercel.json` (fmcsa-reverify 2am, invoice-alerts 8am, exception-detect noon, shipper-reports monthly). Engine 2 adds 3 more (pipeline-scan every minute, pipeline-health every 5min, feedback-aggregation 7am) per `Engine 2/CLAUDE.md`. | Cron routes need tenant iteration (Phase 2.4 §6 in TENANTING_AUDIT). Engine 2 crons are deferred per Rule A. | Phase 2.4 adds tenant-iteration to the 4 existing crons. Engine 2 crons handled in Phase 6.5. |

## §8 — Misc references the prompt got right

For audit completeness — these are NOT drifts, just confirmations:

- ✅ Neon PostgreSQL (serverless) via `@neondatabase/serverless` — confirmed
- ✅ Upstash Redis for queues + caching — confirmed (Engine 2 uses `ioredis` for BullMQ; main app uses Upstash REST)
- ✅ Retell AI voice agent — confirmed (Engine 2 integration)
- ✅ Mapbox for maps — confirmed
- ✅ xAI/Grok for AI chat — confirmed
- ✅ Vercel Blob — confirmed (used over the assumed R2)
- ✅ Tailwind 4.x + Shadcn/UI (NY style) — confirmed
- ✅ pnpm package manager — confirmed
- ✅ TypeScript strict in MyraTMS, relaxed in DApp — confirmed
- ✅ Custom JWT auth — confirmed (over the assumed NextAuth)
- ✅ 4 deployed Vercel projects (MyraTMS, DApp, One_pager, myra-landing) — confirmed

## §9 — Net plan adjustments resulting from drift

| Original | Adjusted |
|---|---|
| Phase 1: 4–6h | Same |
| Phase 2: 3–4h | **4h firm** (90 routes, not 73) |
| Phase 3: 4–5h | Same |
| Phase 4: 2–3h | **2h** for gating + tracking; **billing deferred** to standalone session |
| Phase 5: 3–4h | Same |
| Phase 6: 2h (warehouse) | **30 min** (documentation only, per Patrice) |
| Phase 7: 3–4h | Same |
| Phase 8: 2–3h | Same |
| Phase 9: 1h | Same |
| **Phase 6.5 (Engine 2 tenanting, deferred)** | **2–3h** post-Engine-2-v1-validation |

**Total revised:** 21.5–28h across 8 sessions (was 25–40h across 9 phases). Reduction comes from removing the warehouse build and deferring billing to a separate session.

**APPROVED 2026-05-01** (Patrice Confirmation 3): per-session 20% overage triggers documentation; 50% triggers a pause for Patrice scope review; cumulative 35h triggers a structural alarm. Live tracking in [SESSION_TIME_LOG.md](./SESSION_TIME_LOG.md).

## §10 — Drift discovered in Session 3 (multi-tenant API refactor)

| # | Finding | Implication | Action |
|---|---|---|---|
| 10.1 | **AXIOM naming collision** — there is no actual collision in the current schema, but the audit flagged a *future* risk: `lib/quoting/geo/distance-service.ts` and `lib/geo/distance-service.ts` both manage a globally-shared `distance_cache` table. They were independently written and use different connection patterns. | If both modules are loaded in the same request, two `withTenant` calls each open their own pooled connection just to read a row from `distance_cache`. Because `distance_cache` is a global cross-tenant table, the second `withTenant` is wasteful and creates pool pressure under load. | Recorded — followup: Phase 7 (perf) should consolidate the two modules and switch to a single HTTP-mode `getDb()` read-path for the global tables (`distance_cache`, `fuel_index`, `loadboard_sources`). Not a Session 3 concern. |
| 10.2 | **`lib/pipeline/db-adapter.ts` exports `db.sql` typed as `any`** | Engine 2's RankerWorker called `matchCarriers(db.sql, …)` (old single-tenant signature). Because `db.sql` is `any`, this typechecked even after `matchCarriers` changed signature to `(tenantId: number, request)`. At runtime `withTenant` rejected the function-typed tenantId. The unit test `__tests__/pipeline/ranker.test.ts` caught it. | **Hotfixed in Session 3:** `lib/workers/ranker-worker.ts` now imports `LEGACY_DEFAULT_TENANT_ID` and calls `matchCarriers(ENGINE2_TENANT_ID, …)` + `storeMatchResults(ENGINE2_TENANT_ID, …)`. This pins Engine 2 to the Myra default tenant until migration `030_engine2_tenanting.sql.PENDING` lands and pipelines plumb per-load `tenant_id`. The `db.sql: any` typing should be tightened in the same migration. |
| 10.3 | **Missing `pipeline_loads.tenant_id` column** | Migration `030_engine2_tenanting.sql.PENDING` is the planned vehicle. Until it lands, Engine 2 cannot resolve a real tenant for matching/scoring. | Documented; covered by 10.2 hotfix in the interim. |
| 10.4 | **Pre-existing SQL injection in `app/api/shippers/[id]/route.ts` PATCH** — column name in the `SET <col> = $1` clause was derived from a regex of user-supplied keys. | Cross-tenant impact: a malicious admin could write to arbitrary columns or trigger a syntax error to leak DB internals. | **Fixed in Session 3** out of strict scope: added `ALLOWED_COLUMNS` whitelist mapping camelCase request keys to known snake_case column names. Recorded here so it appears in the security audit trail. |
| 10.5 | **`@/lib/db` mock pattern in unit tests is now stale** | `__tests__/lib/workflow-engine.test.ts` mocked `getDb()` as a tagged-template `vi.fn()`. After the engine moved to `withTenant` + `client.query()`, every test would have run against the still-real DB or short-circuited to undefined results. | Tests rewritten to mock `withTenant` from `@/lib/db/tenant-context`, with a fake `PoolClient` whose `.query()` is a `vi.fn()` returning `{ rows: […] }`. Pattern documented for future test refactors. |
| 10.6 | **Pre-existing test failures in `lib/pipeline/__tests__/cost-calculator.test.ts`** (5 numeric-drift assertions failing on values like "expected 721.62 to be greater than 1700"). | Engine 2 cost calculator parameters have moved since these tests were written; tests assert against stale brief-spec numbers. | Not a multi-tenancy issue. Engine 2 owns the fix when migration 030 / Engine 2 tenanting work picks up. |
