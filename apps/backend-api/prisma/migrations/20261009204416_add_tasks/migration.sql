-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "due_date" DATE,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "assigned_to_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_office_id_assigned_to_id_status_due_date_idx" ON "tasks"("office_id", "assigned_to_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "tasks_office_id_file_id_idx" ON "tasks"("office_id", "file_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_id_office_id_fkey" FOREIGN KEY ("assigned_to_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- completed_at is set exactly while the task is DONE (D-098); the Kanban position is never negative.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_when_done_check" CHECK (("status" = 'DONE') = ("completed_at" IS NOT NULL));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sort_order_check" CHECK ("sort_order" >= 0);
