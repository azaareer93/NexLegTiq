-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'TEMPLATE', 'AI_NEXT_STEP');

-- AlterTable: where a task came from (D-156); existing tasks were typed by hand.
ALTER TABLE "tasks" ADD COLUMN     "source_type" "TaskSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "source_id" UUID;
