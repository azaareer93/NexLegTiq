-- Forced regeneration (MVP-88): the table is append-only, so a regenerated summary is a newer row; reads take the newest.
ALTER TABLE "ai_summaries" ADD COLUMN "regeneration" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "ai_summaries_office_id_source_type_source_id_version_number_key";
CREATE UNIQUE INDEX "ai_summaries_office_id_source_type_source_id_version_number_key" ON "ai_summaries"("office_id", "source_type", "source_id", "version_number", "language", "prompt_version", "regeneration");
CREATE UNIQUE INDEX "ai_summaries_id_office_id_key" ON "ai_summaries"("id", "office_id");

-- CreateEnum
CREATE TYPE "AiFeedbackReason" AS ENUM ('INACCURATE', 'MISSING_INFO', 'WRONG_LANGUAGE', 'PII_LEAK', 'OTHER');

-- CreateTable
CREATE TABLE "ai_feedbacks" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "summary_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" "AiFeedbackReason" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_feedbacks_office_id_summary_id_idx" ON "ai_feedbacks"("office_id", "summary_id");

-- AddForeignKey
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_summary_id_office_id_fkey" FOREIGN KEY ("summary_id", "office_id") REFERENCES "ai_summaries"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ai_feedbacks" ADD CONSTRAINT "ai_feedbacks_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Feedback is history: append-only for the app role, like ai_summaries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, TRUNCATE ON "ai_feedbacks" FROM nexlegtiq_app;
  END IF;
END
$$;
