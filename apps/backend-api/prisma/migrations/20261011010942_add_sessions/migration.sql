-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('HEARING', 'MEDIATION', 'ARBITRATION', 'PRE_TRIAL', 'STATUS_CONFERENCE', 'APPEAL_HEARING', 'JUDGMENT_PRONOUNCEMENT');

-- CreateEnum
CREATE TYPE "SessionOutcome" AS ENUM ('ADJOURNED', 'DECIDED', 'SETTLED', 'DISMISSED', 'POSTPONED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "session_type" "SessionType" NOT NULL DEFAULT 'HEARING',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "court_id" UUID,
    "judge_id" UUID,
    "court_room" TEXT,
    "attending_lawyer_id" UUID NOT NULL,
    "reminder_days" INTEGER[],
    "outcome" "SessionOutcome",
    "minutes" TEXT,
    "next_session_id" UUID,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancellation_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_reminders" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "days_before" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "job_id" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_party_attendances" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "attended" BOOLEAN,
    "represented_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_party_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_office_id_attending_lawyer_id_starts_at_idx" ON "sessions"("office_id", "attending_lawyer_id", "starts_at");

-- CreateIndex
CREATE INDEX "sessions_office_id_starts_at_idx" ON "sessions"("office_id", "starts_at");

-- CreateIndex
CREATE INDEX "sessions_office_id_file_id_starts_at_idx" ON "sessions"("office_id", "file_id", "starts_at");

-- CreateIndex
CREATE INDEX "sessions_court_id_idx" ON "sessions"("court_id");

-- CreateIndex
CREATE INDEX "sessions_judge_id_idx" ON "sessions"("judge_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_id_office_id_key" ON "sessions"("id", "office_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_next_session_id_office_id_key" ON "sessions"("next_session_id", "office_id");

-- CreateIndex
CREATE INDEX "session_reminders_office_id_session_id_idx" ON "session_reminders"("office_id", "session_id");

-- CreateIndex
CREATE INDEX "session_reminders_status_scheduled_for_idx" ON "session_reminders"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "session_party_attendances_office_id_party_id_idx" ON "session_party_attendances"("office_id", "party_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_party_attendances_session_id_party_id_key" ON "session_party_attendances"("session_id", "party_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_file_id_office_id_fkey" FOREIGN KEY ("file_id", "office_id") REFERENCES "legal_files"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_attending_lawyer_id_office_id_fkey" FOREIGN KEY ("attending_lawyer_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_id_office_id_fkey" FOREIGN KEY ("created_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_next_session_id_office_id_fkey" FOREIGN KEY ("next_session_id", "office_id") REFERENCES "sessions"("id", "office_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_reminders" ADD CONSTRAINT "session_reminders_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_reminders" ADD CONSTRAINT "session_reminders_session_id_office_id_fkey" FOREIGN KEY ("session_id", "office_id") REFERENCES "sessions"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_party_attendances" ADD CONSTRAINT "session_party_attendances_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_party_attendances" ADD CONSTRAINT "session_party_attendances_session_id_office_id_fkey" FOREIGN KEY ("session_id", "office_id") REFERENCES "sessions"("id", "office_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_party_attendances" ADD CONSTRAINT "session_party_attendances_party_id_office_id_fkey" FOREIGN KEY ("party_id", "office_id") REFERENCES "parties"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ─── Raw SQL Prisma cannot express ──────────────────────────────────────────────────────────────────────────────

-- A session ends after it starts; a cancelled session has no outcome; a session is not adjourned to itself; reminder
-- offsets are 0–365 days, at most 10 (D-116).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ends_after_start_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cancelled_without_outcome_check" CHECK (NOT ("is_cancelled" AND "outcome" IS NOT NULL));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_next_not_self_check" CHECK ("next_session_id" IS NULL OR "next_session_id" <> "id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_reminder_days_check" CHECK (
  cardinality("reminder_days") <= 10 AND 0 <= ALL ("reminder_days") AND 365 >= ALL ("reminder_days")
);
ALTER TABLE "session_reminders" ADD CONSTRAINT "session_reminders_days_before_check" CHECK ("days_before" BETWEEN 0 AND 365);

-- Court and judge of a session: the guarantee a file has (D-115) — a court its office can see, a judge of that court.
-- Courts never change office and judges never change court (add_courts_judges_prosecutors), so the check stays true.
CREATE FUNCTION nlq_sessions_check_court() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.court_id IS NOT NULL AND NOT nlq_court_visible(NEW.court_id, NEW.office_id) THEN
    RAISE EXCEPTION 'session % names a court its office cannot see', NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.judge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM judges j
    WHERE j.id = NEW.judge_id AND j.court_id = NEW.court_id AND (j.office_id IS NULL OR j.office_id = NEW.office_id)
  ) THEN
    RAISE EXCEPTION 'session % names a judge that is not at its court', NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sessions_court_visible" BEFORE INSERT OR UPDATE OF "court_id", "judge_id", "office_id" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION nlq_sessions_check_court();
