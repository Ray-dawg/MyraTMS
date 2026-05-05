-- ============================================================================
-- 027: Multi-Tenant Foundation Tables
-- ============================================================================
-- Session 2 / Phase M1a — introduces tenant metadata.
-- Companion ADRs: docs/architecture/ADR-001..004
-- Companion docs:  PERMISSIONS_MATRIX.md, TENANT_CONFIG_SEMANTICS.md, SECURITY.md
--
-- This migration is ADDITIVE ONLY. It does not modify any existing TMS-core
-- table — those changes live in 028. RLS policies are NOT enabled here; that
-- happens in 029 (CREATE POLICY only) and Phase M3 (ENABLE per RLS_ROLLOUT.md).
--
-- Idempotent: yes (IF NOT EXISTS / ON CONFLICT DO NOTHING throughout).
-- Rollback:   027_multi_tenant_foundation_rollback.sql
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. tenants — tenant registry
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id                    BIGSERIAL    PRIMARY KEY,
    slug                  VARCHAR(32)  UNIQUE NOT NULL,
                          -- Validated at app layer by lib/tenants/validators.ts:
                          --   real slugs match ^[a-z][a-z0-9-]{2,30}$
                          --   '_system' is the only legal underscore-prefixed slug
                          --   (seeded below; cannot be created via app API).
    name                  VARCHAR(200) NOT NULL,
    type                  VARCHAR(20)  NOT NULL
                          CHECK (type IN ('operating_company', 'saas_customer', 'internal')),
    status                VARCHAR(20)  NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'trial', 'past_due', 'suspended', 'canceled', 'deleted')),
    parent_tenant_id      BIGINT       REFERENCES tenants(id) ON DELETE SET NULL,
                          -- Operating-company sub-tenants (e.g. Sudbury under Myra).
                          -- NULL for top-level tenants.
    billing_email         TEXT,
    primary_admin_user_id TEXT         REFERENCES users(id) ON DELETE SET NULL,
                          -- The tenant's owner. NULL until first admin onboards.
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ
                          -- Soft delete. Hard purge handled by /api/admin/tenants/[id]/purge.
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug   ON tenants(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id) WHERE parent_tenant_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. tenant_subscriptions — one row per tenant, current tier + overrides
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    tenant_id                BIGINT       PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tier                     VARCHAR(20)  NOT NULL DEFAULT 'starter'
                             CHECK (tier IN ('starter', 'pro', 'enterprise', 'internal')),
    status                   VARCHAR(20)  NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'trial', 'past_due', 'suspended', 'canceled')),
    started_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at               TIMESTAMPTZ,
    feature_overrides        JSONB        NOT NULL DEFAULT '{}'::jsonb,
                             -- Shape per ADR-003 §Layer 2:
                             --   { "addedFeatures":   ["sso_saml"],
                             --     "removedFeatures": ["multi_language"],
                             --     "limitOverrides":  { "personas": 50 } }

    -- Stubs for future billing session — see BILLING_DEFERRED.md.
    billing_provider         VARCHAR(50),       -- 'stripe' once integrated
    external_subscription_id VARCHAR(200),      -- 'sub_xxx' from Stripe
    external_customer_id     VARCHAR(200),      -- 'cus_xxx' from Stripe

    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN tenant_subscriptions.billing_provider IS
    'NULL until billing session: will be ''stripe'' once integrated. See BILLING_DEFERRED.md.';
COMMENT ON COLUMN tenant_subscriptions.external_subscription_id IS
    'NULL until billing session: will hold sub_xxx from Stripe.';
COMMENT ON COLUMN tenant_subscriptions.external_customer_id IS
    'NULL until billing session: will hold cus_xxx from Stripe.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. tenant_users — N:M between users (TEXT id) and tenants
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_users (
    tenant_id   BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        VARCHAR(20)  NOT NULL
                CHECK (role IN ('owner', 'admin', 'operator', 'driver', 'viewer', 'service_admin')),
                -- Per PERMISSIONS_MATRIX.md:
                --   owner/admin/operator/service_admin → fully wired in Phase 1
                --   driver/viewer                       → scaffolded, narrowed in future session
    is_primary  BOOLEAN      NOT NULL DEFAULT false,
                -- Each user has exactly one primary tenant (the default at login).
                -- Enforced by partial unique index below.
    joined_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users(user_id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_users_one_primary
    ON tenant_users(user_id) WHERE is_primary = true;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. tenant_config — per-tenant key/value (encrypted-at-rest for sensitive)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_config (
    tenant_id   BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key         VARCHAR(100) NOT NULL,
    value       TEXT         NOT NULL,
                -- TEXT (not JSONB) because encrypted values are arbitrary base64;
                -- plaintext values still hold JSON-encoded strings/numbers.
                -- See TENANT_CONFIG_SEMANTICS.md §6.
    encrypted   BOOLEAN      NOT NULL DEFAULT false,
                -- When true, value is base64({nonce}:{ct}:{auth_tag}) per SECURITY.md §1.
                -- Decrypted via lib/crypto/tenant-secrets.ts.
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by  TEXT,
                -- User ID of last writer; NULL for system writes.
    PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_config_tenant ON tenant_config(tenant_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 5. tenant_audit_log — append-only event log
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_audit_log (
    id              BIGSERIAL    PRIMARY KEY,
    tenant_id       BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_user_id   TEXT,
                    -- User ID for human actors, or 'system:<process>' for automated
                    -- callers (e.g. 'system:tracking', 'system:cron-invoice-alerts').
                    -- NULL only when the actor is genuinely unknown.
    event_type      VARCHAR(60)  NOT NULL,
                    -- Catalog in SECURITY.md §6. Common values:
                    --   service_admin_invocation, tracking_token_resolution,
                    --   tenant_resolution_conflict, tenant_user_role_changed,
                    --   subscription_tier_changed, tenant_config_changed, etc.
    event_payload   JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_tenant
    ON tenant_audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_event_type
    ON tenant_audit_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_actor
    ON tenant_audit_log(actor_user_id) WHERE actor_user_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Auto-bump updated_at trigger (reused by tenants, tenant_subscriptions,
--    tenant_config). Same pattern as 026-loadboard-sources.sql.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tenant_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_updated_at_trg ON tenants;
CREATE TRIGGER tenants_updated_at_trg
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION tenant_set_updated_at();

DROP TRIGGER IF EXISTS tenant_subscriptions_updated_at_trg ON tenant_subscriptions;
CREATE TRIGGER tenant_subscriptions_updated_at_trg
    BEFORE UPDATE ON tenant_subscriptions
    FOR EACH ROW EXECUTE FUNCTION tenant_set_updated_at();

DROP TRIGGER IF EXISTS tenant_config_updated_at_trg ON tenant_config;
CREATE TRIGGER tenant_config_updated_at_trg
    BEFORE UPDATE ON tenant_config
    FOR EACH ROW EXECUTE FUNCTION tenant_set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- 7. Seed data
--    - System tenant '_system' (slug bypasses the regex by being seeded here).
--    - Tenant 1 'myra' for Myra Logistics primary operations.
--    - Subscriptions for both.
--    - DEFAULT_TENANT_CONFIG cloned for the myra tenant. This SQL hardcodes
--      the same defaults as lib/tenants/defaults.ts — keep them in sync.
--      Future tenants get this set via the onboarding wizard, not this SQL.
-- ──────────────────────────────────────────────────────────────────────────

-- The system tenant. Used as actor_user_id parent for system-generated audit.
INSERT INTO tenants (slug, name, type, status)
VALUES ('_system', 'System', 'internal', 'active')
ON CONFLICT (slug) DO NOTHING;

-- The Myra primary tenant. All existing TMS data backfills to this tenant in 028.
INSERT INTO tenants (slug, name, type, status)
VALUES ('myra', 'Myra Logistics', 'operating_company', 'active')
ON CONFLICT (slug) DO NOTHING;

-- Subscriptions
INSERT INTO tenant_subscriptions (tenant_id, tier, status)
SELECT id, 'internal', 'active' FROM tenants WHERE slug = '_system'
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO tenant_subscriptions (tenant_id, tier, status)
SELECT id, 'enterprise', 'active' FROM tenants WHERE slug = 'myra'
ON CONFLICT (tenant_id) DO NOTHING;

-- Clone DEFAULT_TENANT_CONFIG for the Myra tenant only.
-- The system tenant gets no config rows (it's a sentinel for cross-tenant ops).
DO $seed$
DECLARE
    v_myra_tenant_id BIGINT;
BEGIN
    SELECT id INTO v_myra_tenant_id FROM tenants WHERE slug = 'myra';
    IF v_myra_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Myra tenant not seeded; cannot clone default config';
    END IF;

    -- Localization
    INSERT INTO tenant_config (tenant_id, key, value, encrypted) VALUES
        (v_myra_tenant_id, 'currency_default',         '"CAD"',           false),
        (v_myra_tenant_id, 'locale_default',           '"en-CA"',         false),
        (v_myra_tenant_id, 'timezone_default',         '"America/Toronto"', false),
        (v_myra_tenant_id, 'language_default',         '"en"',            false),
        -- Operational defaults
        (v_myra_tenant_id, 'margin_floor_cad',         '150',             false),
        (v_myra_tenant_id, 'margin_floor_usd',         '110',             false),
        (v_myra_tenant_id, 'walk_away_rate_factor',    '0.92',            false),
        (v_myra_tenant_id, 'checkcall_threshold_hours', '4',              false),
        (v_myra_tenant_id, 'detention_threshold_minutes', '120',          false),
        -- Engine 2 / AutoBroker
        (v_myra_tenant_id, 'persona_alpha_init',       '1.0',             false),
        (v_myra_tenant_id, 'persona_beta_init',        '1.0',             false),
        (v_myra_tenant_id, 'auto_book_profit_threshold_cad', '200',       false),
        (v_myra_tenant_id, 'shipper_fatigue_max',      '2',               false),
        -- Branding
        (v_myra_tenant_id, 'branding_logo_url',        'null',            false),
        (v_myra_tenant_id, 'branding_primary_color',   '"#0066FF"',       false),
        (v_myra_tenant_id, 'branding_company_name',    'null',            false),
        -- Communication
        (v_myra_tenant_id, 'smtp_from_email',          '"noreply@myralogistics.com"', false),
        (v_myra_tenant_id, 'factoring_email',          'null',            false),
        -- Notification preferences
        (v_myra_tenant_id, 'notif_checkcall_enabled',  'true',            false),
        (v_myra_tenant_id, 'notif_invoice_overdue_days', '7',             false)
    ON CONFLICT (tenant_id, key) DO NOTHING;
END $seed$;

-- ──────────────────────────────────────────────────────────────────────────
-- 8. Self-audit: log this migration into tenant_audit_log
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_applied',
       jsonb_build_object(
         'migration', '027_multi_tenant_foundation',
         'applied_at', NOW(),
         'description', 'Created tenant metadata tables; seeded _system + myra tenants'
       )
FROM tenants WHERE slug = 'myra'
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================================
-- Verification queries (run manually after applying):
--   SELECT id, slug, name, type, status FROM tenants ORDER BY id;
--   SELECT tenant_id, tier, status FROM tenant_subscriptions ORDER BY tenant_id;
--   SELECT tenant_id, key FROM tenant_config WHERE tenant_id =
--     (SELECT id FROM tenants WHERE slug = 'myra') ORDER BY key;
--   SELECT * FROM tenant_audit_log ORDER BY id DESC LIMIT 5;
-- Expected: 2 tenants (_system, myra), 2 subscriptions, ~20 myra config keys,
-- 1 audit entry for migration_applied.
-- ============================================================================
