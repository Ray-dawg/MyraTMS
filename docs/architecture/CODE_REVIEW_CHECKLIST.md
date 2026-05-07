# CODE_REVIEW_CHECKLIST.md

> **Purpose:** Catch tenant-isolation regressions during the long
> Phase M3 → M4 soak window (per ADR-004 §Long calendar time mitigation).
>
> **Audience:** Anyone reviewing a PR that touches DB access, API
> handlers, BullMQ workers, lib helpers, or anywhere `getDb` /
> `withTenant` / `asServiceAdmin` is referenced.
>
> **When to use:** Every PR that modifies code under `MyraTMS/app/api/`,
> `MyraTMS/lib/`, or `MyraTMS/scripts/`. PRs that only touch
> documentation, tests, frontend-only components, or marketing assets
> can skip.
>
> **Why a checklist instead of a custom ESLint rule:** the project has
> no ESLint config beyond Next.js defaults; adding a custom rule needs
> config setup that is its own session. The checklist captures the same
> intent at lower cost. Promote to a custom rule if the checklist
> consistently misses.

## §1 — Tenant scoping (must-pass)

For every DB-touching code path in the diff:

- [ ] **No new `getDb()` calls** for tenant-scoped reads or writes.
      `getDb` stays for: `auth/login`, `auth/driver-login`, public
      tracking-token resolution **before** `resolveTrackingToken`,
      cron auth header check (no DB), and lib utilities that explicitly
      target global tables (`distance_cache`, `fuel_index`,
      `loadboard_sources`).
- [ ] Tenant-scoped reads/writes use `withTenant(ctx.tenantId, async (client) => …)`.
- [ ] The route resolves tenant context via `requireTenantContext(req)`
      (not `getCurrentUser(req)?.tenantId`) so middleware-injected
      headers take precedence over the JWT fallback.
- [ ] All queries inside the `withTenant` callback are parameterized
      (`client.query("... WHERE x = $1", [value])`) — no string
      interpolation of user input into SQL.
- [ ] Multi-step routes (read-then-write) are inside ONE `withTenant`
      block so they share a transaction.

## §2 — Cross-tenant escapes (must-pass when applicable)

If the diff introduces or modifies an `asServiceAdmin(...)` call:

- [ ] The `reason` string is ≥ 5 chars and describes the operation
      meaningfully (e.g., "Cross-tenant email uniqueness check for new invite",
      not "x" or "lookup").
- [ ] The escape is genuinely necessary — could the work be done with
      a normal `withTenant` call instead?
- [ ] If the work is admin-only, `requireSuperAdmin(req)` is called
      BEFORE `asServiceAdmin` so unauthorized callers don't generate
      audit-log noise.
- [ ] Public-token paths (e.g. `/track/{token}`, `/rate/{token}`) use
      `resolveTrackingToken` first to convert the token to `tenantId`,
      then `withTenant` for follow-on queries.

## §3 — Crons (must-pass when applicable)

If the diff adds or modifies a cron handler in `app/api/cron/`:

- [ ] The cron iterates active tenants via `forEachActiveTenant(reason, cb)`
      instead of calling `withTenant` once for an arbitrary tenant.
- [ ] Per-tenant work is wrapped in try/catch so one tenant's failure
      doesn't abort the run for others (the helper already does this;
      verify the cron's body doesn't add its own short-circuiting).
- [ ] Auth header check (`x-cron-secret` or `Bearer ${CRON_SECRET}`)
      runs BEFORE the iteration.
- [ ] Engine 2 crons (`pipeline-health`, `feedback-aggregation`,
      `pipeline-scan`) are intentionally exempt per Engine 2 Rule A
      until migration 030 lands — don't accidentally convert them.

## §4 — Schema changes (must-pass when applicable)

If the diff includes a new SQL migration in `MyraTMS/scripts/`:

- [ ] A paired `*_rollback.sql` exists and is idempotent.
- [ ] New tables that hold per-tenant data have `tenant_id BIGINT NOT NULL
      REFERENCES tenants(id) ON DELETE CASCADE`.
- [ ] New tables that hold per-tenant data have an RLS policy CREATED
      (not enabled — Phase M3 enables in batches per RLS_ROLLOUT.md).
- [ ] Indexes on tenant-scoped tables lead with `tenant_id` (composite
      indexes work, but `tenant_id` must be in leading position so RLS
      filtering hits them).
- [ ] If the migration touches existing rows, a `current_setting('myra_migration.tenant_id')`
      default is used so backfills don't require a separate UPDATE pass.
- [ ] Migration is named with the next sequential number (032, 033, …)
      and has a leading-zero-free prefix (we use `031_tenant_usage.sql`,
      not `031_tenant-usage.sql` — underscores, not hyphens, per
      existing convention).

## §5 — Feature gating (must-pass when applicable)

If the diff exposes a tier-restricted capability (any new route, any
new BullMQ job type, any new cron iterator that should skip free-tier
tenants):

- [ ] The capability is named in `lib/features/index.ts` `FEATURES`.
- [ ] `requireFeature(subscription, feature)` is called BEFORE the work
      starts. The subscription is fetched via `loadTenantSubscription(ctx.tenantId)`.
- [ ] Errors from `requireFeature` are mapped to 403 via `gateErrorResponse`.
- [ ] Metered capabilities additionally call `withinLimit(subscription, key, currentUsage)`
      with usage from `getCurrentUsage(tenantId, key)` (lib/usage/tracker).
- [ ] On success, `incrementUsage(tenantId, key)` is called as a
      side-effect AFTER the main work commits (don't increment on error).
- [ ] UI changes that gate the same capability use the non-throwing
      `useHasFeature(name)` hook — UI hiding is COSMETIC, server is
      authoritative.

## §6 — Tenant-aware UI (must-pass when applicable)

If the diff modifies a page that calls `useTenant()` / `useFeatures()` /
`useHasFeature()`:

- [ ] The page handles BOTH `tenant === null && isLoading` (still loading,
      render spinner) AND `tenant === null && !isLoading` (failed to load,
      render error). Conflating these produced the perpetual-loading bug
      in Session 7. Use `useTenantStatus()` to get the explicit status.
- [ ] Cosmetic super-admin gates (e.g. `/admin/*`) render an inline
      "Forbidden" message rather than `router.push`-ing — avoids the
      flash-of-redirect on slow networks.
- [ ] Tier-gated nav items have a `requiredFeature: Feature` (not just
      hardcoded route paths) so the same `Feature` keyword works in
      route, sidebar, and command palette.

## §7 — Encrypted config (must-pass when applicable)

If the diff PATCHes a `tenant_config` row from a route handler:

- [ ] Plaintext keys store `JSON.stringify(value)`; encrypted keys
      store `encrypt(value-as-string)`. The `isEncryptedConfigKey(key)`
      helper decides which.
- [ ] The audit log entry records `<encrypted>` for both old and new
      values when the key is sensitive — never the plaintext credential.
- [ ] The PATCH validates the new value against `validateConfigValue(key, value)`
      (Zod schema in `lib/tenants/config-schema.ts`) before storage.
- [ ] The route requires a `reason` field (≥ 5 chars) in the request body.

## §8 — Tests (recommended, not always blocking)

For non-trivial logic changes:

- [ ] Unit tests added/updated where behavior changed (e.g., new
      branch in `lib/features/gate.ts`, new validator in `config-schema.ts`).
- [ ] If the change is a new route, the response shape has at least
      one test case (see `__tests__/lib/me-tenant-shape.test.ts` for the
      contract-pin pattern).
- [ ] Tests don't introduce real DB / Redis access in unit-tier files
      — those go in `tests/multitenant/` integration suite gated on
      `RUN_INTEGRATION_TESTS=1`.
- [ ] Mocking pattern: `vi.mock("@/lib/db/tenant-context", ...)` with
      a `vi.hoisted({ mockWithTenant })` block when sharing the mock fn
      between factory and test body. (See `cross-tenant-leak.test.ts`
      for the canonical pattern.)

## §9 — Documentation (recommended)

- [ ] If the change introduces a new public helper, add a JSDoc with
      a `Spec:` reference to the relevant ADR or design doc.
- [ ] If the change is a new admin route, add a row to
      `API_REFACTOR_LOG.md` under the matching section.
- [ ] If the change reveals new drift from documented assumptions,
      add an entry to `STACK_DRIFT_REPORT.md` §10.

## §10 — Final gate

Before approving:

- [ ] `npx tsc --noEmit` passes (run locally or wait for CI).
- [ ] `pnpm vitest run` passes (5 pre-existing Engine 2 failures are OK;
      anything else regresses → block).
- [ ] No `.env.local`, `API-KEYS.md`, or other secrets in the diff.
- [ ] Migration files (if any) have been spot-checked against staging
      via STAGING_APPLY.md before merge.

End of checklist.
