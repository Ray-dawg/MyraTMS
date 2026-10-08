-- Rollback for 060: restore 029's policy shape (no NULLIF). Only needed if
-- the NULLIF form misbehaves; RLS enable state is untouched either way.
BEGIN;

CREATE OR REPLACE FUNCTION install_tenant_rls_policies(p_table TEXT)
RETURNS void AS $$
BEGIN
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', p_table);
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I '
        'FOR ALL '
        'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::BIGINT) '
        'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::BIGINT)',
        p_table
    );
    EXECUTE format('DROP POLICY IF EXISTS service_admin_bypass ON public.%I', p_table);
    EXECUTE format(
        'CREATE POLICY service_admin_bypass ON public.%I '
        'FOR ALL '
        'USING (current_setting(''app.role'', true) = ''service_admin'') '
        'WITH CHECK (current_setting(''app.role'', true) = ''service_admin'')',
        p_table
    );
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN
        SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname IN ('tenant_isolation', 'service_admin_bypass')
    LOOP
        PERFORM install_tenant_rls_policies(t);
    END LOOP;
END $$;

INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_rolled_back',
       jsonb_build_object('migration', '060_harden_rls_policies', 'rolled_back_at', NOW())
FROM tenants WHERE slug = 'myra';

COMMIT;
