-- Office deletion (MVP-152, D-251): a 30-day read-only grace, then one per-tenant purge.

-- AlterTable
ALTER TABLE "offices" ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_scheduled_for" TIMESTAMPTZ(3),
ADD COLUMN     "purged_at" TIMESTAMPTZ(3);

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
-- its scheduled deletion, so the app role cannot use it to erase a live office.
-- Kept: the office row, its settings (audit retention), the anonymized audit log, subscriptions, platform payments (our own
-- accounting records) and retained invoices. Every other table with an office_id is read from the catalogue, so a tenant
-- table added later is purged without changing this function. Foreign-key order is found by retrying: a table still
-- referenced by another office row is tried again after the others; a pass that removes nothing (a cycle) aborts it all.
CREATE FUNCTION nlq_purge_office(p_office_id uuid) RETURNS integer
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

  -- Who did what stays provable without naming anyone: ids, values, IP, agent and request id go; entity and time stay.
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

  -- Portal accounts that belonged to this office only; one still referenced elsewhere (another office's audit) stays.
  FOREACH u IN ARRAY portal_users LOOP
    BEGIN
      DELETE FROM public.client_users cu
        WHERE cu.id = u
          AND NOT EXISTS (SELECT 1 FROM public.client_portal_accesses a WHERE a.client_user_id = u);
      GET DIAGNOSTICS n = ROW_COUNT;
      removed := removed + n;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;

  RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION nlq_purge_office(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    GRANT EXECUTE ON FUNCTION nlq_purge_office(uuid) TO nexlegtiq_app;
  END IF;
END
$$;
