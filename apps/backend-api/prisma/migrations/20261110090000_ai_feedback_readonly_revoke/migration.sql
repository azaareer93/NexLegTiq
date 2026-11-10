-- Feedback comments are free text about case material: the read-only support role never reads them (as ai_summaries).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "ai_feedbacks" FROM nexlegtiq_readonly;
  END IF;
END
$$;
