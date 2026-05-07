-- =============================================================================
-- Rollback for migration 031 — drop tenant_usage table.
--
-- Idempotent. Drops policies, indexes, and the table itself. Refuses to
-- run if rows exist (safety) — operator must TRUNCATE first if they
-- truly want to discard usage history.
-- =============================================================================

DO $$
DECLARE
    row_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO row_count FROM tenant_usage;
    IF row_count > 0 THEN
        RAISE EXCEPTION 'Refusing to drop tenant_usage — % rows present. TRUNCATE first if you really mean to discard usage history.', row_count;
    END IF;
END $$;

DROP POLICY IF EXISTS tenant_usage_tenant_isolation ON tenant_usage;
DROP POLICY IF EXISTS tenant_usage_service_admin_bypass ON tenant_usage;

DROP INDEX IF EXISTS idx_tenant_usage_key_period;
DROP INDEX IF EXISTS idx_tenant_usage_tenant_period;

DROP TABLE IF EXISTS tenant_usage;
