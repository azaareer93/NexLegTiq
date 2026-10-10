-- CreateEnum
CREATE TYPE "CourtType" AS ENUM ('CIVIL', 'CRIMINAL', 'COMMERCIAL', 'LABOR', 'FAMILY', 'ADMINISTRATIVE', 'SHARIA', 'MAGISTRATE', 'FIRST_INSTANCE', 'APPEAL', 'CASSATION', 'SUPREME', 'ARBITRATION');

-- AlterTable
ALTER TABLE "legal_files" ADD COLUMN     "court_id" UUID,
ADD COLUMN     "judge_id" UUID;

-- CreateTable
CREATE TABLE "courts" (
    "id" UUID NOT NULL,
    "office_id" UUID,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "court_type" "CourtType" NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "city" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judges" (
    "id" UUID NOT NULL,
    "office_id" UUID,
    "court_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "judges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_prosecutors" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "office_name" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "public_prosecutors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "courts_jurisdiction_office_id_idx" ON "courts"("jurisdiction", "office_id");

-- CreateIndex
CREATE INDEX "courts_office_id_idx" ON "courts"("office_id");

-- CreateIndex
CREATE INDEX "judges_court_id_idx" ON "judges"("court_id");

-- CreateIndex
CREATE INDEX "judges_office_id_idx" ON "judges"("office_id");

-- CreateIndex
CREATE INDEX "public_prosecutors_office_id_full_name_idx" ON "public_prosecutors"("office_id", "full_name");

-- CreateIndex
CREATE INDEX "legal_files_court_id_idx" ON "legal_files"("court_id");

-- CreateIndex
CREATE INDEX "legal_files_judge_id_idx" ON "legal_files"("judge_id");

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "legal_files" ADD CONSTRAINT "legal_files_judge_id_fkey" FOREIGN KEY ("judge_id") REFERENCES "judges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "courts" ADD CONSTRAINT "courts_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "judges" ADD CONSTRAINT "judges_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "judges" ADD CONSTRAINT "judges_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public_prosecutors" ADD CONSTRAINT "public_prosecutors_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reference rows (D-037, D-115): platform rows (office_id NULL) are keyed by jurisdiction + English name (the seed key);
-- an office's own rows by office, jurisdiction and Arabic name (English is optional for them).
CREATE UNIQUE INDEX "courts_platform_name_key" ON "courts" ("jurisdiction", "name_en") WHERE "office_id" IS NULL;
CREATE UNIQUE INDEX "courts_office_name_key" ON "courts" ("office_id", "jurisdiction", "name_ar") WHERE "office_id" IS NOT NULL;
ALTER TABLE "courts" ADD CONSTRAINT "courts_platform_name_en_check" CHECK ("office_id" IS NOT NULL OR "name_en" IS NOT NULL);
ALTER TABLE "courts" ADD CONSTRAINT "courts_name_ar_check" CHECK (btrim("name_ar") <> '');
ALTER TABLE "judges" ADD CONSTRAINT "judges_full_name_check" CHECK (btrim("full_name") <> '');
ALTER TABLE "public_prosecutors" ADD CONSTRAINT "public_prosecutors_full_name_check" CHECK (btrim("full_name") <> '');

-- A court or judge may be a platform row, so these references cannot be composite (…, office_id) FKs (D-079). The
-- triggers give the same guarantee: a judge sits at a court its office can see (a platform judge at a platform court),
-- and a file names only a court its office can see and a judge of that court. The API checks first (400 VAL-001);
-- these are the backstop. A court never changes office and a judge never changes court or office, so a check made when
-- a row is written stays true.
CREATE FUNCTION nlq_court_visible(court uuid, office uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM courts c WHERE c.id = court AND (c.office_id IS NULL OR c.office_id = office))
$$;

CREATE FUNCTION nlq_reference_owner_fixed() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% % cannot move to another office or court', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;
CREATE TRIGGER "courts_office_fixed" BEFORE UPDATE OF "office_id" ON "courts"
  FOR EACH ROW WHEN (OLD.office_id IS DISTINCT FROM NEW.office_id) EXECUTE FUNCTION nlq_reference_owner_fixed();
CREATE TRIGGER "judges_owner_fixed" BEFORE UPDATE OF "office_id", "court_id" ON "judges"
  FOR EACH ROW WHEN (OLD.office_id IS DISTINCT FROM NEW.office_id OR OLD.court_id IS DISTINCT FROM NEW.court_id)
  EXECUTE FUNCTION nlq_reference_owner_fixed();

CREATE FUNCTION nlq_judges_check_court() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT nlq_court_visible(NEW.court_id, NEW.office_id) THEN
    RAISE EXCEPTION 'judge % sits at a court its office cannot see', NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "judges_court_visible" BEFORE INSERT ON "judges"
  FOR EACH ROW EXECUTE FUNCTION nlq_judges_check_court();

CREATE FUNCTION nlq_legal_files_check_court() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.court_id IS NOT NULL AND NOT nlq_court_visible(NEW.court_id, NEW.office_id) THEN
    RAISE EXCEPTION 'file % names a court its office cannot see', NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.judge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM judges j
    WHERE j.id = NEW.judge_id AND j.court_id = NEW.court_id AND (j.office_id IS NULL OR j.office_id = NEW.office_id)
  ) THEN
    RAISE EXCEPTION 'file % names a judge that is not at its court', NEW.id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "legal_files_court_visible" BEFORE INSERT OR UPDATE OF "court_id", "judge_id", "office_id" ON "legal_files"
  FOR EACH ROW EXECUTE FUNCTION nlq_legal_files_check_court();
