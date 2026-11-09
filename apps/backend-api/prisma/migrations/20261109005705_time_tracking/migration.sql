-- AlterTable
ALTER TABLE "office_settings" ADD COLUMN     "time_increment_minutes" INTEGER NOT NULL DEFAULT 6;

-- CreateTable
CREATE TABLE "time_entries" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "duration_hours" DECIMAL(6,2) NOT NULL,
    "description" TEXT NOT NULL,
    "is_billable" BOOLEAN NOT NULL DEFAULT true,
    "hourly_rate" DECIMAL(14,2),
    "currency" CHAR(3) NOT NULL,
    "invoice_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_timers" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "description" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_timers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entries_office_id_file_id_work_date_idx" ON "time_entries"("office_id", "file_id", "work_date");

-- CreateIndex
CREATE INDEX "time_entries_office_id_user_id_work_date_idx" ON "time_entries"("office_id", "user_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "time_timers_user_id_office_id_key" ON "time_timers"("user_id", "office_id");

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_user_id_office_id_fkey" FOREIGN KEY ("user_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- D-152: an entry is more than nothing and at most a day; rates are not negative; currency is an ISO-4217 code.
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_duration_check" CHECK ("duration_hours" > 0 AND "duration_hours" <= 24);
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_rate_check" CHECK ("hourly_rate" IS NULL OR "hourly_rate" >= 0);
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "office_settings" ADD CONSTRAINT "office_settings_time_increment_check" CHECK ("time_increment_minutes" BETWEEN 1 AND 60);
