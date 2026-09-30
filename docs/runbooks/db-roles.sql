-- NexLegTiq database roles (ops-security.md, D-001, D-079). Run as a superuser / the managed DB's admin user against
-- each staging/production database. Idempotent: safe to re-run. Not used locally or in CI (the compose/CI superuser runs
-- everything there). Passwords are never stored here: set them afterwards with `\password <role>` or the provider UI.
--
--   nexlegtiq_migrator  owns the schema; runs `prisma migrate deploy` (DATABASE_URL of the one-off migrate job)
--   nexlegtiq_app       the API and worker (DATABASE_URL of the app); DML only, audit_logs is append-only
--   nexlegtiq_readonly  support/analytics queries; SELECT only
--
-- Run it twice: before the first `prisma migrate deploy` (creates roles and default privileges) and once after it
-- (default privileges also grant UPDATE/DELETE on the new audit_logs table; the block below revokes them).
--
-- Usage: psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/runbooks/db-roles.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_migrator') THEN
    CREATE ROLE nexlegtiq_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    CREATE ROLE nexlegtiq_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    CREATE ROLE nexlegtiq_readonly LOGIN;
  END IF;
END
$$;

-- The migrator owns public, so every table/sequence/function a migration creates is owned by it.
ALTER SCHEMA public OWNER TO nexlegtiq_migrator;
DO $
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexlegtiq_app, nexlegtiq_readonly', current_database());
END
$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nexlegtiq_app, nexlegtiq_readonly;

-- Objects created by future migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexlegtiq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexlegtiq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO nexlegtiq_readonly;

-- Objects that already exist (first run after the initial migration).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexlegtiq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexlegtiq_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexlegtiq_readonly;

-- Audit log is append-only for the app (domain-model.md). Retention purge runs as the migrator.
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM nexlegtiq_app;
  END IF;
END
$$;

-- Prisma's bookkeeping table belongs to the migrator only.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM nexlegtiq_app, nexlegtiq_readonly;
  END IF;
END
$$;
