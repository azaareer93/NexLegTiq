-- Office deletion (MVP-152, D-251): a 30-day read-only grace, then one per-tenant purge.

-- AlterTable
ALTER TABLE "offices" ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_scheduled_for" TIMESTAMPTZ(3),
ADD COLUMN     "purged_at" TIMESTAMPTZ(3),
ADD COLUMN     "records_retained_until" TIMESTAMPTZ(3);

-- AlterTable: a purged office's pseudonymous actor ("User 1", "Client 1"), stable within the office (owner, 2026-11-28).
ALTER TABLE "audit_logs" ADD COLUMN     "actor_ref" TEXT;

-- CreateTable
CREATE TABLE "retained_invoices" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "retain_until" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retained_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retained_invoices_retain_until_idx" ON "retained_invoices"("retain_until");

-- CreateIndex
CREATE UNIQUE INDEX "retained_invoices_office_id_invoice_number_key" ON "retained_invoices"("office_id", "invoice_number");

-- AddForeignKey
ALTER TABLE "retained_invoices" ADD CONSTRAINT "retained_invoices_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The irreversible step. The app role cannot UPDATE audit_logs (D-079), so anonymizing them needs the migrator's rights
-- (SECURITY DEFINER, search_path pinned, as nlq_purge_audit_logs, D-136). The function refuses an office that is not past
-- its scheduled deletion; it enforces that date only — the app role, which writes the date, already has DML on every row.
-- Kept: the office row, its settings, the anonymized audit log, subscriptions, platform payments (our own accounting
-- records) and retained invoices. Every other table with an office_id is read from the catalogue, so a tenant table added
-- later is purged without changing this function. Foreign-key order is found by retrying: a table still referenced by
-- another office row is tried again after the others; a pass that removes nothing (a cycle) aborts it all.
-- `p_retain_until` puts the anonymized audit on the retained invoices' clock (records_retained_until); it is refused under
-- one year, so the app role cannot use it to age the log out early.
CREATE FUNCTION nlq_purge_office(p_office_id uuid, p_retain_until timestamptz) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  kept constant text[] := ARRAY['offices', 'office_settings', 'audit_logs', 'subscriptions', 'platform_payments',
                                'retained_invoices'];
  pending text[];
  blocked text[];
  portal_users uuid[];
  t text;
  u uuid;
  n integer;
  removed integer := 0;
BEGIN
  PERFORM 1 FROM public.offices
    WHERE id = p_office_id AND purged_at IS NULL AND deletion_scheduled_for <= now()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'office % is not due for purge', p_office_id;
  END IF;
  IF p_retain_until IS NULL OR p_retain_until < now() + interval '1 year' THEN
    RAISE EXCEPTION 'retention of office % must be at least one year', p_office_id;
  END IF;
  UPDATE public.offices SET records_retained_until = p_retain_until WHERE id = p_office_id;

  -- Who did what stays provable without naming anyone: each actor becomes a per-office pseudonym (staff "User n", portal
  -- clients "Client n", numbered by first appearance), then ids, values, IP, agent and request id go; entity, action and
  -- time stay. Platform admins keep their id: they are our own staff, not the office's data.
  WITH actors AS (
    SELECT kind, actor,
           CASE kind WHEN 'u' THEN 'User ' ELSE 'Client ' END
             || row_number() OVER (PARTITION BY kind ORDER BY min(occurred_at), actor) AS ref
    FROM (
      SELECT CASE WHEN user_id IS NOT NULL THEN 'u' ELSE 'c' END AS kind,
             coalesce(user_id, client_user_id) AS actor, occurred_at
      FROM public.audit_logs
      WHERE office_id = p_office_id AND (user_id IS NOT NULL OR client_user_id IS NOT NULL)
    ) seen
    GROUP BY kind, actor
  )
  UPDATE public.audit_logs a SET actor_ref = actors.ref
    FROM actors
    WHERE a.office_id = p_office_id
      AND actors.actor = coalesce(a.user_id, a.client_user_id)
      AND actors.kind = CASE WHEN a.user_id IS NOT NULL THEN 'u' ELSE 'c' END;
  UPDATE public.audit_logs
    SET user_id = NULL, client_user_id = NULL, old_values = NULL, new_values = NULL,
        ip_address = NULL, user_agent = NULL, request_id = NULL
    WHERE office_id = p_office_id;

  SELECT coalesce(array_agg(DISTINCT client_user_id), '{}') INTO portal_users
    FROM public.client_portal_accesses WHERE office_id = p_office_id;

  SELECT coalesce(array_agg(c.table_name::text ORDER BY c.table_name::text), '{}') INTO pending
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'office_id' AND NOT (c.table_name::text = ANY (kept));

  WHILE cardinality(pending) > 0 LOOP
    blocked := '{}';
    FOREACH t IN ARRAY pending LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE office_id = $1', t) USING p_office_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        removed := removed + n;
      EXCEPTION WHEN foreign_key_violation THEN
        blocked := blocked || t;
      END;
    END LOOP;
    IF cardinality(blocked) = cardinality(pending) THEN
      RAISE EXCEPTION 'purge of office % blocked by foreign keys between %', p_office_id, blocked;
    END IF;
    pending := blocked;
  END LOOP;

  -- Portal accounts that belonged to this office only. One another office's rows still reference (its audit, uploads)
  -- cannot be deleted: it is anonymized instead, so no name, email or password survives.
  FOREACH u IN ARRAY portal_users LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.client_portal_accesses a WHERE a.client_user_id = u);
    BEGIN
      DELETE FROM public.client_users WHERE id = u;
      GET DIAGNOSTICS n = ROW_COUNT;
      removed := removed + n;
    EXCEPTION WHEN foreign_key_violation THEN
      UPDATE public.client_users
        SET email = id::text || '@purged.invalid', full_name = '', password_hash = '!', is_active = false,
            email_verified_at = NULL, last_login_at = NULL, updated_at = now()
        WHERE id = u;
    END;
  END LOOP;

  RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION nlq_purge_office(uuid, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    GRANT EXECUTE ON FUNCTION nlq_purge_office(uuid, timestamptz) TO nexlegtiq_app;
  END IF;
END
$$;

-- One clock for what a purged office leaves (D-251): its anonymized audit rows stay until records_retained_until, the same
-- date as its retained invoices, whatever their age; a live office keeps the D-136 rule (its longest retention, >= 365 d).
CREATE OR REPLACE FUNCTION nlq_purge_audit_logs(p_office_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  keep_days integer;
  kept_until timestamptz;
  removed integer;
BEGIN
  SELECT o.records_retained_until INTO kept_until FROM public.offices o WHERE o.id = p_office_id;
  IF kept_until IS NOT NULL THEN
    DELETE FROM public.audit_logs WHERE office_id = p_office_id AND now() >= kept_until;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
  END IF;
  SELECT s.max_audit_retention_days INTO keep_days FROM public.office_settings s WHERE s.office_id = p_office_id;
  keep_days := greatest(coalesce(keep_days, 365), 365);
  DELETE FROM public.audit_logs
    WHERE office_id = p_office_id AND occurred_at < now() - make_interval(days => keep_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
