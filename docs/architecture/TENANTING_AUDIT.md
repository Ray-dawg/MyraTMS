# TENANTING_AUDIT.md

> **Session:** 1 — Phase 0 / Task 0.1
> **Date:** 2026-05-01
> **Author:** Claude (Opus 4.7) under Patrice direction
> **Status:** Draft for Patrice review (gate to Session 2)

## Purpose

Categorize every Postgres table currently used by MyraTMS so that the multi-tenant retrofit (Phases 1–4) knows exactly which tables get a `tenant_id`, which stay global, and which are deferred to Phase 6.5 (Engine 2). For every Category A (per-tenant) table, identify the columns whose uniqueness scope must change from global to per-tenant.

## Source documents read for this audit

| Doc | Actual path | Notes |
|---|---|---|
| T01 — TMS Platform Audit | `T01_TMS_Platform_Audit.md` (repo root) | Generated 2026-04-02; lists 29 tables. Verified against current schema; 2 tables added since (compliance_audit, loadboard_sources) |
| T02 — Database Schema Additions | `Engine 2/T02_Database_Schema_Additions.md` | Engine 2 tables — copied into MyraTMS/scripts/pipeline_migrations.sql at integration |
| T03 — Orchestration Backbone | `Engine 2/T03_Orchestration_Backbone.md` | Read for queue/worker context |
| T04 — Scanner Agent | `Engine 2/T04_Scanner_Agent.md` | Read for scanner integration context |
| T04A — Headless Scanner Fallback | `Engine 2/T04A_Headless_Scanner_Fallback.md` | Read for scraper context |
| T13 — Compliance & Consent | `Engine 2/T13_Compliance_Consent.md` | Per-tenant DNC and consent_log requirements |
| Engine 2 CLAUDE.md | `Engine 2/CLAUDE.md` | Authoritative file inventory + integration mapping |
| Pipeline migrations | `Engine 2/pipeline_migrations.sql` and `MyraTMS/scripts/pipeline_migrations.sql` | Engine 2 schema, applied to MyraTMS DB |
| Live migrations | `MyraTMS/scripts/001-026*.sql` | Authoritative current schema |
| Auth | `MyraTMS/lib/auth.ts`, `MyraTMS/middleware.ts` | Custom JWT, no NextAuth |
| DB client | `MyraTMS/lib/db.ts` | `neon()` per-request, tagged-template SQL |

> **Doc paths note:** The original mega-prompt referenced `/docs/T*` paths. Per Patrice's Answer 2, the actual paths above are canonical. T15, T16, AXIOM exist outside the repo and are not yet needed (Phase 0 doesn't depend on them).

## Categorization legend

| Cat | Meaning |
|---|---|
| **A** | REQUIRES `tenant_id`. Transactional / operational data owned by a specific tenant. Gets a column in Phase 1, RLS in Phase 1, code refactor in Phase 2. |
| **A-DEF** | Same as A, but **deferred to Phase 6.5** per Rule A (Engine 2 v1 must run in production for 24h before its tables are touched). |
| **A-JOIN** | Belongs in Cat A logically but does NOT carry `tenant_id` directly because of N:M tenant membership (only the `users` table). Tenant scoping happens via the `tenant_users` join. |
| **B** | SHARED lookup / read-only. Same content for every tenant. No `tenant_id` column. |
| **C** | TENANT-METADATA. New tables created in migration 027 to hold the multi-tenant model itself. |
| **D** | DEPRECATED. Should not survive the refactor. (None identified — see §5.) |

## §1 — Tenant-metadata tables (Category C, NEW)

These are introduced by `migrations/027_multi_tenant_foundation.sql` (renumbered from "020" in the original mega-prompt — slot 020 is taken by `quoting-engine.sql`).

| Table | Purpose | PK | Notable columns |
|---|---|---|---|
| `tenants` | Tenant registry | `id BIGSERIAL` (no reserved sentinel) | `slug UNIQUE` validated by `^[a-z][a-z0-9-]{2,30}$` (subdomain-safe; disallows leading `_` or numeric), `type ENUM('operating_company','saas_customer','internal')`, `status ENUM('active','trial','past_due','suspended','canceled','deleted')`, `parent_tenant_id BIGINT NULL FK→tenants(id)`, `billing_email`, `primary_admin_user_id`, `created_at`, `deleted_at`. The system tenant has slug `'_system'` (only row that bypasses the slug regex via privileged seed). |
| `tenant_config` | Per-tenant key/value config (encrypted-at-rest for sensitive fields per [SECURITY.md](./SECURITY.md) §1) | `(tenant_id, key)` | `value TEXT`, `encrypted BOOLEAN DEFAULT false`, `updated_at`, `updated_by`. Storage uses TEXT (not JSONB) because encrypted values are arbitrary base64 — see [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) §6 |
| `tenant_subscriptions` | One row per tenant — current tier + overrides | `tenant_id` | `tier ENUM('starter','pro','enterprise','internal')`, `started_at`, `expires_at`, `status`, `feature_overrides JSONB DEFAULT '{}'`, `billing_provider VARCHAR(50) NULL`, `external_subscription_id VARCHAR(200) NULL`, `external_customer_id VARCHAR(200) NULL` (the three NULL columns are stubs for the future billing session — see [BILLING_DEFERRED.md](./BILLING_DEFERRED.md)) |
| `tenant_users` | N:M between users and tenants | `(tenant_id, user_id)` | `role ENUM('owner','admin','operator','driver','viewer','service_admin')`, `joined_at`, `is_primary BOOLEAN` (one primary tenant per user). Per [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md): `owner`/`admin`/`operator`/`service_admin` get full enforcement in Phase 1; `driver`/`viewer` scaffolded |
| `tenant_audit_log` | Append-only event log per tenant | `id BIGSERIAL` | `tenant_id`, `actor_user_id`, `event_type`, `event_payload JSONB`, `created_at`. Used for service_admin escalation logging and tenant-admin audit views. Full event-type catalog in [SECURITY.md](./SECURITY.md) §6 |

**Seed data:**
- `tenants(slug='_system', type='internal', status='active')` — system tenant for cross-tenant analytics + audit ownership; underscore prefix prevents collision with real slugs
- `tenants(slug='myra', name='Myra Logistics', type='operating_company', status='active')` — Tenant 1 (existing prod data)
- `tenant_subscriptions` for system tenant (`internal`) and Tenant 1 (`enterprise`)
- All existing rows in users/shippers/carriers/loads/etc. backfill to the Tenant 1 id (whatever BIGSERIAL assigns — likely 2 since system tenant inserts first)
- For each existing tenant, `DEFAULT_TENANT_CONFIG` is cloned into `tenant_config` per [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) §2

## §2 — Existing tables (TMS-core, in scope for Phases 1–4)

For every Category A table, the **"Composite uniqueness changes"** column lists existing UNIQUE constraints whose scope must change from global → per-tenant.

### §2.1 Identity & access

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `users` | **A-JOIN** | `email` stays globally unique (one human, one email) | Tenant scoping via `tenant_users` join. No `tenant_id` column on users. RLS policy joins to `tenant_users` to scope visibility within a tenant admin's UI. Super-admins can see all users. |
| `user_invites` | A | `(tenant_id, token)` UNIQUE; `email` no longer globally unique (same email may be invited to multiple tenants) | Add `tenant_id NOT NULL`. Invite link includes tenant context. |
| `settings` | A | `(tenant_id, user_id, settings_key)` UNIQUE | **Semantics shift.** Today `user_id IS NULL` = global. Post-refactor: `user_id IS NULL` = tenant-wide. Existing global settings are CLONED per-tenant at backfill (Q4 resolution) — not fall-back-resolved. See [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) §3 for the clone-on-create flow. Every code path reading `WHERE user_id IS NULL` for global settings must add `AND tenant_id = $current` — flagged for code-search in Phase 2. |
| `push_subscriptions` | A | `(tenant_id, endpoint)` UNIQUE | Web push endpoints theoretically global but a driver belongs to a tenant; safer per-tenant. |

### §2.2 Customer & vendor master data

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `shippers` | A | None today; consider adding `(tenant_id, contact_email)` UNIQUE optional | Pure tenant data. |
| `carriers` | A | `mc_number` currently unique-by-convention only (no DB constraint) — formalize as `(tenant_id, mc_number)` UNIQUE WHERE mc_number IS NOT NULL | Two tenants legitimately serve the same MC carrier; rates and ratings stay separate. |
| `drivers` | A | `(tenant_id, app_pin)` UNIQUE for PIN scope (driver PIN today is implicitly per-carrier; needs to be per-tenant in case of carrier overlap) | Drivers belong to a tenant via their carrier. |

### §2.3 Operations (loads & lifecycle)

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `loads` | A | `reference_number` becomes `(tenant_id, reference_number)` UNIQUE; `tracking_token` stays globally unique (64-char hex collision space is fine, public URL); `id` stays globally unique BUT prefix changes from `LD-{tsBase36}` to `LD-T{tenantId}-{tsBase36}` so external rate-cons / emails don't collide | The ID-prefix change is a **breaking observable**: existing rate-cons reference old IDs, drivers know their load IDs by sight. Document in API_REFACTOR_LOG (Phase 2) and ensure Tenant 1 backfill keeps old IDs unmodified — only NEW loads get the prefixed format. |
| `invoices` | A | `id` similarly prefixed `INV-T{tenantId}-...` for new invoices; existing IDs unchanged | Invoice numbers appear on factoring submissions and shipper-facing PDFs. Coordinate with finance before flipping. |
| `documents` | A | None | Cascade-deleted with parent entity. |
| `activity_notes` | A | None | |
| `notifications` | A | None | `user_id` stays global; broadcast notifications get `user_id = ''` AND `tenant_id = X`. |
| `compliance_alerts` | A | None | Per-tenant carrier compliance state. |
| `location_pings` | A | None — denormalize `tenant_id` from drivers/loads for query performance | Hot table, indexed on `(tenant_id, load_id, recorded_at DESC)`. |
| `load_events` | A | None — denormalize `tenant_id` from loads | |
| `check_calls` | A | None — denormalize `tenant_id` from loads | |
| `tracking_tokens` | A | `token` stays globally unique (public URL); `(tenant_id, load_id)` UNIQUE retained | Token-resolution path bypasses subdomain (see ADR-002 §Public token paths). |
| `delivery_ratings` | A | `token_hash` stays globally unique; `(tenant_id, load_id)` indexed | |
| `shipper_report_log` | A | `(tenant_id, shipper_id, period_year, period_month)` UNIQUE | Existing 3-col UNIQUE expands. |

### §2.4 Workflow & automation

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `workflows` | A | None | Each tenant has its own automation rules. |

### §2.5 Carrier matching engine

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `carrier_equipment` | A | `idx_carrier_equip_unique` becomes `(tenant_id, carrier_id, equipment_type)` | |
| `carrier_lanes` | A | `idx_carrier_lane_unique` becomes `(tenant_id, carrier_id, origin_region, dest_region, equipment_type)` | |
| `match_results` | A | None | Per-tenant audit trail. |

### §2.6 Quoting engine

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `quotes` | A | `reference` becomes `(tenant_id, reference)` UNIQUE | |
| `rate_cache` | A (initially) | None initially; flag for **future migration to anonymized cross-tenant aggregate** (see §4) | Per-tenant in Phase 1 to be safe. Cross-tenant lane intelligence is a stated value-prop — handled later via a separate aggregated read view. |
| `distance_cache` | **B** | None | Pure geo lookup keyed on origin/dest hash. Same answer for every tenant. No `tenant_id`. |
| `fuel_index` | **B** | None | Public market data (DOE / regional diesel index). Same for every tenant. No `tenant_id`. |
| `quote_corrections` | A | UNIQUE expands to `(tenant_id, source, origin_region, dest_region, equipment_type)` | Each tenant learns its own correction factors. |

### §2.7 Integrations & sources

| Table | Cat | Composite uniqueness changes | Notes |
|---|---|---|---|
| `integrations` | A | `provider` becomes `(tenant_id, provider)` UNIQUE | Each tenant brings its own DAT/Truckstop/Mapbox/xAI/Retell credentials. **AES-256-GCM encryption-at-rest** on `api_key`/`api_secret`/`config` (where credentials live) per [SECURITY.md](./SECURITY.md) §1. Implementation `lib/crypto/tenant-secrets.ts` (Phase 1.4). Decrypted credentials NEVER returned to UI — masked to last 4 chars. |
| `loadboard_sources` | **B** | None | Lookup table of supported board providers (DAT, Truckstop, 123LB). Identical across tenants. |

### §2.8 Tally — TMS-core

- **Category A:** 24 tables get `tenant_id`
- **Category A-JOIN:** 1 table (`users`) — scoped via `tenant_users`
- **Category B:** 3 tables (`distance_cache`, `fuel_index`, `loadboard_sources`)
- **Category D:** 0
- **Total in scope for Phases 1–4:** 28 tables

## §3 — Engine 2 tables (DEFERRED to Phase 6.5)

Per **Rule A**: Engine 2 v1 must run end-to-end in production for ≥24h before any of these tables receive `tenant_id`. Migration `028_engine2_tenanting.sql` is staged but not run. Listed here so the audit is complete.

| Table | Cat | Composite uniqueness change (when Phase 6.5 lands) | Notes |
|---|---|---|---|
| `pipeline_loads` | A-DEF | `UNIQUE (tenant_id, load_id, load_board_source)` (existing UNIQUE expands) | Per-tenant scanner queues. |
| `agent_calls` | A-DEF | `call_id` stays globally unique (Retell-issued); `tenant_id` denormalized | Voice-call log. |
| `negotiation_briefs` | A-DEF | None | Per-load brief. |
| `consent_log` | A-DEF | `(tenant_id, phone)` indexed; consent does NOT transfer between tenants per CASL — same phone may be opted-in to Tenant 1 and opted-out for Tenant 3 | Tenant-scoped is **legally required**, not just architectural preference. |
| `dnc_list` | A-DEF | `(tenant_id, phone)` UNIQUE — was global UNIQUE | Same legal logic as consent_log: a carrier can DNC one tenant without DNC'ing another. |
| `shipper_preferences` | A-DEF | `(tenant_id, phone)` UNIQUE | Per-tenant learning. |
| `lane_stats` | A-DEF (initially) | UNIQUE expands to include `tenant_id` | Per-tenant lane intelligence; future cross-tenant anonymized aggregate (see §4). |
| `personas` | A-DEF | `(tenant_id, persona_name)` UNIQUE; each tenant clones the Myra-default 3 personas at onboarding and trains its own α/β | Thompson Sampling per-tenant. |
| `agent_jobs` | A-DEF | None | Denormalized `tenant_id` from `pipeline_loads` for queue observability. |
| `compliance_audit` | A-DEF | None | |

**Engine 2 ALTER additions to existing TMS tables** (already applied via Engine 2 integration; tenanting handled when the parent table gets its `tenant_id`):
- `loads.pipeline_load_id`, `loads.source_type`, `loads.booked_via` — Phase 1, no special handling
- `carriers.accepts_ai_dispatch`, `carriers.preferred_contact_method`, `carriers.ai_call_count`, `carriers.ai_acceptance_rate` — Phase 1
- `shippers.consent_status`, `shippers.preferred_language`, `shippers.ai_interaction_count`, `shippers.last_ai_call_at`, `shippers.shipper_fatigue_score` — Phase 1

### §3.1 Tally — Engine 2

- **Category A-DEF:** 10 tables (deferred to Phase 6.5)

## §4 — Cross-tenant aggregates (post-Phase 6.5 future work)

Two tables are per-tenant in Phase 1 but should eventually expose anonymized cross-tenant aggregates as a value-prop for Pro/Enterprise tiers:

| Table | Per-tenant view | Cross-tenant view (future) |
|---|---|---|
| `rate_cache` | Tenant's own rate observations | Anonymized lane index across all tenants who opt in (not gated by tier — public lane intelligence as marketed value) |
| `lane_stats` (Engine 2) | Tenant's own A/B persona learning per lane | Anonymized aggregate booking rates per lane (anonymity guarantee to be defined in PRIVACY.md, Phase 8) |

Implementation: a separate materialized view (e.g. `mv_rate_index_public`) that aggregates across tenants with a HAVING clause requiring n ≥ 5 distinct tenants per row to prevent re-identification. Phase 6.5 deliverable, not Phase 1.

## §5 — Deprecation candidates (Category D)

**None identified.** All 38 existing tables (28 TMS-core + 10 Engine 2) survive the refactor.

Two close calls considered and rejected:

1. `004-hash-passwords.js` / `004-hash-passwords.mjs` — these are SCRIPTS (not tables), one-shot data migrations. Not relevant to this audit.
2. `loadboard_sources` (added 2026-04 in migration 026) — could arguably be removed if we move source enum into application code, but keeping it as Cat B avoids a data-loss decision and costs nothing.

## §6 — Hot-path indexes to add in Phase 1.2

For every Category A table, the migration `028_add_tenant_id_to_existing_tables.sql` will add a composite index on `(tenant_id, frequently_queried_column)`. Audit of hot queries (from T01 §2 and current API route reads):

| Table | Composite index to add | Replaces / supplements existing |
|---|---|---|
| `loads` | `(tenant_id, status)`, `(tenant_id, shipper_id)`, `(tenant_id, carrier_id)`, `(tenant_id, driver_id)`, `(tenant_id, created_at DESC)` | Existing single-col indexes stay for super-admin queries |
| `invoices` | `(tenant_id, status)`, `(tenant_id, due_date)` | |
| `carriers` | `(tenant_id, mc_number)`, `(tenant_id, performance_score DESC)` | |
| `shippers` | `(tenant_id, pipeline_stage)`, `(tenant_id, assigned_rep)` | |
| `notifications` | `(tenant_id, user_id, read)` | Replaces `idx_notifications_user` |
| `documents` | `(tenant_id, related_type, related_to)` | Replaces `idx_documents_related` |
| `activity_notes` | `(tenant_id, entity_type, entity_id)` | Replaces `idx_activity_entity` |
| `compliance_alerts` | `(tenant_id, carrier_id, resolved)` | |
| `location_pings` | `(tenant_id, load_id, recorded_at DESC)` | Replaces `idx_location_pings_load_time` |
| `load_events` | `(tenant_id, load_id, created_at DESC)` | |
| `check_calls` | `(tenant_id, next_check_call) WHERE next_check_call IS NOT NULL` | |
| `quotes` | `(tenant_id, status)`, `(tenant_id, shipper_id)` | |
| `rate_cache` | `(tenant_id, origin_region, dest_region, equipment_type, expires_at)` | Replaces `idx_rate_cache_lane` |
| `match_results` | `(tenant_id, load_id, match_score DESC)` | |
| `carrier_lanes` | `(tenant_id, origin_region, dest_region, equipment_type)` | |
| `tenant_users` | `(user_id, tenant_id)` reverse-lookup for "which tenants does this user belong to?" | New table, both directions indexed |

Performance budget per ADR-001: <10% degradation on hot-path queries vs single-tenant baseline. Phase 7 task validates.

## §7 — Special-case enumeration for code refactor

Patterns in the current codebase that need explicit fix-ups in Phase 2:

1. **`WHERE user_id IS NULL` for global settings** — every read of the `settings` table that uses this pattern must add `AND tenant_id = $current_tenant`. Grep candidates: `settings_value` reads in `/api/settings`, `lib/settings.ts` (if exists), and any cron jobs reading global flags.
2. **`mc_number` global uniqueness** — currently enforced only by application code (no DB UNIQUE). Phase 1.2 adds the per-tenant UNIQUE; existing duplicate detection logic in `/api/carriers` must switch from "is this MC already in the DB?" to "is this MC already in THIS tenant's DB?".
3. **Load ID generation** — `LD-${Date.now().toString(36).toUpperCase()}` in `/api/loads` route → `LD-T${tenantId}-${Date.now().toString(36).toUpperCase()}`. Same for `INV-`, `DOC-`, `CAR-`, `SHP-`, `MR-`, `CE-`, `CL-` prefixes. Audit grep: `LD-${`, `INV-${`, `DOC-${`, etc.
4. **`tracking_token` resolution** — `/api/tracking/[token]/*` routes currently look up `loads` by `tracking_token` then return data. Must continue to bypass subdomain-based tenant resolution; the token lookup itself yields `tenant_id`. See ADR-002 §Public token paths.
5. **Driver login flow** — `/api/auth/driver-login` accepts a carrier_code + PIN. Must additionally accept (or imply) tenant context. Decision deferred to ADR-002.
6. **Cron job auth** — All four cron routes use `CRON_SECRET`. They need to iterate over all active tenants (or at least tenants whose feature includes the cron, e.g. `shipper-reports` only for tenants with `data_lane_intelligence`). Documented in API_REFACTOR_LOG (Phase 2.4).
7. **AI tool calls** — `/api/ai/chat` exposes 5 tools that execute SQL (`lookupLoad`, `searchLoads`, `getFinanceSummary`, `lookupCarrier`). Each tool must run `withTenant(req.tenant.id, ...)` so the AI cannot accidentally surface another tenant's data via a creative prompt.

## §8 — Out of scope for this audit

Listed for awareness — these are real surfaces but live outside Phase 0:

- **Vercel Blob namespacing.** Document/POD URLs are currently flat keys. Multi-tenant should prefix with `tenants/{tenantId}/...` to enable per-tenant export and bucket-level deletion. Phase 3.4 deliverable.
- **Upstash Redis key prefixes.** Cache keys (loadboard 4h, GPS 60s, rates 6h, AI 24h) need `tenant:{id}:` prefix to prevent cross-tenant cache pollution. Phase 2.2 deliverable as part of the `tenant-aware.ts` wrapper.
- **BullMQ queue names.** Engine 2 queues (`qualify-queue`, `research-queue`, etc.) are global. Per Phase 6.5: each queue stays global but every job payload includes `tenantId` — workers reject jobs without it. Documented in T03 (Engine 2 orchestration).
- **Retell agent IDs.** Per `personas` table: each tenant has its own Retell agent IDs (English + French). Phase 6.5 work; ADR-001 to confirm this is stored in `tenant_config` not `personas`.

## §9 — Resolutions (Patrice approved 2026-05-01)

All 8 open questions from the initial draft of this audit are RESOLVED. Recommendations approved as-is, with implementation specifics added per Patrice's directive.

| # | Resolution | Implementation reference |
|---|---|---|
| 1 | **Load ID prefix change — new-only.** Existing IDs untouched. New loads use `LD-T{tenantId}-{tsBase36}`. Cutover date documented in T-02 v3 (Session 8). Analytics joins use `tenant_id`, not ID prefix. | Code change in Phase 2.4 across `loads/route.ts`, `quotes/[id]/book/route.ts`, `loadboard/import/route.ts`. Same pattern for `INV-T{n}-`, `DOC-T{n}-`, `CAR-T{n}-`, `SHP-T{n}-`, `MR-T{n}-`, `CE-T{n}-`, `CL-T{n}-`. |
| 2 | **`tenant_users.role` enum — full set in Phase 1.** Roles: `owner`, `admin`, `operator`, `driver`, `viewer`, `service_admin`. Only `owner`/`admin`/`operator`/`service_admin` get full RBAC enforcement in Phase 1; `driver` and `viewer` are scaffolded. | Full role-permission matrix in [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md). Migration 027 defines the ENUM with all 6 values. |
| 3 | **Tenant 0 dropped.** System tenant uses `slug='_system'` with normal `BIGSERIAL` id. Real tenant slugs validated against `^[a-z][a-z0-9-]{2,30}$` (subdomain-safe; disallows leading `_` or numeric). | Migration 027 `INSERT INTO tenants (slug, name, type) VALUES ('_system', 'System', 'internal')` first, then Tenant 1. Slug regex validation in `lib/tenants/validators.ts` (Phase 1.4). |
| 4 | **Settings semantics — clone per-tenant.** Current global settings (e.g., `checkcall_threshold_hours`, `notif_checkcall_enabled`) are cloned into each tenant's `tenant_config` at provisioning. No runtime fallback to global defaults. New defaults can be selectively propagated via `scripts/sync_tenant_defaults.ts`. | Full default list and clone-on-create flow in [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md). |
| 5 | **Integration credentials — app-level AES-256-GCM.** Master key in `MYRA_TENANT_CONFIG_KEY` env var (32-byte base64). Storage format `{nonce}:{ciphertext}:{auth_tag}` base64-encoded. Implementation in `lib/crypto/tenant-secrets.ts`. Key rotation procedure documented. | Full crypto policy in [SECURITY.md](./SECURITY.md) §1. Coverage list (what must vs must not be encrypted) in [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) §2. |
| 6 | **`feature_overrides` vs `tenant_config` split — codified.** `feature_overrides` for boolean features and numeric limits (hot-path, request-time read). `tenant_config` for everything else (margins, persona prompts, branding, encrypted API keys; on-demand read with per-key audit + per-key encryption). | Split rule + anti-patterns in [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) §1. |
| 7 | **RLS rollout cadence — 1 batch/day default.** Acceleration to 2 batches/day after 3 clean days, Patrice arbitrates. Hot-path tables (`loads`, `carriers`) stay isolated regardless of streak. | Full schedule with batch ordering and per-batch workflow in [RLS_ROLLOUT.md](./RLS_ROLLOUT.md). |
| 8 | **Stripe billing — deferred to standalone session.** This work includes only schema stubs (`billing_provider`, `external_subscription_id`, `external_customer_id` NULLABLE columns) and feature gating + usage tracking infrastructure. No Stripe SDK, no webhooks, no checkout. | Full deferral scope and starting point for billing session in [BILLING_DEFERRED.md](./BILLING_DEFERRED.md). |

End of audit. Awaiting Session 2 kickoff (no further blockers).
