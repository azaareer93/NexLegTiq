-- CreateEnum
CREATE TYPE "AiRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "ai_summaries" ADD COLUMN     "next_steps" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "risk_assessment" "AiRiskLevel";

