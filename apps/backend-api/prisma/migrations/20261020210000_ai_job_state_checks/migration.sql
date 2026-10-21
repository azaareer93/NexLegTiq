-- An AI job's error code and finish time follow its status (D-130): FAILED has a code, a finished job has a time.
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_error_code_check"
  CHECK (("status" = 'FAILED') = ("error_code" IS NOT NULL));
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_finished_at_check"
  CHECK (("status" IN ('SUCCEEDED', 'FAILED')) = ("finished_at" IS NOT NULL));
