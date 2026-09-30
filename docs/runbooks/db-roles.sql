-- NexLegTiq database roles (ops-security.md, D-001, D-079). Run as a superuser / the managed DB's admin user against
-- each staging/production database. Idempotent: safe to re-run. Not used locally or in CI (the compose/CI superuser runs
-- everything there). Passwords are never stored here: set them afterwards with `\password <role>` or the provider UI.
--
--   nexlegtiq_migrator  owns the schema; runs `prisma migrate deploy` (DATABASE_URL of the one-off migrate job)
--   nexlegtiq_app       the API and worker (DATABASE_URL of the app); DML only, audit_logs is append-only
--   nexlegtiq_readonly  support/analytics queries; SELECT only, never credentials or token hashes
--
-- Run it before the first `prisma migrate deploy` (roles, extensions, default privileges) and again after every deploy
-- that adds tables holding credentials (re-applies the readonly column restrictions). The init migration itself revokes
-- UPDATE/DELETE on audit_logs from the app role.
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

-- Extensions need more than the migrator has (pgvector is not a trusted extension), so the admin creates them; the
-- migration's CREATE EXTENSION IF NOT EXISTS then finds them.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- Only our roles may connect; the migrator may create schema objects.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexlegtiq_migrator, nexlegtiq_app, nexlegtiq_readonly', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO nexlegtiq_migrator', current_database());
END
$$;

-- The migrator owns public, so every table/sequence/function a migration creates is owned by it.
ALTER SCHEMA public OWNER TO nexlegtiq_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nexlegtiq_app, nexlegtiq_readonly;

-- Objects created by future migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexlegtiq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexlegtiq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nexlegtiq_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO nexlegtiq_readonly;

-- Objects that already exist.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexlegtiq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexlegtiq_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexlegtiq_readonly;

-- Audit log is append-only for the app (domain-model.md; also revoked by the init migration). Retention purge runs as
-- the migrator. Prisma's bookkeeping table belongs to the migrator only.
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM nexlegtiq_app;
  END IF;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM nexlegtiq_app, nexlegtiq_readonly;
  END IF;
END
$$;

-- Readonly never sees credentials: token tables are off-limits, and users/platform_admins are readable column by
-- column without password_hash / mfa_secret. Re-run after migrations that add such tables or columns.
DO $$
DECLARE
  secret_table text;
  people_table text;
  readable text;
BEGIN
  FOREACH secret_table IN ARRAY ARRAY['refresh_tokens', 'password_reset_tokens', 'office_invitations'] LOOP
    IF to_regclass('public.' || secret_table) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM nexlegtiq_readonly', secret_table);
    END IF;
  END LOOP;
  FOREACH people_table IN ARRAY ARRAY['users', 'platform_admins'] LOOP
    IF to_regclass('public.' || people_table) IS NOT NULL THEN
      SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO readable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = people_table
         AND column_name NOT IN ('password_hash', 'mfa_secret');
      EXECUTE format('REVOKE ALL ON public.%I FROM nexlegtiq_readonly', people_table);
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO nexlegtiq_readonly', readable, people_table);
    END IF;
  END LOOP;
END
$$;
