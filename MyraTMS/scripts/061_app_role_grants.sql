-- ============================================================================
-- 061: Non-bypass application role for RLS (PROPOSAL — not applied anywhere)
-- ============================================================================
-- Found 2026-10-07 during the M3 pre-flight, verified on dev-tests
-- (br-damp-river-ai21gg86):
--
--   * `neondb_owner` — the role in every DATABASE_URL (Vercel, Railway, local)
--     — has rolbypassrls = TRUE and OWNS every table.
--   * With RLS ENABLED on tenant_audit_log and app.current_tenant_id set to a
--     wrong tenant, neondb_owner still saw all 338 rows.
--   * A plain role without BYPASSRLS saw 7 rows for Myra's tenant, 0 for a
--     wrong tenant, and 338 with app.role = 'service_admin'.
--
-- Consequence: the whole Phase M3 schedule in RLS_ROLLOUT.md is a no-op for
-- the application as deployed. SECURITY.md §"No backdoor superuser path"
-- states the connection user is not a superuser — true, but BYPASSRLS is a
-- separate attribute and it is set. FORCE ROW LEVEL SECURITY does not help:
-- BYPASSRLS skips forced policies too.
--
-- Fix (two halves, both outside this file's reach):
--   1. Create role `myra_app` WITHOUT BYPASSRLS, not the table owner
--      (Neon console or MCP create_postgres_role, so it gets a password).
--   2. Apply the grants below, then rotate DATABASE_URL on Vercel + Railway
--      to the myra_app credentials. Migrations keep using neondb_owner.
--
-- Scope of grants: SELECT/INSERT/UPDATE/DELETE on all public tables,
-- USAGE on sequences, EXECUTE on functions (fn_myra_tenant_id etc.), and
-- the same for objects created later by neondb_owner. No DDL.
-- ============================================================================

BEGIN;

GRANT USAGE ON SCHEMA public TO myra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO myra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO myra_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO myra_app;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO myra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO myra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO myra_app;

INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
SELECT id, 'system:migration', 'migration_applied',
       jsonb_build_object('migration', '061_app_role_grants', 'applied_at', NOW(),
         'description', 'Granted DML on public schema to non-BYPASSRLS role myra_app for Phase M3')
FROM tenants WHERE slug = 'myra';

COMMIT;

-- Verify (as neondb_owner):
--   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('neondb_owner','myra_app');
--   -- Expected: myra_app  false  false
