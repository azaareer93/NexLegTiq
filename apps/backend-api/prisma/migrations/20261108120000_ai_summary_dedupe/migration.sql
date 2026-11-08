-- Same work asked twice while queued or running joins the first job (D-148).
ALTER TABLE "ai_jobs" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "ai_jobs_one_live_per_dedupe_key" ON "ai_jobs" ("office_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING');

-- One stored summary per version, language and prompt (D-148): two racing jobs cannot both store one.
DROP INDEX "ai_summaries_office_id_source_type_source_id_language_creat_idx";
CREATE UNIQUE INDEX "ai_summaries_office_id_source_type_source_id_version_number_key" ON "ai_summaries"("office_id", "source_type", "source_id", "version_number", "language", "prompt_version");
