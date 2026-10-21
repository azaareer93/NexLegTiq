-- CreateEnum
CREATE TYPE "AiSourceType" AS ENUM ('DOCUMENT', 'SESSION', 'WITNESS_STATEMENT', 'COURT_RULING', 'OPPOSING_BRIEF');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source_type" "AiSourceType",
    "source_id" UUID,
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "error_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "created_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usages" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_jobs_office_id_created_by_id_created_at_idx" ON "ai_jobs"("office_id", "created_by_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_usages_office_id_created_at_idx" ON "ai_usages"("office_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Counters and money are never negative.
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_counts_check"
  CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "duration_ms" >= 0 AND "cost_usd" >= 0);

-- AI usage is the quota and cost record: append-only for the app role (like the audit log and document versions).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app') THEN
    REVOKE UPDATE, TRUNCATE ON "ai_usages" FROM nexlegtiq_app;
  END IF;
END
$$;
