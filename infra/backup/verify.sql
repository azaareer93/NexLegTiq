-- Checks on a restored backup (D-141), run by restore-check.sh with ON_ERROR_STOP: any failed check raises and fails the
-- restore test.

-- Every migration the dump knows finished, none failed or rolled back half-way.
DO $$
DECLARE
  applied int;
  broken int;
BEGIN
  SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
         count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)
    INTO applied, broken
    FROM _prisma_migrations;
  IF applied = 0 THEN RAISE EXCEPTION 'restore check: no applied migration'; END IF;
  IF broken > 0 THEN RAISE EXCEPTION 'restore check: % unfinished migration(s)', broken; END IF;
END $$;

-- The extensions the schema needs came back (search, vectors).
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'unaccent', 'citext')) < 4 THEN
    RAISE EXCEPTION 'restore check: an extension is missing';
  END IF;
END $$;

-- The Arabic normalisation function used by search came back and works (D-059).
DO $$
BEGIN
  IF nlq_normalize_ar('أحمد') <> 'احمد' THEN
    RAISE EXCEPTION 'restore check: nlq_normalize_ar is broken';
  END IF;
END $$;

-- The audit purge (D-136) came back as SECURITY DEFINER, and the documents' search trigger exists (D-119).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'nlq_purge_audit_logs' AND prosecdef) THEN
    RAISE EXCEPTION 'restore check: nlq_purge_audit_logs is missing or not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE c.relname = 'document_texts' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'restore check: the document_texts search trigger is missing';
  END IF;
END $$;

-- Row counts, for a manual restore (BACKUP_VERBOSE=1); the restore test never prints them (public Actions log).
SELECT 'offices' AS table_name, count(*) AS rows FROM offices
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'legal_files', count(*) FROM legal_files
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'documents', count(*) FROM documents
UNION ALL SELECT 'document_versions', count(*) FROM document_versions
UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
UNION ALL SELECT '_prisma_migrations', count(*) FROM _prisma_migrations;
