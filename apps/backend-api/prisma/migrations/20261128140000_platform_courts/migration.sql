-- Platform courts per country managed by the platform admin; offices report missing courts (MVP-167, D-266).

-- CreateEnum
CREATE TYPE "CourtReportStatus" AS ENUM ('PENDING', 'ADDED', 'DISMISSED');

-- AlterTable: a constant default, so no table rewrite.
ALTER TABLE "courts" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "court_reports" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "reported_by_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "note" TEXT,
    "status" "CourtReportStatus" NOT NULL DEFAULT 'PENDING',
    "court_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "dismiss_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "court_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "court_reports_status_created_at_idx" ON "court_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "court_reports_office_id_created_at_idx" ON "court_reports"("office_id", "created_at");

-- CreateIndex
CREATE INDEX "court_reports_court_id_idx" ON "court_reports"("court_id");

-- AddForeignKey
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_reported_by_id_office_id_fkey" FOREIGN KEY ("reported_by_id", "office_id") REFERENCES "users"("id", "office_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A report has a name; it is resolved exactly when it is no longer pending, and an added one names its court.
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_resolved_check"
  CHECK (("status" = 'PENDING') = ("resolved_at" IS NULL));
ALTER TABLE "court_reports" ADD CONSTRAINT "court_reports_added_court_check"
  CHECK (("status" = 'ADDED') = ("court_id" IS NOT NULL));

-- D-115 fixes a court's office and a judge's court so a visibility check made on write stays true. The platform admin's
-- replace (judges move to a platform court) and promote (an office court becomes a platform court) need exactly those
-- changes: they set `nlq.court_merge` for their own transaction only (set_config(…, true)); every other write still fails.
CREATE OR REPLACE FUNCTION nlq_reference_owner_fixed() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('nlq.court_merge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% % cannot move to another office or court', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;
