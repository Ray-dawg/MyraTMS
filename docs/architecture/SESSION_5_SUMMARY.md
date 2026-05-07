# SESSION_5_SUMMARY.md

> **Session:** 5 — Phase 4 (Feature gating + subscription tiers, no billing)
> **Started / closed:** 2026-05-06
> **Status:** ✅ COMPLETE — production typechecks clean, 320/325 tests pass (5 pre-existing Engine 2 cost-calculator failures unrelated to multi-tenancy)
> **Drafter:** Claude (Opus 4.7) under Patrice direction

## TL;DR

The platform now has a working three-layer feature-gating system per
ADR-003. Routes can call `requireFeature(sub, "autobroker_pro")` to gate
tier-restricted capabilities and `withinLimit(sub, "personas", current)`
to enforce quotas. UI components can call `hasFeature()` for cosmetic
hiding. The system reads from `tenant_subscriptions` (already in
schema), validates `feature_overrides` JSONB with a Zod schema (typos
in field names rejected), and exposes a Redis-backed usage tracker.

Stripe billing remains deferred per BILLING_DEFERRED.md. This session
built the *enforcement* layer; metering/charging is the future billing
session.

## §1 — Deliverables produced

### New library modules

| File | Purpose |
|---|---|
| `lib/features/index.ts` | Layer 1 catalog — `FEATURES` (15 keys), `LIMIT_KEYS` (7 keys), `LIMIT_PERIODS`, `TIERS`, typed helpers `Feature`, `LimitKey`, `Tier`, `LimitPeriod`. |
| `lib/features/tiers.ts` | Layer 2 mapping — `TIER_FEATURES` (per-tier feature lists), `TIER_LIMITS` (per-tier quotas with Infinity for unlimited), `FEATURE_OVERRIDES_SCHEMA` (Zod validation for tenant_subscriptions.feature_overrides JSONB), `computeEffectiveFeatures`, `computeEffectiveLimits`, `limitToJson`/`limitFromJson` (Infinity ↔ null). |
| `lib/features/gate.ts` | Layer 3 enforcement — `ResolvedSubscription` shape, `resolveSubscription` builder, `FeatureUnavailableError` (403), `LimitExceededError` (429), `requireFeature` (throwing), `hasFeature` (non-throwing), `withinLimit`, `usageBand` (5-band classifier: normal/warn/limit_reached/over/hard_block), `gateErrorResponse` (maps thrown errors to HTTP responses), `resolveLimit`. |
| `lib/features/loader.ts` | `loadTenantSubscription(tenantId)` — DB read of `tenant_subscriptions`, JSONB validation, returns a `ResolvedSubscription`. Defaults to starter tier if no row exists. |
| `lib/usage/tracker.ts` | Redis-backed counters — `incrementUsage`, `getCurrentUsage`, `decrementConcurrent` (concurrent-period only), `incrementAndClassify` (returns usage + UsageBand). Period-bucketed Redis keys: monthly (`YYYY-MM`), daily (`YYYY-MM-DD`), concurrent. TTLs: 32d / 36h / no expiry. Errors are swallowed — usage tracking failure never blocks the underlying operation. |

### New migration

| File | Purpose |
|---|---|
| `scripts/031_tenant_usage.sql` | Creates `tenant_usage(tenant_id, key, period, period_start, value)` table for daily-aggregated metrics. RLS policies created (not yet enabled — Phase M3). Per the same convention as 029. |
| `scripts/031_tenant_usage_rollback.sql` | Drops the table; refuses to run if rows present (forces explicit TRUNCATE before discarding usage history). |

### Routes gated this session (audit-trail seed)

| Route | Required feature |
|---|---|
| `app/api/import/execute/route.ts` POST | `tms_advanced` (bulk import) |
| `app/api/loads/bulk-match/route.ts` POST | `tms_advanced` (bulk operations) |
| `app/api/admin/tenants/[id]/export/route.ts` POST | `data_export` — gated on the SUBJECT tenant's tier (a Starter tenant's data cannot be exported even by a super-admin) |

The full route audit (every tier-gated capability) is intentionally
deferred to Phase 7 — these three exemplars establish the pattern and
make sure the typecheck is clean.

### Tests (in `MyraTMS/__tests__/lib/`)

| File | Coverage |
|---|---|
| `features.test.ts` | 45 cases — catalog integrity, tier mapping (starter ⊆ pro structurally, enterprise ≡ ALL_FEATURES), `FEATURE_OVERRIDES_SCHEMA` (typos rejected, .strict catches extra fields), override resolution semantics (added grants, removed revokes, removed wins over add), limit overrides raise/lower, Infinity ↔ null round-trip, `requireFeature` throws/passes, `withinLimit` thresholds (limit_reached at 1.0×, hard_block at 2.0×), `usageBand` 5-band classification including the limit=0 edge case, `gateErrorResponse` shape (403/429 with code+payload). |

## §2 — Architectural decisions surfaced this session

### 2.1 — Infinity sentinel + JSON serialization

`Infinity` is the in-code sentinel for "unlimited" (`enterprise.personas`,
all `internal.*`, etc.). JS arithmetic comparisons (`5 >= Infinity`) work
correctly, but `JSON.stringify(Infinity)` produces `null`. To keep
client/server symmetry:

- API responses convert `Infinity` to `null` via `limitToJson()`
- Clients parse `null` back to `Infinity` via `limitFromJson()`

This pair is exported alongside the tier helpers so it's hard to use
the wrong serialization. Tests cover both directions with an explicit
round-trip case.

### 2.2 — Strict Zod schema on `feature_overrides`

The shape `{ addedFeatures, removedFeatures, limitOverrides }` is
validated by `FEATURE_OVERRIDES_SCHEMA` with `.strict()` — extra
top-level fields (e.g., a typo like `addedFeature` singular) cause a
validation error rather than being silently ignored. The schema also
constrains the values of `addedFeatures`/`removedFeatures` to the
literal union of `Feature` keys, and `limitOverrides` keys to `LimitKey`.
This is the catch for the most common operator mistake: writing
`{ "limitOverrides": { "person": 50 } }` (missing 's') would otherwise
silently leave personas at 3 forever.

The PATCH-tenant-subscription endpoint (out of scope this session) will
parse the body through this schema before persisting.

### 2.3 — Request-scoped, never cross-request cached

`loadTenantSubscription` reads `tenant_subscriptions` per request. There
is no cache. The reasoning:

- Subscription changes (upgrade/downgrade/feature override) need to take
  effect on the next request, not on a cache TTL boundary
- The query is `SELECT ... WHERE tenant_id = $1 LIMIT 1` against an
  indexed primary key — sub-millisecond on Neon
- Cross-request invalidation has correctness pitfalls (stale on
  edge-runtime caches, test-environment leakage) that buy us nothing
  since the underlying read is already fast

If this becomes a bottleneck under heavy load, an in-process per-request
memoization layer is the right next step (memoize for the lifetime of
ONE request) — not Redis-backed cross-request caching.

### 2.4 — `usageBand` returns `'normal'` for limit ≤ 0

`starter.quick_pay_advances_monthly = 0` (no Quick Pay on the starter
tier). The naive `ratio = currentUsage / limit` would divide by zero,
producing `NaN` or `Infinity` for every comparison. The classifier
short-circuits at `limit <= 0 → 'normal'` since "you've used 0 of 0"
isn't an over-limit condition; the gate is enforced separately by the
feature check (`hasFeature(sub, "capital_quick_pay")` is false on
starter).

### 2.5 — Errors swallowed in usage tracker

`incrementUsage` and `getCurrentUsage` log and return -1/0 on Redis
failure. The trade-off:

- **Pro:** A brief Upstash outage doesn't 500 every metered request
- **Con:** A persistent outage under-counts usage (could let a tenant
  exceed their limit for the duration)

This is consistent with how `lib/redis.ts` already handles `getCached` /
`setCache`. If usage tracking ever becomes cost-critical (e.g., a
metered-billing flow where under-counting is revenue loss), it should
either fail-closed at that specific call site OR fall back to a DB
counter. Current scope is access gating, not billing, so swallowed
errors are the right default.

## §3 — What is *not* built yet (deferred)

| Item | Why deferred | Tracked under |
|---|---|---|
| Daily aggregation cron (Redis → tenant_usage) | Out of session scope. Pattern follows the Session 3 forEachActiveTenant cron template; should be added with the purge-executor cron in a future "platform crons" session. | TODO |
| Full route audit (every tier-gated capability) | Three exemplars seed the pattern. Comprehensive audit belongs to Phase 7 (testing & validation) per ADR-003 §Validation item 4. | Phase 7 |
| 80% threshold notification firing | The `usageBand` classifier produces 'warn'; a notifier hook (writes to `notifications` table) is a follow-up. | Future |
| Tier-aware UI hooks (`useFeatures()` React hook) | UI is Phase 6 territory. The non-throwing `hasFeature` API is ready; the React hook just calls it after the page-level subscription loader runs. | Phase 6 |
| Tier-downgrade migration path | What happens to a tenant's data when they downgrade from Pro to Starter and they had 7 personas (Starter limit is 3)? Current behavior: `withinLimit` blocks new creates, existing rows untouched. A formal "grandfather expiry" policy is a future Phase 9 deliverable. | Phase 9 |
| Stripe webhook → tier change | Per BILLING_DEFERRED.md, the entire billing surface is its own future session. Today, tier changes are direct PATCH against `tenant_subscriptions`. | Billing session |

## §4 — Verification

### Typecheck
```
$ npx tsc --noEmit
(exit 0)
```

### Test suite
```
$ pnpm vitest run
Test Files  1 failed | 21 passed (22)
Tests       5 failed | 320 passed (325)
```

The 5 failures are pre-existing Engine 2 numeric drift in
`lib/pipeline/__tests__/cost-calculator.test.ts`. Net change vs.
Session 4 close: **+45 passing, 0 regressions**.

### Smoke confirmation (still TODO before Phase M3)
- [ ] Provision a Starter tenant; verify `POST /api/import/execute` returns 403 with `code: "feature_unavailable"`
- [ ] PATCH the tenant's `feature_overrides` to add `tms_advanced`; verify the next request succeeds
- [ ] Increment a usage counter (e.g., autobroker_bookings_monthly) past the Starter limit (25) via direct route invocation; verify 429 with `code: "limit_exceeded"`, `reason: "limit_reached"`
- [ ] Push usage to 2× the limit; verify the same 429 returns `reason: "hard_block"`
- [ ] Confirm `tenant_audit_log` records every super-admin override

## §5 — Open items for Patrice

| # | Item | Action requested | Blocking? |
|---|---|---|---|
| 1 | Apply migration 031 to staging | Same path as 027–029 (Neon MCP or out-of-band connection string). | Soft — gating works without `tenant_usage` since Redis is the hot path; migration only matters once the daily aggregation cron is built |
| 2 | Decide on the daily aggregation cron timing | Default proposal: 02:30 UTC daily, between exception-detect (02:00) and FMCSA reverify (06:00). Iterates active tenants via `forEachActiveTenant`. | Not blocking |
| 3 | Whether to add a `is_super_admin` PATCH endpoint | Today this requires a direct DB write. Phase 5 admin UI will need a way to toggle it; either expose via `/api/admin/tenants/[id]/users/[userId]/super-admin` or keep DB-only. | Soft — needed for Phase 5 prep |

## §6 — Cumulative scorecard

| Metric | Value |
|---|---|
| Sessions completed | 5 of 8 |
| Cumulative actual time | ~19h (Session 5 ran ~2h vs 2h budget — on the nose) |
| Cumulative budget low | 17h |
| Cumulative budget high | 20h |
| Status | Within tolerance — Session 5 came in on budget, cumulative tracks the high end |
| Blockers | None |
| Open questions for Patrice | 3 (all in §5); none blocking Session 6 start |

## §7 — Session 6 readiness

Session 6 (Phase 5 — UI: tenant-aware shell + onboarding wizard) is
unblocked. The data layer is fully multi-tenant; the admin/onboarding
APIs exist; the feature gating + usage tracking exist. Phase 5 work
focuses on:
- Tenant-aware app shell (subdomain → tenant resolution → branding)
- Onboarding wizard UI that drives `POST /api/admin/tenants/[id]/onboard`
- React hooks: `useFeatures()`, `useTenantConfig()`, `useUsage()`
- Tier-gated menu items / disabled buttons via `hasFeature`

This is also the point at which Patrice typically reviews UI work before
merging — flag for that gate when entering Session 6.

End of Session 5.
