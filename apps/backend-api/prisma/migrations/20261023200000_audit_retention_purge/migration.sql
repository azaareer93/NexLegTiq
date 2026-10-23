-- D-136: the retention the purge honours is the highest ever set (D-060 "upward only"): lowering the setting later never
-- deletes history already kept. A trigger maintains it from the setting; the app cannot lower it (it ignores NEW values).
ALTER TABLE "office_settings" ADD COLUMN "max_audit_retention_days" INTEGER NOT NULL DEFAULT 365;
UPDATE "office_settings" SET "max_audit_retention_days" = greatest("audit_retention_days", 365);

CREATE FUNCTION nlq_keep_max_audit_retention() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  NEW.max_audit_retention_days := greatest(
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.max_audit_retention_days ELSE 365 END,
    NEW.audit_retention_days,
    365
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER office_settings_keep_max_audit_retention
  BEFORE INSERT OR UPDATE ON "office_settings"
  FOR EACH ROW EXECUTE FUNCTION nlq_keep_max_audit_retention();

-- The audit log stays append-only for the app role (UPDATE/DELETE revoked, D-079); the retention purge is this
-- function, owned by the migrator and run with its rights (SECURITY DEFINER). It can only remove an office's rows older
-- than the longest retention that office ever set, never less than 365 days (D-060), so the app role cannot use it to erase recent history.
CREATE FUNCTION nlq_purge_audit_logs(p_office_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  keep_days integer;
  removed integer;
BEGIN
  SELECT s.max_audit_retention_days INTO keep_days FROM public.office_settings s WHERE s.office_id = p_office_id;
  keep_days := greatest(coalesce(keep_days, 365), 365);
  DELETE FROM public.audit_logs
    WHERE office_id = p_office_id AND occurred_at < now() - make_interval(days => keep_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION nlq_purge_audit_logs(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    GRANT EXECUTE ON FUNCTION nlq_purge_audit_logs(uuid) TO nexlegtiq_app;
  END IF;
END
$$;
