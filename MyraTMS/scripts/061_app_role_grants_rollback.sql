-- Rollback for 061. Point DATABASE_URL back at neondb_owner FIRST, then:
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE ALL ON TABLES FROM myra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM myra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM myra_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM myra_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM myra_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM myra_app;
REVOKE USAGE ON SCHEMA public FROM myra_app;
COMMIT;
-- Then drop the role via Neon console / MCP delete_postgres_role.
