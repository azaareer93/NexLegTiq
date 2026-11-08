-- AlterTable
ALTER TABLE "ai_usages" ADD COLUMN     "partial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_summaries" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "source_type" "AiSourceType" NOT NULL,
    "source_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version_number" INTEGER,
    "language" "UiLanguage" NOT NULL,
    "summary" TEXT NOT NULL,
    "key_facts" JSONB NOT NULL DEFAULT '[]',
    "key_legal_issues" JSONB NOT NULL DEFAULT '[]',
    "parties" JSONB NOT NULL DEFAULT '[]',
    "dates" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "chunks" INTEGER NOT NULL DEFAULT 1,
    "ai_job_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_summaries_office_id_source_type_source_id_language_creat_idx" ON "ai_summaries"("office_id", "source_type", "source_id", "language", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_summaries_office_id_file_id_idx" ON "ai_summaries"("office_id", "file_id");

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Summaries are history: append-only for the app role (D-148), like ai_usages (D-130).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, TRUNCATE ON "ai_summaries" FROM nexlegtiq_app;
  END IF;
  -- Summaries carry document content: the read-only support role never reads them (as document_texts, D-119).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_readonly') THEN
    REVOKE ALL ON "ai_summaries" FROM nexlegtiq_readonly;
  END IF;
END
$$;
