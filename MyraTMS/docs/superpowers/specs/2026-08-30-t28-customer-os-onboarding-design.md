# T-28 — Customer OS & Onboarding — Design Doc

**Spec:** [T28_Customer_OS_Onboarding.md](../../../../Engine%203/T28_Customer_OS_Onboarding.md)
**Date:** 2026-08-30
**Status:** Design complete, ready for implementation plan.

## 1. The central finding: T-28's spec assumes infrastructure that doesn't exist, and misses infrastructure that does

Before writing any migration or code, this session did the "confirm live schema/reality" check every Engine 3 module has done since T-17. It surfaced something bigger than the usual column-type correction: **T-28's spec (§4.2) says it reuses "T-19's existing `POST /api/tenants`"** — but T-19's own completion-tracker entry explicitly lists tenant API endpoints as **not yet built**, and a live search confirms it: there is no `app/api/tenants/` directory, and no `createTenant()`/`addTenantUser()` function anywhere in `lib/`. That part of the spec's assumption is simply wrong.

**At the same time, a substantial, already-shipped, super-admin tenant-provisioning system exists that no Engine 3 document mentions at all:**

- `app/api/admin/tenants/route.ts` — `GET` (list) / `POST` (create) a tenant row, gated `requireSuperAdmin`
- `app/api/admin/tenants/[id]/route.ts`, `.../users/route.ts`, `.../purge/route.ts`, `.../export/route.ts`
- `app/api/admin/tenants/[id]/onboard/route.ts` — clones `DEFAULT_TENANT_CONFIG` into `tenant_config`, seats an owner in `tenant_users`, flips `tenants.status` `trial → active`, writes `tenant_audit_log`
- `app/admin/tenants/[id]/onboard/page.tsx` — a 3-step wizard UI (Review → Owner → Confirm) driving that route
- `lib/tenants/{defaults,validators,config-schema}.ts` — `DEFAULT_TENANT_CONFIG`, slug validation (`assertValidTenantSlug`, `RESERVED_TENANT_SLUGS`), Zod validators per config key
- `tenants` (migration `027`, already has `type IN ('operating_company','saas_customer','internal')`, `status`, `parent_tenant_id`, `billing_email`, `primary_admin_user_id`), `tenant_config`, `tenant_users`, `tenant_audit_log`, and **`tenant_subscriptions`** (tier/status/`feature_overrides`/stubbed `billing_provider`/`external_subscription_id`/`external_customer_id` — i.e. exactly the "billing intent" shape T-28 §2 asks for) — all migration `027_multi_tenant_foundation.sql`, part of MyraTMS's own base multi-tenant build (top-level `CLAUDE.md`'s "Multi-tenancy" section), predating and independent of Engine 3.

This system was built by a parallel/earlier session never logged in `Engine 3/docs/superpowers/plans/completion.md`. It is real, live, and does real work — but it has **zero connection to T-19's policy engine**: `tenants.type` (`operating_company/saas_customer/internal` — a platform/billing axis) is a completely different column from T-19's `tenants.freight_business_type` (`broker/dispatcher/carrier/acquired_opco` — a freight-business axis, migration `035`), and the existing `/onboard` route never touches `tenant_type_policy_templates` or writes a `tenant_policies` row. **No tenant provisioned through the existing admin flow today gets a governance policy at all.** That gap is real and previously undocumented, not a T-28 invention.

**Consequence for scope:** T-28 is not "build tenant provisioning from scratch." It is:
1. Extract the existing admin flow's tenant-creation/config-clone/owner-seat logic into shared, reusable functions (currently inlined twice, in two route files) so T-28's new self-serve session flow calls the *same* code the admin UI already exercises in production — not a parallel reimplementation.
2. Add the one genuinely missing capability: applying a `tenant_type_policy_templates` row to a new tenant as a `tenant_policies` row. This has never been built as a reusable function — migration `035` did it once, by hand, in raw SQL, for Myra only.
3. Build the net-new `tenant_onboarding_sessions` staged-flow layer the spec actually asks for, on top of (1) and (2).

## 2. Other schema-reality corrections vs. the base spec

1. **§4.2's `createTenant()`/`addTenantUser()` pseudocode functions don't exist** — see §1. Built fresh in `lib/tenants/provision.ts`, and the two existing admin routes are refactored (behavior-preserving) to call the same functions, per the "extend, never duplicate" precedent T-22/T-25/T-26/T-27 all set.
2. **`tenants.type` vs `tenants.freight_business_type` are two different axes that both need setting.** T-28's session must capture both: `tenantType` (T-19's `freight_business_type`, drives policy template selection) and the pre-existing `tenants.type` (`operating_company`/`saas_customer`/`internal`, the platform/billing relationship axis the admin tooling already uses for its own listing/filtering). A new external tenant licensing MyraOS (T-28's actual subject, per the spec's own §1 distinction) is `tenants.type = 'saas_customer'` by construction — this is not user-chosen, it's implied by using the self-serve flow at all.
3. **"Billing intent captured" (spec §2) has a real destination table already: `tenant_subscriptions`.** T-28 does not invent a new billing-intent field — the `billing_captured` step writes `tier` (mapped from the session's plan choice) into the existing `tenant_subscriptions` row, leaving `billing_provider`/`external_subscription_id`/`external_customer_id` NULL exactly as today's schema comment says ("NULL until billing session" — T-29's explicit scope). No new table for this.
4. **§4.4's claim that "approval correctly flips `tenants.status` to fully active via the existing PATCH mechanism's pattern" is aspirational, not real.** `PATCH /api/exceptions/[id]`'s `resolve` action (`app/api/exceptions/[id]/route.ts`) only updates `exceptions`/`loads.has_exception` and logs a T-17 `exception.resolved` event — it has no knowledge of `source_module` beyond that logging payload, and no side effect on `tenants`. This needs one small, additive branch in that route (mirroring the existing "log a permanent T-17 event... never blocks or alters the response above" pattern already there): `if (exc.source_module === 'tenant_onboarding' && exc.type === 'go_live_requested')`, flip `tenants.status` to `active` and advance the session to `current_step = 'live'`, `status = 'completed'`. Non-blocking, same discipline as the existing event-logging block right above where it goes.
5. **`bridgeToExceptions()` silently no-ops without a matching classification rule.** `matchClassificationRule(tenantId, sourceModule, context)` (T-24) must return a rule or `bridgeToExceptions` returns `false` before ever reaching the insert — this is exactly how T-18's `authority_shadow` sourceModule is deliberately suppressed (`bridge.ts` line 34). T-28's `go_live_requested` exception type needs its own seed row in `exception_classification_rules` (additive migration, same table T-24 created and T-25 already added 2 rows to) or every go-live request will silently vanish. Severity `medium` per spec §4.4's own literal.
6. **`lib/exceptions/bridge.ts`'s `SourceSignal.sourceModule` union needs one more member.** Same one-line-widening precedent as T-25 (`payer_risk`/`transaction_halt`) and T-26 (`document_terms_mismatch`): add `'tenant_onboarding'`. No other line in that file changes.
7. **Two DB access patterns are both legitimately in play here, used for different things — not a bug to unify.** The existing admin tenant routes use `asServiceAdmin()`/`PoolClient` (`lib/db/tenant-context.ts`, a real `pg` `Pool`). Engine 3 governance/pricing/dispatch code (T-19/T-21/T-23/T-24) uses `lib/pipeline/db-adapter`'s `db.query(text, params)` (Neon serverless). `lib/tenants/provision.ts`'s functions take a `client`/`query` parameter generically (matching whichever caller passes it in) rather than importing one specific client, so both the admin routes (via `asServiceAdmin`) and T-28's own new routes (via `withTenant`/`db`) can call the same functions without forcing a client migration in either direction.
8. **The dry-run step (§4.3) only needs read paths, confirmed side-effect-free.** `evaluatePolicy()` (`lib/governance/evaluate-policy-db.ts`) and `resolveDispatchRouting()` (`lib/dispatch/routing.ts`) are pure reads against `tenant_policies`/`dispatch_routing_rules`. `quotePricing()` (`lib/pricing/pricing-engine.ts`) computes and also inserts one audit row into `pricing_engine_requests` (T-21) — that's an existing, intentional side effect of every real call to that function (not something T-28 introduces), and it's tenant-scoped by design, so a dry-run call is not free of every side effect, but it writes only to T-21's own audit trail, never to `pipeline_loads` — satisfying criterion 3's actual requirement ("zero writes to real `pipeline_loads`").

## 3. What gets built

### 3.1 Migration `058-t28-customer-os-onboarding.sql`
- `tenant_onboarding_sessions` exactly per spec §4.1.
- One seed row in `exception_classification_rules` for `source_module = 'tenant_onboarding'`, `exception_type = 'go_live_requested'`, `severity = 'medium'` (finding #5 above).

### 3.2 `lib/tenants/provision.ts` (new — the shared layer, finding #1/#2/#3)
- `createTenantRow(query, input)` — same INSERT `app/api/admin/tenants/route.ts` already does (slug validated by the existing `assertValidTenantSlug`), extended to also accept `freightBusinessType` (nullable — the existing admin flow doesn't set it, and shouldn't be forced to).
- `cloneDefaultTenantConfig(query, tenantId)` — same clone-loop as `.../onboard/route.ts`.
- `seatTenantOwner(query, tenantId, userId)` — same owner-seat + `is_primary` clear-then-set logic as `.../onboard/route.ts`.
- `applyTenantTypePolicyTemplate(query, tenantId, freightBusinessType)` — **new capability.** Reads the matching `tenant_type_policy_templates` row and inserts version-1 `tenant_policies`, generalizing migration `035`'s one-time Myra-only SQL (finding #1, step 2) into a reusable function.
- `captureBillingIntent(query, tenantId, tier)` — upserts `tenant_subscriptions.tier`/`status='trial'` (finding #3).
- **Refactor** `app/api/admin/tenants/route.ts` and `app/api/admin/tenants/[id]/onboard/route.ts` to call `createTenantRow`/`cloneDefaultTenantConfig`/`seatTenantOwner` instead of inlining the SQL — behavior-preserving, covered by the existing route tests (if any) plus new regression tests asserting identical request/response shape before and after.

### 3.3 `lib/tenants/onboarding-session.ts` (new — the session state machine)
- `startSession()`, `advanceSession(sessionId, step, stepData)`, `provisionTenantFromSession(sessionId)` (calls `createTenantRow` once `company_created` data is present), `runDryRun(sessionId)` (§4.3, calls `evaluatePolicy`/`resolveDispatchRouting`/`quotePricing` against a synthetic fixture load built from the session's own `load_sources_selected`/`policy_confirmed` step data), `requestGoLive(sessionId)` (calls `bridgeToExceptions` with `sourceModule: 'tenant_onboarding'`, per spec §4.4).

### 3.4 API routes per spec §5
`POST /api/tenant-onboarding/start`, `PATCH /api/tenant-onboarding/:sessionId`, `POST /api/tenant-onboarding/:sessionId/test`, `POST /api/tenant-onboarding/:sessionId/request-go-live`, `GET /api/tenants/:id/onboarding-status`. **Gated `requireSuperAdmin`, same trust boundary as the existing `/api/admin/tenants/*` routes** — the spec's own §2 explicitly defers "where the signup flow is linked from publicly" as out of scope, so v1 is Patrice-operated on behalf of a prospect (same operating model as the existing onboard wizard), not an unauthenticated public signup form. This is a deliberate scope choice, not an oversight — revisit only if a future module explicitly asks for public self-serve entry.

### 3.5 `PATCH /api/exceptions/[id]/route.ts` — one additive branch (finding #4)
After the existing "log a permanent T-17 event" block, non-blocking: if `exc.source_module === 'tenant_onboarding'` and `exc.type === 'go_live_requested'`, flip `tenants.status = 'active'` and `tenant_onboarding_sessions.current_step = 'live', status = 'completed'` for the session tied to that tenant.

### 3.6 `lib/exceptions/bridge.ts` — one-line `SourceSignal.sourceModule` union widening (finding #6), same pattern as T-25/T-26.

## 4. Acceptance criteria mapping (spec §6)

1. Full flow, fixture tenant of each `freight_business_type` → real `tenants`/`tenant_policies`/`tenant_users` rows via the shared `lib/tenants/provision.ts` functions (not duplicated logic) — **note the spec's own wording ("via T-19's existing endpoints") is corrected per finding #1: there are no such endpoints; the shared functions are the zero-duplication mechanism instead, which is what the criterion is actually protecting.**
2. Explicit regression test: zero writes to `shippers`/`carriers` — grep-style test over every query string executed during a full session run, or an integration test asserting row counts unchanged.
3. Dry-run test: fixture tenant, synthetic load, zero `pipeline_loads` writes (finding #8: `pricing_engine_requests` writes are expected and fine; `pipeline_loads` writes are what's actually forbidden).
4. Go-live request appears in Alert Center as `source_module = 'tenant_onboarding'` (requires finding #5's classification-rule seed) and approval flips `tenants.status` (requires finding #4's route branch) — both are real gaps this design closes, not already-working mechanisms the spec assumed.
5. T-16 suite green; zero changes to `/get-started`, C-06's SOP, carrier recruitment agent config.

## 5. What this design deliberately does NOT touch

- The existing `app/admin/tenants/**` UI and `/api/admin/tenants/**` routes' external behavior (only their internals, via the extraction in §3.2 — response shapes and request contracts are unchanged, verified by keeping their existing tests green).
- `shippers`, `carriers`, `/get-started`, the carrier recruitment Retell config — per spec §2/§9, and criterion 2 exists specifically to prove this in code.
- Real billing collection, white-label branding — T-29's scope, confirmed still correctly deferred (finding #3 shows the *table* for billing intent already exists, but nothing that talks to Stripe/a payment processor is touched here).
