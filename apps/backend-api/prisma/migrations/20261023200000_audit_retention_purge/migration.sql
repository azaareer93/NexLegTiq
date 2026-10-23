-- D-136: the audit log stays append-only for the app role (UPDATE/DELETE revoked, D-079); the retention purge is this
-- function, owned by the migrator and run with its rights (SECURITY DEFINER). It can only remove an office's rows older
-- than that office's retention, never less than 365 days (D-060), so the app role cannot use it to erase recent history.
CREATE FUNCTION nlq_purge_audit_logs(p_office_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  keep_days integer;
  removed integer;
BEGIN
  SELECT s.audit_retention_days INTO keep_days FROM office_settings s WHERE s.office_id = p_office_id;
  keep_days := greatest(coalesce(keep_days, 365), 365);
  DELETE FROM audit_logs
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
